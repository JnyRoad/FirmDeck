from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.contracts.error_registry import ERROR_REGISTRY, ErrorContractViolation, ErrorVisibility
from app.contracts.errors import ErrorDescriptor, InternalErrorContext
from app.db.models import (
    ChatSession,
    HarnessTurnRecord,
    Tenant,
    User,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    ReplyLocaleConflict,
    normalize_locale,
    resolve_language_context,
)
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDecision,
    require_active_tenant,
    require_matching_admission_version,
)
from app.session.session_schema import ChatTurnRequest, ChatTurnResponse

TURN_LEASE_SECONDS = 900
logger = logging.getLogger(__name__)


def _optional_tenant_admission(
    db: Session,
    tenant_id: str,
    correlation_id: str,
) -> TenantLifecycleDecision | None:
    """Return the authoritative Harness admission when a tenant row exists.

    A few trusted pre-migration unit callers construct an in-memory session without
    its Tenant row.  Those callers retain the historical version-one receipt shape;
    every real tenant row still goes through the central fail-closed lifecycle gate.
    """
    if db.get(Tenant, tenant_id) is None:
        return None
    return require_active_tenant(
        db,
        tenant_id,
        TenantExecutionKind.JOB_CLAIM,
        correlation_id,
    )


def _turn_error_payload(code: object, message: object, *, status: str) -> dict[str, object]:
    """Build a registry-shaped turn error and retain legacy prose only in private diagnostics."""
    entry = ERROR_REGISTRY.get(code) if isinstance(code, str) else None
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
    descriptor = ErrorDescriptor(
        code=entry.code,
        params={},
        retryable=entry.retryable_default if status != "retrying" else True,
    )
    try:
        ERROR_REGISTRY.validate(descriptor)
    except (ErrorContractViolation, TypeError, ValueError):
        descriptor = ErrorDescriptor(code="INTERNAL_ERROR", params={}, retryable=status == "retrying")
    context = InternalErrorContext(
        source="harness_turn_store",
        raw_message=str(message) if message is not None else None,
        upstream_code=str(code) if code is not None else None,
    )
    if message is not None:
        logger.info("Harness turn failure retained in private diagnostics: %s", context)
    return descriptor.model_dump(mode="json")


class HarnessTurnConflict(RuntimeError):
    """Stable execution conflict that callers can project without exposing internals."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "HARNESS_TURN_CONFLICT",
        params: dict[str, str] | None = None,
    ) -> None:
        """Retain a machine-readable code and safe parameters alongside the legacy message."""
        super().__init__(message)
        self.code = code
        self.params = dict(params or {})


class HarnessTurnClaim:
    def __init__(
        self,
        *,
        record: HarnessTurnRecord | None,
        replay: ChatTurnResponse | None = None,
    ) -> None:
        self.record = record
        self.replay = replay


class HarnessTurnStore:
    """Durable exactly-once receipts keyed by the caller's client_turn_id."""

    def __init__(
        self,
        db: Session,
        *,
        admission_check: Callable[[], None] | None = None,
    ) -> None:
        self.db = db
        self.admission_check = admission_check

    def claim(
        self,
        session: ChatSession,
        request: ChatTurnRequest,
    ) -> HarnessTurnClaim:
        """Resolve the immutable locale snapshot before creating or replaying a turn receipt."""
        client_turn_id = str(request.client_turn_id or "").strip()
        admission = _optional_tenant_admission(
            self.db,
            session.tenant_id,
            client_turn_id or session.id,
        )
        existing = self._find(session, client_turn_id) if client_turn_id else None
        if admission is not None and existing is not None:
            require_matching_admission_version(
                admission,
                existing.tenant_lifecycle_version,
            )
        _prepare_turn_language_context(self.db, session, request, existing=existing)
        if not client_turn_id:
            return HarnessTurnClaim(record=None)
        digest = _request_digest(request)
        if existing is not None:
            return self._existing_claim(existing, digest)

        now = utc_now()
        record = HarnessTurnRecord(
            tenant_id=session.tenant_id,
            session_id=session.id,
            client_turn_id=client_turn_id,
            request_digest=digest,
            tenant_lifecycle_version=(
                admission.lifecycle_version if admission is not None else 1
            ),
            lease_owner=new_id("hturnlease"),
            lease_expires_at=now + timedelta(seconds=TURN_LEASE_SECONDS),
            language_context_json=request.language_context.model_dump(mode="json")
            if request.language_context is not None
            else None,
        )
        self.db.add(record)
        try:
            self._check_admission()
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self._find(session, client_turn_id)
            if existing is None:
                raise
            return self._existing_claim(existing, digest)
        self.db.refresh(record)
        return HarnessTurnClaim(record=record)

    def bind_user_message(
        self,
        record: HarnessTurnRecord | None,
        user_message_id: str,
    ) -> None:
        if record is None:
            return
        self._fenced_update(
            record,
            values={
                "user_message_id": user_message_id,
                "updated_at": utc_now(),
            },
        )

    def renew(self, record: HarnessTurnRecord | None) -> None:
        """Keep the durable turn receipt alive while its executor is healthy."""

        if record is None or record.status not in {"started", "finalizing"}:
            return
        now = utc_now()
        self._fenced_update(
            record,
            expected_statuses=("started", "finalizing"),
            values={
                "lease_expires_at": now + timedelta(seconds=TURN_LEASE_SECONDS),
                "updated_at": now,
            },
        )

    def complete(
        self,
        record: HarnessTurnRecord | None,
        response: ChatTurnResponse,
    ) -> None:
        """Persist a terminal response together with the receipt's original locale snapshot."""
        if record is None:
            return
        _apply_record_language_context(record, response)
        now = utc_now()
        self._fenced_update(
            record,
            # ``started`` remains accepted for compatibility with non-projecting
            # callers; the Harness v2 response path always reserves
            # ``finalizing`` first.
            expected_statuses=("started", "finalizing"),
            values={
                "status": "completed",
                "response_json": response.model_dump(mode="json"),
                "finished_at": now,
                "updated_at": now,
            },
        )

    def begin_completion(self, record: HarnessTurnRecord | None) -> None:
        """Acquire the durable right to publish the normal terminal reply."""

        if record is None:
            return
        self._fenced_update(
            record,
            expected_statuses=("started",),
            values={"status": "finalizing", "updated_at": utc_now()},
        )

    def cancel(
        self,
        record: HarnessTurnRecord | None,
        *,
        message: str = "用户取消了当前 Harness 执行。",
    ) -> bool:
        """Atomically make cancellation the terminal owner for a receipt."""

        if record is None:
            return False
        now = utc_now()
        return self._try_fenced_update(
            record,
            expected_statuses=("started",),
            values={
                "status": "cancelled",
                "error_json": _turn_error_payload("CANCELLED", message, status="cancelled"),
                "finished_at": now,
                "updated_at": now,
            },
        )

    def finish_with_error(
        self,
        record: HarnessTurnRecord | None,
        *,
        status: str,
        code: str,
        message: str,
    ) -> None:
        """Persist a terminal turn failure as a canonical descriptor, never as natural-language text."""
        if record is None or record.status not in {"started", "finalizing"}:
            return
        now = utc_now()
        self._fenced_update(
            record,
            expected_statuses=("started", "finalizing"),
            values={
                "status": status,
                "error_json": _turn_error_payload(code, str(message)[:2_000], status=status),
                "finished_at": now,
                "updated_at": now,
            },
        )

    def _find(
        self,
        session: ChatSession,
        client_turn_id: str,
    ) -> HarnessTurnRecord | None:
        return self.db.exec(
            select(HarnessTurnRecord).where(
                HarnessTurnRecord.tenant_id == session.tenant_id,
                HarnessTurnRecord.session_id == session.id,
                HarnessTurnRecord.client_turn_id == client_turn_id,
            )
        ).first()

    def _existing_claim(
        self,
        existing: HarnessTurnRecord,
        request_digest: str,
    ) -> HarnessTurnClaim:
        """Compare the normalized request digest and replay only an already completed receipt."""
        if existing.request_digest != request_digest:
            raise HarnessTurnConflict(
                "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。"
            )
        if existing.status == "completed" and existing.response_json:
            replay = ChatTurnResponse.model_validate(existing.response_json)
            _apply_record_language_context(existing, replay)
            return HarnessTurnClaim(
                record=existing,
                replay=replay,
            )
        if existing.status in {"started", "finalizing"}:
            state = (
                "仍在执行"
                if existing.lease_expires_at > utc_now()
                else "执行结果未知，需先核对执行记录"
            )
            raise HarnessTurnConflict(
                f"该 client_turn_id 对应的 Harness turn {state}，不会重复执行。"
            )
        raise HarnessTurnConflict(
            "该 client_turn_id 已结束且不能自动重试；请使用新的 client_turn_id。"
        )

    def _fenced_update(
        self,
        record: HarnessTurnRecord,
        *,
        expected_statuses: tuple[str, ...] = ("started",),
        values: dict[str, Any],
    ) -> None:
        if self._try_fenced_update(
            record,
            expected_statuses=expected_statuses,
            values=values,
        ):
            return
        raise HarnessTurnConflict("Harness turn receipt 已由其他执行者更新。")

    def _try_fenced_update(
        self,
        record: HarnessTurnRecord,
        *,
        expected_statuses: tuple[str, ...],
        values: dict[str, Any],
    ) -> bool:
        result = self.db.exec(
            update(HarnessTurnRecord)
            .where(
                HarnessTurnRecord.id == record.id,
                HarnessTurnRecord.status.in_(expected_statuses),
                HarnessTurnRecord.lease_owner == record.lease_owner,
            )
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        if getattr(result, "rowcount", 0) != 1:
            self.db.rollback()
            self.db.refresh(record)
            return False
        self._check_admission()
        self.db.commit()
        self.db.refresh(record)
        return True

    def _check_admission(self) -> None:
        """Run the enclosing wake fence immediately before a receipt commit."""
        check = self.admission_check
        if callable(check):
            check()


def _request_digest(request: ChatTurnRequest) -> str:
    """Hash all execution inputs, including the normalized immutable locale snapshot."""
    payload = request.model_dump(
        mode="json",
        exclude={"session_id", "client_turn_id", "ui_locale", "agent_reply_locale"},
    )
    payload["ui_locale"] = (
        normalize_locale(request.ui_locale).value if request.ui_locale is not None else None
    )
    payload["agent_reply_locale"] = (
        normalize_locale(request.agent_reply_locale).value
        if request.agent_reply_locale is not None
        else None
    )
    if request.language_context is not None:
        payload["language_context"] = request.language_context.model_dump(mode="json")
    canonical = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _prepare_turn_language_context(
    db: Session,
    session: ChatSession,
    request: ChatTurnRequest,
    *,
    existing: HarnessTurnRecord | None = None,
) -> LanguageContext:
    """Resolve and bind one turn snapshot without deriving language from historical message text."""
    # Workflow: completed receipts reuse their persisted snapshot when the retry carries no
    # explicit locale, so replay remains byte-for-byte compatible after a session preference update.
    persisted_snapshot = _record_language_context(existing)
    uses_durable_snapshot = persisted_snapshot is not None
    if uses_durable_snapshot:
        if (
            request.language_context is not None
            and request.language_context != persisted_snapshot
        ):
            raise HarnessTurnConflict(
                "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。"
            )
        context = persisted_snapshot
    elif request.language_context is not None:
        context = request.language_context
    else:
        user = db.get(User, request.user_id) if request.user_id else None
        try:
            context = resolve_language_context(
                LanguageContextInputs(
                    explicit_ui_locale=request.ui_locale,
                    explicit_agent_reply_locale=request.agent_reply_locale,
                    session_agent_reply_locale=session.agent_reply_locale,
                    user_ui_locale=user.ui_locale if user else None,
                    user_agent_reply_locale=user.agent_reply_locale if user else None,
                )
            )
        except ReplyLocaleConflict as exc:
            raise HarnessTurnConflict(
                "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。",
                code=exc.code,
                params=exc.params,
            ) from exc

    # Workflow: a session-level reply locale is authoritative even when an internal caller supplies
    # a pre-resolved snapshot; reject drift before the receipt digest is compared or persisted.
    session_locale = normalize_locale(session.agent_reply_locale)
    if (
        session_locale is not None
        and context.agent_reply_locale is not session_locale
        and not uses_durable_snapshot
    ):
        raise HarnessTurnConflict(
            "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。",
            code="AGENT_REPLY_LOCALE_CONFLICT",
            params={
                "requested": context.agent_reply_locale.value,
                "session": session_locale.value,
            },
        )
    explicit_ui_locale = normalize_locale(request.ui_locale)
    if explicit_ui_locale is not None and explicit_ui_locale is not context.ui_locale:
        raise HarnessTurnConflict(
            "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。",
            params={
                "requested": explicit_ui_locale.value,
                "snapshot": context.ui_locale.value,
            },
        )
    explicit_reply_locale = normalize_locale(request.agent_reply_locale)
    if explicit_reply_locale is not None and explicit_reply_locale is not context.agent_reply_locale:
        raise HarnessTurnConflict(
            "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。",
            code="AGENT_REPLY_LOCALE_CONFLICT",
            params={
                "requested": explicit_reply_locale.value,
                "session": context.agent_reply_locale.value,
            },
        )

    request.language_context = context
    request.ui_locale = context.ui_locale
    request.agent_reply_locale = context.agent_reply_locale
    if session.agent_reply_locale is None:
        session.agent_reply_locale = context.agent_reply_locale.value
        session.agent_reply_locale_source = context.agent_reply_locale_source.value
        session.updated_at = utc_now()
        db.add(session)
    return context


def _record_language_context(record: HarnessTurnRecord | None) -> LanguageContext | None:
    """Parse a stored snapshot when present, leaving legacy records un-inferred."""
    if record is None or not isinstance(record.language_context_json, dict):
        return None
    try:
        return LanguageContext.model_validate(record.language_context_json)
    except (TypeError, ValueError):
        return None


def _apply_record_language_context(
    record: HarnessTurnRecord,
    response: ChatTurnResponse,
) -> None:
    """Fill response locale fields from the receipt without changing legacy response content."""
    context = _record_language_context(record)
    if context is None:
        return
    if response.ui_locale is None:
        response.ui_locale = context.ui_locale
    if response.agent_reply_locale is None:
        response.agent_reply_locale = context.agent_reply_locale
    if response.language_context is None:
        response.language_context = context


__all__ = [
    "HarnessTurnClaim",
    "HarnessTurnConflict",
    "HarnessTurnStore",
    "_prepare_turn_language_context",
]

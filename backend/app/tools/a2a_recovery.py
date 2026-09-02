from __future__ import annotations

import threading
import uuid
from datetime import timedelta

from sqlalchemy import or_, update
from sqlmodel import Session, select

from app.contracts.error_registry import ERROR_REGISTRY, ErrorContractViolation, ErrorVisibility
from app.contracts.errors import ErrorDescriptor
from app.db import engine
from app.db.models import (
    A2ATaskEvent,
    A2ATaskRun,
    ChatSession,
    HarnessInvocationRecord,
    Tool,
    utc_now,
)
from app.i18n.language_context import resolve_compatible_language_context
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDenied,
    require_active_tenant,
    require_matching_admission_version,
)
from app.tools.tool_executor import ToolExecutor
from app.tools.tool_schema import ToolCall

_RECOVERABLE_STATES = {"submitted", "working"}
_WORKER_LEASE_SECONDS = 15 * 60


def _recovery_error_payload(
    code: str,
    *,
    params: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build durable recovery failures from the exact public error registry contract."""
    entry = ERROR_REGISTRY.get(code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        params = {}
    try:
        descriptor = ErrorDescriptor(
            code=entry.code,
            params=dict(params or {}),
            retryable=entry.retryable_default,
        )
        descriptor = ERROR_REGISTRY.validate(descriptor)
    except (ErrorContractViolation, TypeError, ValueError):
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        descriptor = ErrorDescriptor(
            code=entry.code,
            params={},
            retryable=entry.retryable_default,
        )
    return descriptor.model_dump(mode="json")


def recover_a2a_client_tasks() -> None:
    """Resume durable outbound A2A tasks after an application restart."""

    with Session(engine) as db:
        run_ids = list(
            db.exec(
                select(A2ATaskRun.id).where(
                    A2ATaskRun.direction == "client",
                    A2ATaskRun.owner_scope == "tenant",
                    A2ATaskRun.tenant_id.is_not(None),
                    A2ATaskRun.status.in_(_RECOVERABLE_STATES),
                )
            ).all()
        )
    for run_id in run_ids:
        threading.Thread(
            target=_recover_one,
            args=(str(run_id),),
            name=f"a2a-client-recovery-{run_id}",
            daemon=True,
        ).start()


def _recover_one(run_id: str) -> None:
    with Session(engine) as db:
        claimed = _claim_recovery_run(db, run_id)
        if claimed is None:
            return
        run, worker_owner, worker_generation = claimed
        if not run.tool_id or not run.invocation_id:
            _terminalize_run(db, run, "A2A_RECOVERY_INVALID")
            return
        try:
            # Recovery discovery is not admission: re-read current state and require the exact
            # lifecycle version before any ToolExecutor redispatch can reach a provider.
            db.expire_all()
            decision = require_active_tenant(
                db,
                run.tenant_id,
                TenantExecutionKind.A2A_CLIENT_RECOVERY,
                run.invocation_id,
            )
            require_matching_admission_version(decision, run.tenant_lifecycle_version)
        except TenantLifecycleDenied:
            _terminalize_run(db, run, "TENANT_WORK_TERMINALIZED")
            return
        tool = db.get(Tool, run.tool_id)
        if tool is None:
            _terminalize_run(db, run, "A2A_RECOVERY_TOOL_MISSING")
            return
        invocation = db.exec(
            select(HarnessInvocationRecord)
            .where(
                HarnessInvocationRecord.tenant_id == run.tenant_id,
                HarnessInvocationRecord.call_id == run.invocation_id,
            )
            .order_by(HarnessInvocationRecord.started_at.desc())
        ).first()
        language_context = resolve_compatible_language_context(
            snapshot=(
                run.language_context_json
                or (invocation.language_context_json if invocation is not None else None)
            ),
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )
        session = db.get(ChatSession, run.session_id) if run.session_id else None
        if (
            session is not None
            and session.agent_reply_locale is not None
            and session.agent_reply_locale != language_context.agent_reply_locale.value
        ):
            run.status = "failed"
            run.error_json = _recovery_error_payload(
                "AGENT_REPLY_LOCALE_CONFLICT",
                params={
                    "requested": language_context.agent_reply_locale.value,
                    "session": session.agent_reply_locale,
                },
            )
            run.finished_at = utc_now()
            run.updated_at = utc_now()
            db.add(run)
            db.commit()
            return
        run.language_context_json = language_context.model_dump(mode="json")
        db.add(run)
        db.commit()
        request = run.request_json if isinstance(run.request_json, dict) else {}
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        ToolExecutor(db).execute(
            tenant_id=run.tenant_id,
            tool_call=ToolCall(name=tool.name, arguments=arguments),
            agent_id=run.agent_id,
            session_id=run.session_id,
            invocation_id=run.invocation_id,
            language_context=language_context,
            user_id=session.user_id if session is not None else None,
            a2a_worker_owner=worker_owner,
            a2a_worker_generation=worker_generation,
        )


def _claim_recovery_run(
    db: Session,
    run_id: str,
) -> tuple[A2ATaskRun, str, int] | None:
    """CAS one recoverable tenant run to a durable worker generation."""
    now = utc_now()
    worker_owner = f"a2a-recovery-{uuid.uuid4().hex}"
    result = db.exec(
        update(A2ATaskRun)
        .where(
            A2ATaskRun.id == run_id,
            A2ATaskRun.owner_scope == "tenant",
            A2ATaskRun.direction == "client",
            A2ATaskRun.tenant_id.is_not(None),
            A2ATaskRun.status.in_(_RECOVERABLE_STATES),
            or_(
                A2ATaskRun.worker_owner.is_(None),
                A2ATaskRun.worker_lease_until.is_(None),
                A2ATaskRun.worker_lease_until < now,
            ),
        )
        .values(
            worker_owner=worker_owner,
            worker_generation=A2ATaskRun.worker_generation + 1,
            worker_lease_until=now + timedelta(seconds=_WORKER_LEASE_SECONDS),
            updated_at=now,
        )
    )
    db.commit()
    if getattr(result, "rowcount", 0) != 1:
        return None
    db.expire_all()
    run = db.get(A2ATaskRun, run_id)
    if run is None or run.worker_owner != worker_owner:
        return None
    return run, worker_owner, run.worker_generation


def _terminalize_run(db: Session, run: A2ATaskRun, code: str) -> None:
    """Persist one non-retryable recovery terminal state and a secret-free lifecycle event."""
    run.status = "failed"
    run.error_json = _recovery_error_payload(code)
    run.finished_at = utc_now()
    run.updated_at = utc_now()
    db.add(run)
    db.commit()
    previous = db.exec(
        select(A2ATaskEvent)
        .where(A2ATaskEvent.run_id == run.id)
        .order_by(A2ATaskEvent.sequence.desc())
    ).first()
    event_data: dict[str, object] = {"error": dict(run.error_json)}
    try:
        context = resolve_compatible_language_context(
            snapshot=run.language_context_json,
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )
    except (TypeError, ValueError):
        context = None
    if context is not None:
        event_data["metadata"] = {"language_context": context.model_dump(mode="json")}
    db.add(
        A2ATaskEvent(
            run_id=run.id,
            sequence=(previous.sequence + 1) if previous else 1,
            event_type="recovery_failed",
            data_json=event_data,
        )
    )
    db.commit()

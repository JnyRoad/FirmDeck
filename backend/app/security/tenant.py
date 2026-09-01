"""Central fail-closed tenant lifecycle admission decisions for tenant-owned execution."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from types import MappingProxyType
from typing import NoReturn

from sqlmodel import Session

from app.contracts.http import build_http_exception
from app.db.models import Tenant

logger = logging.getLogger(__name__)

# Provider conversation identifiers may carry an ``@``-qualified subject (for example,
# ``user@im.wechat``); keep that bounded shape distinct from free-form payload text.
_SAFE_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
_DENIAL_CODES = frozenset(
    {
        "TENANT_SUSPENDED",
        "TENANT_NOT_FOUND",
        "TENANT_LIFECYCLE_CHECK_FAILED",
    }
)
_DENIAL_EVIDENCE_KEYS = frozenset({"tenant_id", "execution_kind", "correlation_id"})
_EXCEPTION_RUNTIME_ATTRIBUTES = frozenset(
    {"__traceback__", "__cause__", "__context__", "__suppress_context__", "__notes__"}
)


class TenantExecutionKind(str, Enum):
    """Registered tenant-owned admission and recovery boundaries currently using the central gate."""

    A2A_CLIENT_SUBMIT = "a2a.client.submit"
    A2A_CLIENT_RECOVERY = "a2a.client.recovery"
    JOB_CLAIM = "job.claim"
    CHANNEL_DELIVERY = "channel.delivery"


@dataclass(frozen=True, slots=True)
class TenantLifecycleDecision:
    """Capture one immutable authoritative admission result for the current execution attempt."""

    tenant_id: str
    status: str
    lifecycle_version: int
    execution_kind: str
    correlation_id: str
    decided_at: datetime

    def __post_init__(self) -> None:
        """Reject direct construction that would manufacture an invalid admission decision."""
        utc_offset = self.decided_at.utcoffset() if type(self.decided_at) is datetime else None
        if (
            _safe_identifier(self.tenant_id) != self.tenant_id
            or type(self.status) is not str
            or self.status != "active"
            or not _is_positive_integer(self.lifecycle_version)
            or type(self.execution_kind) is not str
            or _normalize_execution_kind(self.execution_kind) != self.execution_kind
            or _safe_identifier(self.correlation_id) != self.correlation_id
            or utc_offset != timedelta(0)
        ):
            raise ValueError("Invalid tenant lifecycle decision")


class TenantLifecycleDenied(RuntimeError):
    """Expose one immutable stable denial code plus allowlisted correlation evidence."""

    __slots__ = ("_code", "_evidence")

    def __init__(
        self,
        code: str,
        evidence: Mapping[str, str | None],
    ) -> None:
        """Freeze safe denial evidence; no raw cause or tenant metadata is retained."""
        try:
            evidence_keys = frozenset(evidence)
            tenant_id = evidence["tenant_id"]
            execution_kind = evidence["execution_kind"]
            correlation_id = evidence["correlation_id"]
        except (KeyError, TypeError):
            raise ValueError("Invalid tenant lifecycle denial") from None
        invalid_evidence = (
            code not in _DENIAL_CODES
            or evidence_keys != _DENIAL_EVIDENCE_KEYS
            or (tenant_id is not None and _safe_identifier(tenant_id) != tenant_id)
            or (
                execution_kind is not None
                and _normalize_execution_kind(execution_kind) != execution_kind
            )
            or (correlation_id is not None and _safe_identifier(correlation_id) != correlation_id)
            or (code == "TENANT_NOT_FOUND" and tenant_id is not None)
            or (
                code in {"TENANT_SUSPENDED", "TENANT_NOT_FOUND"}
                and (execution_kind is None or correlation_id is None)
            )
            or (code == "TENANT_SUSPENDED" and tenant_id is None)
        )
        if invalid_evidence:
            raise ValueError("Invalid tenant lifecycle denial")
        super().__init__(code)
        object.__setattr__(self, "_code", code)
        object.__setattr__(self, "_evidence", MappingProxyType(dict(evidence)))

    def __setattr__(self, _name: str, _value: object) -> NoReturn:
        """Freeze business evidence while allowing Python to maintain exception metadata."""
        if _name in _EXCEPTION_RUNTIME_ATTRIBUTES:
            super().__setattr__(_name, _value)
            return
        if _name in {"_code", "_evidence"}:
            raise AttributeError("TenantLifecycleDenied is immutable")
        raise AttributeError("TenantLifecycleDenied is immutable")

    @property
    def code(self) -> str:
        """Return the stable machine denial code without exposing diagnostic causes."""
        return self._code

    @property
    def evidence(self) -> Mapping[str, str | None]:
        """Return read-only allowlisted identity and correlation evidence."""
        return self._evidence


def _safe_identifier(value: object) -> str | None:
    """Accept one bounded identifier shape or return null without echoing malformed content."""
    if type(value) is not str or _SAFE_IDENTIFIER.fullmatch(value) is None:
        return None
    return value


def _normalize_execution_kind(value: object) -> str | None:
    """Normalize a registered execution enum or exact registered string without accepting raw labels."""
    if isinstance(value, TenantExecutionKind):
        return value.value
    if type(value) is not str:
        return None
    try:
        return TenantExecutionKind(value).value
    except ValueError:
        return None


def _is_positive_integer(value: object) -> bool:
    """Recognize strict positive integers while excluding booleans and numeric coercions."""
    return type(value) is int and value > 0


def _deny_lifecycle(
    *,
    code: str,
    event_code: str,
    exception_tenant_id: str | None,
    signal_tenant_id: str | None,
    execution_kind: str | None,
    correlation_id: str | None,
) -> NoReturn:
    """Emit one non-persistent safe denial signal, then raise the immutable denial contract."""
    signal_evidence = {
        "tenant_id": signal_tenant_id,
        "execution_kind": execution_kind,
        "correlation_id": correlation_id,
    }
    logger.warning(
        event_code,
        extra={
            "event_code": event_code,
            "lifecycle_evidence": signal_evidence,
        },
    )
    raise TenantLifecycleDenied(
        code,
        {
            "tenant_id": exception_tenant_id,
            "execution_kind": execution_kind,
            "correlation_id": correlation_id,
        },
    )


def require_active_tenant(
    db: Session,
    tenant_id: str,
    execution_kind: TenantExecutionKind | str,
    correlation_id: str,
) -> TenantLifecycleDecision:
    """Load authoritative tenant state and allow only exact active state with a positive version."""
    safe_tenant_id = _safe_identifier(tenant_id)
    safe_execution_kind = _normalize_execution_kind(execution_kind)
    safe_correlation_id = _safe_identifier(correlation_id)

    # Reject malformed boundary inputs before they can reach the database or diagnostic output.
    if safe_tenant_id is None or safe_execution_kind is None or safe_correlation_id is None:
        _deny_lifecycle(
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            event_code="tenant.lifecycle.check.failed",
            exception_tenant_id=safe_tenant_id,
            signal_tenant_id=safe_tenant_id,
            execution_kind=safe_execution_kind,
            correlation_id=safe_correlation_id,
        )

    # Establish all state used by the decision from one authoritative read and fail closed on errors.
    authoritative_read_failed = False
    try:
        tenant = db.get(Tenant, safe_tenant_id)
        if tenant is not None:
            loaded_tenant_id = tenant.id
            status = tenant.status
            lifecycle_version = tenant.lifecycle_version
    except Exception:  # noqa: BLE001
        # Leave the exception handler before denial so the safe exception retains no raw context.
        authoritative_read_failed = True

    # Every ORM/storage failure denies after Python has cleared the active raw exception context.
    if authoritative_read_failed:
        _deny_lifecycle(
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            event_code="tenant.lifecycle.check.failed",
            exception_tenant_id=safe_tenant_id,
            signal_tenant_id=safe_tenant_id,
            execution_kind=safe_execution_kind,
            correlation_id=safe_correlation_id,
        )

    # A missing row uses the requested ID only for the internal signal, not exception evidence.
    if tenant is None:
        _deny_lifecycle(
            code="TENANT_NOT_FOUND",
            event_code="tenant.lifecycle.check.failed",
            exception_tenant_id=None,
            signal_tenant_id=safe_tenant_id,
            execution_kind=safe_execution_kind,
            correlation_id=safe_correlation_id,
        )

    # Corrupt identity, status, or lifecycle state must not be normalized into an executable tenant.
    if (
        loaded_tenant_id != safe_tenant_id
        or type(status) is not str
        or status not in {"active", "suspended"}
        or not _is_positive_integer(lifecycle_version)
    ):
        _deny_lifecycle(
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            event_code="tenant.lifecycle.check.failed",
            exception_tenant_id=safe_tenant_id,
            signal_tenant_id=safe_tenant_id,
            execution_kind=safe_execution_kind,
            correlation_id=safe_correlation_id,
        )

    # A valid suspended state has its dedicated stable denial projection.
    if status == "suspended":
        _deny_lifecycle(
            code="TENANT_SUSPENDED",
            event_code="tenant.lifecycle.suspended",
            exception_tenant_id=safe_tenant_id,
            signal_tenant_id=safe_tenant_id,
            execution_kind=safe_execution_kind,
            correlation_id=safe_correlation_id,
        )

    return TenantLifecycleDecision(
        tenant_id=safe_tenant_id,
        status=status,
        lifecycle_version=lifecycle_version,
        execution_kind=safe_execution_kind,
        correlation_id=safe_correlation_id,
        decided_at=datetime.now(UTC),
    )


def require_matching_admission_version(
    decision: TenantLifecycleDecision,
    persisted_lifecycle_version: object,
) -> TenantLifecycleDecision:
    """Retain admission only when durable work holds the exact strict positive decision version."""
    if (
        not _is_positive_integer(persisted_lifecycle_version)
        or persisted_lifecycle_version != decision.lifecycle_version
    ):
        _deny_lifecycle(
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            event_code="tenant.lifecycle.check.failed",
            exception_tenant_id=decision.tenant_id,
            signal_tenant_id=decision.tenant_id,
            execution_kind=decision.execution_kind,
            correlation_id=decision.correlation_id,
        )
    return decision


def ensure_tenant(session: Session, tenant_id: str) -> Tenant:
    """Load a tenant or return its safe identifier-bearing not-found contract."""
    tenant = session.get(Tenant, tenant_id)
    if not tenant:
        raise build_http_exception("TENANT_NOT_FOUND", params={"tenant_id": tenant_id})
    return tenant

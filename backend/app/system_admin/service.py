"""Transactional application services for the installation-scoped control plane."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from uuid import uuid4

from sqlalchemy import Engine, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import get_settings
from app.db.models import SystemAdmin, SystemControlAudit, Tenant, User, new_id, utc_now
from app.db.tenant_template import seed_default_tenant_template
from app.security import system_admin_auth
from app.security.auth import hash_password, verify_password
from app.security.password_policy import (
    SYSTEM_POLICY_SCOPE,
    TENANT_DEFAULT_POLICY_SCOPE,
    effective_tenant_policy,
    installation_policy,
    validate_password,
)

logger = logging.getLogger(__name__)

SYSTEM_ADMIN_STATUS = Literal["active", "disabled"]
TENANT_STATUS = Literal["active", "suspended"]


class InvalidControlInputError(ValueError):
    """Signal a control request that cannot be represented safely in the data model."""


class SystemAdminNotFoundError(LookupError):
    """Signal that a local password-recovery target does not exist."""


class InvalidSystemCredentialsError(ValueError):
    """Signal one generic system-login credential rejection."""


class TenantProvisionConflictError(ValueError):
    """Signal that an immutable tenant slug is already allocated."""

    def __init__(self, tenant_id: str | None = None) -> None:
        """Retain only the safe conflicting tenant identifier for audit targeting."""
        super().__init__("tenant slug is already allocated")
        self.tenant_id = tenant_id


class TenantNotFoundError(LookupError):
    """Signal that a system control target tenant does not exist."""

    def __init__(self, tenant_id: str) -> None:
        """Retain the target ID for a registered, non-secret API error projection."""
        super().__init__("tenant control target not found")
        self.tenant_id = tenant_id


class InitialTenantAdminNotFoundError(LookupError):
    """Signal that a tenant's initial administrator pointer cannot be resolved safely."""

    def __init__(self, tenant_id: str) -> None:
        """Retain only the tenant identity needed by the control-plane error boundary."""
        super().__init__("tenant initial administrator not found")
        self.tenant_id = tenant_id


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    """Describe whether this local operator won the first-administrator race."""

    admin_id: str
    username: str
    created: bool


@dataclass(frozen=True, slots=True)
class PasswordResetResult:
    """Identify the administrator whose local credential was rotated."""

    admin_id: str
    username: str


@dataclass(frozen=True, slots=True)
class SystemAdminIdentity:
    """Carry the safe post-login identity and dedicated token across the API boundary."""

    token: str
    admin_id: str
    username: str
    display_name: str | None
    status: SYSTEM_ADMIN_STATUS
    must_change_password: bool
    last_login_at: datetime
    created_at: datetime


@dataclass(frozen=True, slots=True)
class TenantProvisionResult:
    """Identify the tenant created by one all-or-nothing provisioning transaction."""

    tenant_id: str


def _new_correlation_id(correlation_id: str | None) -> str:
    """Return a caller correlation ID or generate a non-secret local identifier."""
    if isinstance(correlation_id, str) and correlation_id.strip():
        return correlation_id.strip()
    return uuid4().hex


@contextmanager
def _control_transaction(db: Session) -> Iterator[Session]:
    """Run one control mutation on a dedicated connection with SQLite writer serialization.

    The caller's session may already hold a read transaction from authentication.  It is
    rolled back before a fresh connection starts ``BEGIN IMMEDIATE`` so the empty-check,
    identity mutation, and audit write share one database transaction.  The yielded session
    must call ``commit`` for success; all other exits roll back and close the private session.
    """
    db.rollback()
    bind = db.get_bind()
    if not isinstance(bind, Engine):
        bind = bind.engine
    connection = bind.connect()
    control = Session(bind=connection, expire_on_commit=False)
    transaction_started = False
    try:
        if connection.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        else:
            connection.begin()
        transaction_started = True
        yield control
        if control.in_transaction() and not control.info.get("control_committed"):
            control.rollback()
    except BaseException:
        if control.in_transaction() and not control.info.get("control_committed"):
            control.rollback()
        elif transaction_started and not control.info.get("control_committed"):
            connection.rollback()
        raise
    finally:
        control.close()
        connection.close()


def _commit_control(control: Session) -> None:
    """Flush a control mutation and commit its explicit database connection transaction."""
    control.flush()
    control.connection().commit()
    control.info["control_committed"] = True


def _audit_row(
    *,
    actor_system_admin_id: str | None,
    actor_label: str | None,
    action: str,
    target_type: str,
    target_id: str | None,
    result: Literal["succeeded", "rejected", "failed"],
    reason_code: str,
    request_id: str,
    status_before: str | None = None,
    status_after: str | None = None,
    lifecycle_version: int | None = None,
    operator_reason: str | None = None,
    safe_params: dict[str, str] | None = None,
) -> SystemControlAudit:
    """Build an audit row from allowlisted identity and control metadata only."""
    return SystemControlAudit(
        actor_system_admin_id=actor_system_admin_id,
        actor_label=actor_label,
        action=action,
        target_type=target_type,
        target_id=target_id,
        result=result,
        reason_code=reason_code,
        status_before=status_before,
        status_after=status_after,
        lifecycle_version=lifecycle_version,
        operator_reason=operator_reason,
        request_id=request_id,
        safe_params_json=dict(safe_params or {}),
    )


def _append_audit(
    db: Session,
    *,
    actor_system_admin_id: str | None,
    actor_label: str | None,
    action: str,
    target_type: str,
    target_id: str | None,
    result: Literal["succeeded", "rejected", "failed"],
    reason_code: str,
    request_id: str,
    status_before: str | None = None,
    status_after: str | None = None,
    lifecycle_version: int | None = None,
    safe_params: dict[str, str] | None = None,
) -> None:
    """Persist one independent audit outcome after a prior control transaction released its lock."""
    with _control_transaction(db) as control:
        control.add(
            _audit_row(
                actor_system_admin_id=actor_system_admin_id,
                actor_label=actor_label,
                action=action,
                target_type=target_type,
                target_id=target_id,
                result=result,
                reason_code=reason_code,
                request_id=request_id,
                status_before=status_before,
                status_after=status_after,
                lifecycle_version=lifecycle_version,
                safe_params=safe_params,
            )
        )
        _commit_control(control)


def _later_timestamp(previous: datetime | None) -> datetime:
    """Produce a UTC-naive timestamp strictly newer than an existing model timestamp."""
    current = utc_now()
    if previous is not None and current <= previous:
        return previous + timedelta(microseconds=1)
    return current


def bootstrap_system_admin(
    db: Session,
    *,
    correlation_id: str | None = None,
) -> BootstrapResult:
    """Create the first system administrator or record one safe rejected repeat attempt.

    This development-only operation has no credential input: it creates the explicitly approved
    ``sysadmin`` / ``sysadmin`` account in a forced-change state.  The function mutates only the
    system identity and its audit row; a database error propagates for the caller to map to a safe
    storage result, and never creates an independent partial audit.
    """
    correlation = _new_correlation_id(correlation_id)
    existing_id: str | None = None
    existing_username: str | None = None
    with _control_transaction(db) as control:
        existing = control.exec(select(SystemAdmin).order_by(SystemAdmin.id)).first()
        if existing is not None:
            existing_id = existing.id
            existing_username = existing.username
        else:
            admin = SystemAdmin(
                username="sysadmin",
                password_hash=hash_password("sysadmin"),
                status="active",
                auth_version=1,
                must_change_password=True,
                password_changed_at=None,
            )
            control.add(admin)
            control.flush()
            control.add(
                _audit_row(
                    actor_system_admin_id=None,
                    actor_label="local-operator",
                    action="system_admin.bootstrap",
                    target_type="system_admin",
                    target_id=admin.id,
                    result="succeeded",
                    reason_code="SYSTEM_BOOTSTRAP_SUCCEEDED",
                    request_id=correlation,
                    status_after=admin.status,
                )
            )
            _commit_control(control)
            return BootstrapResult(admin_id=admin.id, username=admin.username, created=True)

    assert existing_id is not None
    assert existing_username is not None
    _append_audit(
        db,
        actor_system_admin_id=None,
        actor_label="local-operator",
        action="system_admin.bootstrap",
        target_type="system_admin",
        target_id=existing_id,
        result="rejected",
        reason_code="SYSTEM_BOOTSTRAP_ALREADY_COMPLETE",
        request_id=correlation,
        status_after="active",
    )
    return BootstrapResult(admin_id=existing_id, username=existing_username, created=False)


def reset_system_admin_password(
    db: Session,
    *,
    username: str,
    password_hash: str,
    correlation_id: str | None = None,
) -> PasswordResetResult:
    """Rotate one local system administrator credential and its authentication version atomically."""
    correlation = _new_correlation_id(correlation_id)
    normalized_username = username.strip() if isinstance(username, str) else ""
    if not normalized_username or len(normalized_username) > 120 or not password_hash:
        raise InvalidControlInputError("invalid system administrator password reset input")

    missing = False
    result: PasswordResetResult | None = None
    with _control_transaction(db) as control:
        admin = control.exec(
            select(SystemAdmin).where(SystemAdmin.username == normalized_username)
        ).first()
        if admin is None:
            missing = True
        else:
            admin.password_hash = password_hash
            admin.auth_version += 1
            admin.updated_at = _later_timestamp(admin.updated_at)
            control.add(admin)
            control.flush()
            control.add(
                _audit_row(
                    actor_system_admin_id=None,
                    actor_label="local-operator",
                    action="system_admin.local_password_reset",
                    target_type="system_admin",
                    target_id=admin.id,
                    result="succeeded",
                    reason_code="SYSTEM_ADMIN_PASSWORD_RESET_SUCCEEDED",
                    request_id=correlation,
                    status_before="active" if admin.status == "active" else "disabled",
                    status_after=admin.status,
                )
            )
            _commit_control(control)
            result = PasswordResetResult(admin_id=admin.id, username=admin.username)
    if missing:
        raise SystemAdminNotFoundError("system administrator not found")
    assert result is not None
    return result


def authenticate_system_admin(
    db: Session,
    *,
    username: str,
    password: str,
    correlation_id: str | None = None,
) -> SystemAdminIdentity:
    """Verify one system credential, audit exactly one outcome, and issue a system token.

    Username whitespace is insignificant, while the password is passed byte-for-byte to the
    password verifier.  The signer is invoked before the login mutation so an unavailable
    system secret cannot update ``last_login_at`` without issuing a usable token.
    """
    correlation = _new_correlation_id(correlation_id)
    normalized_username = username.strip() if isinstance(username, str) else ""
    invalid = False
    result: SystemAdminIdentity | None = None
    try:
        with _control_transaction(db) as control:
            admin = control.exec(
                select(SystemAdmin).where(SystemAdmin.username == normalized_username)
            ).first()
            if (
                admin is None
                or admin.status != "active"
                or not verify_password(password, admin.password_hash)
            ):
                invalid = True
            else:
                token = system_admin_auth.create_system_access_token(admin)
                login_time = _later_timestamp(admin.last_login_at)
                admin.last_login_at = login_time
                admin.updated_at = _later_timestamp(admin.updated_at)
                control.add(admin)
                control.flush()
                control.add(
                    _audit_row(
                        actor_system_admin_id=admin.id,
                        actor_label=None,
                        action="system_admin.login",
                        target_type="system_admin",
                        target_id=admin.id,
                        result="succeeded",
                        reason_code="SYSTEM_AUTH_SUCCEEDED",
                        request_id=correlation,
                        status_before=admin.status,
                        status_after=admin.status,
                    )
                )
                _commit_control(control)
                result = SystemAdminIdentity(
                    token=token,
                    admin_id=admin.id,
                    username=admin.username,
                    display_name=admin.display_name,
                    status="active",
                    must_change_password=admin.must_change_password,
                    last_login_at=login_time,
                    created_at=admin.created_at,
                )
    except system_admin_auth.SystemAuthUnavailable:
        # The signer may fail after credentials were verified.  Keep that original 503
        # semantics while recording a separate, secret-free rejected login if possible.
        try:
            _append_audit(
                db,
                actor_system_admin_id=None,
                actor_label=None,
                action="system_admin.login",
                target_type="system_admin",
                target_id=None,
                result="rejected",
                reason_code="SYSTEM_AUTH_UNAVAILABLE",
                request_id=correlation,
            )
        except Exception as audit_exc:  # noqa: BLE001 - preserve the signer failure contract.
            logger.error(
                "system login rejection audit failed exception_type=%s correlation_id=%s",
                type(audit_exc).__name__,
                correlation,
            )
        raise
    if invalid:
        try:
            _append_audit(
                db,
                actor_system_admin_id=None,
                actor_label=None,
                action="system_admin.login",
                target_type="system_admin",
                target_id=None,
                result="rejected",
                reason_code="SYSTEM_AUTH_INVALID_CREDENTIALS",
                request_id=correlation,
            )
        except Exception as audit_exc:  # noqa: BLE001 - preserve the generic auth denial.
            logger.error(
                "system login rejection audit failed exception_type=%s correlation_id=%s",
                type(audit_exc).__name__,
                correlation,
            )
        raise InvalidSystemCredentialsError("invalid system credentials")
    assert result is not None
    return result


def change_system_admin_password(
    db: Session,
    *,
    admin_id: str,
    current_password: str,
    new_password: str,
    correlation_id: str | None = None,
) -> SystemAdminIdentity:
    """Replace one system administrator password under the effective policy and rotate its token."""
    correlation = _new_correlation_id(correlation_id)
    if not isinstance(current_password, str) or not isinstance(new_password, str):
        raise InvalidControlInputError("invalid system administrator password change input")
    result: SystemAdminIdentity | None = None
    with _control_transaction(db) as control:
        admin = control.get(SystemAdmin, admin_id)
        if admin is None or not verify_password(current_password, admin.password_hash):
            raise InvalidSystemCredentialsError("invalid system credentials")
        if not validate_password(new_password, installation_policy(control, SYSTEM_POLICY_SCOPE)):
            raise InvalidControlInputError("new system password violates policy")
        admin.password_hash = hash_password(new_password)
        admin.must_change_password = False
        admin.password_changed_at = utc_now()
        admin.auth_version += 1
        admin.updated_at = _later_timestamp(admin.updated_at)
        control.add(admin)
        control.flush()
        token = system_admin_auth.create_system_access_token(admin)
        control.add(
            _audit_row(
                actor_system_admin_id=admin.id,
                actor_label=None,
                action="system_admin.password_change",
                target_type="system_admin",
                target_id=admin.id,
                result="succeeded",
                reason_code="SYSTEM_ADMIN_PASSWORD_CHANGED",
                request_id=correlation,
                status_before=admin.status,
                status_after=admin.status,
            )
        )
        _commit_control(control)
        result = SystemAdminIdentity(
            token=token,
            admin_id=admin.id,
            username=admin.username,
            display_name=admin.display_name,
            status=admin.status,
            must_change_password=False,
            last_login_at=admin.last_login_at or utc_now(),
            created_at=admin.created_at,
        )
    assert result is not None
    return result


def list_tenants(
    db: Session,
    *,
    query: str | None = None,
    status: TENANT_STATUS | None = None,
    cursor: str | None = None,
    limit: int = 25,
) -> tuple[list[Tenant], str | None]:
    """Read a bounded tenant-control page using tenant and initial-admin metadata only."""
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise InvalidControlInputError("tenant list limit is outside the allowed range")
    offset = 0
    if cursor:
        if not cursor.isdigit():
            raise InvalidControlInputError("tenant list cursor is invalid")
        offset = int(cursor)
        if offset < 0:
            raise InvalidControlInputError("tenant list cursor is invalid")

    statement = select(Tenant)
    normalized_query = query.strip() if isinstance(query, str) else ""
    if normalized_query:
        pattern = f"%{normalized_query}%"
        initial_admin_match = select(User.id).where(
            User.id == Tenant.initial_admin_user_id,
            User.tenant_id == Tenant.id,
            User.role == "admin",
            or_(User.username.ilike(pattern), User.display_name.ilike(pattern)),
        ).exists()
        statement = statement.where(
            or_(
                Tenant.slug.ilike(pattern),
                Tenant.name.ilike(pattern),
                initial_admin_match,
            )
        )
    if status is not None:
        statement = statement.where(Tenant.status == status)
    rows = db.exec(
        statement.order_by(Tenant.created_at, Tenant.id).offset(offset).limit(limit + 1)
    ).all()
    next_cursor = str(offset + limit) if len(rows) > limit else None
    return rows[:limit], next_cursor


def rename_tenant(
    db: Session,
    *,
    actor_system_admin_id: str,
    tenant_id: str,
    display_name: str,
    correlation_id: str | None = None,
) -> Tenant:
    """Rename only a tenant's display name while preserving its ID, slug, and admin pointer."""
    correlation = _new_correlation_id(correlation_id)
    normalized_display_name = display_name.strip() if isinstance(display_name, str) else ""
    if not normalized_display_name or len(normalized_display_name) > 120:
        raise InvalidControlInputError("invalid tenant rename input")

    missing = False
    result: Tenant | None = None
    with _control_transaction(db) as control:
        tenant = control.get(Tenant, tenant_id)
        if tenant is None:
            missing = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.rename",
                    target_type="tenant",
                    target_id=tenant_id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_NOT_FOUND",
                    request_id=correlation,
                )
            )
            _commit_control(control)
        else:
            old_display_name = tenant.name
            tenant.name = normalized_display_name
            tenant.updated_at = _later_timestamp(tenant.updated_at)
            control.add(tenant)
            control.flush()
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.rename",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_RENAMED",
                    request_id=correlation,
                    status_before=tenant.status,
                    status_after=tenant.status,
                    lifecycle_version=tenant.lifecycle_version,
                    safe_params={
                        "old_display_name": old_display_name,
                        "new_display_name": normalized_display_name,
                    },
                )
            )
            _commit_control(control)
            result = tenant
    if missing:
        raise TenantNotFoundError(tenant_id)
    assert result is not None
    return result


def suspend_tenant(
    db: Session,
    *,
    actor_system_admin_id: str,
    tenant_id: str,
    reason: str,
    correlation_id: str | None = None,
) -> Tenant:
    """Suspend one active tenant and append exactly one atomic control audit.

    The reason is trimmed and bounded before it is stored as operator evidence.  Repeating a
    suspend request for an already suspended tenant returns its committed state without changing
    the lifecycle version, timestamp, or reason; it still records one successful idempotent audit.
    Missing tenants, invalid lifecycle rows, and invalid reasons are rejected inside the same
    writer transaction as their safe audit so a failed transition cannot leave partial state.
    """
    correlation = _new_correlation_id(correlation_id)
    normalized_reason = reason.strip() if isinstance(reason, str) else ""
    missing = False
    invalid = False
    result: Tenant | None = None

    with _control_transaction(db) as control:
        tenant = control.get(Tenant, tenant_id)
        if tenant is None:
            missing = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant_id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_NOT_FOUND",
                    request_id=correlation,
                )
            )
        elif not normalized_reason or len(normalized_reason) > 500:
            invalid = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="rejected",
                    reason_code="VALIDATION_ERROR",
                    request_id=correlation,
                    status_before=tenant.status,
                    lifecycle_version=(
                        tenant.lifecycle_version
                        if isinstance(tenant.lifecycle_version, int)
                        and not isinstance(tenant.lifecycle_version, bool)
                        and tenant.lifecycle_version > 0
                        else None
                    ),
                )
            )
        elif tenant.status == "suspended" and not _valid_suspended_tenant(tenant):
            invalid = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_INVALID_STATE",
                    request_id=correlation,
                    status_before="suspended",
                    lifecycle_version=(
                        tenant.lifecycle_version
                        if _valid_lifecycle_version(tenant.lifecycle_version)
                        else None
                    ),
                )
            )
        elif tenant.status == "suspended":
            # An idempotent replay must not replace the reason originally committed by the
            # first transition, even if the retried request carries different operator text.
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_SUSPEND_IDEMPOTENT",
                    request_id=correlation,
                    status_before=tenant.status,
                    status_after=tenant.status,
                    lifecycle_version=tenant.lifecycle_version,
                    operator_reason=tenant.suspension_reason,
                )
            )
            _commit_control(control)
            result = tenant
        elif tenant.status != "active" or not _valid_lifecycle_version(tenant.lifecycle_version):
            invalid = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_INVALID_STATE",
                    request_id=correlation,
                    status_before=tenant.status
                    if tenant.status in {"active", "suspended"}
                    else None,
                    lifecycle_version=(
                        tenant.lifecycle_version
                        if _valid_lifecycle_version(tenant.lifecycle_version)
                        else None
                    ),
                )
            )
        else:
            suspended_at = _later_timestamp(tenant.suspended_at)
            tenant.status = "suspended"
            tenant.lifecycle_version += 1
            tenant.suspended_at = suspended_at
            tenant.suspension_reason = normalized_reason
            tenant.updated_at = _later_timestamp(tenant.updated_at)
            control.add(tenant)
            control.flush()
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.suspend",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_SUSPENDED",
                    request_id=correlation,
                    status_before="active",
                    status_after=tenant.status,
                    lifecycle_version=tenant.lifecycle_version,
                    operator_reason=normalized_reason,
                )
            )
            _commit_control(control)
            result = tenant

        if not control.info.get("control_committed"):
            _commit_control(control)

    if missing:
        raise TenantNotFoundError(tenant_id)
    if invalid:
        raise InvalidControlInputError("invalid tenant suspension request")
    assert result is not None
    return result


def reactivate_tenant(
    db: Session,
    *,
    actor_system_admin_id: str,
    tenant_id: str,
    correlation_id: str | None = None,
) -> Tenant:
    """Reactivate one suspended tenant and append exactly one atomic control audit.

    A successful suspended-to-active transition increments the lifecycle fence once, records a
    monotonic reactivation timestamp, and clears only the current suspension reason.  Repeating
    the active target is a no-op with one idempotent audit, while missing or malformed lifecycle
    rows are rejected without mutating tenant data.
    """
    correlation = _new_correlation_id(correlation_id)
    missing = False
    invalid = False
    result: Tenant | None = None

    with _control_transaction(db) as control:
        tenant = control.get(Tenant, tenant_id)
        if tenant is None:
            missing = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.reactivate",
                    target_type="tenant",
                    target_id=tenant_id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_NOT_FOUND",
                    request_id=correlation,
                )
            )
        elif tenant.status == "active" and _valid_lifecycle_version(tenant.lifecycle_version):
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.reactivate",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_REACTIVATE_IDEMPOTENT",
                    request_id=correlation,
                    status_before=tenant.status,
                    status_after=tenant.status,
                    lifecycle_version=tenant.lifecycle_version,
                )
            )
            _commit_control(control)
            result = tenant
        elif (
            tenant.status != "suspended"
            or not _valid_suspended_tenant(tenant)
        ):
            invalid = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.reactivate",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_INVALID_STATE",
                    request_id=correlation,
                    status_before=tenant.status
                    if tenant.status in {"active", "suspended"}
                    else None,
                    lifecycle_version=(
                        tenant.lifecycle_version
                        if _valid_lifecycle_version(tenant.lifecycle_version)
                        else None
                    ),
                )
            )
        else:
            tenant.status = "active"
            tenant.lifecycle_version += 1
            tenant.reactivated_at = _later_timestamp(tenant.reactivated_at)
            tenant.suspension_reason = None
            tenant.updated_at = _later_timestamp(tenant.updated_at)
            control.add(tenant)
            control.flush()
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.reactivate",
                    target_type="tenant",
                    target_id=tenant.id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_REACTIVATED",
                    request_id=correlation,
                    status_before="suspended",
                    status_after=tenant.status,
                    lifecycle_version=tenant.lifecycle_version,
                )
            )
            _commit_control(control)
            result = tenant

        if not control.info.get("control_committed"):
            _commit_control(control)

    if missing:
        raise TenantNotFoundError(tenant_id)
    if invalid:
        raise InvalidControlInputError("invalid tenant reactivation request")
    assert result is not None
    return result


def _valid_lifecycle_version(version: object) -> bool:
    """Return whether a persisted tenant lifecycle fence is a strict positive integer."""
    return isinstance(version, int) and not isinstance(version, bool) and version > 0


def _valid_suspended_tenant(tenant: Tenant) -> bool:
    """Require every metadata field that makes a persisted suspended state auditable."""
    reason = tenant.suspension_reason
    return (
        _valid_lifecycle_version(tenant.lifecycle_version)
        and isinstance(reason, str)
        and bool(reason.strip())
        and len(reason.strip()) <= 500
        and isinstance(tenant.suspended_at, datetime)
    )


def reset_initial_tenant_admin_password(
    db: Session,
    *,
    actor_system_admin_id: str,
    tenant_id: str,
    temporary_password: str,
    correlation_id: str | None = None,
) -> None:
    """Rotate a tenant's pointed initial-admin credential and invalidate every prior session."""
    correlation = _new_correlation_id(correlation_id)
    if not isinstance(temporary_password, str):
        raise InvalidControlInputError("invalid initial administrator password reset input")

    missing_tenant = False
    missing_admin = False
    with _control_transaction(db) as control:
        if not validate_password(
            temporary_password,
            effective_tenant_policy(control, tenant_id),
        ):
            raise InvalidControlInputError("invalid initial administrator password reset input")
        tenant = control.get(Tenant, tenant_id)
        if tenant is None:
            missing_tenant = True
            control.add(
                _audit_row(
                    actor_system_admin_id=actor_system_admin_id,
                    actor_label=None,
                    action="tenant.initial_admin_password_reset",
                    target_type="tenant",
                    target_id=tenant_id,
                    result="rejected",
                    reason_code="SYSTEM_TENANT_NOT_FOUND",
                    request_id=correlation,
                )
            )
            _commit_control(control)
        else:
            admin = (
                control.get(User, tenant.initial_admin_user_id)
                if tenant.initial_admin_user_id
                else None
            )
            if admin is None or admin.tenant_id != tenant.id or admin.role != "admin":
                missing_admin = True
                control.add(
                    _audit_row(
                        actor_system_admin_id=actor_system_admin_id,
                        actor_label=None,
                        action="tenant.initial_admin_password_reset",
                        target_type="tenant",
                        target_id=tenant.id,
                        result="rejected",
                        reason_code="SYSTEM_INITIAL_ADMIN_NOT_FOUND",
                        request_id=correlation,
                        status_before=tenant.status,
                        status_after=tenant.status,
                        lifecycle_version=tenant.lifecycle_version,
                    )
                )
                _commit_control(control)
            else:
                admin.password_hash = hash_password(temporary_password)
                admin.auth_version += 1
                admin.must_change_password = True
                admin.password_changed_at = utc_now()
                admin.updated_at = _later_timestamp(admin.updated_at)
                control.add(admin)
                control.flush()
                control.add(
                    _audit_row(
                        actor_system_admin_id=actor_system_admin_id,
                        actor_label=None,
                        action="tenant.initial_admin_password_reset",
                        target_type="tenant",
                        target_id=tenant.id,
                        result="succeeded",
                        reason_code="SYSTEM_INITIAL_ADMIN_PASSWORD_RESET",
                        request_id=correlation,
                        status_before=tenant.status,
                        status_after=tenant.status,
                        lifecycle_version=tenant.lifecycle_version,
                        safe_params={"initial_admin_user_id": admin.id},
                    )
                )
                _commit_control(control)
    if missing_tenant:
        raise TenantNotFoundError(tenant_id)
    if missing_admin:
        raise InitialTenantAdminNotFoundError(tenant_id)


def list_tenant_audits(
    db: Session,
    *,
    tenant_id: str,
    cursor: str | None = None,
    limit: int = 25,
) -> tuple[list[SystemControlAudit], str | None]:
    """Read a cursor-paginated, tenant-targeted audit page without payload expansion."""
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise InvalidControlInputError("tenant audit limit is outside the allowed range")
    offset = 0
    if cursor:
        if not cursor.isdigit():
            raise InvalidControlInputError("tenant audit cursor is invalid")
        offset = int(cursor)
        if offset < 0:
            raise InvalidControlInputError("tenant audit cursor is invalid")

    rows = db.exec(
        select(SystemControlAudit)
        .where(
            SystemControlAudit.target_type == "tenant",
            SystemControlAudit.target_id == tenant_id,
        )
        .order_by(SystemControlAudit.created_at, SystemControlAudit.id)
        .offset(offset)
        .limit(limit + 1)
    ).all()
    next_cursor = str(offset + limit) if len(rows) > limit else None
    return rows[:limit], next_cursor


def codex_a2a_runtime_status() -> dict[str, object]:
    """Return installation-owned Codex A2A configuration state without runtime work details."""
    settings = get_settings()
    token = getattr(settings, "codex_a2a_token", "")
    return {
        "key": "codex_a2a",
        "enabled": bool(getattr(settings, "codex_a2a_enabled", False)),
        "credential_configured": (
            isinstance(token, str) and bool(token) and token == token.strip()
        ),
        "command": str(getattr(settings, "codex_a2a_command", "codex")),
        "workspace_root": str(getattr(settings, "codex_a2a_workspace_root", "")),
        "timeout_seconds": float(getattr(settings, "codex_a2a_timeout_seconds", 1800.0)),
    }


def get_tenant(db: Session, tenant_id: str) -> Tenant | None:
    """Load one tenant control row by immutable ID without traversing tenant business tables."""
    return db.get(Tenant, tenant_id)


def record_rejected_control_attempt(
    db: Session,
    *,
    action: str,
    target_type: str,
    reason_code: str,
    correlation_id: str | None = None,
    actor_system_admin_id: str | None = None,
    target_id: str | None = None,
) -> None:
    """Persist one secret-free rejected attempt with only known actor and target metadata."""
    _append_audit(
        db,
        actor_system_admin_id=actor_system_admin_id,
        actor_label=None,
        action=action,
        target_type=target_type,
        target_id=target_id,
        result="rejected",
        reason_code=reason_code,
        request_id=_new_correlation_id(correlation_id),
    )


def provision_tenant(
    db: Session,
    *,
    actor_system_admin_id: str,
    slug: str,
    display_name: str,
    initial_admin_username: str,
    initial_admin_display_name: str | None,
    temporary_password: str,
    correlation_id: str | None = None,
) -> TenantProvisionResult:
    """Create one active tenant, one tenant-local administrator, its pointer, and one audit atomically."""
    correlation = _new_correlation_id(correlation_id)
    normalized_slug = slug if isinstance(slug, str) else ""
    normalized_display_name = display_name.strip() if isinstance(display_name, str) else ""
    normalized_username = (
        initial_admin_username.strip() if isinstance(initial_admin_username, str) else ""
    )
    normalized_admin_name = (
        initial_admin_display_name.strip()
        if isinstance(initial_admin_display_name, str) and initial_admin_display_name.strip()
        else None
    )
    if (
        not normalized_slug
        or not normalized_display_name
        or not normalized_username
        or len(normalized_display_name) > 120
        or len(normalized_username) > 120
        or not isinstance(temporary_password, str)
    ):
        raise InvalidControlInputError("invalid tenant provisioning input")

    conflict_id: str | None = None
    try:
        with _control_transaction(db) as control:
            if not validate_password(
                temporary_password,
                installation_policy(control, TENANT_DEFAULT_POLICY_SCOPE),
            ):
                raise InvalidControlInputError("invalid tenant provisioning input")
            existing = control.exec(select(Tenant).where(Tenant.slug == normalized_slug)).first()
            if existing is not None:
                conflict_id = existing.id
            else:
                tenant = Tenant(
                    id=new_id("tenant"),
                    slug=normalized_slug,
                    name=normalized_display_name,
                    status="active",
                    lifecycle_version=1,
                )
                initial_admin = User(
                    tenant_id=tenant.id,
                    username=normalized_username,
                    display_name=normalized_admin_name,
                    role="admin",
                    password_hash=hash_password(temporary_password),
                    must_change_password=True,
                    auth_version=1,
                )
                control.add(tenant)
                control.flush()
                control.add(initial_admin)
                control.flush()
                seed_default_tenant_template(control, tenant.id, initial_admin)
                tenant.initial_admin_user_id = initial_admin.id
                tenant.updated_at = _later_timestamp(tenant.updated_at)
                control.add(tenant)
                control.flush()
                control.add(
                    _audit_row(
                        actor_system_admin_id=actor_system_admin_id,
                        actor_label=None,
                        action="tenant.provision",
                        target_type="tenant",
                        target_id=tenant.id,
                        result="succeeded",
                        reason_code="SYSTEM_TENANT_PROVISIONED",
                        request_id=correlation,
                        status_after=tenant.status,
                        lifecycle_version=tenant.lifecycle_version,
                        safe_params={
                            "slug": tenant.slug,
                            "display_name": tenant.name,
                        },
                    )
                )
                _commit_control(control)
                return TenantProvisionResult(tenant_id=tenant.id)
    except IntegrityError:
        db.rollback()
        existing = db.exec(select(Tenant).where(Tenant.slug == normalized_slug)).first()
        conflict_id = existing.id if existing is not None else None
        if conflict_id is None:
            raise

    _append_audit(
        db,
        actor_system_admin_id=actor_system_admin_id,
        actor_label=None,
        action="tenant.provision",
        target_type="tenant",
        target_id=conflict_id,
        result="rejected",
        reason_code="SYSTEM_CONTROL_CONFLICT",
        request_id=correlation,
        safe_params={
            "slug": normalized_slug,
            "display_name": normalized_display_name,
        },
    )
    raise TenantProvisionConflictError(conflict_id)


__all__ = [
    "BootstrapResult",
    "InitialTenantAdminNotFoundError",
    "InvalidControlInputError",
    "InvalidSystemCredentialsError",
    "PasswordResetResult",
    "SystemAdminIdentity",
    "SystemAdminNotFoundError",
    "TenantNotFoundError",
    "TenantProvisionConflictError",
    "TenantProvisionResult",
    "authenticate_system_admin",
    "bootstrap_system_admin",
    "change_system_admin_password",
    "codex_a2a_runtime_status",
    "get_tenant",
    "list_tenant_audits",
    "list_tenants",
    "provision_tenant",
    "record_rejected_control_attempt",
    "rename_tenant",
    "reset_initial_tenant_admin_password",
    "reset_system_admin_password",
]

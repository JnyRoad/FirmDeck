"""Dedicated system-authenticated routes for installation tenant control metadata."""

from __future__ import annotations

import inspect
import logging
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import InternalErrorContext
from app.contracts.http import build_http_exception
from app.db import get_session
from app.db.models import SystemAdmin, Tenant, TenantPasswordPolicy, User
from app.security import system_admin_auth
from app.security.password_policy import (
    SYSTEM_POLICY_SCOPE,
    TENANT_DEFAULT_POLICY_SCOPE,
    PasswordPolicy,
    effective_tenant_policy,
    installation_policy,
    policy_from_values,
    save_installation_policy,
    save_tenant_policy,
)
from app.system_admin import schema
from app.system_admin.service import (
    InitialTenantAdminNotFoundError,
    InvalidControlInputError,
    InvalidSystemCredentialsError,
    SystemAdminIdentity,
    TenantNotFoundError,
    TenantProvisionConflictError,
    authenticate_system_admin,
    change_system_admin_password,
    codex_a2a_runtime_status,
    get_tenant,
    list_tenant_audits,
    list_tenants,
    provision_tenant,
    reactivate_tenant,
    record_rejected_control_attempt,
    rename_tenant,
    reset_initial_tenant_admin_password,
    suspend_tenant,
)

logger = logging.getLogger(__name__)

_AUDIT_SAFE_PARAM_ALLOWLIST: dict[str, frozenset[str]] = {
    "tenant.provision": frozenset({"slug", "display_name"}),
    "tenant.rename": frozenset(
        {"display_name", "old_display_name", "new_display_name", "display_name_changed"}
    ),
    "tenant.initial_admin.reset": frozenset(
        {"initial_admin_user_id", "sessions_invalidated"}
    ),
    "tenant.initial_admin_password_reset": frozenset(
        {"initial_admin_user_id", "sessions_invalidated"}
    ),
    "tenant.suspend": frozenset(),
    "tenant.reactivate": frozenset(),
}

_SYSTEM_CONTROL_AUDIT_CONTEXTS: dict[tuple[str, str], tuple[str, str]] = {
    ("POST", "/api/system/auth/login"): ("system_admin.login", "system_admin"),
    ("GET", "/api/system/auth/me"): ("system_admin.me", "system_admin"),
    ("GET", "/api/system/tenants"): ("tenant.list", "tenant"),
    ("POST", "/api/system/tenants"): ("tenant.provision", "tenant"),
    ("GET", "/api/system/tenants/{tenant_id}"): ("tenant.detail", "tenant"),
    ("PATCH", "/api/system/tenants/{tenant_id}"): ("tenant.rename", "tenant"),
    (
        "POST",
        "/api/system/tenants/{tenant_id}/initial-admin/temporary-password",
    ): ("tenant.initial_admin_password_reset", "tenant"),
    ("POST", "/api/system/tenants/{tenant_id}/suspend"): ("tenant.suspend", "tenant"),
    ("POST", "/api/system/tenants/{tenant_id}/reactivate"): (
        "tenant.reactivate",
        "tenant",
    ),
    ("GET", "/api/system/tenants/{tenant_id}/audit"): ("tenant.audit", "tenant"),
    ("GET", "/api/system/runtimes/codex-a2a"): ("system.runtime.codex_a2a", "system_admin"),
}
_SAFE_SYSTEM_AUTH_CODES = frozenset(
    {"SYSTEM_AUTH_INVALID_CREDENTIALS", "SYSTEM_AUTH_UNAVAILABLE"}
)


class _SafeSystemRoute(APIRoute):
    """Keep request-validation inputs out of privileged control-plane responses."""

    def get_route_handler(self):
        route_handler = super().get_route_handler()

        async def safe_route_handler(request: Request):
            try:
                return await route_handler(request)
            except RequestValidationError as exc:
                request_id = await _audit_request_validation(request)
                raise build_http_exception(
                    "VALIDATION_ERROR",
                    params={"error_count": max(1, len(exc.errors()))},
                    status_code=400,
                    request_id=request_id,
                ) from None

        return safe_route_handler


router = APIRouter(
    prefix="/api/system",
    tags=["system-admin"],
    route_class=_SafeSystemRoute,
)


def _correlation_id() -> str:
    """Create a fresh request correlation identifier without incorporating request data."""
    return uuid4().hex


def _system_control_context(request: Request) -> tuple[str, str, str | None]:
    """Return an allowlisted audit action and bounded target from the matched route."""
    route = request.scope.get("route")
    route_path = getattr(route, "path", "")
    action, target_type = _SYSTEM_CONTROL_AUDIT_CONTEXTS.get(
        (request.method.upper(), route_path),
        ("system.control.request", "system_admin"),
    )
    target_id = request.path_params.get("tenant_id") if target_type == "tenant" else None
    if not isinstance(target_id, str) or not target_id.strip() or len(target_id) > 120:
        target_id = None
    return action, target_type, target_id


def _record_control_rejection(
    request: Request,
    db: Session,
    *,
    reason_code: str,
    actor_system_admin_id: str | None = None,
    correlation_id: str | None = None,
) -> str:
    """Best-effort persist one safe rejection while preserving the original public outcome."""
    request_id = correlation_id or _correlation_id()
    request.state.system_control_rejection_audited = True
    action, target_type, target_id = _system_control_context(request)
    try:
        record_rejected_control_attempt(
            db,
            action=action,
            target_type=target_type,
            target_id=target_id,
            actor_system_admin_id=actor_system_admin_id,
            reason_code=reason_code,
            correlation_id=request_id,
        )
    except Exception as audit_exc:  # noqa: BLE001 - audit failure cannot rewrite the safe result.
        logger.error(
            "system control rejection audit failed exception_type=%s correlation_id=%s",
            type(audit_exc).__name__,
            request_id,
        )
    return request_id


async def _audit_request_validation(request: Request) -> str:
    """Audit one request-shape rejection without reading or retaining the invalid payload."""
    request_id = _correlation_id()
    if getattr(request.state, "system_control_rejection_audited", False):
        return request_id

    action, target_type, _target_id = _system_control_context(request)
    actor_id = getattr(request.state, "system_control_actor_id", None)
    existing_db = getattr(request.state, "system_control_db", None)
    if isinstance(existing_db, Session):
        return _record_control_rejection(
            request,
            existing_db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=actor_id,
            correlation_id=request_id,
        )

    # A body/query validation error may happen before FastAPI yields the normal session
    # dependency.  Resolve the configured override only for this safe audit write.
    session_provider = request.app.dependency_overrides.get(get_session, get_session)
    resource = None
    try:
        resource = session_provider()
        if inspect.isawaitable(resource):
            resource = await resource
        if inspect.isasyncgen(resource):
            db = await resource.__anext__()
            try:
                _record_control_rejection(
                    request,
                    db,
                    reason_code="VALIDATION_ERROR",
                    actor_system_admin_id=actor_id,
                    correlation_id=request_id,
                )
            finally:
                await resource.aclose()
        elif inspect.isgenerator(resource):
            db = next(resource)
            try:
                _record_control_rejection(
                    request,
                    db,
                    reason_code="VALIDATION_ERROR",
                    actor_system_admin_id=actor_id,
                    correlation_id=request_id,
                )
            finally:
                resource.close()
        elif isinstance(resource, Session):
            _record_control_rejection(
                request,
                resource,
                reason_code="VALIDATION_ERROR",
                actor_system_admin_id=actor_id,
                correlation_id=request_id,
            )
            resource.close()
    except Exception as audit_exc:  # noqa: BLE001 - validation response remains deterministic.
        logger.error(
            "system validation rejection audit failed action=%s target_type=%s "
            "exception_type=%s correlation_id=%s",
            action,
            target_type,
            type(audit_exc).__name__,
            request_id,
        )
        if inspect.isgenerator(resource):
            resource.close()
        elif inspect.isasyncgen(resource):
            await resource.aclose()
        elif isinstance(resource, Session):
            resource.close()
    return request_id


def _system_admin_read(admin: SystemAdmin | SystemAdminIdentity) -> schema.SystemAdminRead:
    """Project either a persisted or post-login administrator into the exact safe response shape."""
    if isinstance(admin, SystemAdminIdentity):
        return schema.SystemAdminRead(
            id=admin.admin_id,
            username=admin.username,
            display_name=admin.display_name,
            status=admin.status,
            must_change_password=admin.must_change_password,
            last_login_at=admin.last_login_at,
            created_at=admin.created_at,
        )
    return schema.SystemAdminRead(
        id=admin.id,
        username=admin.username,
        display_name=admin.display_name,
        status=admin.status,
        must_change_password=admin.must_change_password,
        last_login_at=admin.last_login_at,
        created_at=admin.created_at,
    )


def _initial_admin_read(db: Session, tenant: Tenant) -> schema.InitialTenantAdminSummary | None:
    """Resolve only the referenced tenant administrator and reject cross-tenant pointers."""
    if not tenant.initial_admin_user_id:
        return None
    admin = db.get(User, tenant.initial_admin_user_id)
    if not admin or admin.tenant_id != tenant.id or admin.role != "admin":
        return None
    return schema.InitialTenantAdminSummary(
        id=admin.id,
        username=admin.username,
        display_name=admin.display_name,
        role="admin",
    )


def _initial_admin_provision_read(
    db: Session, tenant: Tenant
) -> schema.InitialTenantAdminRead | None:
    """Include only the initial admin's forced-change flag in the immediate provision receipt."""
    if not tenant.initial_admin_user_id:
        return None
    admin = db.get(User, tenant.initial_admin_user_id)
    if not admin or admin.tenant_id != tenant.id or admin.role != "admin":
        return None
    return schema.InitialTenantAdminRead(
        id=admin.id,
        username=admin.username,
        display_name=admin.display_name,
        role="admin",
        must_change_password=admin.must_change_password,
    )


def _tenant_summary(db: Session, tenant: Tenant) -> schema.TenantControlSummary:
    """Project one tenant row and its initial-admin pointer without reading tenant business data."""
    return schema.TenantControlSummary(
        id=tenant.id,
        slug=tenant.slug,
        display_name=tenant.name,
        status=tenant.status,
        lifecycle_version=tenant.lifecycle_version,
        initial_admin=_initial_admin_read(db, tenant),
        suspended_at=tenant.suspended_at,
        reactivated_at=tenant.reactivated_at,
        created_at=tenant.created_at,
        updated_at=tenant.updated_at,
    )


def _tenant_detail(db: Session, tenant: Tenant) -> schema.TenantControlDetail:
    """Project one tenant's bounded control detail, including only its suspension reason."""
    return schema.TenantControlDetail(
        **_tenant_summary(db, tenant).model_dump(),
        suspension_reason=tenant.suspension_reason,
    )


def _audit_read(row) -> schema.SystemControlAuditRead:
    """Project one persisted audit row through the explicit secret-safe allowlist."""
    raw_safe_params = row.safe_params_json if isinstance(row.safe_params_json, dict) else {}
    allowed_keys = _AUDIT_SAFE_PARAM_ALLOWLIST.get(row.action, frozenset())
    safe_params = {
        key: value
        for key, value in raw_safe_params.items()
        if key in allowed_keys
        and isinstance(key, str)
        and isinstance(value, (str, int, float, bool))
        and not isinstance(value, (bytes, bytearray))
    }
    return schema.SystemControlAuditRead(
        id=row.id,
        actor_system_admin_id=row.actor_system_admin_id,
        actor_label=row.actor_label,
        action=row.action,
        target_type=row.target_type,
        target_id=row.target_id,
        result=row.result,
        reason_code=row.reason_code,
        operator_reason=row.operator_reason,
        status_before=row.status_before,
        status_after=row.status_after,
        lifecycle_version=row.lifecycle_version,
        request_id=row.request_id,
        trace_id=row.trace_id,
        safe_params=dict(safe_params),
        created_at=row.created_at,
    )


def _safe_internal_exception(source: str, correlation_id: str, exc: Exception) -> HTTPException:
    """Create a registered internal error while logging only exception type and correlation."""
    logger.error(
        "system control operation failed source=%s exception_type=%s correlation_id=%s",
        source,
        type(exc).__name__,
        correlation_id,
    )
    return build_http_exception(
        "INTERNAL_ERROR",
        request_id=correlation_id,
        internal=InternalErrorContext(
            source=source,
            exception_type=type(exc).__name__,
            diagnostic_reference=correlation_id,
        ),
    )


def _auth_error_code(exc: HTTPException) -> str:
    """Extract only the two registered system-auth denial reasons from an HTTP exception."""
    detail = exc.detail
    if isinstance(detail, dict):
        candidate = detail.get("code")
        if isinstance(candidate, str) and candidate in _SAFE_SYSTEM_AUTH_CODES:
            return candidate
    return "SYSTEM_AUTH_INVALID_CREDENTIALS"


def _authenticate_system_admin(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(system_admin_auth.system_security),
    ],
    db: Annotated[Session, Depends(get_session)],
) -> SystemAdmin:
    """Require a system bearer and audit one safe denial without exposing token or DB details."""
    request.state.system_control_db = db
    request_id = _correlation_id()
    try:
        admin = system_admin_auth.get_current_system_admin(credentials, db)
    except system_admin_auth.SystemAuthUnavailable:
        _record_control_rejection(
            request,
            db,
            reason_code="SYSTEM_AUTH_UNAVAILABLE",
            correlation_id=request_id,
        )
        raise build_http_exception("SYSTEM_AUTH_UNAVAILABLE", request_id=request_id) from None
    except HTTPException as exc:
        code = _auth_error_code(exc)
        _record_control_rejection(request, db, reason_code=code, correlation_id=request_id)
        # Keep all invalid bearer branches byte-for-byte identical; the private audit
        # row retains the correlation needed for diagnostics without becoming an oracle.
        entry = ERROR_REGISTRY.get(code) or ERROR_REGISTRY.require(
            "SYSTEM_AUTH_INVALID_CREDENTIALS"
        )
        raise build_http_exception(entry.code) from None
    temporary_password_allowed = request.url.path in {
        "/api/system/auth/me",
        "/api/system/auth/change-password",
    } or (
        request.method == "GET" and request.url.path == "/api/system/password-policies"
    )
    if admin.must_change_password and not temporary_password_allowed:
        raise build_http_exception("TEMPORARY_PASSWORD_CHANGE_REQUIRED")
    request.state.system_control_actor_id = admin.id
    return admin


@router.post("/auth/login", response_model=schema.SystemLoginResponse)
def login(
    request: schema.SystemLoginRequest,
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.SystemLoginResponse:
    """Authenticate a system administrator without resolving a tenant or tenant user."""
    correlation_id = _correlation_id()
    try:
        result = authenticate_system_admin(
            db,
            username=request.username,
            password=request.password,
            correlation_id=correlation_id,
        )
    except system_admin_auth.SystemAuthUnavailable:
        raise build_http_exception("SYSTEM_AUTH_UNAVAILABLE", request_id=correlation_id) from None
    except InvalidSystemCredentialsError:
        # Keep unknown-user and wrong-password responses byte-for-byte identical; the
        # correlation remains in the private audit row rather than becoming an oracle.
        raise build_http_exception("SYSTEM_AUTH_INVALID_CREDENTIALS") from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception("system_admin.login", correlation_id, exc) from None
    except Exception as exc:  # noqa: BLE001 - keep the login error contract stable.
        raise _safe_internal_exception("system_admin.login", correlation_id, exc) from None
    return schema.SystemLoginResponse(
        token=result.token,
        scope="system",
        system_admin=_system_admin_read(result),
    )


@router.get("/auth/me", response_model=schema.SystemAdminRead)
def me(admin: SystemAdmin = Depends(_authenticate_system_admin)) -> schema.SystemAdminRead:  # noqa: B008
    """Return the current system administrator's safe identity projection."""
    return _system_admin_read(admin)


@router.post("/auth/change-password", response_model=schema.SystemLoginResponse)
def change_password(
    request: schema.SystemPasswordChangeRequest,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.SystemLoginResponse:
    """Replace the current system password, clear first-change state, and return a rotated token."""
    correlation_id = _correlation_id()
    try:
        result = change_system_admin_password(
            db,
            admin_id=admin.id,
            current_password=request.current_password,
            new_password=request.new_password,
            correlation_id=correlation_id,
        )
    except InvalidSystemCredentialsError:
        raise build_http_exception("SYSTEM_AUTH_INVALID_CREDENTIALS", status_code=400) from None
    except InvalidControlInputError:
        raise build_http_exception(
            "VALIDATION_ERROR", params={"error_count": 1}, status_code=400
        ) from None
    return schema.SystemLoginResponse(
        token=result.token,
        scope="system",
        system_admin=_system_admin_read(result),
    )


def _policy_read(policy: PasswordPolicy) -> schema.PasswordPolicy:
    """Project one internal policy into the strict HTTP contract without any credential values."""
    return schema.PasswordPolicy(
        min_length=policy.min_length,
        max_length=policy.max_length,
        complexity_enabled=policy.complexity_enabled,
        require_uppercase=policy.require_uppercase,
        require_lowercase=policy.require_lowercase,
        require_digit=policy.require_digit,
        require_special=policy.require_special,
    )


def _policy_request(policy: schema.PasswordPolicy) -> PasswordPolicy:
    """Validate and translate one strict request model before it enters durable policy storage."""
    return policy_from_values(
        policy.min_length,
        policy.max_length,
        policy.complexity_enabled,
        policy.require_uppercase,
        policy.require_lowercase,
        policy.require_digit,
        policy.require_special,
    )


def _tenant_policy_read(db: Session, tenant_id: str) -> schema.TenantPasswordPolicyRead:
    """Project a tenant policy mode, optional custom value, and resolved effective policy."""
    record = db.get(TenantPasswordPolicy, tenant_id)
    effective = effective_tenant_policy(db, tenant_id)
    return schema.TenantPasswordPolicyRead(
        mode="custom" if record is not None and record.mode == "custom" else "inherit",
        custom=_policy_read(effective) if record is not None and record.mode == "custom" else None,
        effective=_policy_read(effective),
    )


@router.get("/password-policies", response_model=schema.SystemPasswordPoliciesRead)
def get_system_password_policies(
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.SystemPasswordPoliciesRead:
    """Return system and default-tenant policy values, including their safe development defaults."""
    return schema.SystemPasswordPoliciesRead(
        system=_policy_read(installation_policy(db, SYSTEM_POLICY_SCOPE)),
        tenant_default=_policy_read(installation_policy(db, TENANT_DEFAULT_POLICY_SCOPE)),
    )


@router.put("/password-policies", response_model=schema.SystemPasswordPoliciesRead)
def update_system_password_policies(
    request: schema.SystemPasswordPoliciesUpdate,
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.SystemPasswordPoliciesRead:
    """Persist complete policy replacements for both installation scopes before replying."""
    try:
        system = save_installation_policy(db, SYSTEM_POLICY_SCOPE, _policy_request(request.system))
        tenant_default = save_installation_policy(
            db, TENANT_DEFAULT_POLICY_SCOPE, _policy_request(request.tenant_default)
        )
    except ValueError:
        raise build_http_exception(
            "VALIDATION_ERROR", params={"error_count": 1}, status_code=400
        ) from None
    db.commit()
    return schema.SystemPasswordPoliciesRead(
        system=_policy_read(system), tenant_default=_policy_read(tenant_default)
    )


@router.get("/tenants/{tenant_id}/password-policy", response_model=schema.TenantPasswordPolicyRead)
def get_tenant_password_policy(
    tenant_id: str,
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantPasswordPolicyRead:
    """Return one existing tenant's inherited or custom password policy without business data."""
    if db.get(Tenant, tenant_id) is None:
        raise build_http_exception("TENANT_NOT_FOUND", params={"tenant_id": tenant_id})
    return _tenant_policy_read(db, tenant_id)


@router.put("/tenants/{tenant_id}/password-policy", response_model=schema.TenantPasswordPolicyRead)
def update_tenant_password_policy(
    tenant_id: str,
    request: schema.TenantPasswordPolicyUpdate,
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantPasswordPolicyRead:
    """Persist a tenant inheritance choice or complete custom override, then return its effective rule."""
    if db.get(Tenant, tenant_id) is None:
        raise build_http_exception("TENANT_NOT_FOUND", params={"tenant_id": tenant_id})
    try:
        save_tenant_policy(
            db,
            tenant_id,
            request.mode,
            _policy_request(request.custom) if request.custom is not None else None,
        )
    except ValueError:
        raise build_http_exception(
            "VALIDATION_ERROR", params={"error_count": 1}, status_code=400
        ) from None
    db.commit()
    return _tenant_policy_read(db, tenant_id)


@router.get("/tenants", response_model=schema.TenantControlPage)
def list_system_tenants(
    request: Request,
    query: str | None = Query(default=None, max_length=120),
    status: Literal["active", "suspended"] | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlPage:
    """List control metadata through the system dependency without entering tenant routers."""
    correlation_id = _correlation_id()
    try:
        rows, next_cursor = list_tenants(
            db,
            query=query,
            status=status,
            cursor=cursor,
            limit=limit,
        )
    except InvalidControlInputError:
        request_id = _record_control_rejection(
            request,
            db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=admin.id,
            correlation_id=correlation_id,
        )
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=request_id,
        ) from None
    return schema.TenantControlPage(
        items=[_tenant_summary(db, tenant) for tenant in rows],
        next_cursor=next_cursor,
    )


@router.post(
    "/tenants",
    response_model=schema.TenantProvisionDetail,
    status_code=201,
)
def provision_system_tenant(
    request: schema.TenantProvisionRequest,
    http_request: Request,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlDetail:
    """Provision one active tenant and its initial admin through the dedicated control service."""
    correlation_id = _correlation_id()
    try:
        result = provision_tenant(
            db,
            actor_system_admin_id=admin.id,
            slug=request.slug,
            display_name=request.display_name,
            initial_admin_username=request.initial_admin.username,
            initial_admin_display_name=request.initial_admin.display_name,
            temporary_password=request.initial_admin.temporary_password,
            correlation_id=correlation_id,
        )
    except TenantProvisionConflictError:
        raise build_http_exception("SYSTEM_CONTROL_CONFLICT", request_id=correlation_id) from None
    except InvalidControlInputError:
        _record_control_rejection(
            http_request,
            db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=admin.id,
            correlation_id=correlation_id,
        )
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception("system_admin.provision", correlation_id, exc) from None
    except Exception as exc:  # noqa: BLE001 - keep the provisioning error contract stable.
        raise _safe_internal_exception("system_admin.provision", correlation_id, exc) from None

    tenant = db.get(Tenant, result.tenant_id)
    if tenant is None:
        missing = RuntimeError("provisioned tenant could not be reloaded")
        raise _safe_internal_exception("system_admin.provision.reload", correlation_id, missing)
    detail = _tenant_detail(db, tenant).model_dump()
    detail["initial_admin"] = _initial_admin_provision_read(db, tenant)
    return schema.TenantProvisionDetail(**detail)


@router.get("/tenants/{tenant_id}", response_model=schema.TenantControlDetail)
def get_system_tenant(
    tenant_id: str,
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlDetail:
    """Return one tenant's control detail without exposing tenant-owned business records."""
    tenant = get_tenant(db, tenant_id)
    if tenant is None:
        raise build_http_exception("TENANT_NOT_FOUND", params={"tenant_id": tenant_id})
    return _tenant_detail(db, tenant)


@router.patch("/tenants/{tenant_id}", response_model=schema.TenantControlDetail)
def rename_system_tenant(
    tenant_id: str,
    request: schema.TenantRenameRequest,
    http_request: Request,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlDetail:
    """Change only a tenant display name while retaining all immutable identity references."""
    correlation_id = _correlation_id()
    try:
        rename_tenant(
            db,
            actor_system_admin_id=admin.id,
            tenant_id=tenant_id,
            display_name=request.display_name,
            correlation_id=correlation_id,
        )
    except TenantNotFoundError:
        raise build_http_exception(
            "TENANT_NOT_FOUND",
            params={"tenant_id": tenant_id},
            request_id=correlation_id,
        ) from None
    except InvalidControlInputError:
        _record_control_rejection(
            http_request,
            db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=admin.id,
            correlation_id=correlation_id,
        )
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception("system_admin.tenant.rename", correlation_id, exc) from None
    except Exception as exc:  # noqa: BLE001 - keep the control error contract stable.
        raise _safe_internal_exception("system_admin.tenant.rename", correlation_id, exc) from None

    tenant = get_tenant(db, tenant_id)
    if tenant is None:
        missing = RuntimeError("renamed tenant could not be reloaded")
        raise _safe_internal_exception("system_admin.tenant.rename.reload", correlation_id, missing)
    return _tenant_detail(db, tenant)


@router.post("/tenants/{tenant_id}/suspend", response_model=schema.TenantControlDetail)
def suspend_system_tenant(
    tenant_id: str,
    request: schema.TenantSuspendRequest,
    http_request: Request,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlDetail:
    """Suspend a tenant through the system control transaction after a bounded reason is supplied."""
    correlation_id = _correlation_id()
    try:
        suspend_tenant(
            db,
            actor_system_admin_id=admin.id,
            tenant_id=tenant_id,
            reason=request.reason,
            correlation_id=correlation_id,
        )
    except TenantNotFoundError:
        raise build_http_exception(
            "TENANT_NOT_FOUND",
            params={"tenant_id": tenant_id},
            request_id=correlation_id,
        ) from None
    except InvalidControlInputError:
        # The service records semantic reason/state rejections atomically with the target read.
        # Request-shape failures are handled by _SafeSystemRoute before this function runs.
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception("system_admin.tenant.suspend", correlation_id, exc) from None
    except Exception as exc:  # noqa: BLE001 - keep lifecycle internals out of public responses.
        raise _safe_internal_exception("system_admin.tenant.suspend", correlation_id, exc) from None

    tenant = get_tenant(db, tenant_id)
    if tenant is None:
        missing = RuntimeError("suspended tenant could not be reloaded")
        raise _safe_internal_exception("system_admin.tenant.suspend.reload", correlation_id, missing)
    return _tenant_detail(db, tenant)


@router.post("/tenants/{tenant_id}/reactivate", response_model=schema.TenantControlDetail)
def reactivate_system_tenant(
    tenant_id: str,
    http_request: Request,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.TenantControlDetail:
    """Reactivate a tenant through the system control transaction without replaying old work."""
    correlation_id = _correlation_id()
    try:
        reactivate_tenant(
            db,
            actor_system_admin_id=admin.id,
            tenant_id=tenant_id,
            correlation_id=correlation_id,
        )
    except TenantNotFoundError:
        raise build_http_exception(
            "TENANT_NOT_FOUND",
            params={"tenant_id": tenant_id},
            request_id=correlation_id,
        ) from None
    except InvalidControlInputError:
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception(
            "system_admin.tenant.reactivate", correlation_id, exc
        ) from None
    except Exception as exc:  # noqa: BLE001 - keep lifecycle internals out of public responses.
        raise _safe_internal_exception(
            "system_admin.tenant.reactivate", correlation_id, exc
        ) from None

    tenant = get_tenant(db, tenant_id)
    if tenant is None:
        missing = RuntimeError("reactivated tenant could not be reloaded")
        raise _safe_internal_exception(
            "system_admin.tenant.reactivate.reload", correlation_id, missing
        )
    return _tenant_detail(db, tenant)


@router.post(
    "/tenants/{tenant_id}/initial-admin/temporary-password",
    status_code=204,
)
def reset_system_tenant_initial_admin_password(
    tenant_id: str,
    request: schema.TemporaryPasswordRequest,
    http_request: Request,
    admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> Response:
    """Replace the pointed initial-admin credential without returning any credential material."""
    correlation_id = _correlation_id()
    try:
        reset_initial_tenant_admin_password(
            db,
            actor_system_admin_id=admin.id,
            tenant_id=tenant_id,
            temporary_password=request.temporary_password,
            correlation_id=correlation_id,
        )
    except TenantNotFoundError:
        raise build_http_exception(
            "TENANT_NOT_FOUND",
            params={"tenant_id": tenant_id},
            request_id=correlation_id,
        ) from None
    except InitialTenantAdminNotFoundError:
        raise build_http_exception("AUTH_CREDENTIAL_NOT_FOUND", request_id=correlation_id) from None
    except InvalidControlInputError:
        _record_control_rejection(
            http_request,
            db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=admin.id,
            correlation_id=correlation_id,
        )
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception(
            "system_admin.tenant.initial_admin.reset", correlation_id, exc
        ) from None
    except Exception as exc:  # noqa: BLE001 - keep credential details out of the response.
        raise _safe_internal_exception(
            "system_admin.tenant.initial_admin.reset", correlation_id, exc
        ) from None
    return Response(status_code=204)


@router.get("/tenants/{tenant_id}/audit", response_model=schema.SystemControlAuditPage)
def list_system_tenant_audit(
    tenant_id: str,
    request: Request,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> schema.SystemControlAuditPage:
    """List only allowlisted audit metadata for one existing tenant control target."""
    correlation_id = _correlation_id()
    if get_tenant(db, tenant_id) is None:
        raise build_http_exception(
            "TENANT_NOT_FOUND",
            params={"tenant_id": tenant_id},
            request_id=correlation_id,
        )
    try:
        rows, next_cursor = list_tenant_audits(
            db,
            tenant_id=tenant_id,
            cursor=cursor,
            limit=limit,
        )
    except InvalidControlInputError:
        _record_control_rejection(
            request,
            db,
            reason_code="VALIDATION_ERROR",
            actor_system_admin_id=_admin.id,
            correlation_id=correlation_id,
        )
        raise build_http_exception(
            "VALIDATION_ERROR",
            params={"error_count": 1},
            status_code=400,
            request_id=correlation_id,
        ) from None
    except SQLAlchemyError as exc:
        raise _safe_internal_exception("system_admin.tenant.audit", correlation_id, exc) from None
    except Exception as exc:  # noqa: BLE001 - do not expose audit storage details.
        raise _safe_internal_exception("system_admin.tenant.audit", correlation_id, exc) from None
    return schema.SystemControlAuditPage(
        items=[_audit_read(row) for row in rows],
        next_cursor=next_cursor,
    )


@router.get("/runtimes/codex-a2a", response_model=schema.SystemRuntimeStatus)
def get_system_codex_a2a_runtime(
    _admin: SystemAdmin = Depends(_authenticate_system_admin),  # noqa: B008
) -> schema.SystemRuntimeStatus:
    """Return installation runtime configuration state without reading persisted A2A work."""
    return schema.SystemRuntimeStatus(**codex_a2a_runtime_status())


__all__ = ["router"]

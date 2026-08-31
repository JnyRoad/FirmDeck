from __future__ import annotations

from fastapi import Depends, Query
from sqlmodel import Session

from app.contracts.http import build_http_exception
from app.db import get_session
from app.db.models import AgentProfile, User
from app.security.auth import ensure_current_user_tenant, get_current_user

ADMIN_ROLE = "admin"
MEMBER_ROLE = "member"
USER_ROLES = {ADMIN_ROLE, MEMBER_ROLE}


def is_admin_user(current_user: User) -> bool:
    return current_user.role == ADMIN_ROLE


def ensure_tenant_admin(tenant_id: str, current_user: User) -> User:
    """Require tenant membership and administrator role using stable permission errors."""
    ensure_current_user_tenant(tenant_id, current_user)
    if not is_admin_user(current_user):
        raise build_http_exception("PERMISSION_TENANT_ADMIN_REQUIRED")
    return current_user


def require_tenant_admin(
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
) -> User:
    return ensure_tenant_admin(tenant_id, current_user)


def require_agent_scope_viewer(
    tenant_id: str = Query(...),
    agent_id: str | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> User:
    """Resolve an optional agent scope only when the principal can view that agent."""
    ensure_current_user_tenant(tenant_id, current_user)
    if not agent_id:
        return current_user
    row = db.get(AgentProfile, agent_id)
    if not row or row.tenant_id != tenant_id:
        raise build_http_exception("AGENT_NOT_FOUND")
    if (
        is_admin_user(current_user)
        or row.is_overall
        or agent_owned_by_user(row, current_user)
        or (row.metadata_json or {}).get("published_to_gallery") is True
    ):
        return current_user
    raise build_http_exception("PERMISSION_AGENT_ACCESS_DENIED")


def ensure_open_gallery_admin(tenant_id: str, current_user: User) -> None:
    ensure_tenant_admin(tenant_id, current_user)


def ensure_agent_scope_manager(
    db: Session,
    tenant_id: str,
    agent_id: str | None,
    current_user: User,
) -> AgentProfile | None:
    """Resolve an optional agent scope for mutation and enforce its owner policy."""
    ensure_current_user_tenant(tenant_id, current_user)
    if not agent_id:
        return None
    row = db.get(AgentProfile, agent_id)
    if not row or row.tenant_id != tenant_id:
        raise build_http_exception("AGENT_NOT_FOUND")
    if is_admin_user(current_user):
        return row
    if row.is_overall:
        raise build_http_exception("PERMISSION_OVERALL_AGENT_ADMIN_REQUIRED")
    if agent_owned_by_user(row, current_user):
        return row
    raise build_http_exception("PERMISSION_AGENT_OWNER_OR_ADMIN_REQUIRED")


def agent_owned_by_user(row: AgentProfile, user: User) -> bool:
    metadata = row.metadata_json or {}
    return metadata.get("owner_user_id") == user.id

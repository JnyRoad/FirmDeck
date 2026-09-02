"""Provisioning-time owner for the tenant-local curated employee template."""

from sqlmodel import Session, select

from app.db.models import AgentProfile, User
from app.db.staffdeck_seed import SEED_SOURCE, SELECTED_AGENT_NAMES, seed_staffdeck_tenant_gallery


def seed_default_tenant_template(session: Session, tenant_id: str, tenant_admin: User) -> None:
    """Flush the standard ten-employee template for one tenant without committing the caller session.

    ``tenant_admin`` must belong to ``tenant_id``. Existing seed-managed employees make this
    operation idempotent; a non-template employee with one of the reserved curated names is
    rejected before any template rows are written.
    """
    if tenant_admin.tenant_id != tenant_id:
        raise ValueError("Tenant administrator does not belong to the requested tenant")

    _reject_reserved_employee_conflicts(session, tenant_id)
    seed_staffdeck_tenant_gallery(
        session,
        tenant_id=tenant_id,
        admin_user_id=tenant_admin.id,
        admin_username=tenant_admin.username,
        admin_display_name=tenant_admin.display_name or tenant_admin.username,
    )


def _reject_reserved_employee_conflicts(session: Session, tenant_id: str) -> None:
    """Fail before writes when a tenant-owned employee would be overwritten by the curated template."""
    existing_agents = session.exec(
        select(AgentProfile).where(
            AgentProfile.tenant_id == tenant_id,
            AgentProfile.name.in_(SELECTED_AGENT_NAMES),
        )
    ).all()
    for agent in existing_agents:
        metadata = agent.metadata_json or {}
        if metadata.get("seed_source") != SEED_SOURCE or metadata.get("managed_by_seed") is not True:
            raise ValueError("Tenant already has a non-template employee using a reserved template name")

from sqlmodel import Session

from app.contracts.http import build_http_exception
from app.db.models import Tenant


def ensure_tenant(session: Session, tenant_id: str) -> Tenant:
    """Load a tenant or return its safe identifier-bearing not-found contract."""
    tenant = session.get(Tenant, tenant_id)
    if not tenant:
        raise build_http_exception("TENANT_NOT_FOUND", params={"tenant_id": tenant_id})
    return tenant

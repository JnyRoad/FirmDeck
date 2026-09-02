"""RED contracts for the isolated system tenant-control HTTP plane."""

from __future__ import annotations

import importlib
import importlib.util
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, create_engine, select

from app.api import auth as tenant_auth_api
from app.db import get_session
from app.db.models import (
    A2ATaskRun,
    AgentProfile,
    AgentResourceBinding,
    KnowledgeBucket,
    KnowledgeChunk,
    KnowledgeConcept,
    KnowledgeDiscoverySuggestion,
    KnowledgeDocument,
    KnowledgeIngestJob,
    SystemAdmin,
    SystemControlAudit,
    Tenant,
    User,
)
from app.security import auth as tenant_auth
from app.security import system_admin_auth
from app.security.auth import create_access_token, hash_password

_APP_SECRET = "t016-tenant-signing-secret"
_SYSTEM_SECRET = "t016-system-signing-secret"
_SYSTEM_PASSWORD = "System-login-secret-2026"
_TEMPORARY_PASSWORD = "TempA1!9"
_RESET_TEMPORARY_PASSWORD = "ResetA1!9"


def _system_api_module() -> ModuleType:
    """Load the planned router lazily so T016 collects before T021 exists."""
    assert importlib.util.find_spec("app.api.system_admin") is not None, (
        "T021 must implement app.api.system_admin with a dedicated router"
    )
    module = importlib.import_module("app.api.system_admin")
    assert getattr(module, "router", None) is not None, "T021 must expose system_admin.router"
    return module


def _engine(tmp_path, name: str = "system-control.db"):
    """Create a file-backed isolated database for request and concurrency tests."""
    engine = create_engine(
        f"sqlite:///{tmp_path / name}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _settings() -> SimpleNamespace:
    return SimpleNamespace(app_secret=_APP_SECRET, system_admin_secret=_SYSTEM_SECRET)


def _seed_principals(engine) -> dict[str, object]:
    """Seed only explicit auth/control rows; never call demo seeding."""
    with Session(engine) as db:
        system_admin = SystemAdmin(
            id="sysadmin-root",
            username="root",
            display_name="System Operator",
            password_hash=hash_password(_SYSTEM_PASSWORD),
            status="active",
            auth_version=1,
        )
        tenant = Tenant(
            id="tenant-existing",
            slug="existing",
            name="Existing Tenant",
            status="active",
            lifecycle_version=1,
        )
        tenant_admin = User(
            id="tenant-admin",
            tenant_id=tenant.id,
            username="admin",
            role="admin",
            password_hash=hash_password("tenant-admin-secret"),
            auth_version=1,
        )
        tenant_member = User(
            id="tenant-member",
            tenant_id=tenant.id,
            username="member",
            role="member",
            password_hash=hash_password("tenant-member-secret"),
            auth_version=1,
        )
        tenant.initial_admin_user_id = tenant_admin.id
        db.add(system_admin)
        db.add(tenant)
        db.add(tenant_admin)
        db.add(tenant_member)
        db.commit()
        db.refresh(system_admin)
        db.refresh(tenant_admin)
        db.refresh(tenant_member)
        return {
            "system_admin": system_admin,
            "tenant": tenant,
            "tenant_admin": tenant_admin,
            "tenant_member": tenant_member,
        }


def _app(engine) -> FastAPI:
    """Build only the system router and one ordinary tenant-auth probe route."""
    system_api = _system_api_module()
    app = FastAPI()
    app.include_router(system_api.router)
    app.include_router(tenant_auth_api.router)

    def override_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_session
    return app


def _client(engine, *, raise_server_exceptions: bool = True) -> TestClient:
    return TestClient(_app(engine), raise_server_exceptions=raise_server_exceptions)


def _system_headers(admin: SystemAdmin) -> dict[str, str]:
    return {"Authorization": f"Bearer {system_admin_auth.create_system_access_token(admin)}"}


def _tenant_headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user)}"}


def _login(client: TestClient) -> dict[str, object]:
    response = client.post(
        "/api/system/auth/login",
        json={"username": "root", "password": _SYSTEM_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(autouse=True)
def _test_signing_secrets(monkeypatch):
    """Keep both test token domains explicit and independent for every case."""
    monkeypatch.setattr(system_admin_auth, "get_settings", _settings)
    monkeypatch.setattr(tenant_auth, "get_settings", _settings)


def test_system_login_and_me_return_only_safe_system_identity(tmp_path) -> None:
    """Authenticate without tenant context, then verify the system session at its own endpoint."""
    engine = _engine(tmp_path)
    _seed_principals(engine)
    client = _client(engine)

    session = _login(client)
    assert set(session) == {"token", "scope", "system_admin"}
    assert session["scope"] == "system"
    assert isinstance(session["token"], str) and session["token"]
    assert session["system_admin"] == {
        "id": "sysadmin-root",
        "username": "root",
        "display_name": "System Operator",
        "status": "active",
        "must_change_password": False,
        "last_login_at": session["system_admin"]["last_login_at"],
        "created_at": session["system_admin"]["created_at"],
    }
    assert session["system_admin"]["last_login_at"] is not None
    assert _SYSTEM_PASSWORD not in repr(session)
    assert "tenant" not in session["system_admin"]
    with Session(engine) as db:
        persisted = db.get(SystemAdmin, "sysadmin-root")
        assert persisted is not None
        assert persisted.last_login_at is not None
        assert persisted.last_login_at.isoformat() in session["system_admin"]["last_login_at"]

    response = client.get(
        "/api/system/auth/me",
        headers={"Authorization": f"Bearer {session['token']}"},
    )
    assert response.status_code == 200
    assert response.json() == session["system_admin"]


def test_system_login_failures_are_generic_and_each_login_has_one_audit(tmp_path) -> None:
    """Make unknown-user and wrong-password responses identical while auditing each final result once."""
    engine = _engine(tmp_path)
    _seed_principals(engine)
    client = _client(engine)

    unknown = client.post(
        "/api/system/auth/login",
        json={"username": "unknown", "password": "not-the-password"},
    )
    wrong = client.post(
        "/api/system/auth/login",
        json={"username": "root", "password": "not-the-password"},
    )
    success = client.post(
        "/api/system/auth/login",
        json={"username": "root", "password": _SYSTEM_PASSWORD},
    )

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()
    assert unknown.json()["detail"]["code"] == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    assert "unknown" not in unknown.text
    assert "root" not in wrong.text
    assert "not-the-password" not in unknown.text + wrong.text
    assert success.status_code == 200
    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit)
            .where(SystemControlAudit.action == "system_admin.login")
            .order_by(SystemControlAudit.created_at, SystemControlAudit.id)
        ).all()
    assert len(audits) == 3
    assert [audit.result for audit in audits].count("rejected") == 2
    assert [audit.result for audit in audits].count("succeeded") == 1
    assert {(audit.result, audit.reason_code) for audit in audits} == {
        ("rejected", "SYSTEM_AUTH_INVALID_CREDENTIALS"),
        ("succeeded", "SYSTEM_AUTH_SUCCEEDED"),
    }
    with Session(engine) as db:
        actual_hash = db.get(SystemAdmin, "sysadmin-root").password_hash
    forbidden = {
        _SYSTEM_PASSWORD,
        "not-the-password",
        actual_hash,
        success.json()["token"],
    }
    serialized = repr([audit.model_dump() for audit in audits])
    assert all(secret not in serialized for secret in forbidden)
    assert all(audit.request_id or audit.trace_id for audit in audits)
    succeeded = [audit for audit in audits if audit.result == "succeeded"]
    assert succeeded[0].actor_system_admin_id == "sysadmin-root"
    assert succeeded[0].target_id == "sysadmin-root"


def test_system_secret_absence_maps_login_and_me_to_registered_503(tmp_path, monkeypatch) -> None:
    """Fail system HTTP authentication closed when its dedicated signer is unavailable."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    valid_token = system_admin_auth.create_system_access_token(principals["system_admin"])
    monkeypatch.setattr(
        system_admin_auth,
        "get_settings",
        lambda: SimpleNamespace(system_admin_secret="", app_secret=_APP_SECRET),
    )
    client = _client(engine, raise_server_exceptions=False)

    login = client.post(
        "/api/system/auth/login",
        json={"username": "root", "password": _SYSTEM_PASSWORD},
    )
    me = client.get(
        "/api/system/auth/me",
        headers={"Authorization": f"Bearer {valid_token}"},
    )
    assert login.status_code == me.status_code == 503
    assert login.json()["detail"]["code"] == "SYSTEM_AUTH_UNAVAILABLE"
    assert me.json()["detail"]["code"] == "SYSTEM_AUTH_UNAVAILABLE"


def test_control_plane_authorization_matrix_rejects_every_wrong_domain(tmp_path) -> None:
    """Admit only system bearers to inventory and reject system bearers at a tenant endpoint."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    system_headers = _system_headers(principals["system_admin"])
    tenant_admin_headers = _tenant_headers(principals["tenant_admin"])
    tenant_member_headers = _tenant_headers(principals["tenant_member"])

    allowed = client.get("/api/system/tenants", headers=system_headers)
    denials = [
        client.get("/api/system/tenants"),
        client.get("/api/system/tenants", headers={"Authorization": "Bearer malformed"}),
        client.get("/api/system/tenants", headers=tenant_admin_headers),
        client.get("/api/system/tenants", headers=tenant_member_headers),
    ]
    assert allowed.status_code == 200
    assert all(response.status_code == 401 for response in denials)
    assert len({response.text for response in denials}) == 1
    assert "Existing Tenant" not in denials[0].text
    with Session(engine) as db:
        rejected_audits = db.exec(
            select(SystemControlAudit).where(
                SystemControlAudit.action == "tenant.list",
                SystemControlAudit.result == "rejected",
            )
        ).all()
    assert len(rejected_audits) == len(denials)
    assert all(audit.target_id is None for audit in rejected_audits)
    assert all(audit.safe_params_json == {} for audit in rejected_audits)
    assert all(audit.reason_code == "SYSTEM_AUTH_INVALID_CREDENTIALS" for audit in rejected_audits)
    assert all(audit.request_id or audit.trace_id for audit in rejected_audits)

    tenant_endpoint = client.get("/api/auth/me", headers=system_headers)
    assert tenant_endpoint.status_code == 401
    assert "System Operator" not in tenant_endpoint.text


def test_system_list_and_detail_return_control_metadata_only_with_filters(tmp_path) -> None:
    """List/filter/inspect tenant control rows without exposing tenant business or secret fields."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant-suspended",
                slug="suspended-lab",
                name="Suspended Lab",
                status="suspended",
                lifecycle_version=2,
                suspension_reason="billing hold",
            )
        )
        db.commit()
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])

    page = client.get("/api/system/tenants?query=existing&limit=25", headers=headers)
    assert page.status_code == 200
    assert page.json()["next_cursor"] is None
    assert [item["id"] for item in page.json()["items"]] == ["tenant-existing"]
    item = page.json()["items"][0]
    summary_fields = {
        "id",
        "slug",
        "display_name",
        "status",
        "lifecycle_version",
        "initial_admin",
        "suspended_at",
        "reactivated_at",
        "created_at",
        "updated_at",
    }
    assert set(item) == summary_fields
    assert item["slug"] == "existing"
    assert item["display_name"] == "Existing Tenant"
    assert item["status"] == "active"
    assert item["lifecycle_version"] == 1
    assert item["initial_admin"]["username"] == "admin"

    def assert_safe_page(payload: dict[str, object]) -> None:
        assert set(payload) == {"items", "next_cursor"}
        assert all(set(row) == summary_fields for row in payload["items"])
        serialized_page = repr(payload).lower()
        assert all(fragment not in serialized_page for fragment in forbidden_fragments)

    suspended_page = client.get("/api/system/tenants?status=suspended", headers=headers)
    assert suspended_page.status_code == 200
    assert [row["id"] for row in suspended_page.json()["items"]] == ["tenant-suspended"]
    assert all(row["status"] == "suspended" for row in suspended_page.json()["items"])

    active_page = client.get("/api/system/tenants?status=active", headers=headers)
    assert active_page.status_code == 200
    assert [row["id"] for row in active_page.json()["items"]] == ["tenant-existing"]
    assert all(row["status"] == "active" for row in active_page.json()["items"])

    detail = client.get("/api/system/tenants/tenant-existing", headers=headers)
    missing = client.get("/api/system/tenants/missing-tenant", headers=headers)
    assert detail.status_code == 200
    assert missing.status_code == 404
    assert set(detail.json()) == summary_fields | {"suspension_reason"}
    forbidden_fragments = {
        "password",
        "hash",
        "token",
        "conversation",
        "message",
        "knowledge",
        "prompt",
        "artifact",
        "credential",
    }
    assert_safe_page(page.json())
    assert_safe_page(suspended_page.json())
    assert_safe_page(active_page.json())
    serialized = repr({"page": page.json(), "detail": detail.json()}).lower()
    assert all(fragment not in serialized for fragment in forbidden_fragments)


def _provision_payload(slug: str = "alpha-lab") -> dict[str, object]:
    return {
        "slug": slug,
        "display_name": "Alpha Lab",
        "initial_admin": {
            "username": "alpha-admin",
            "display_name": "Alpha Operator",
            "temporary_password": _TEMPORARY_PASSWORD,
        },
    }


def _password_policy(
    *,
    min_length: int = 8,
    max_length: int = 20,
    complexity_enabled: bool = False,
    require_uppercase: bool = True,
    require_lowercase: bool = True,
    require_digit: bool = True,
    require_special: bool = True,
) -> dict[str, object]:
    """Build a literal password-policy request fixture without production-derived values."""
    return {
        "min_length": min_length,
        "max_length": max_length,
        "complexity_enabled": complexity_enabled,
        "require_uppercase": require_uppercase,
        "require_lowercase": require_lowercase,
        "require_digit": require_digit,
        "require_special": require_special,
    }


def test_system_password_policy_get_put_persists_independent_complexity_rules(tmp_path) -> None:
    """Catch policy writes omitting a scope or losing enabled complexity requirements on reread."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])

    default_response = client.get("/api/system/password-policies", headers=headers)
    assert default_response.status_code == 200, default_response.text
    assert default_response.json() == {
        "system": _password_policy(),
        "tenant_default": _password_policy(),
    }

    expected_system = _password_policy(
        min_length=10,
        max_length=16,
        complexity_enabled=True,
        require_uppercase=True,
        require_lowercase=True,
        require_digit=True,
        require_special=True,
    )
    expected_tenant_default = _password_policy(
        min_length=9,
        max_length=14,
        complexity_enabled=True,
        require_uppercase=False,
        require_lowercase=True,
        require_digit=True,
        require_special=False,
    )
    updated = client.put(
        "/api/system/password-policies",
        json={"system": expected_system, "tenant_default": expected_tenant_default},
        headers=headers,
    )
    reread = client.get("/api/system/password-policies", headers=headers)

    assert updated.status_code == 200, updated.text
    assert updated.json() == {
        "system": expected_system,
        "tenant_default": expected_tenant_default,
    }
    assert reread.status_code == 200, reread.text
    assert reread.json() == updated.json()


def test_invalid_system_password_policy_update_keeps_both_scopes_unchanged(tmp_path) -> None:
    """Catch a two-scope policy update committing its valid half before rejecting the invalid half."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    before = client.get("/api/system/password-policies", headers=headers)
    rejected = client.put(
        "/api/system/password-policies",
        json={
            "system": _password_policy(min_length=10, max_length=15),
            "tenant_default": _password_policy(min_length=14, max_length=10),
        },
        headers=headers,
    )
    after = client.get("/api/system/password-policies", headers=headers)

    assert before.status_code == 200, before.text
    assert rejected.status_code == 400, rejected.text
    assert after.status_code == 200, after.text
    assert after.json() == before.json()


def test_system_self_change_enforces_enabled_complexity_before_rotating_token(tmp_path) -> None:
    """Catch a system self-change bypassing complexity or mutating credentials after rejection."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    strict_system_policy = _password_policy(
        min_length=10,
        max_length=12,
        complexity_enabled=True,
    )
    assert client.put(
        "/api/system/password-policies",
        json={"system": strict_system_policy, "tenant_default": _password_policy()},
        headers=headers,
    ).status_code == 200
    with Session(engine) as db:
        before = db.get(SystemAdmin, "sysadmin-root")
        assert before is not None
        before_snapshot = (
            before.password_hash,
            before.auth_version,
            before.must_change_password,
            before.password_changed_at,
        )

    rejected = client.post(
        "/api/system/auth/change-password",
        json={"current_password": _SYSTEM_PASSWORD, "new_password": "Weakpass10"},
        headers=headers,
    )
    with Session(engine) as db:
        rejected_admin = db.get(SystemAdmin, "sysadmin-root")
        assert rejected_admin is not None
        assert (
            rejected_admin.password_hash,
            rejected_admin.auth_version,
            rejected_admin.must_change_password,
            rejected_admin.password_changed_at,
        ) == before_snapshot

    accepted = client.post(
        "/api/system/auth/change-password",
        json={"current_password": _SYSTEM_PASSWORD, "new_password": "ValidA1!234"},
        headers=headers,
    )
    assert rejected.status_code == 400, rejected.text
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["token"] != headers["Authorization"].removeprefix("Bearer ")


def test_tenant_password_policy_custom_and_inherit_return_correct_effective_rule(tmp_path) -> None:
    """Catch an override leaking into inherited tenants or leaving a stale custom effective rule."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    default_tenant_policy = _password_policy(min_length=11, max_length=13)
    assert client.put(
        "/api/system/password-policies",
        json={"system": _password_policy(), "tenant_default": default_tenant_policy},
        headers=headers,
    ).status_code == 200

    inherited = client.get(
        "/api/system/tenants/tenant-existing/password-policy", headers=headers
    )
    custom_policy = _password_policy(
        min_length=8,
        max_length=10,
        complexity_enabled=True,
        require_uppercase=False,
        require_lowercase=True,
        require_digit=True,
        require_special=False,
    )
    custom = client.put(
        "/api/system/tenants/tenant-existing/password-policy",
        json={"mode": "custom", "custom": custom_policy},
        headers=headers,
    )
    restored = client.put(
        "/api/system/tenants/tenant-existing/password-policy",
        json={"mode": "inherit", "custom": None},
        headers=headers,
    )

    assert inherited.status_code == 200, inherited.text
    assert inherited.json() == {
        "mode": "inherit",
        "custom": None,
        "effective": default_tenant_policy,
    }
    assert custom.status_code == 200, custom.text
    assert custom.json() == {
        "mode": "custom",
        "custom": custom_policy,
        "effective": custom_policy,
    }
    assert restored.status_code == 200, restored.text
    assert restored.json() == {
        "mode": "inherit",
        "custom": None,
        "effective": default_tenant_policy,
    }


def test_tenant_password_policy_rejects_invalid_provision_and_reset_without_mutation(
    tmp_path,
) -> None:
    """Catch policy bypasses that create a tenant or rotate an admin credential before rejection."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    strict_policy = _password_policy(
        min_length=10,
        max_length=12,
        complexity_enabled=True,
        require_uppercase=True,
        require_lowercase=True,
        require_digit=True,
        require_special=True,
    )
    assert client.put(
        "/api/system/password-policies",
        json={"system": _password_policy(), "tenant_default": strict_policy},
        headers=headers,
    ).status_code == 200

    rejected_provision = client.post(
        "/api/system/tenants",
        json={
            **_provision_payload("policy-rejected-lab"),
            "initial_admin": {
                **_provision_payload()["initial_admin"],
                "temporary_password": "weakpass10",
            },
        },
        headers=headers,
    )
    with Session(engine) as db:
        assert db.exec(select(Tenant).where(Tenant.slug == "policy-rejected-lab")).first() is None
        assert db.exec(select(User).where(User.username == "alpha-admin")).first() is None

    with Session(engine) as db:
        initial_admin = db.get(User, "tenant-admin")
        assert initial_admin is not None
        unchanged = (
            initial_admin.password_hash,
            initial_admin.auth_version,
            initial_admin.must_change_password,
            initial_admin.password_changed_at,
        )
    rejected_reset = client.post(
        "/api/system/tenants/tenant-existing/initial-admin/temporary-password",
        json={"temporary_password": "Weakpass10"},
        headers=headers,
    )
    with Session(engine) as db:
        initial_admin = db.get(User, "tenant-admin")
        assert initial_admin is not None
        assert (
            initial_admin.password_hash,
            initial_admin.auth_version,
            initial_admin.must_change_password,
            initial_admin.password_changed_at,
        ) == unchanged

    accepted_reset = client.post(
        "/api/system/tenants/tenant-existing/initial-admin/temporary-password",
        json={"temporary_password": "ValidA1!234"},
        headers=headers,
    )
    with Session(engine) as db:
        initial_admin = db.get(User, "tenant-admin")
        assert initial_admin is not None
        assert (initial_admin.password_hash, initial_admin.auth_version) != unchanged[:2]

    assert rejected_provision.status_code == 400, rejected_provision.text
    assert rejected_reset.status_code == 400, rejected_reset.text
    assert accepted_reset.status_code == 204, accepted_reset.text


def test_provision_creates_one_complete_tenant_admin_and_success_audit(tmp_path) -> None:
    """Create tenant control metadata, its initial admin, and one audit as one complete outcome."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    response = client.post(
        "/api/system/tenants",
        json=_provision_payload(),
        headers=_system_headers(principals["system_admin"]),
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["slug"] == "alpha-lab"
    assert body["display_name"] == "Alpha Lab"
    assert body["status"] == "active"
    assert body["lifecycle_version"] == 1
    assert body["initial_admin"]["username"] == "alpha-admin"
    assert body["initial_admin"]["role"] == "admin"
    assert body["initial_admin"]["must_change_password"] is True
    assert _TEMPORARY_PASSWORD not in response.text
    assert "password_hash" not in response.text

    with Session(engine) as db:
        tenant = db.exec(select(Tenant).where(Tenant.slug == "alpha-lab")).one()
        users = db.exec(select(User).where(User.tenant_id == tenant.id)).all()
        audits = db.exec(
            select(SystemControlAudit).where(
                SystemControlAudit.action == "tenant.provision",
                SystemControlAudit.target_id == tenant.id,
            )
        ).all()
    assert tenant.initial_admin_user_id == users[0].id
    assert len(users) == 1
    assert users[0].role == "admin"
    assert users[0].must_change_password is True
    assert users[0].password_hash not in response.text
    assert len(audits) == 1
    assert audits[0].result == "succeeded"
    assert audits[0].reason_code == "SYSTEM_TENANT_PROVISIONED"
    assert audits[0].actor_system_admin_id == principals["system_admin"].id
    assert audits[0].target_id == tenant.id
    assert audits[0].request_id or audits[0].trace_id


def test_provision_creates_curated_template_without_demo_business_rows(tmp_path) -> None:
    """Provision the ten curated employees and resources without demo-only knowledge records."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    response = client.post(
        "/api/system/tenants",
        json=_provision_payload("clean-lab"),
        headers=_system_headers(principals["system_admin"]),
    )
    assert response.status_code == 201
    tenant_id = response.json()["id"]

    with Session(engine) as db:
        agents = db.exec(select(AgentProfile).where(AgentProfile.tenant_id == tenant_id)).all()
        bindings = db.exec(
            select(AgentResourceBinding).where(AgentResourceBinding.tenant_id == tenant_id)
        ).all()
        assert {agent.name for agent in agents} == {
            "IT",
            "人事",
            "法务",
            "行政",
            "财务",
            "销售",
            "市场",
            "采购",
            "项目管理",
            "数据分析",
        }
        assert bindings
        assert {binding.agent_id for binding in bindings} <= {agent.id for agent in agents}
        for model in (
            KnowledgeDocument,
            KnowledgeBucket,
            KnowledgeChunk,
            KnowledgeConcept,
            KnowledgeDiscoverySuggestion,
            KnowledgeIngestJob,
        ):
            assert not db.exec(select(model).where(model.tenant_id == tenant_id)).all()


def test_provision_rolls_back_tenant_and_template_when_template_write_fails(tmp_path) -> None:
    """Keep tenant, admin, curated rows, and audit atomic when template persistence fails."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine, raise_server_exceptions=False)
    injected = False

    def fail_first_agent(_conn, _cursor, statement, parameters, _context, _many) -> None:
        nonlocal injected
        if "INSERT INTO agent_profiles" in statement:
            injected = True
            raise OperationalError(statement, parameters, RuntimeError("template-write-sentinel"))

    event.listen(engine, "before_cursor_execute", fail_first_agent)
    response = client.post(
        "/api/system/tenants",
        json=_provision_payload("rollback-template-lab"),
        headers=_system_headers(principals["system_admin"]),
    )
    event.remove(engine, "before_cursor_execute", fail_first_agent)

    assert injected is True
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "INTERNAL_ERROR"
    assert "template-write-sentinel" not in response.text
    with Session(engine) as db:
        assert db.exec(select(Tenant).where(Tenant.slug == "rollback-template-lab")).first() is None
        assert db.exec(select(User).where(User.username == "alpha-admin")).first() is None
        assert db.exec(select(AgentProfile)).all() == []
        assert db.exec(select(AgentResourceBinding)).all() == []
        assert db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == "tenant.provision")
        ).first() is None


def test_system_request_validation_never_echoes_temporary_password(tmp_path) -> None:
    """Map system request validation to the registered safe 400 projection without raw input."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    secret = "tiny"

    response = client.post(
        "/api/system/tenants",
        json={
            "slug": "validation-lab",
            "display_name": "Validation Lab",
            "initial_admin": {
                "username": "validation-admin",
                "temporary_password": secret,
            },
        },
        headers=_system_headers(principals["system_admin"]),
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    assert response.json()["detail"]["params"] == {"error_count": 1}
    assert secret not in response.text
    assert "temporary_password" not in response.text


def test_provision_rolls_back_tenant_user_pointer_and_audit_on_storage_failure(tmp_path) -> None:
    """Inject failure after tenant work starts and prove no partial provisioning state survives."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine, raise_server_exceptions=False)

    prior_tenant_insert = False
    injected = False

    def fail_initial_user(_conn, _cursor, statement, parameters, _context, _many) -> None:
        nonlocal injected, prior_tenant_insert
        if "INSERT INTO tenants" in statement and "rollback-lab" in repr(parameters):
            prior_tenant_insert = True
        if "INSERT INTO users" in statement and "alpha-admin" in repr(parameters):
            assert prior_tenant_insert
            injected = True
            raise OperationalError(statement, parameters, RuntimeError("raw-provision-sentinel"))

    event.listen(engine, "before_cursor_execute", fail_initial_user)
    response = client.post(
        "/api/system/tenants",
        json=_provision_payload("rollback-lab"),
        headers=_system_headers(principals["system_admin"]),
    )
    event.remove(engine, "before_cursor_execute", fail_initial_user)

    assert prior_tenant_insert is True
    assert injected is True
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "INTERNAL_ERROR"
    assert "raw-provision-sentinel" not in response.text
    assert _TEMPORARY_PASSWORD not in response.text
    with Session(engine) as db:
        assert db.exec(select(Tenant).where(Tenant.slug == "rollback-lab")).first() is None
        assert db.exec(select(User).where(User.username == "alpha-admin")).first() is None
        assert (
            db.exec(
                select(SystemControlAudit).where(SystemControlAudit.action == "tenant.provision")
            ).first()
            is None
        )


def test_concurrent_same_slug_has_one_complete_winner_and_one_rejected_audit(tmp_path) -> None:
    """Resolve a slug race at commit with one complete tenant and one safe conflict outcome."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    headers = _system_headers(principals["system_admin"])
    barrier = threading.Barrier(2)

    def attempt(index: int):
        client = _client(engine)
        payload = _provision_payload("race-lab")
        payload["initial_admin"] = {
            **payload["initial_admin"],
            "username": f"race-admin-{index}",
        }
        barrier.wait(timeout=10)
        return client.post("/api/system/tenants", json=payload, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(attempt, [1, 2]))

    assert sorted(response.status_code for response in responses) == [201, 409]
    assert all(_TEMPORARY_PASSWORD not in response.text for response in responses)
    assert all("password_hash" not in response.text for response in responses)
    with Session(engine) as db:
        tenants = db.exec(select(Tenant).where(Tenant.slug == "race-lab")).all()
        users = db.exec(select(User).where(User.tenant_id == tenants[0].id)).all()
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == "tenant.provision")
        ).all()
    assert len(tenants) == 1
    assert len(users) == 1
    assert tenants[0].initial_admin_user_id == users[0].id
    assert all(users[0].password_hash not in response.text for response in responses)
    assert len(audits) == 2
    assert sorted(audit.result for audit in audits) == ["rejected", "succeeded"]
    assert {(audit.result, audit.reason_code) for audit in audits} == {
        ("rejected", "SYSTEM_CONTROL_CONFLICT"),
        ("succeeded", "SYSTEM_TENANT_PROVISIONED"),
    }
    assert all(audit.actor_system_admin_id == principals["system_admin"].id for audit in audits)
    assert all(audit.request_id or audit.trace_id for audit in audits)


def test_disabled_and_stale_system_sessions_cannot_read_inventory(tmp_path) -> None:
    """Revalidate current system status and auth version on every protected control request."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    admin = principals["system_admin"]
    headers = _system_headers(admin)
    client = _client(engine)

    with Session(engine) as db:
        current = db.get(SystemAdmin, admin.id)
        assert current is not None
        current.auth_version += 1
        db.add(current)
        db.commit()
    stale = client.get("/api/system/tenants", headers=headers)
    assert stale.status_code == 401

    with Session(engine) as db:
        current = db.get(SystemAdmin, admin.id)
        assert current is not None
        current.status = "disabled"
        db.add(current)
        db.commit()
        db.refresh(current)
        disabled_headers = _system_headers(current)
    disabled = client.get("/api/system/tenants", headers=disabled_headers)
    assert disabled.status_code == 401


def test_each_provision_success_and_conflict_has_exactly_one_safe_final_audit(tmp_path) -> None:
    """Persist one outcome per business action without credentials or serialized request bodies."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    first = client.post(
        "/api/system/tenants", json=_provision_payload("audit-lab"), headers=headers
    )
    second = client.post(
        "/api/system/tenants", json=_provision_payload("audit-lab"), headers=headers
    )
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "SYSTEM_CONTROL_CONFLICT"
    assert _TEMPORARY_PASSWORD not in first.text + second.text
    assert "password_hash" not in first.text + second.text

    with Session(engine) as db:
        tenant = db.exec(select(Tenant).where(Tenant.slug == "audit-lab")).one()
        actual_hash = db.exec(select(User).where(User.tenant_id == tenant.id)).one().password_hash
        audits = db.exec(
            select(SystemControlAudit)
            .where(SystemControlAudit.action == "tenant.provision")
            .order_by(SystemControlAudit.created_at, SystemControlAudit.id)
        ).all()
    assert len(audits) == 2
    assert sorted(audit.result for audit in audits) == ["rejected", "succeeded"]
    assert {(audit.result, audit.reason_code) for audit in audits} == {
        ("rejected", "SYSTEM_CONTROL_CONFLICT"),
        ("succeeded", "SYSTEM_TENANT_PROVISIONED"),
    }
    assert actual_hash not in first.text + second.text
    assert all(audit.actor_system_admin_id == principals["system_admin"].id for audit in audits)
    assert all(audit.target_id == tenant.id for audit in audits)
    assert all(audit.request_id or audit.trace_id for audit in audits)
    forbidden = {
        _TEMPORARY_PASSWORD,
        actual_hash,
        _SYSTEM_SECRET,
        _APP_SECRET,
    }
    serialized = repr([audit.model_dump() for audit in audits])
    assert all(secret not in serialized for secret in forbidden)
    assert all(set(audit.safe_params_json) <= {"slug", "display_name"} for audit in audits)


def test_system_tenant_list_supports_cursor_search_and_status_filter(tmp_path) -> None:
    """Return deterministic control pages while filtering only tenant metadata."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    tenants = (
        Tenant(
            id="tenant-page-alpha",
            slug="alpha-page",
            name="Page Tenant Alpha",
            status="active",
            lifecycle_version=1,
            created_at=base_time,
            updated_at=base_time,
        ),
        Tenant(
            id="tenant-page-beta",
            slug="beta-page",
            name="Page Tenant Beta",
            status="suspended",
            lifecycle_version=2,
            suspension_reason="operator hold",
            created_at=base_time + timedelta(seconds=1),
            updated_at=base_time + timedelta(seconds=1),
        ),
        Tenant(
            id="tenant-page-gamma",
            slug="gamma-page",
            name="Page Tenant Gamma",
            status="active",
            lifecycle_version=1,
            created_at=base_time + timedelta(seconds=2),
            updated_at=base_time + timedelta(seconds=2),
        ),
    )
    page_admins = tuple(
        User(
            id=f"page-admin-{index}",
            tenant_id=tenant.id,
            username=f"{tenant.slug}-owner",
            role="admin",
            password_hash=f"hash-for-{tenant.slug}",
        )
        for index, tenant in enumerate(tenants)
    )
    for tenant, admin in zip(tenants, page_admins, strict=True):
        tenant.initial_admin_user_id = admin.id
    with Session(engine) as db:
        db.add_all([*tenants, *page_admins])
        db.commit()

    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    first = client.get(
        "/api/system/tenants",
        params={"query": "page tenant", "limit": 2},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    first_body = first.json()
    assert [item["id"] for item in first_body["items"]] == [
        "tenant-page-alpha",
        "tenant-page-beta",
    ]
    assert first_body["next_cursor"]

    second = client.get(
        "/api/system/tenants",
        params={
            "query": "page tenant",
            "cursor": first_body["next_cursor"],
            "limit": 2,
        },
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert [item["id"] for item in second.json()["items"]] == ["tenant-page-gamma"]
    assert second.json()["next_cursor"] is None

    active = client.get(
        "/api/system/tenants",
        params={"query": "PAGE TENANT", "status": "active", "limit": 2},
        headers=headers,
    )
    assert active.status_code == 200, active.text
    assert [item["id"] for item in active.json()["items"]] == [
        "tenant-page-alpha",
        "tenant-page-gamma",
    ]
    assert all(item["status"] == "active" for item in active.json()["items"])

    suspended = client.get(
        "/api/system/tenants",
        params={"query": "PAGE TENANT", "status": "suspended", "limit": 2},
        headers=headers,
    )
    assert suspended.status_code == 200, suspended.text
    assert [item["id"] for item in suspended.json()["items"]] == ["tenant-page-beta"]
    assert suspended.json()["items"][0]["status"] == "suspended"

    admin_search = client.get(
        "/api/system/tenants",
        params={"query": "alpha-page-owner", "limit": 2},
        headers=headers,
    )
    assert admin_search.status_code == 200, admin_search.text
    assert [item["id"] for item in admin_search.json()["items"]] == ["tenant-page-alpha"]


def test_system_tenant_rename_preserves_identity_and_writes_one_safe_audit(tmp_path) -> None:
    """Rename only the display name and retain the tenant identity and membership graph."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    tenant_id = "tenant-existing"
    original_slug = "existing"
    with Session(engine) as db:
        original_users = [
            user.id
            for user in db.exec(select(User).where(User.tenant_id == tenant_id)).all()
        ]
        original_admin_pointer = db.get(Tenant, tenant_id).initial_admin_user_id

    client = _client(engine)
    response = client.patch(
        f"/api/system/tenants/{tenant_id}",
        json={"display_name": "Renamed Existing Tenant"},
        headers=_system_headers(principals["system_admin"]),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == tenant_id
    assert body["slug"] == original_slug
    assert body["display_name"] == "Renamed Existing Tenant"

    with Session(engine) as db:
        tenant = db.get(Tenant, tenant_id)
        users = db.exec(select(User).where(User.tenant_id == tenant_id)).all()
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.target_id == tenant_id)
        ).all()
    assert tenant is not None
    assert tenant.slug == original_slug
    assert tenant.name == "Renamed Existing Tenant"
    assert tenant.initial_admin_user_id == original_admin_pointer
    assert sorted(user.id for user in users) == sorted(original_users)
    assert len(audits) == 1
    audit = audits[0]
    assert audit.target_type == "tenant"
    assert audit.result == "succeeded"
    assert "rename" in audit.action
    assert audit.request_id or audit.trace_id
    assert set(audit.safe_params_json) <= {"display_name", "old_display_name", "new_display_name"}
    serialized = repr({"response": body, "audit": audit.model_dump()}).lower()
    assert all(fragment not in serialized for fragment in ("password", "hash", "token", "prompt"))


def test_reset_initial_admin_password_invalidates_old_session_and_forces_change(tmp_path) -> None:
    """Rotate the initial admin credential, reject old sessions, and flag the new login as temporary."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    tenant_id = "tenant-existing"
    old_headers = _tenant_headers(
        User(
            id="tenant-admin",
            tenant_id=tenant_id,
            username="admin",
            password_hash="not-used-for-token",
            auth_version=1,
        )
    )
    client = _client(engine)

    response = client.post(
        f"/api/system/tenants/{tenant_id}/initial-admin/temporary-password",
        json={"temporary_password": _RESET_TEMPORARY_PASSWORD},
        headers=_system_headers(principals["system_admin"]),
    )
    assert response.status_code == 204, response.text
    assert response.content == b""
    assert _RESET_TEMPORARY_PASSWORD not in response.text

    old_me = client.get("/api/auth/me", headers=old_headers)
    assert old_me.status_code == 401
    old_login = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "existing",
            "username": "admin",
            "password": "tenant-admin-secret",
        },
    )
    assert old_login.status_code == 401
    new_login = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "existing",
            "username": "admin",
            "password": _RESET_TEMPORARY_PASSWORD,
        },
    )
    assert new_login.status_code == 200, new_login.text
    assert new_login.json()["user"]["must_change_password"] is True
    assert _RESET_TEMPORARY_PASSWORD not in new_login.text

    with Session(engine) as db:
        admin = db.get(User, "tenant-admin")
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.target_id == tenant_id)
        ).all()
    assert admin is not None
    assert admin.auth_version == 2
    assert admin.must_change_password is True
    assert admin.password_changed_at is not None
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "succeeded"
    assert "reset" in audit.action
    assert audit.request_id or audit.trace_id
    serialized = repr(audit.model_dump())
    assert all(secret not in serialized for secret in (_RESET_TEMPORARY_PASSWORD, admin.password_hash))


def test_reset_missing_initial_admin_is_safe_and_audited(tmp_path) -> None:
    """Reject a tenant with an unresolvable initial-admin pointer without leaking reset input."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    tenant_id = "tenant-orphan-admin"
    reset_secret = "OrphanA1!9"
    with Session(engine) as db:
        db.add(
            Tenant(
                id=tenant_id,
                slug="orphan-admin",
                name="Orphan Admin Tenant",
                initial_admin_user_id="missing-initial-admin",
            )
        )
        db.commit()

    client = _client(engine)
    response = client.post(
        f"/api/system/tenants/{tenant_id}/initial-admin/temporary-password",
        json={"temporary_password": reset_secret},
        headers=_system_headers(principals["system_admin"]),
    )
    assert response.status_code == 404
    assert reset_secret not in response.text

    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.target_id == tenant_id)
        ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "rejected"
    assert audit.target_type == "tenant"
    assert audit.request_id or audit.trace_id
    assert reset_secret not in repr(audit.model_dump())


def test_system_tenant_audit_page_is_cursor_paginated_and_secret_safe(tmp_path) -> None:
    """Expose only allowlisted audit metadata with a stable cursor page shape."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    tenant_id = "tenant-existing"
    base_time = datetime(2026, 2, 1, tzinfo=UTC)
    with Session(engine) as db:
        for index in range(3):
            db.add(
                SystemControlAudit(
                    actor_system_admin_id=principals["system_admin"].id,
                    action="tenant.rename",
                    target_type="tenant",
                    target_id=tenant_id,
                    result="succeeded",
                    reason_code="SYSTEM_TENANT_RENAMED",
                    request_id=f"request-audit-{index}",
                    safe_params_json={"display_name": f"Audit Tenant {index}"},
                    created_at=base_time + timedelta(seconds=index),
                )
            )
        db.commit()

    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    first = client.get(
        f"/api/system/tenants/{tenant_id}/audit",
        params={"limit": 2},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert set(body) == {"items", "next_cursor"}
    assert len(body["items"]) == 2
    assert body["next_cursor"]

    second = client.get(
        f"/api/system/tenants/{tenant_id}/audit",
        params={"limit": 2, "cursor": body["next_cursor"]},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert len(second.json()["items"]) == 1
    assert second.json()["next_cursor"] is None
    rows = [*body["items"], *second.json()["items"]]
    assert len({row["id"] for row in rows}) == 3
    expected_fields = {
        "id",
        "actor_system_admin_id",
        "actor_label",
        "action",
        "target_type",
        "target_id",
        "result",
        "reason_code",
        "operator_reason",
        "status_before",
        "status_after",
        "lifecycle_version",
        "request_id",
        "trace_id",
        "safe_params",
        "created_at",
    }
    assert all(set(row) == expected_fields for row in rows)
    serialized = repr(rows).lower()
    assert all(
        fragment not in serialized
        for fragment in (
            "password",
            "hash",
            "token",
            "credential",
            "prompt",
            "artifact",
            "conversation",
        )
    )


def test_system_codex_runtime_status_is_secret_safe_and_not_tenant_inventory(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expose system-owned Codex status without returning runtime secrets, work, or fake tenants."""
    engine = _engine(tmp_path)
    principals = _seed_principals(engine)
    raw_prompt = "private prompt must not cross the status projection"
    raw_artifact = "private-artifact.txt"
    raw_task_id = "system-task-secret-id"
    raw_session_id = "codex-session-secret-id"
    runtime_secret = "codex-installation-secret"
    with Session(engine) as db:
        db.add(
            A2ATaskRun(
                id="codex-system-run",
                owner_scope="system",
                direction="server",
                tenant_id=None,
                system_runtime_key="codex_a2a",
                tenant_lifecycle_version=None,
                endpoint_url="http://localhost/api/a2a/codex",
                remote_task_id=raw_task_id,
                codex_session_id=raw_session_id,
                status="working",
                request_json={"prompt": raw_prompt},
                result_json={"artifact": raw_artifact},
                artifacts_json=[{"name": raw_artifact}],
            )
        )
        db.commit()

    runtime_settings = SimpleNamespace(
        app_secret=_APP_SECRET,
        system_admin_secret=_SYSTEM_SECRET,
        codex_a2a_enabled=True,
        codex_a2a_command="codex",
        codex_a2a_workspace_root="/srv/codex-workspace",
        codex_a2a_timeout_seconds=1800.0,
        codex_a2a_token=runtime_secret,
    )
    system_api = _system_api_module()
    service = importlib.import_module("app.system_admin.service")
    codex_adapter = importlib.import_module("app.a2a.codex_adapter")
    monkeypatch.setattr(system_api, "get_settings", lambda: runtime_settings, raising=False)
    monkeypatch.setattr(service, "get_settings", lambda: runtime_settings, raising=False)
    monkeypatch.setattr(codex_adapter, "get_settings", lambda: runtime_settings, raising=False)

    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    status = client.get("/api/system/runtimes/codex-a2a", headers=headers)
    assert status.status_code == 200, status.text
    payload = status.json()
    assert payload == {
        "key": "codex_a2a",
        "enabled": True,
        "credential_configured": True,
        "command": "codex",
        "workspace_root": "/srv/codex-workspace",
        "timeout_seconds": 1800.0,
    }
    serialized = repr(payload)
    assert all(
        value not in serialized
        for value in (runtime_secret, raw_prompt, raw_artifact, raw_task_id, raw_session_id)
    )

    inventory = client.get("/api/system/tenants", params={"limit": 100}, headers=headers)
    assert inventory.status_code == 200, inventory.text
    assert [item["id"] for item in inventory.json()["items"]] == ["tenant-existing"]
    assert all(item["slug"] != "codex_a2a" for item in inventory.json()["items"])


@pytest.mark.parametrize("auth_mode", ["missing", "invalid", "tenant"])
@pytest.mark.parametrize(
    ("operation", "method", "path", "action", "target_type", "target_id", "body"),
    [
        (
            "create",
            "post",
            "/api/system/tenants",
            "tenant.provision",
            "tenant",
            None,
            _provision_payload("denied-create-lab"),
        ),
        (
            "rename",
            "patch",
            "/api/system/tenants/tenant-existing",
            "tenant.rename",
            "tenant",
            "tenant-existing",
            {"display_name": "Denied Rename"},
        ),
        (
            "reset",
            "post",
            "/api/system/tenants/tenant-existing/initial-admin/temporary-password",
            "tenant.initial_admin_password_reset",
            "tenant",
            "tenant-existing",
            {"temporary_password": "Denied-reset-secret-2026"},
        ),
        (
            "list",
            "get",
            "/api/system/tenants",
            "tenant.list",
            "tenant",
            None,
            None,
        ),
        (
            "detail",
            "get",
            "/api/system/tenants/tenant-existing",
            "tenant.detail",
            "tenant",
            "tenant-existing",
            None,
        ),
        (
            "audit",
            "get",
            "/api/system/tenants/tenant-existing/audit",
            "tenant.audit",
            "tenant",
            "tenant-existing",
            None,
        ),
        (
            "runtime",
            "get",
            "/api/system/runtimes/codex-a2a",
            "system.runtime.codex_a2a",
            "system_admin",
            None,
            None,
        ),
    ],
)
def test_unauthorized_system_control_requests_are_audited_once_and_secret_safe(
    tmp_path,
    auth_mode: str,
    operation: str,
    method: str,
    path: str,
    action: str,
    target_type: str,
    target_id: str | None,
    body: dict[str, object] | None,
) -> None:
    """Reject every wrong-domain control request with one allowlisted, correlated audit row."""
    engine = _engine(tmp_path, f"denied-{operation}-{auth_mode}.db")
    principals = _seed_principals(engine)
    client = _client(engine)
    if auth_mode == "missing":
        headers = {}
    elif auth_mode == "invalid":
        headers = {"Authorization": "Bearer malformed-system-token"}
    else:
        headers = _tenant_headers(principals["tenant_admin"])

    response = client.request(method, path, json=body, headers=headers)

    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    assert all(secret not in response.text for secret in ("malformed-system-token", "Denied-reset-secret-2026"))
    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == action)
        ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "rejected"
    assert audit.target_type == target_type
    assert audit.target_id == target_id
    assert audit.reason_code == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    assert audit.request_id or audit.trace_id
    assert audit.safe_params_json == {}
    serialized = repr(audit.model_dump())
    assert all(
        secret not in serialized
        for secret in ("malformed-system-token", "Denied-reset-secret-2026", "password_hash")
    )


def test_system_secret_missing_login_is_safe_and_audited_once(tmp_path, monkeypatch) -> None:
    """Keep signer unavailability at the stable 503 boundary with one safe login audit."""
    engine = _engine(tmp_path)
    _seed_principals(engine)
    monkeypatch.setattr(
        system_admin_auth,
        "get_settings",
        lambda: SimpleNamespace(system_admin_secret="", app_secret=_APP_SECRET),
    )
    client = _client(engine)
    response = client.post(
        "/api/system/auth/login",
        json={"username": "root", "password": _SYSTEM_PASSWORD},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "SYSTEM_AUTH_UNAVAILABLE"
    assert _SYSTEM_PASSWORD not in response.text
    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == "system_admin.login")
        ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "rejected"
    assert audit.target_type == "system_admin"
    assert audit.target_id is None
    assert audit.reason_code == "SYSTEM_AUTH_UNAVAILABLE"
    assert audit.request_id or audit.trace_id
    assert audit.safe_params_json == {}
    assert _SYSTEM_PASSWORD not in repr(audit.model_dump())


@pytest.mark.parametrize(
    ("operation", "method", "path", "body", "action", "target_type", "target_id", "secret"),
    [
        (
            "create-validation",
            "post",
            "/api/system/tenants",
            {
                "slug": "x",
                "display_name": "Validation Lab",
                "initial_admin": {
                    "username": "validation-admin",
                    "temporary_password": "body-secret-must-not-echo",
                },
            },
            "tenant.provision",
            "tenant",
            None,
            "body-secret-must-not-echo",
        ),
        (
            "rename-validation",
            "patch",
            "/api/system/tenants/tenant-existing",
            {"unexpected": "raw-body-secret"},
            "tenant.rename",
            "tenant",
            "tenant-existing",
            "raw-body-secret",
        ),
        (
            "reset-validation",
            "post",
            "/api/system/tenants/tenant-existing/initial-admin/temporary-password",
            {"temporary_password": "tiny"},
            "tenant.initial_admin_password_reset",
            "tenant",
            "tenant-existing",
            "tiny",
        ),
    ],
)
def test_system_request_validation_is_secret_safe_and_audited_once(
    tmp_path,
    operation: str,
    method: str,
    path: str,
    body: dict[str, object],
    action: str,
    target_type: str,
    target_id: str | None,
    secret: str,
) -> None:
    """Record one validation rejection without serializing request body or password fields."""
    engine = _engine(tmp_path, f"validation-{operation}.db")
    principals = _seed_principals(engine)
    client = _client(engine)
    response = client.request(
        method,
        path,
        json=body,
        headers=_system_headers(principals["system_admin"]),
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    assert secret not in response.text
    assert "raw-body-secret" not in response.text
    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == action)
        ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "rejected"
    assert audit.target_type == target_type
    assert audit.target_id == target_id
    assert audit.reason_code == "VALIDATION_ERROR"
    assert audit.request_id or audit.trace_id
    assert audit.safe_params_json == {}
    assert secret not in repr(audit.model_dump())


@pytest.mark.parametrize(
    ("operation", "path", "action", "target_type", "target_id"),
    [
        (
            "list-semantic",
            "/api/system/tenants?cursor=not-a-cursor",
            "tenant.list",
            "tenant",
            None,
        ),
        (
            "rename-semantic",
            "/api/system/tenants/tenant-existing",
            "tenant.rename",
            "tenant",
            "tenant-existing",
        ),
    ],
)
def test_system_semantic_validation_is_audited_once_without_raw_details(
    tmp_path,
    operation: str,
    path: str,
    action: str,
    target_type: str,
    target_id: str | None,
) -> None:
    """Record stable semantic validation failures without leaking cursor or request details."""
    engine = _engine(tmp_path, f"semantic-{operation}.db")
    principals = _seed_principals(engine)
    client = _client(engine)
    if operation == "rename-semantic":
        response = client.patch(
            path,
            json={"display_name": "   "},
            headers=_system_headers(principals["system_admin"]),
        )
    else:
        response = client.get(path, headers=_system_headers(principals["system_admin"]))

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    with Session(engine) as db:
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == action)
        ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.result == "rejected"
    assert audit.target_type == target_type
    assert audit.target_id == target_id
    assert audit.reason_code == "VALIDATION_ERROR"
    assert audit.request_id or audit.trace_id
    assert audit.safe_params_json == {}


def test_suspend_and_reactivate_are_versioned_idempotent_and_audited(tmp_path) -> None:
    """Transition one tenant through both lifecycle states without changing identity or data."""
    engine = _engine(tmp_path, "lifecycle-transition.db")
    principals = _seed_principals(engine)
    tenant_id = "tenant-existing"
    old_tenant_token = create_access_token(principals["tenant_admin"])
    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    suspension_reason = "security review requested by operator"

    suspended = client.post(
        f"/api/system/tenants/{tenant_id}/suspend",
        json={"reason": suspension_reason},
        headers=headers,
    )
    assert suspended.status_code == 200, suspended.text
    suspended_body = suspended.json()
    assert suspended_body["id"] == tenant_id
    assert suspended_body["slug"] == "existing"
    assert suspended_body["status"] == "suspended"
    assert suspended_body["lifecycle_version"] == 2
    assert suspended_body["suspension_reason"] == suspension_reason
    assert suspended_body["suspended_at"] is not None
    assert suspended_body["reactivated_at"] is None

    # Repeating the target state must return the same version and retain the committed reason.
    repeated_suspend = client.post(
        f"/api/system/tenants/{tenant_id}/suspend",
        json={"reason": "a different reason must not rewrite the state"},
        headers=headers,
    )
    assert repeated_suspend.status_code == 200, repeated_suspend.text
    assert repeated_suspend.json()["status"] == "suspended"
    assert repeated_suspend.json()["lifecycle_version"] == 2
    assert repeated_suspend.json()["suspension_reason"] == suspension_reason

    # The token issued before suspension must fail at the common tenant bearer boundary.
    old_session = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {old_tenant_token}"},
    )
    assert old_session.status_code == 403
    assert old_session.json()["detail"]["code"] == "TENANT_SUSPENDED"

    reactivated = client.post(
        f"/api/system/tenants/{tenant_id}/reactivate",
        headers=headers,
    )
    assert reactivated.status_code == 200, reactivated.text
    reactivated_body = reactivated.json()
    assert reactivated_body["id"] == tenant_id
    assert reactivated_body["slug"] == "existing"
    assert reactivated_body["status"] == "active"
    assert reactivated_body["lifecycle_version"] == 3
    assert reactivated_body["reactivated_at"] is not None
    assert reactivated_body["suspension_reason"] is None

    repeated_reactivation = client.post(
        f"/api/system/tenants/{tenant_id}/reactivate",
        headers=headers,
    )
    assert repeated_reactivation.status_code == 200, repeated_reactivation.text
    assert repeated_reactivation.json()["status"] == "active"
    assert repeated_reactivation.json()["lifecycle_version"] == 3

    with Session(engine) as db:
        tenant = db.get(Tenant, tenant_id)
        admin = db.get(User, "tenant-admin")
        audits = db.exec(
            select(SystemControlAudit)
            .where(SystemControlAudit.target_id == tenant_id)
            .order_by(SystemControlAudit.created_at, SystemControlAudit.id)
        ).all()
    assert tenant is not None and admin is not None
    assert tenant.status == "active"
    assert tenant.lifecycle_version == 3
    assert tenant.slug == "existing"
    assert tenant.name == "Existing Tenant"
    assert tenant.initial_admin_user_id == admin.id
    assert len(audits) == 4

    suspend_audits = [audit for audit in audits if audit.action == "tenant.suspend"]
    reactivate_audits = [audit for audit in audits if audit.action == "tenant.reactivate"]
    assert len(suspend_audits) == len(reactivate_audits) == 2
    assert suspend_audits[0].result == "succeeded"
    assert suspend_audits[0].status_before == "active"
    assert suspend_audits[0].status_after == "suspended"
    assert suspend_audits[0].lifecycle_version == 2
    assert suspend_audits[0].operator_reason == suspension_reason
    assert reactivate_audits[0].result == "succeeded"
    assert reactivate_audits[0].status_before == "suspended"
    assert reactivate_audits[0].status_after == "active"
    assert reactivate_audits[0].lifecycle_version == 3
    assert reactivate_audits[0].operator_reason is None
    assert all(audit.actor_system_admin_id == principals["system_admin"].id for audit in audits)
    assert all(audit.request_id or audit.trace_id for audit in audits)
    serialized = repr([audit.model_dump() for audit in audits])
    assert old_tenant_token not in serialized


def test_suspend_requires_a_nonempty_reason_and_audits_the_rejection(tmp_path) -> None:
    """Reject whitespace-only suspension reasons without exposing the submitted text."""
    engine = _engine(tmp_path, "lifecycle-invalid-reason.db")
    principals = _seed_principals(engine)
    client = _client(engine)
    response = client.post(
        "/api/system/tenants/tenant-existing/suspend",
        json={"reason": "   "},
        headers=_system_headers(principals["system_admin"]),
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    assert "   " not in response.text
    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant-existing")
        audits = db.exec(
            select(SystemControlAudit).where(
                SystemControlAudit.action == "tenant.suspend",
                SystemControlAudit.target_id == "tenant-existing",
            )
        ).all()
    assert tenant is not None and tenant.status == "active" and tenant.lifecycle_version == 1
    assert len(audits) == 1
    assert audits[0].result == "rejected"
    assert audits[0].reason_code == "VALIDATION_ERROR"
    assert audits[0].status_before == "active"
    assert audits[0].status_after is None
    assert audits[0].lifecycle_version == 1
    assert audits[0].safe_params_json == {}


def test_lifecycle_controls_fail_closed_for_malformed_suspended_state(tmp_path) -> None:
    """Reject a suspended row that lacks the metadata required by the lifecycle invariant."""
    engine = _engine(tmp_path, "lifecycle-malformed-suspended.db")
    principals = _seed_principals(engine)
    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant-existing")
        assert tenant is not None
        tenant.status = "suspended"
        tenant.lifecycle_version = 2
        tenant.suspension_reason = None
        tenant.suspended_at = None
        db.add(tenant)
        db.commit()

    client = _client(engine)
    headers = _system_headers(principals["system_admin"])
    suspend_response = client.post(
        "/api/system/tenants/tenant-existing/suspend",
        json={"reason": "must not repair malformed state"},
        headers=headers,
    )
    reactivate_response = client.post(
        "/api/system/tenants/tenant-existing/reactivate",
        headers=headers,
    )

    for response in (suspend_response, reactivate_response):
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["code"] == "VALIDATION_ERROR"

    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant-existing")
        audits = db.exec(
            select(SystemControlAudit)
            .where(SystemControlAudit.target_id == "tenant-existing")
            .order_by(SystemControlAudit.created_at, SystemControlAudit.id)
        ).all()
    assert tenant is not None
    assert tenant.status == "suspended"
    assert tenant.lifecycle_version == 2
    assert tenant.suspension_reason is None
    assert tenant.suspended_at is None
    assert [audit.action for audit in audits] == ["tenant.suspend", "tenant.reactivate"]
    assert all(audit.result == "rejected" for audit in audits)
    assert all(audit.reason_code == "SYSTEM_TENANT_INVALID_STATE" for audit in audits)


def test_lifecycle_control_rejects_tenant_bearer_and_audits_once(tmp_path) -> None:
    """Keep tenant principals out of lifecycle controls while retaining one safe rejection audit."""
    engine = _engine(tmp_path, "lifecycle-wrong-domain.db")
    principals = _seed_principals(engine)
    client = _client(engine)
    response = client.post(
        "/api/system/tenants/tenant-existing/suspend",
        json={"reason": "tenant bearer must not control lifecycle"},
        headers=_tenant_headers(principals["tenant_admin"]),
    )

    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant-existing")
        audits = db.exec(
            select(SystemControlAudit).where(
                SystemControlAudit.action == "tenant.suspend",
                SystemControlAudit.target_id == "tenant-existing",
            )
        ).all()
    assert tenant is not None and tenant.status == "active"
    assert len(audits) == 1
    assert audits[0].result == "rejected"
    assert audits[0].reason_code == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    assert audits[0].safe_params_json == {}

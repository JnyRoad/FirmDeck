from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.api.auth as auth_api
import app.security.auth as tenant_auth
from app.api.agents import enterprise_router as agents_router
from app.api.agents import scope_router as agent_scope_router
from app.api.feedback import router as feedback_router
from app.api.general_skills import router as general_skills_router
from app.api.knowledge import router as knowledge_router
from app.api.knowledge_bases import router as knowledge_bases_router
from app.api.memories import router as memories_router
from app.api.model_configs import router as model_configs_router
from app.api.persona import router as persona_router
from app.api.scheduled_tasks import enterprise_router as scheduled_tasks_router
from app.api.sessions import router as sessions_router
from app.api.skills import router as skills_router
from app.api.tools import mcp_router
from app.api.tools import router as tools_router
from app.api.traces import router as traces_router
from app.api.ui_config import enterprise_router as ui_config_router
from app.db import get_session
from app.db.models import Tenant, User
from app.security.auth import hash_password, verify_password

_TEST_APP_SECRET = "t026-tenant-signing-secret"
_OLD_PASSWORD = "Temporary-password-2026"
_NEW_PASSWORD = "Replace-pass-2026"


@pytest.fixture(autouse=True)
def _test_signing_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    def _settings() -> SimpleNamespace:
        return SimpleNamespace(app_secret=_TEST_APP_SECRET)

    monkeypatch.setattr(tenant_auth, "get_settings", _settings)


def test_enterprise_read_endpoints_require_authentication() -> None:
    app = FastAPI()
    app.include_router(memories_router)
    app.include_router(tools_router)
    app.include_router(mcp_router)
    app.include_router(general_skills_router)
    app.include_router(knowledge_router)
    app.include_router(knowledge_bases_router)
    app.include_router(model_configs_router)
    app.include_router(persona_router)
    app.include_router(skills_router)
    app.include_router(traces_router)
    app.include_router(ui_config_router)
    app.include_router(agents_router)
    app.include_router(agent_scope_router)
    app.include_router(feedback_router)
    app.include_router(scheduled_tasks_router)
    app.include_router(sessions_router)
    client = TestClient(app)

    paths = [
        "/api/enterprise/memories?tenant_id=tenant_demo",
        "/api/enterprise/tools?tenant_id=tenant_demo",
        "/api/enterprise/tools/buckets?tenant_id=tenant_demo",
        "/api/enterprise/tools/a2a/codex-adapter",
        "/api/enterprise/tools/tool_demo?tenant_id=tenant_demo",
        "/api/enterprise/tools/tool_demo/a2a-runs?tenant_id=tenant_demo",
        "/api/enterprise/mcp-servers?tenant_id=tenant_demo",
        "/api/enterprise/mcp-servers/server_demo?tenant_id=tenant_demo",
        "/api/enterprise/general-skills?tenant_id=tenant_demo",
        "/api/enterprise/knowledge/jobs?tenant_id=tenant_demo",
        "/api/enterprise/knowledge-bases?tenant_id=tenant_demo",
        "/api/enterprise/model-configs?tenant_id=tenant_demo",
        "/api/enterprise/persona?tenant_id=tenant_demo",
        "/api/enterprise/skills?tenant_id=tenant_demo",
        "/api/enterprise/traces?tenant_id=tenant_demo",
        "/api/enterprise/ui-config?tenant_id=tenant_demo",
        "/api/enterprise/agents?tenant_id=tenant_demo",
        "/api/enterprise/agent-scope?tenant_id=tenant_demo",
        "/api/enterprise/feedback/summary?tenant_id=tenant_demo",
        "/api/enterprise/scheduled-tasks?tenant_id=tenant_demo",
        "/api/enterprise/sessions?tenant_id=tenant_demo",
    ]

    for path in paths:
        response = client.get(path)
        assert response.status_code == 401
        payload = response.json()
        assert payload["detail"]["code"] == "AUTH_NOT_AUTHENTICATED"


def test_tenant_token_with_stale_auth_version_is_rejected() -> None:
    engine = _test_engine()
    _seed_user(engine)
    client = _auth_client(engine)
    login_response = _login(client)
    token = login_response["token"]

    with Session(engine) as db:
        user = db.get(User, "user_alpha")
        assert user is not None
        user.auth_version = 2
        db.add(user)
        db.commit()

    response = client.get("/api/auth/me", headers=_bearer(token))
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "AUTH_INVALID_USER_TOKEN"
    assert _OLD_PASSWORD not in response.text
    assert _NEW_PASSWORD not in response.text
    assert "password_hash" not in response.text


def test_me_returns_bare_tenant_user_without_login_envelope() -> None:
    engine = _test_engine()
    _seed_user(engine)
    client = _auth_client(engine)
    token = _login(client)["token"]

    response = client.get("/api/auth/me", headers=_bearer(token))
    payload = _assert_bare_tenant_user(response, must_change_password=False)
    assert payload["id"] == "user_alpha"
    assert payload["tenant_id"] == "tenant-alpha"
    assert payload["username"] == "admin"


def test_suspended_tenant_invalidates_issued_token_at_auth_and_business_boundaries() -> None:
    engine = _test_engine()
    _seed_user(engine)
    client = _auth_client(engine, include_business_router=True)
    token = _login(client)["token"]

    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant-alpha")
        assert tenant is not None
        tenant.status = "suspended"
        db.add(tenant)
        db.commit()

    me_response = client.get("/api/auth/me", headers=_bearer(token))
    business_response = client.get(
        "/api/enterprise/sessions?tenant_id=tenant-alpha",
        headers=_bearer(token),
    )
    for response in (me_response, business_response):
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "TENANT_SUSPENDED"
        assert response.json()["detail"]["params"] == {}
        assert "tenant-alpha" not in response.text
        assert "Alpha Enterprise" not in response.text
        assert "password_hash" not in response.text


def test_temporary_password_session_can_view_me_but_business_route_is_denied() -> None:
    engine = _test_engine()
    _seed_user(engine, must_change_password=True)
    client = _auth_client(engine, include_business_router=True)
    login_response = _login(client)
    assert login_response["user"]["must_change_password"] is True
    token = login_response["token"]

    me_response = client.get("/api/auth/me", headers=_bearer(token))
    _assert_bare_tenant_user(me_response, must_change_password=True)
    assert _OLD_PASSWORD not in me_response.text
    assert "password_hash" not in me_response.text
    business_response = client.get(
        "/api/enterprise/sessions?tenant_id=tenant-alpha",
        headers=_bearer(token),
    )
    assert business_response.status_code == 403
    assert business_response.json()["detail"]["code"] == "TEMPORARY_PASSWORD_CHANGE_REQUIRED"
    assert _OLD_PASSWORD not in business_response.text
    assert _NEW_PASSWORD not in business_response.text
    assert "password_hash" not in business_response.text


@pytest.mark.parametrize(
    ("current_password", "new_password"),
    [
        (_OLD_PASSWORD, "short"),
        ("Wrong-current-password-2026", _NEW_PASSWORD),
    ],
    ids=["short-new-password", "wrong-current-password"],
)
def test_invalid_password_change_rejects_without_mutating_credentials(
    current_password: str,
    new_password: str,
) -> None:
    engine = _test_engine()
    _seed_user(engine, must_change_password=True)
    client = _auth_client(engine)
    token = _login(client)["token"]

    with Session(engine) as db:
        before = db.get(User, "user_alpha")
        assert before is not None
        before_hash = before.password_hash
        before_auth_version = before.auth_version
        before_must_change = before.must_change_password
        before_password_changed_at = before.password_changed_at

    response = client.post(
        "/api/auth/change-password",
        headers=_bearer(token),
        json={"current_password": current_password, "new_password": new_password},
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] in {
        "AUTH_INVALID_CREDENTIALS",
        "AUTH_LOGIN_FIELDS_REQUIRED",
    }
    assert response.json()["detail"]["params"] == {}
    assert "token" not in response.text
    assert "password_hash" not in response.text
    for private_value in {_OLD_PASSWORD, current_password, new_password}:
        assert private_value not in response.text

    with Session(engine) as db:
        after = db.get(User, "user_alpha")
        assert after is not None
        assert after.password_hash == before_hash
        assert after.auth_version == before_auth_version
        assert after.must_change_password is before_must_change
        assert after.password_changed_at == before_password_changed_at


def test_password_change_rotates_hash_version_and_replaces_session() -> None:
    engine = _test_engine()
    _seed_user(engine, must_change_password=True)
    client = _auth_client(engine, include_business_router=True)
    login_response = _login(client)
    old_token = login_response["token"]

    with Session(engine) as db:
        before = db.get(User, "user_alpha")
        assert before is not None
        old_hash = before.password_hash
        old_auth_version = before.auth_version

    response = client.post(
        "/api/auth/change-password",
        headers=_bearer(old_token),
        json={"current_password": _OLD_PASSWORD, "new_password": _NEW_PASSWORD},
    )
    assert response.status_code == 200, response.text
    payload = _assert_session_shape(response, password_values=(_OLD_PASSWORD, _NEW_PASSWORD))
    new_token = payload["token"]
    assert new_token != old_token

    with Session(engine) as db:
        after = db.get(User, "user_alpha")
        assert after is not None
        assert after.password_hash != old_hash
        assert verify_password(_NEW_PASSWORD, after.password_hash)
        assert not verify_password(_OLD_PASSWORD, after.password_hash)
        assert after.auth_version == old_auth_version + 1
        assert after.must_change_password is False
        assert after.password_changed_at is not None

    old_token_response = client.get("/api/auth/me", headers=_bearer(old_token))
    assert old_token_response.status_code == 401
    assert old_token_response.json()["detail"]["code"] == "AUTH_INVALID_USER_TOKEN"
    replacement_response = client.get("/api/auth/me", headers=_bearer(new_token))
    assert replacement_response.status_code == 200
    business_response = client.get(
        "/api/enterprise/sessions?tenant_id=tenant-alpha",
        headers=_bearer(new_token),
    )
    assert business_response.status_code == 200
    assert _OLD_PASSWORD not in old_token_response.text
    assert _NEW_PASSWORD not in old_token_response.text
    assert _OLD_PASSWORD not in replacement_response.text
    assert _NEW_PASSWORD not in replacement_response.text
    assert "password_hash" not in replacement_response.text


def _test_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _auth_client(engine, *, include_business_router: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(auth_api.router)
    if include_business_router:
        app.include_router(sessions_router)

    def override_get_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _seed_user(engine, *, must_change_password: bool = False) -> None:
    with Session(engine) as db:
        db.add(Tenant(id="tenant-alpha", slug="alpha", name="Alpha Enterprise"))
        db.add(
            User(
                id="user_alpha",
                tenant_id="tenant-alpha",
                username="admin",
                role="admin",
                password_hash=hash_password(_OLD_PASSWORD),
                must_change_password=must_change_password,
            )
        )
        db.commit()


def _login(client: TestClient) -> dict:
    response = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "username": "admin",
            "password": _OLD_PASSWORD,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload) == {"token", "scope", "tenant", "user"}
    assert payload["scope"] == "tenant"
    assert payload["tenant"] == {
        "id": "tenant-alpha",
        "slug": "alpha",
        "display_name": "Alpha Enterprise",
    }
    assert payload["user"]["id"] == "user_alpha"
    assert payload["user"]["tenant_id"] == "tenant-alpha"
    assert payload["user"]["username"] == "admin"
    assert payload["user"]["role"] == "admin"
    assert _OLD_PASSWORD not in response.text
    assert "password_hash" not in response.text
    return payload


def _assert_session_shape(response, *, password_values: tuple[str, ...]) -> dict:
    payload = response.json()
    assert set(payload) == {"token", "scope", "tenant", "user"}
    assert payload["scope"] == "tenant"
    assert payload["tenant"] == {
        "id": "tenant-alpha",
        "slug": "alpha",
        "display_name": "Alpha Enterprise",
    }
    assert {
        "id",
        "tenant_id",
        "username",
        "role",
        "must_change_password",
    } <= set(payload["user"])
    for password in password_values:
        assert password not in response.text
    assert "password_hash" not in response.text
    assert payload["token"]
    return payload


def _assert_bare_tenant_user(response, *, must_change_password: bool) -> dict:
    assert response.status_code == 200, response.text
    payload = response.json()
    allowed_fields = {
        "id",
        "tenant_id",
        "username",
        "display_name",
        "role",
        "must_change_password",
        "avatar_url",
    }
    required_fields = {"id", "tenant_id", "username", "role", "must_change_password"}
    assert required_fields <= set(payload) <= allowed_fields
    assert {"token", "scope", "tenant"}.isdisjoint(payload)
    assert payload["must_change_password"] is must_change_password
    assert "password_hash" not in response.text
    return payload


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.api.auth as auth_api
import app.security.auth as tenant_auth
from app.api.auth import (
    LoginRequest,
    UserCreateRequest,
    UserUpdateRequest,
    create_user,
    login,
    update_user,
)
from app.db import get_session
from app.db.models import InstallationPasswordPolicy, Tenant, User
from app.db.seed import seed_demo_data
from app.security.auth import hash_password

_TEST_APP_SECRET = "t026-tenant-signing-secret"
_ALPHA_PASSWORD = "Alpha-password-2026"
_BETA_PASSWORD = "Beta-password-2026"


@pytest.fixture(autouse=True)
def _test_signing_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    def _settings() -> SimpleNamespace:
        return SimpleNamespace(app_secret=_TEST_APP_SECRET)

    monkeypatch.setattr(tenant_auth, "get_settings", _settings)


def test_unknown_login_does_not_create_account() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        try:
            login(LoginRequest(tenant_id="tenant_demo", username="missing", password="secret"), db)
        except HTTPException as error:
            assert error.status_code == 401
            assert error.detail["code"] == "AUTH_INVALID_CREDENTIALS"
        else:
            raise AssertionError("unknown account must not be created during login")

        assert db.exec(select(User)).all() == []


def test_database_role_controls_account_management() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        member_named_admin = User(
            id="user_named_admin",
            tenant_id="tenant_demo",
            username="admin",
            role="member",
            password_hash=hash_password("secret"),
        )
        role_admin = User(
            id="user_role_admin",
            tenant_id="tenant_demo",
            username="ops",
            role="admin",
            password_hash=hash_password("secret"),
        )
        db.add(member_named_admin)
        db.add(role_admin)
        db.commit()

        try:
            create_user(
                UserCreateRequest(tenant_id="tenant_demo", username="blocked", password="secret12"),
                member_named_admin,
                db,
            )
        except HTTPException as error:
            assert error.status_code == 403
        else:
            raise AssertionError("an admin-looking username must not grant administrator access")

        created = create_user(
            UserCreateRequest(
                tenant_id="tenant_demo",
                username="created_admin",
                password="secret12",
                role="admin",
            ),
            role_admin,
            db,
        )
        assert created.role == "admin"

        updated = update_user(
            created.id,
            UserUpdateRequest(tenant_id="tenant_demo", role="member"),
            role_admin,
            db,
        )
        assert updated.role == "member"


def test_admin_password_update_allows_login_with_unique_display_name() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        admin = User(
            id="admin",
            tenant_id="tenant_demo",
            username="admin",
            role="admin",
            password_hash=hash_password("admin"),
        )
        member = User(
            id="user_demo",
            tenant_id="tenant_demo",
            username="user_demo",
            display_name="zongkelong",
            role="member",
            password_hash=hash_password("old-password"),
        )
        db.add(admin)
        db.add(member)
        db.commit()

        update_user(
            member.id,
            UserUpdateRequest(tenant_id="tenant_demo", password="12345678"),
            admin,
            db,
        )

        session = login(
            LoginRequest(tenant_id="tenant_demo", username="zongkelong", password="12345678"),
            db,
        )

        assert session.user.id == member.id
        assert session.user.username == "user_demo"


def test_admin_password_update_rotates_auth_version_and_records_change() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        admin = User(
            id="admin",
            tenant_id="tenant_demo",
            username="admin",
            role="admin",
            password_hash=hash_password("admin"),
        )
        member = User(
            id="user_demo",
            tenant_id="tenant_demo",
            username="user_demo",
            role="member",
            password_hash=hash_password("old-password"),
        )
        db.add(admin)
        db.add(member)
        db.commit()
        old_token = tenant_auth.create_access_token(member)
        old_version = member.auth_version
        old_changed_at = member.password_changed_at

        update_user(
            member.id,
            UserUpdateRequest(tenant_id="tenant_demo", password="new-password"),
            admin,
            db,
        )

        assert member.auth_version == old_version + 1
        assert member.password_changed_at is not None
        assert member.password_changed_at != old_changed_at
        with pytest.raises(HTTPException) as stale:
            tenant_auth.get_current_user(
                HTTPAuthorizationCredentials(scheme="Bearer", credentials=old_token),
                db,
            )
        assert stale.value.detail["code"] == "AUTH_INVALID_USER_TOKEN"


def test_admin_password_update_failure_does_not_mutate_credentials() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        admin = User(
            id="admin",
            tenant_id="tenant_demo",
            username="admin",
            role="admin",
            password_hash=hash_password("admin"),
        )
        member = User(
            id="user_demo",
            tenant_id="tenant_demo",
            username="user_demo",
            role="member",
            password_hash=hash_password("old-password"),
        )
        db.add(admin)
        db.add(member)
        db.commit()
        before = (member.password_hash, member.auth_version, member.password_changed_at)

        original_display_name = member.display_name
        with pytest.raises(HTTPException) as denied:
            update_user(
                member.id,
                UserUpdateRequest(
                    tenant_id="tenant_demo",
                    display_name="Must Not Persist",
                    password="   ",
                ),
                admin,
                db,
            )

        assert denied.value.status_code == 400
        assert (member.password_hash, member.auth_version, member.password_changed_at) == before
        assert member.display_name == original_display_name


def test_enabled_tenant_complexity_applies_to_self_change_and_admin_update() -> None:
    """Catch self-change and admin updates applying different enabled-complexity policy branches."""
    engine = _test_engine()
    _seed_two_tenants(engine)
    with Session(engine) as db:
        db.add(
            InstallationPasswordPolicy(
                scope="tenant_default",
                min_length=10,
                max_length=12,
                complexity_enabled=True,
                require_uppercase=True,
                require_lowercase=True,
                require_digit=True,
                require_special=True,
            )
        )
        db.add(
            User(
                id="user_member",
                tenant_id="tenant_alpha",
                username="member",
                role="member",
                password_hash=hash_password("Member-old-2026"),
            )
        )
        db.commit()

    client = _api_client(engine)
    login_response = client.post(
        "/api/auth/login",
        json={"tenant_slug": "alpha", "username": "member", "password": "Member-old-2026"},
    )
    assert login_response.status_code == 200, login_response.text
    member_headers = {"Authorization": f"Bearer {login_response.json()['token']}"}
    with Session(engine) as db:
        member = db.get(User, "user_member")
        assert member is not None
        before_self_change = (member.password_hash, member.auth_version, member.password_changed_at)

    rejected_self_change = client.post(
        "/api/auth/change-password",
        json={"current_password": "Member-old-2026", "new_password": "weakpass10"},
        headers=member_headers,
    )
    with Session(engine) as db:
        member = db.get(User, "user_member")
        assert member is not None
        assert (member.password_hash, member.auth_version, member.password_changed_at) == before_self_change

    accepted_self_change = client.post(
        "/api/auth/change-password",
        json={"current_password": "Member-old-2026", "new_password": "MemberA1!2"},
        headers=member_headers,
    )
    assert rejected_self_change.status_code == 400, rejected_self_change.text
    assert accepted_self_change.status_code == 200, accepted_self_change.text

    with Session(engine) as db:
        member = db.get(User, "user_member")
        admin = db.get(User, "user_alpha")
        assert member is not None
        assert admin is not None
        before_admin_update = (member.password_hash, member.auth_version, member.password_changed_at)
        with pytest.raises(HTTPException) as rejected_admin_update:
            update_user(
                member.id,
                UserUpdateRequest(tenant_id="tenant_alpha", password="weakpass10"),
                admin,
                db,
            )
        assert rejected_admin_update.value.status_code == 400
        assert (member.password_hash, member.auth_version, member.password_changed_at) == before_admin_update

        update_user(
            member.id,
            UserUpdateRequest(tenant_id="tenant_alpha", password="AdminSetA1!"),
            admin,
            db,
        )
        assert member.auth_version == before_admin_update[1] + 1


def test_duplicate_display_name_cannot_be_used_to_login() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            User(
                id="member_one",
                tenant_id="tenant_demo",
                username="member_one",
                display_name="duplicate",
                password_hash=hash_password("123456"),
            )
        )
        db.add(
            User(
                id="member_two",
                tenant_id="tenant_demo",
                username="member_two",
                display_name="duplicate",
                password_hash=hash_password("123456"),
            )
        )
        db.commit()

        try:
            login(
                LoginRequest(tenant_id="tenant_demo", username="duplicate", password="123456"),
                db,
            )
        except HTTPException as error:
            assert error.status_code == 401
            assert error.detail["code"] == "AUTH_INVALID_CREDENTIALS"
        else:
            raise AssertionError("an ambiguous display name must not authenticate any account")


def test_unknown_tenant_and_user_paths_verify_against_fixed_dummy_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _test_engine()
    _seed_two_tenants(engine)
    calls: list[tuple[str, str]] = []

    def record_verification(password: str, stored_hash: str) -> bool:
        calls.append((password, stored_hash))
        return False

    monkeypatch.setattr(auth_api, "verify_password", record_verification)
    client = _api_client(engine)
    cases = (
        {"tenant_slug": "missing", "username": "admin", "password": "secret-one"},
        {"tenant_slug": "alpha", "username": "missing", "password": "secret-two"},
    )

    for case in cases:
        response = client.post("/api/auth/login", json=case)
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "AUTH_INVALID_CREDENTIALS"

    assert [password for password, _stored_hash in calls] == [
        "secret-one",
        "secret-two",
    ]
    assert len({stored_hash for _password, stored_hash in calls}) == 1
    assert calls[0][1] == auth_api.DUMMY_PASSWORD_HASH


def test_slug_first_login_resolves_server_tenant_and_returns_bound_session() -> None:
    engine = _test_engine()
    _seed_two_tenants(engine)
    client = _api_client(engine)

    alpha_response = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    beta_response = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "beta",
            "username": "admin",
            "password": _BETA_PASSWORD,
        },
    )

    alpha = _assert_tenant_session(
        alpha_response,
        tenant_id="tenant_alpha",
        tenant_slug="alpha",
        tenant_name="Alpha Enterprise",
        user_id="user_alpha",
        password=_ALPHA_PASSWORD,
    )
    beta = _assert_tenant_session(
        beta_response,
        tenant_id="tenant_beta",
        tenant_slug="beta",
        tenant_name="Beta Enterprise",
        user_id="user_beta",
        password=_BETA_PASSWORD,
    )
    assert alpha["token"] != beta["token"]
    assert alpha["tenant"]["id"] != beta["tenant"]["id"]
    assert alpha["user"]["tenant_id"] == "tenant_alpha"
    assert beta["user"]["tenant_id"] == "tenant_beta"


def test_unknown_slug_unknown_user_bad_password_and_suspended_share_generic_401() -> None:
    engine = _test_engine()
    _seed_two_tenants(engine)
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_suspended",
                slug="suspended",
                name="Suspended Enterprise",
                status="suspended",
            )
        )
        db.add(
            User(
                id="user_suspended",
                tenant_id="tenant_suspended",
                username="admin",
                role="admin",
                password_hash=hash_password(_ALPHA_PASSWORD),
            )
        )
        db.commit()
    client = _api_client(engine)

    cases = [
        {"tenant_slug": "missing", "username": "admin", "password": _ALPHA_PASSWORD},
        {"tenant_slug": "alpha", "username": "missing", "password": _ALPHA_PASSWORD},
        {"tenant_slug": "alpha", "username": "admin", "password": "wrong-password-2026"},
        {"tenant_slug": "suspended", "username": "admin", "password": _ALPHA_PASSWORD},
    ]
    responses = [client.post("/api/auth/login", json=case) for case in cases]

    assert all(response.status_code == 401 for response in responses)
    assert len({response.text for response in responses}) == 1
    for response, case in zip(responses, cases, strict=True):
        assert response.json()["detail"]["code"] == "AUTH_INVALID_CREDENTIALS"
        for private_value in case.values():
            assert private_value not in response.text
        assert "password_hash" not in response.text


def test_suspension_rejects_existing_jwt_and_reactivation_allows_new_login() -> None:
    """Stop an issued tenant session during suspension, then admit a fresh login after reactivation."""
    engine = _test_engine()
    _seed_two_tenants(engine)
    client = _api_client(engine)

    initial = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    assert initial.status_code == 200, initial.text
    old_token = initial.json()["token"]

    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant_alpha")
        assert tenant is not None
        tenant.status = "suspended"
        tenant.lifecycle_version = 2
        tenant.suspension_reason = "operator hold"
        db.add(tenant)
        db.commit()

    existing_session = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert existing_session.status_code == 403
    assert existing_session.json()["detail"]["code"] == "TENANT_SUSPENDED"

    suspended_login = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    assert suspended_login.status_code == 401
    assert suspended_login.json()["detail"]["code"] == "AUTH_INVALID_CREDENTIALS"
    assert old_token not in suspended_login.text

    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant_alpha")
        assert tenant is not None
        tenant.status = "active"
        tenant.lifecycle_version = 3
        tenant.suspension_reason = None
        db.add(tenant)
        db.commit()

    fresh_login = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    assert fresh_login.status_code == 200, fresh_login.text
    assert fresh_login.json()["tenant"]["id"] == "tenant_alpha"


def test_deprecated_tenant_id_requires_exact_match_and_rejects_slug_id_mismatch() -> None:
    engine = _test_engine()
    _seed_two_tenants(engine)
    client = _api_client(engine)

    legacy_response = client.post(
        "/api/auth/login",
        json={
            "tenant_id": "tenant_alpha",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    _assert_tenant_session(
        legacy_response,
        tenant_id="tenant_alpha",
        tenant_slug="alpha",
        tenant_name="Alpha Enterprise",
        user_id="user_alpha",
        password=_ALPHA_PASSWORD,
    )

    unknown_legacy_response = client.post(
        "/api/auth/login",
        json={
            "tenant_id": "tenant_missing",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    mismatch_response = client.post(
        "/api/auth/login",
        json={
            "tenant_slug": "alpha",
            "tenant_id": "tenant_beta",
            "username": "admin",
            "password": _ALPHA_PASSWORD,
        },
    )
    for response in (unknown_legacy_response, mismatch_response):
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "AUTH_INVALID_CREDENTIALS"
        assert _ALPHA_PASSWORD not in response.text
        assert "password_hash" not in response.text


def test_seeded_demo_tenant_uses_demo_slug_for_tenant_login() -> None:
    engine = _test_engine()
    with Session(engine) as db:
        seed_demo_data(db)
        tenant = db.get(Tenant, "tenant_demo")
        assert tenant is not None
        assert tenant.slug == "demo"
        assert tenant.status == "active"

    response = _api_client(engine).post(
        "/api/auth/login",
        json={"tenant_slug": "demo", "username": "user_demo", "password": "demo"},
    )
    _assert_tenant_session(
        response,
        tenant_id="tenant_demo",
        tenant_slug="demo",
        tenant_name="Demo Enterprise",
        user_id="user_demo",
        username="user_demo",
        role="member",
        password=None,
    )


def _test_session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _test_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _api_client(engine) -> TestClient:
    app = FastAPI()
    app.include_router(auth_api.router)

    def override_get_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _seed_two_tenants(engine) -> None:
    with Session(engine) as db:
        db.add(Tenant(id="tenant_alpha", slug="alpha", name="Alpha Enterprise"))
        db.add(Tenant(id="tenant_beta", slug="beta", name="Beta Enterprise"))
        db.add(
            User(
                id="user_alpha",
                tenant_id="tenant_alpha",
                username="admin",
                role="admin",
                password_hash=hash_password(_ALPHA_PASSWORD),
            )
        )
        db.add(
            User(
                id="user_beta",
                tenant_id="tenant_beta",
                username="admin",
                role="admin",
                password_hash=hash_password(_BETA_PASSWORD),
            )
        )
        db.commit()


def _assert_tenant_session(
    response,
    *,
    tenant_id: str,
    tenant_slug: str,
    tenant_name: str,
    user_id: str,
    password: str | None,
    username: str = "admin",
    role: str = "admin",
) -> dict:
    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload) == {"token", "scope", "tenant", "user"}
    assert payload["scope"] == "tenant"
    assert set(payload["tenant"]) == {"id", "slug", "display_name"}
    assert payload["tenant"] == {
        "id": tenant_id,
        "slug": tenant_slug,
        "display_name": tenant_name,
    }
    assert {
        "id",
        "tenant_id",
        "username",
        "role",
        "must_change_password",
    } <= set(payload["user"])
    assert payload["user"]["id"] == user_id
    assert payload["user"]["tenant_id"] == tenant_id
    assert payload["user"]["username"] == username
    assert payload["user"]["role"] == role
    if password is not None:
        assert password not in response.text
    assert "password_hash" not in response.text
    assert payload["token"]
    return payload

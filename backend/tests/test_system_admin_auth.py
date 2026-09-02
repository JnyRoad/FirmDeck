"""RED behavior contracts for mutually exclusive system and tenant bearer tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib
import importlib.util
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import models
from app.security import auth

_TENANT_SECRET = "t004-t007-tenant-test-secret"
_SYSTEM_SECRET = "t004-t007-system-test-secret"


def _token_payload(token: str) -> dict[str, object]:
    """Read a token's non-secret payload so tests can assert the issued claims."""
    body = token.split(".", 1)[0]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def _sign_claims(claims: dict[str, object], secret: str) -> str:
    """Create a controlled signed token to exercise decoder claim rejection without real secrets."""
    body = (
        base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
        .decode("utf-8")
        .rstrip("=")
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
        )
        .decode("utf-8")
        .rstrip("=")
    )
    return f"{body}.{signature}"


def _credentials(token: str) -> HTTPAuthorizationCredentials:
    """Build one direct bearer dependency input without starting an HTTP server."""
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _session() -> Session:
    """Create an isolated in-memory database containing the current SQLModel schema."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _system_auth_module():
    """Load the planned system authenticator only after reporting its missing boundary as RED."""
    assert importlib.util.find_spec("app.security.system_admin_auth") is not None, (
        "T011 must provide app.security.system_admin_auth for separately signed system principals"
    )
    module = importlib.import_module("app.security.system_admin_auth")
    required = (
        "create_system_access_token",
        "decode_system_access_token",
        "get_current_system_admin",
        "SystemAuthUnavailable",
    )
    for name in required:
        assert getattr(module, name, None) is not None, f"T011 missing system auth contract: {name}"
    assert getattr(models, "SystemAdmin", None) is not None, "T008 must define SystemAdmin"
    return module


def _settings(system_secret: str = _SYSTEM_SECRET) -> SimpleNamespace:
    """Return an in-memory setting object that deliberately contains only test-only secrets."""
    return SimpleNamespace(app_secret=_TENANT_SECRET, system_admin_secret=system_secret)


def _active_tenant_user() -> tuple[models.Tenant, models.User]:
    """Build the active versioned tenant principal used by token dependency tests."""
    tenant = models.Tenant(id="tenant_1", name="Tenant One", status="active", lifecycle_version=1)
    user = models.User(
        id="tenant-user",
        tenant_id=tenant.id,
        username="ada",
        password_hash="hash",
        auth_version=1,
    )
    return tenant, user


def _active_system_admin():
    """Build the active versioned control-plane principal without tenant identity."""
    admin_type = getattr(models, "SystemAdmin", None)
    assert admin_type is not None, "T008 must define SystemAdmin"
    return admin_type(
        id="system-admin",
        username="root",
        password_hash="hash",
        status="active",
        auth_version=1,
    )


def _assert_system_rejected(action) -> None:
    """Assert one system denial is generic and carries no branch-specific claim data."""
    with pytest.raises(HTTPException) as error:
        action()
    assert error.value.status_code == 401
    assert error.value.detail["code"] == "SYSTEM_AUTH_INVALID_CREDENTIALS"
    assert "tenant_id" not in repr(error.value.detail)
    assert "auth_version" not in repr(error.value.detail)


def _assert_tenant_rejected(action) -> None:
    """Assert malformed tenant claims fail through a safe registered 401 contract."""
    with pytest.raises(HTTPException) as error:
        action()
    assert error.value.status_code == 401
    assert error.value.detail["code"] == "AUTH_INVALID_TOKEN_PAYLOAD"
    assert "tenant_id" not in repr(error.value.detail)
    assert "auth_version" not in repr(error.value.detail)


@pytest.mark.parametrize(
    "settings",
    [
        SimpleNamespace(app_secret=_TENANT_SECRET, system_admin_secret="short"),
        SimpleNamespace(app_secret=_TENANT_SECRET, system_admin_secret=_TENANT_SECRET),
    ],
)
def test_system_signer_rejects_short_or_tenant_shared_secret(monkeypatch, settings) -> None:
    """Fail closed when the control-plane signer is weak or reuses tenant signing material."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: settings)

    with pytest.raises(system_auth.SystemAuthUnavailable):
        system_auth.create_system_access_token(_active_system_admin())


def test_tenant_token_issuance_and_dependency_require_tenant_claims_and_current_version(
    monkeypatch,
) -> None:
    """Issue a tenant token, authenticate it, then reject changed auth version and wrong domain claims."""
    monkeypatch.setattr(auth, "get_settings", lambda: _settings())
    with _session() as db:
        tenant, user = _active_tenant_user()
        db.add(tenant)
        db.add(user)
        db.commit()

        token = auth.create_access_token(user)
        payload = _token_payload(token)
        assert payload == {
            "tenant_id": "tenant_1",
            "user_id": "tenant-user",
            "username": "ada",
            "principal_type": "tenant_user",
            "aud": "tenant_data_plane",
            "auth_version": 1,
            "exp": payload["exp"],
        }
        assert isinstance(payload["exp"], int)
        assert auth.get_current_user(_credentials(token), db).id == user.id

        user.auth_version = 2
        db.add(user)
        db.commit()
        with pytest.raises(HTTPException) as stale:
            auth.get_current_user(_credentials(token), db)
        assert stale.value.status_code == 401

        wrong_audience = _sign_claims({**payload, "aud": "system_control_plane"}, _TENANT_SECRET)
        wrong_type = _sign_claims({**payload, "principal_type": "system_admin"}, _TENANT_SECRET)
        with pytest.raises(HTTPException) as audience_error:
            auth.get_current_user(_credentials(wrong_audience), db)
        with pytest.raises(HTTPException) as type_error:
            auth.get_current_user(_credentials(wrong_type), db)
        assert audience_error.value.status_code == type_error.value.status_code == 401
        assert audience_error.value.detail["code"] == type_error.value.detail["code"]


def test_system_tokens_use_a_separate_secret_and_resolve_only_active_system_admins(
    monkeypatch,
) -> None:
    """Issue and resolve a system token whose signature and claims cannot belong to tenant auth."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    with _session() as db:
        admin = _active_system_admin()
        db.add(admin)
        db.commit()

        token = system_auth.create_system_access_token(admin)
        payload = _token_payload(token)
        assert payload["principal_type"] == "system_admin"
        assert payload["aud"] == "system_control_plane"
        assert payload["sub"] == admin.id
        assert payload["auth_version"] == 1
        assert "tenant_id" not in payload
        assert system_auth.get_current_system_admin(_credentials(token), db).id == admin.id

        tenant_signature = _sign_claims(payload, _TENANT_SECRET)
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(tenant_signature), db)
        )


def test_missing_system_secret_disables_issue_decode_and_dependency(monkeypatch) -> None:
    """Reject every system-auth action when the separately configured signer is unavailable."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings(system_secret=""))
    with _session() as db:
        admin = _active_system_admin()
        db.add(admin)
        db.commit()

        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.create_system_access_token(admin)
        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.decode_system_access_token("not-a-token")
        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.get_current_system_admin(_credentials("not-a-token"), db)


def test_system_dependency_rejects_disabled_missing_expired_and_stale_principals(
    monkeypatch,
) -> None:
    """Deny each system principal validity failure with the same non-enumerating public response."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    with _session() as db:
        admin = _active_system_admin()
        db.add(admin)
        db.commit()
        token = system_auth.create_system_access_token(admin)
        payload = _token_payload(token)

        admin.status = "disabled"
        db.add(admin)
        db.commit()
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(token), db)
        )

        admin.status = "active"
        admin.auth_version = 2
        db.add(admin)
        db.commit()
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(token), db)
        )

        expired = _sign_claims({**payload, "exp": int(time.time()) - 1}, _SYSTEM_SECRET)
        missing = _sign_claims({**payload, "sub": "missing-admin"}, _SYSTEM_SECRET)
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(expired), db)
        )
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(missing), db)
        )


def test_system_dependency_rejects_wrong_audience_type_and_tenant_tokens(monkeypatch) -> None:
    """Keep semantic token-domain rejection generic even when the signature is otherwise valid."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    monkeypatch.setattr(auth, "get_settings", lambda: _settings())
    with _session() as db:
        tenant, user = _active_tenant_user()
        admin = _active_system_admin()
        db.add(tenant)
        db.add(user)
        db.add(admin)
        db.commit()
        system_payload = _token_payload(system_auth.create_system_access_token(admin))
        wrong_audience = _sign_claims(
            {**system_payload, "aud": "tenant_data_plane"}, _SYSTEM_SECRET
        )
        wrong_type = _sign_claims(
            {**system_payload, "principal_type": "tenant_user"}, _SYSTEM_SECRET
        )
        tenant_token = auth.create_access_token(user)

        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(wrong_audience), db)
        )
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(wrong_type), db)
        )
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(tenant_token), db)
        )

        with pytest.raises(HTTPException) as tenant_dependency:
            auth.get_current_user(_credentials(system_auth.create_system_access_token(admin)), db)
        assert tenant_dependency.value.status_code == 401


@pytest.mark.parametrize(
    ("claim", "invalid_value"),
    [
        ("tenant_id", 7),
        ("user_id", None),
        ("username", ["ada"]),
        ("principal_type", True),
        ("aud", {"value": "tenant_data_plane"}),
        ("auth_version", True),
        ("auth_version", 0),
        ("exp", str(int(time.time()) + 60)),
        ("exp", True),
    ],
)
def test_tenant_dependency_rejects_malformed_claim_types(
    monkeypatch,
    claim: str,
    invalid_value: object,
) -> None:
    """Reject tenant tokens whose required claims are not exact non-empty scalar types."""
    monkeypatch.setattr(auth, "get_settings", lambda: _settings())
    with _session() as db:
        tenant, user = _active_tenant_user()
        db.add(tenant)
        db.add(user)
        db.commit()
        payload = _token_payload(auth.create_access_token(user))
        malformed = _sign_claims({**payload, claim: invalid_value}, _TENANT_SECRET)

        _assert_tenant_rejected(lambda: auth.get_current_user(_credentials(malformed), db))


@pytest.mark.parametrize("forbidden_claim", ["sub", "system_admin_id", "impersonation"])
def test_tenant_dependency_rejects_system_or_impersonation_claims(
    monkeypatch,
    forbidden_claim: str,
) -> None:
    """Reject otherwise valid tenant tokens that carry control-plane or impersonation semantics."""
    monkeypatch.setattr(auth, "get_settings", lambda: _settings())
    with _session() as db:
        tenant, user = _active_tenant_user()
        db.add(tenant)
        db.add(user)
        db.commit()
        payload = _token_payload(auth.create_access_token(user))
        mixed_domain = _sign_claims({**payload, forbidden_claim: "forbidden"}, _TENANT_SECRET)

        _assert_tenant_rejected(lambda: auth.get_current_user(_credentials(mixed_domain), db))


@pytest.mark.parametrize(
    ("claim", "invalid_value"),
    [
        ("sub", 7),
        ("principal_type", ["system_admin"]),
        ("aud", True),
        ("auth_version", True),
        ("auth_version", 0),
        ("exp", str(int(time.time()) + 60)),
        ("exp", True),
    ],
)
def test_system_dependency_rejects_malformed_claim_types(
    monkeypatch,
    claim: str,
    invalid_value: object,
) -> None:
    """Reject system tokens whose required claims are not exact non-empty scalar types."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    with _session() as db:
        admin = _active_system_admin()
        db.add(admin)
        db.commit()
        payload = _token_payload(system_auth.create_system_access_token(admin))
        malformed = _sign_claims({**payload, claim: invalid_value}, _SYSTEM_SECRET)

        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(malformed), db)
        )


@pytest.mark.parametrize(
    "forbidden_claim",
    ["tenant_id", "role", "username", "api_key", "impersonation"],
)
def test_system_dependency_rejects_tenant_and_impersonation_claims(
    monkeypatch,
    forbidden_claim: str,
) -> None:
    """Reject otherwise valid system tokens that carry tenant or impersonation semantics."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    with _session() as db:
        admin = _active_system_admin()
        db.add(admin)
        db.commit()
        payload = _token_payload(system_auth.create_system_access_token(admin))
        mixed_domain = _sign_claims({**payload, forbidden_claim: "forbidden"}, _SYSTEM_SECRET)

        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials(mixed_domain), db)
        )


def test_system_dependency_rejects_missing_or_malformed_credentials_generically(
    monkeypatch,
) -> None:
    """Return the same generic denial for absent bearer input and malformed token structure."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())
    with _session() as db:
        _assert_system_rejected(lambda: system_auth.get_current_system_admin(None, db))
        _assert_system_rejected(
            lambda: system_auth.get_current_system_admin(_credentials("not-a-token"), db)
        )


@pytest.mark.parametrize("token", ["a.é", "a.💥", "é.a", "测试.a", "💥.é"])
def test_system_decoder_rejects_unicode_token_segments_with_the_generic_denial(
    monkeypatch,
    token: str,
) -> None:
    """Keep Unicode token segments on the same safe 401 path without echoing supplied text."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings())

    with pytest.raises(HTTPException) as expected_error:
        system_auth.decode_system_access_token("not-a-token")
    with pytest.raises(HTTPException) as unicode_error:
        system_auth.decode_system_access_token(token)

    assert unicode_error.value.status_code == expected_error.value.status_code == 401
    assert unicode_error.value.detail == expected_error.value.detail
    assert token not in repr(unicode_error.value.detail)


@pytest.mark.parametrize("system_secret", [" ", "\t", " secret", "secret ", "\nsecret"])
def test_boundary_whitespace_system_secret_disables_every_auth_action(
    monkeypatch,
    system_secret: str,
) -> None:
    """Disable system authentication when its secret is blank or has boundary whitespace."""
    system_auth = _system_auth_module()
    monkeypatch.setattr(system_auth, "get_settings", lambda: _settings(system_secret=system_secret))
    with _session() as db:
        admin = _active_system_admin()

        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.create_system_access_token(admin)
        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.decode_system_access_token("not-a-token")
        with pytest.raises(system_auth.SystemAuthUnavailable):
            system_auth.get_current_system_admin(None, db)

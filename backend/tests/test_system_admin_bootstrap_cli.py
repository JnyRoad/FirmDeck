"""RED contracts for local fixed system-administrator bootstrap behavior."""

from __future__ import annotations

from types import SimpleNamespace

from sqlmodel import Session, SQLModel, create_engine

from app.db.models import SystemAdmin
from app.security import system_admin_auth
from app.security.auth import hash_password
from app.system_admin.service import bootstrap_system_admin


def test_bootstrap_creates_fixed_temporary_sysadmin_account() -> None:
    """Catch bootstrap accepting arbitrary credentials or skipping its forced first replacement."""
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        result = bootstrap_system_admin(db)
        created = db.get(SystemAdmin, result.admin_id)

    assert result.created is True
    assert created is not None
    assert created.username == "sysadmin"
    assert getattr(created, "must_change_password", None) is True
    assert getattr(created, "password_changed_at", "not-a-field") is None


def test_temporary_system_token_cannot_list_tenants_before_password_change(
    tmp_path, monkeypatch
) -> None:
    """Catch privileged routes accepting a first-login token before mandatory replacement."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import system_admin as system_api
    from app.db import get_session
    from app.security.auth import hash_password

    engine = create_engine(f"sqlite:///{tmp_path / 'system-admin.db'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(
        system_admin_auth,
        "get_settings",
        lambda: SimpleNamespace(system_admin_secret="system-admin-test-secret"),
    )
    with Session(engine) as db:
        admin = SystemAdmin(
            id="sysadmin-root",
            username="sysadmin",
            password_hash=hash_password("sysadmin"),
            must_change_password=True,
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)
        temporary_token = system_admin_auth.create_system_access_token(admin)
    app = FastAPI()
    app.include_router(system_api.router)

    def override_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_session
    client = TestClient(app)
    response = client.get(
        "/api/system/tenants",
        headers={"Authorization": f"Bearer {temporary_token}"},
    )
    policy_response = client.get(
        "/api/system/password-policies",
        headers={"Authorization": f"Bearer {temporary_token}"},
    )
    policy_update_response = client.put(
        "/api/system/password-policies",
        headers={"Authorization": f"Bearer {temporary_token}"},
        json={
            "system": {
                "min_length": 12,
                "max_length": 20,
                "complexity_enabled": False,
                "require_uppercase": False,
                "require_lowercase": False,
                "require_digit": False,
                "require_special": False,
            }
        },
    )

    assert response.status_code == 403
    assert policy_response.status_code == 200
    assert policy_update_response.status_code == 403


def test_system_password_policies_expose_strict_installation_and_tenant_defaults(
    tmp_path, monkeypatch
) -> None:
    """Catch a missing durable policy surface or a default that permits weak credentials."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import system_admin as system_api
    from app.db import get_session

    engine = create_engine(f"sqlite:///{tmp_path / 'password-policy.db'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(
        system_admin_auth,
        "get_settings",
        lambda: SimpleNamespace(system_admin_secret="system-admin-test-secret"),
    )
    with Session(engine) as db:
        admin = SystemAdmin(
            id="sysadmin-root",
            username="sysadmin",
            password_hash=hash_password("Ab1!sysadmin"),
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)
        headers = {"Authorization": f"Bearer {system_admin_auth.create_system_access_token(admin)}"}

    app = FastAPI()
    app.include_router(system_api.router)

    def override_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_session
    response = TestClient(app).get("/api/system/password-policies", headers=headers)

    assert response.status_code == 200
    assert response.json() == {
        "system": {
            "min_length": 8,
            "max_length": 20,
            "complexity_enabled": False,
            "require_uppercase": True,
            "require_lowercase": True,
            "require_digit": True,
            "require_special": True,
        },
        "tenant_default": {
            "min_length": 8,
            "max_length": 20,
            "complexity_enabled": False,
            "require_uppercase": True,
            "require_lowercase": True,
            "require_digit": True,
            "require_special": True,
        },
    }

"""RED contracts for explicit tenant and system A2A ownership."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.a2a import codex_adapter
from app.db.models import A2ATaskEvent, A2ATaskRun, Tenant

_CODEX_A2A_TOKEN = "t004-a2a-test-token"


def _fresh_session() -> Session:
    """Create a fresh in-memory schema so owner constraints are exercised through the real database."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _tenant_run(**overrides) -> A2ATaskRun:
    """Build one valid tenant-owned client run with its positive durable admission version."""
    values = {
        "owner_scope": "tenant",
        "tenant_id": "tenant_1",
        "system_runtime_key": None,
        "tenant_lifecycle_version": 1,
        "direction": "client",
        "endpoint_url": "https://a2a.example.test",
    }
    values.update(overrides)
    return A2ATaskRun(**values)


def _system_run(**overrides) -> A2ATaskRun:
    """Build one valid installation-owned Codex server run without tenant identity."""
    values = {
        "owner_scope": "system",
        "tenant_id": None,
        "system_runtime_key": "codex_a2a",
        "tenant_lifecycle_version": None,
        "direction": "server",
        "endpoint_url": "http://127.0.0.1:9311",
    }
    values.update(overrides)
    return A2ATaskRun(**values)


def _commit_and_reload(session: Session, run: A2ATaskRun) -> A2ATaskRun:
    """Persist one owner shape and reload it so SQL constraints and nullable columns are both tested."""
    session.add(run)
    session.commit()
    stored = session.get(A2ATaskRun, run.id)
    assert stored is not None
    session.refresh(stored)
    session.expunge(stored)
    return stored


def _raw_owner_shape_values(overrides) -> dict[str, object]:
    """Build Core INSERT values that bypass model validation but include every ownership contract column."""
    values: dict[str, object] = {
        "id": "a2arun_invalid_owner_shape",
        "owner_scope": "tenant",
        "tenant_id": "tenant_1",
        "system_runtime_key": None,
        "tenant_lifecycle_version": 1,
        "direction": "client",
        "endpoint_url": "https://a2a.example.test",
    }
    values.update(overrides)
    return values


def _owner_shape_table():
    """Return the mapped table only after T008 has made every Core ownership column real."""
    table = A2ATaskRun.__table__
    expected_columns = {
        "owner_scope",
        "tenant_id",
        "system_runtime_key",
        "tenant_lifecycle_version",
        "direction",
        "endpoint_url",
    }
    assert expected_columns <= set(table.c.keys()), "T008 must add explicit persisted A2A ownership columns"
    return table


def _codex_client(monkeypatch, tmp_path) -> tuple[TestClient, object]:
    """Create an enabled but process-free Codex adapter against a new in-memory persistence engine."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    settings = SimpleNamespace(
        codex_a2a_enabled=True,
        codex_a2a_token=_CODEX_A2A_TOKEN,
        codex_a2a_workspace_root=str(tmp_path / "workspaces"),
        codex_a2a_command="codex",
        codex_a2a_timeout_seconds=30,
    )
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(codex_adapter, "get_settings", lambda: settings)
    monkeypatch.setattr(codex_adapter, "_launch", lambda *_args, **_kwargs: None)
    app = FastAPI()
    app.include_router(codex_adapter.router)
    return TestClient(app), engine


def test_fresh_a2a_tenant_and_system_owner_shapes_commit_and_reload() -> None:
    """Require both legal owner shapes to survive the fresh schema with their exclusive fields intact."""
    with _fresh_session() as session:
        tenant_run = _commit_and_reload(session, _tenant_run())
        system_run = _commit_and_reload(session, _system_run())

    assert (tenant_run.owner_scope, tenant_run.tenant_id, tenant_run.system_runtime_key) == (
        "tenant",
        "tenant_1",
        None,
    )
    assert tenant_run.tenant_lifecycle_version == 1
    assert (system_run.owner_scope, system_run.tenant_id, system_run.system_runtime_key) == (
        "system",
        None,
        "codex_a2a",
    )
    assert system_run.tenant_lifecycle_version is None


@pytest.mark.parametrize(
    ("overrides", "missing_field"),
    [
        ({}, "owner_scope"),
        ({"owner_scope": None}, None),
        ({"owner_scope": "unknown"}, None),
        ({"owner_scope": "tenant", "tenant_id": None}, None),
        ({"owner_scope": "tenant", "system_runtime_key": "codex_a2a"}, None),
        ({"owner_scope": "tenant", "tenant_lifecycle_version": None}, None),
        ({"owner_scope": "tenant", "tenant_lifecycle_version": 0}, None),
        ({"owner_scope": "tenant", "tenant_lifecycle_version": -1}, None),
        ({"owner_scope": "system", "tenant_id": "tenant_1"}, None),
        ({"owner_scope": "system", "system_runtime_key": ""}, None),
        ({"owner_scope": "system", "system_runtime_key": None}, None),
        ({"owner_scope": "system", "tenant_lifecycle_version": 1}, None),
        ({"direction": "unknown"}, None),
    ],
)
def test_invalid_a2a_owner_shapes_are_rejected_by_ordinary_construction(
    overrides,
    missing_field,
) -> None:
    """Reject invalid owner rows before direct SQLModel table-model construction can continue."""
    values = _raw_owner_shape_values(overrides)
    if missing_field is not None:
        values.pop(missing_field)

    with pytest.raises(ValueError, match="owner shape|direction"):
        A2ATaskRun(**values)


def test_model_validate_keeps_the_same_owner_shape_contract() -> None:
    """Keep explicit Pydantic validation aligned with the ordinary constructor guard."""
    values = _raw_owner_shape_values({"owner_scope": "system", "tenant_id": "tenant_1"})

    with pytest.raises(ValidationError, match="owner shape"):
        A2ATaskRun.model_validate(values)


@pytest.mark.parametrize(
    "overrides",
    [
        {"owner_scope": None},
        {"owner_scope": "unknown"},
        {"owner_scope": "tenant", "tenant_id": None},
        {"owner_scope": "tenant", "system_runtime_key": "codex_a2a"},
        {"owner_scope": "tenant", "tenant_lifecycle_version": None},
        {"owner_scope": "tenant", "tenant_lifecycle_version": 0},
        {"owner_scope": "tenant", "tenant_lifecycle_version": -1},
        {"owner_scope": "system", "tenant_id": "tenant_1"},
        {"owner_scope": "system", "system_runtime_key": ""},
        {"owner_scope": "system", "system_runtime_key": None},
        {"owner_scope": "system", "tenant_lifecycle_version": 1},
        {"direction": "unknown"},
    ],
)
def test_invalid_a2a_owner_shapes_are_rejected_by_fresh_schema_checks(overrides) -> None:
    """Require SQLite CHECK constraints to reject every mixed, empty, invalid, or stale owner shape."""
    table = _owner_shape_table()
    with _fresh_session() as session:
        with pytest.raises(IntegrityError, match="CHECK constraint failed"):
            session.execute(table.insert().values(_raw_owner_shape_values(overrides)))
            session.commit()
        session.rollback()


def test_a2a_events_own_only_their_run_and_not_a_second_owner_shape() -> None:
    """Require event authorization to resolve ownership through the run rather than duplicate columns."""
    event_fields = set(A2ATaskEvent.model_fields)

    assert "run_id" in event_fields
    assert {"tenant_id", "owner_scope", "system_runtime_key"}.isdisjoint(event_fields)


def test_tenant_slug_fallback_only_applies_when_slug_is_omitted() -> None:
    """Keep the legacy constructor bridge narrow and reject an explicit null slug."""
    assert Tenant(id="tenant_demo", name="Demo").slug == "demo"

    with pytest.raises(ValueError, match="slug cannot be null"):
        Tenant(id="tenant_demo", name="Demo", slug=None)


def test_codex_submission_writer_persists_system_owner_without_pseudo_tenant(monkeypatch, tmp_path) -> None:
    """Submit through the real server writer and require its durable row to be system-owned, not fake tenant work."""
    client, engine = _codex_client(monkeypatch, tmp_path)
    response = client.post(
        "/api/a2a/codex",
        headers={"Authorization": f"Bearer {_CODEX_A2A_TOKEN}"},
        json={
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "message-1",
                    "role": "ROLE_USER",
                    "parts": [{"text": "system runtime submission"}],
                }
            },
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        run = session.exec(select(A2ATaskRun)).one()
        assert (run.owner_scope, run.tenant_id, run.system_runtime_key) == (
            "system",
            None,
            "codex_a2a",
        )
        assert run.tenant_lifecycle_version is None
        assert session.exec(select(Tenant)).all() == []


def test_codex_recovery_launches_only_the_codex_system_owner_shape(monkeypatch, tmp_path) -> None:
    """Recovery must not redispatch tenant-owned or unrelated system-runtime rows."""
    client, engine = _codex_client(monkeypatch, tmp_path)
    del client
    with Session(engine) as session:
        session.add(
            A2ATaskRun(
                id="a2a-system-recover",
                owner_scope="system",
                direction="server",
                tenant_id=None,
                system_runtime_key="codex_a2a",
                tenant_lifecycle_version=None,
                endpoint_url="local://codex",
                status="working",
            )
        )
        session.add(
            A2ATaskRun(
                id="a2a-other-runtime-recover",
                owner_scope="system",
                direction="server",
                tenant_id=None,
                system_runtime_key="other_runtime",
                tenant_lifecycle_version=None,
                endpoint_url="local://other",
                status="working",
            )
        )
        session.add(
            A2ATaskRun(
                id="a2a-tenant-recover",
                owner_scope="tenant",
                direction="server",
                tenant_id="tenant_1",
                system_runtime_key=None,
                tenant_lifecycle_version=1,
                endpoint_url="https://agent.example.test/a2a",
                status="working",
            )
        )
        session.commit()

    launches: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        codex_adapter,
        "_launch",
        lambda task_id, recovery=False: launches.append((task_id, recovery)),
    )

    codex_adapter.recover_codex_a2a_tasks()

    assert launches == [("a2a-system-recover", True)]

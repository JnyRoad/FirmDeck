from __future__ import annotations

import json

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel, create_engine

from app.db import database
from app.db import models as _db_models  # noqa: F401


def test_wechat_kf_accounts_migration_is_additive_idempotent_and_backfills(
    monkeypatch, tmp_path
) -> None:
    """An existing binding gains one durable account row without destructive schema changes."""
    db_path = tmp_path / "wechat-kf-migration.db"
    engine = create_engine(f"sqlite:///{db_path}")
    existing_tables = [
        table
        for table in SQLModel.metadata.sorted_tables
        if table.name not in {"wechat_kf_accounts", "wechat_kf_account_operations"}
    ]
    SQLModel.metadata.create_all(engine, tables=existing_tables)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS app_data_migrations "
                "(id VARCHAR PRIMARY KEY, applied_at DATETIME)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO tenants (id, name, created_at, updated_at) "
                "VALUES ('tenant_a', 'Tenant A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO channel_bindings "
                "(id, tenant_id, agent_id, channel, status, config_json, config_revision, "
                "connected, created_at, updated_at) VALUES "
                "(:id, :tenant_id, :agent_id, 'wechat_kf', 'active', :config_json, 3, 0, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {
                "id": "chan-kf",
                "tenant_id": "tenant_a",
                "agent_id": "agent_a",
                "config_json": json.dumps(
                    {"corp_id": "corp-a", "open_kfid": "wk-existing"}
                ),
            },
        )
    monkeypatch.setattr(database, "database_url", f"sqlite:///{db_path}")
    monkeypatch.setattr(database, "engine", engine)
    assert "wechat_kf_accounts" not in inspect(engine).get_table_names()
    assert "wechat_kf_account_operations" not in inspect(engine).get_table_names()
    migration_calls: list[set[str]] = []
    migrate_wechat_kf_accounts = database._migrate_wechat_kf_accounts

    def record_migration_call(conn, tables: set[str]) -> None:
        """Record dispatcher integration while running the real additive migration."""
        migration_calls.append(set(tables))
        migrate_wechat_kf_accounts(conn, tables)

    monkeypatch.setattr(database, "_migrate_wechat_kf_accounts", record_migration_call)

    database._migrate_sqlite_skill_schema()
    database._migrate_sqlite_skill_schema()

    inspector = inspect(engine)
    assert len(migration_calls) == 2
    assert "wechat_kf_accounts" not in migration_calls[0]
    assert "wechat_kf_accounts" in inspector.get_table_names()
    assert "wechat_kf_account_operations" in inspector.get_table_names()
    columns = {column["name"] for column in inspector.get_columns("wechat_kf_accounts")}
    assert {
        "id",
        "tenant_id",
        "binding_id",
        "open_kfid",
        "agent_id",
        "team_id",
        "status",
        "sync_cursor",
    } <= columns
    operation_columns = {
        column["name"]
        for column in inspector.get_columns("wechat_kf_account_operations")
    }
    assert {
        "id",
        "tenant_id",
        "binding_id",
        "kind",
        "status",
        "open_kfid",
        "desired_name",
        "desired_media_id",
        "binding_revision",
        "attempts",
        "last_error_code",
        "provider_applied_at",
        "completed_at",
    } <= operation_columns
    with engine.begin() as conn:
        row = conn.execute(text("SELECT * FROM wechat_kf_accounts")).mappings().one()
        assert row["tenant_id"] == "tenant_a"
        assert row["binding_id"] == "chan-kf"
        assert row["open_kfid"] == "wk-existing"
        assert row["agent_id"] == "agent_a"
        assert row["status"] == "active"
        assert row["sync_cursor"] == ""

    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO wechat_kf_accounts "
                "(id, tenant_id, binding_id, open_kfid, status, sync_cursor, created_at, updated_at) "
                "VALUES ('dup-binding', 'tenant_b', 'chan-kf', 'wk-existing', 'active', '', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO wechat_kf_accounts "
                "(id, tenant_id, binding_id, open_kfid, status, sync_cursor, created_at, updated_at) "
                "VALUES ('dup-tenant', 'tenant_a', 'chan-other', 'wk-existing', 'active', '', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

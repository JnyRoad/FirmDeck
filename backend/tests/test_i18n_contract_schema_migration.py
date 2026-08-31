"""Verify additive locale persistence and SQLite migration safety."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine, inspect, text

from app.db import database

_DURABLE_LANGUAGE_TABLES = (
    "api_jobs",
    "a2a_task_runs",
    "channel_inbound_events",
    "channel_deliveries",
    "human_handoff_requests",
    "scheduled_tasks",
    "scheduled_task_runs",
    "harness_task_frames",
    "harness_runs",
    "harness_turns",
    "harness_invocations",
    "team_runs",
    "team_tasks",
    "team_wake_events",
)

_LEGACY_SNAPSHOT = {
    "version": 1,
    "ui_locale": "zh-CN",
    "agent_reply_locale": "zh-CN",
    "ui_locale_source": "legacy_default",
    "agent_reply_locale_source": "legacy_default",
}


def _create_legacy_schema(engine, *, include_partial_columns: bool = False) -> None:
    """Create a minimal pre-locale schema so tests exercise real ALTER TABLE behavior."""
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE users (
                    id VARCHAR PRIMARY KEY,
                    tenant_id VARCHAR NOT NULL,
                    username VARCHAR NOT NULL,
                    password_hash VARCHAR NOT NULL
                )
                """
            )
        )
        session_columns = """
                    id VARCHAR PRIMARY KEY,
                    tenant_id VARCHAR NOT NULL,
                    title VARCHAR,
                    status VARCHAR
        """
        if include_partial_columns:
            session_columns += """
                    , agent_reply_locale VARCHAR
            """
        conn.execute(text(f"CREATE TABLE sessions ({session_columns})"))
        for table_name in _DURABLE_LANGUAGE_TABLES:
            column_sql = "id VARCHAR PRIMARY KEY"
            if include_partial_columns and table_name == "harness_turns":
                column_sql += ", language_context_json JSON"
            conn.execute(text(f"CREATE TABLE {table_name} ({column_sql})"))


def _seed_legacy_rows(engine) -> None:
    """Insert business data and raw records whose locale must never be inferred from content."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, tenant_id, username, password_hash) "
                "VALUES ('user_1', 'tenant_1', 'english_named_user', 'hash')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO sessions (id, tenant_id, title, status) "
                "VALUES ('session_1', 'tenant_1', 'English business title', 'active')"
            )
        )
        for table_name in _DURABLE_LANGUAGE_TABLES:
            conn.execute(text(f"INSERT INTO {table_name} (id) VALUES ('{table_name}_1')"))


def _configure_database(monkeypatch, engine) -> None:
    """Point the module's startup migration at an isolated SQLite database."""
    monkeypatch.setattr(database, "database_url", str(engine.url))
    monkeypatch.setattr(database, "engine", engine)


def test_locale_schema_is_additive_and_backfills_without_translating_business_data(
    monkeypatch,
    tmp_path,
) -> None:
    """Add locale metadata, use deterministic zh-CN defaults, and preserve source content."""
    engine = create_engine(f"sqlite:///{tmp_path / 'locale-schema.db'}")
    _create_legacy_schema(engine)
    _seed_legacy_rows(engine)
    _configure_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()

    inspector = inspect(engine)
    assert {column["name"] for column in inspector.get_columns("users")} >= {
        "ui_locale",
        "agent_reply_locale",
    }
    assert {column["name"] for column in inspector.get_columns("sessions")} >= {
        "agent_reply_locale",
        "agent_reply_locale_source",
    }
    for table_name in _DURABLE_LANGUAGE_TABLES:
        assert "language_context_json" in {
            column["name"] for column in inspector.get_columns(table_name)
        }

    with engine.connect() as conn:
        assert conn.execute(
            text(
                "SELECT username, ui_locale, agent_reply_locale FROM users "
                "WHERE id = 'user_1'"
            )
        ).one() == ("english_named_user", "zh-CN", "zh-CN")
        assert conn.execute(
            text(
                "SELECT title, agent_reply_locale, agent_reply_locale_source "
                "FROM sessions WHERE id = 'session_1'"
            )
        ).one() == ("English business title", "zh-CN", "legacy_default")
        for table_name in _DURABLE_LANGUAGE_TABLES:
            stored = conn.execute(
                text(f"SELECT language_context_json FROM {table_name} WHERE id = :id"),
                {"id": f"{table_name}_1"},
            ).scalar_one()
            assert json.loads(stored) == _LEGACY_SNAPSHOT


def test_locale_schema_is_idempotent_and_preserves_explicit_snapshots(
    monkeypatch,
    tmp_path,
) -> None:
    """Run startup migration twice without duplicate DDL or overwriting explicit locale choices."""
    engine = create_engine(f"sqlite:///{tmp_path / 'locale-idempotent.db'}")
    _create_legacy_schema(engine)
    _seed_legacy_rows(engine)
    explicit_snapshot = json.dumps(
        {
            **_LEGACY_SNAPSHOT,
            "ui_locale": "en-US",
            "agent_reply_locale": "en-US",
            "ui_locale_source": "user_preference",
            "agent_reply_locale_source": "user_preference",
        },
        separators=(",", ":"),
    )
    _configure_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE users SET ui_locale = 'en-US', agent_reply_locale = 'en-US' "
                "WHERE id = 'user_1'"
            )
        )
        conn.execute(
            text(
                "UPDATE sessions SET agent_reply_locale = 'en-US', "
                "agent_reply_locale_source = 'user_preference' WHERE id = 'session_1'"
            )
        )
        conn.execute(
            text(
                "UPDATE harness_turns SET language_context_json = :snapshot "
                "WHERE id = 'harness_turns_1'"
            ),
            {"snapshot": explicit_snapshot},
        )
    database._migrate_sqlite_skill_schema()

    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT ui_locale, agent_reply_locale FROM users WHERE id = 'user_1'")
        ).one() == ("en-US", "en-US")
        assert conn.execute(
            text(
                "SELECT agent_reply_locale, agent_reply_locale_source FROM sessions "
                "WHERE id = 'session_1'"
            )
        ).one() == ("en-US", "user_preference")
        assert json.loads(
            conn.execute(
                text(
                    "SELECT language_context_json FROM harness_turns "
                    "WHERE id = 'harness_turns_1'"
                )
            ).scalar_one()
        ) == json.loads(explicit_snapshot)
        assert conn.execute(
            text(
                "SELECT COUNT(*) FROM app_data_migrations "
                "WHERE id = '20260830_i18n_language_context_v1'"
            )
        ).scalar_one() == 1


def test_locale_schema_repairs_partial_columns_even_when_migration_marker_exists(
    monkeypatch,
    tmp_path,
) -> None:
    """Repair interrupted additive DDL from live columns rather than trusting its marker."""
    engine = create_engine(f"sqlite:///{tmp_path / 'locale-repair.db'}")
    _create_legacy_schema(engine, include_partial_columns=True)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE app_data_migrations ("
                "id VARCHAR PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO app_data_migrations (id) "
                "VALUES ('20260830_i18n_language_context_v1')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO users (id, tenant_id, username, password_hash) "
                "VALUES ('user_1', 'tenant_1', 'legacy', 'hash')"
            )
        )
        conn.execute(
            text("INSERT INTO sessions (id, tenant_id, status) VALUES ('session_1', 'tenant_1', 'active')")
        )
        conn.execute(
            text(
                "INSERT INTO harness_turns (id, language_context_json) "
                "VALUES ('turn_1', :snapshot)"
            ),
            {"snapshot": json.dumps(_LEGACY_SNAPSHOT)},
        )
    _configure_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()

    assert "agent_reply_locale" in {
        column["name"] for column in inspect(engine).get_columns("users")
    }
    assert "agent_reply_locale_source" in {
        column["name"] for column in inspect(engine).get_columns("sessions")
    }
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT ui_locale, agent_reply_locale FROM users WHERE id = 'user_1'")
        ).one() == ("zh-CN", "zh-CN")
        assert json.loads(
            conn.execute(
                text("SELECT language_context_json FROM harness_turns WHERE id = 'turn_1'")
            ).scalar_one()
        ) == _LEGACY_SNAPSHOT


def test_locale_schema_rolls_back_all_changes_when_additive_step_fails(
    monkeypatch,
    tmp_path,
) -> None:
    """Ensure a failed locale step rolls back earlier DDL and leaves the old reader usable."""
    engine = create_engine(f"sqlite:///{tmp_path / 'locale-rollback.db'}")
    _create_legacy_schema(engine)
    _configure_database(monkeypatch, engine)

    def fail_after_first_locale_column(conn, tables) -> None:
        """Simulate a migration failure after one ALTER TABLE statement has run."""
        conn.execute(text("ALTER TABLE users ADD COLUMN ui_locale VARCHAR"))
        raise RuntimeError("forced locale migration failure")

    monkeypatch.setattr(
        database,
        "_migrate_i18n_language_schema",
        fail_after_first_locale_column,
        raising=False,
    )

    with pytest.raises(RuntimeError, match="forced locale migration failure"):
        database._migrate_sqlite_skill_schema()

    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    assert "ui_locale" not in columns
    assert "source" not in columns
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT id, tenant_id, username, password_hash FROM users")
        ).fetchall() == []


def test_old_writer_remains_usable_and_later_startup_backfills_new_locale_fields(
    monkeypatch,
    tmp_path,
) -> None:
    """Allow an old writer after upgrade, then deterministically repair its absent locale fields."""
    engine = create_engine(f"sqlite:///{tmp_path / 'locale-old-writer.db'}")
    _create_legacy_schema(engine)
    _configure_database(monkeypatch, engine)
    database._migrate_sqlite_skill_schema()

    # Simulate an old binary that knows only the pre-i18n columns after additive migration.
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, tenant_id, username, password_hash) "
                "VALUES ('old_user', 'tenant_1', 'raw business user', 'hash')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO sessions (id, tenant_id, title, status) "
                "VALUES ('old_session', 'tenant_1', 'Raw title', 'active')"
            )
        )
        conn.execute(text("INSERT INTO harness_turns (id) VALUES ('old_turn')"))

    # A later startup repairs only absent compatibility fields without rewriting source content.
    database._migrate_sqlite_skill_schema()

    with engine.connect() as conn:
        assert conn.execute(
            text(
                "SELECT username, ui_locale, agent_reply_locale FROM users "
                "WHERE id = 'old_user'"
            )
        ).one() == ("raw business user", "zh-CN", "zh-CN")
        assert conn.execute(
            text(
                "SELECT title, agent_reply_locale, agent_reply_locale_source "
                "FROM sessions WHERE id = 'old_session'"
            )
        ).one() == ("Raw title", "zh-CN", "legacy_default")
        stored = conn.execute(
            text(
                "SELECT language_context_json FROM harness_turns "
                "WHERE id = 'old_turn'"
            )
        ).scalar_one()
        assert json.loads(stored) == _LEGACY_SNAPSHOT

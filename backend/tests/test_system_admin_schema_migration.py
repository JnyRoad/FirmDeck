"""RED contracts for the additive system-tenant SQLite migration."""

from __future__ import annotations

import re
from unittest.mock import ANY

import pytest
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

from app.db import database

_SYSTEM_TENANT_MARKER = "20260831_system_tenant_control_v1"
_SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$")


def _create_legacy_tenant_schema(engine) -> None:
    """Create supported pre-control tenant, user, and durable-work tables in one isolated database."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE tenants (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, "
                "created_at DATETIME)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE users (id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, "
                "username VARCHAR NOT NULL, role VARCHAR NOT NULL, active BOOLEAN NOT NULL, "
                "password_hash VARCHAR NOT NULL, created_at DATETIME)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE api_jobs (id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, "
                "status VARCHAR NOT NULL)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO tenants (id, name) VALUES "
                "('tenant_demo', 'Demo'), ('tenant_acme', 'Acme'), "
                "('tenant-acme', 'Acme Two'), ('tenant_no_admin', 'No Admin')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO users (id, tenant_id, username, role, active, password_hash, created_at) "
                "VALUES "
                "('user_inactive', 'tenant_demo', 'disabled-admin', 'admin', 0, 'hash', '2023-01-01'), "
                "('user_non_admin', 'tenant_demo', 'member', 'member', 1, 'hash', '2023-02-01'), "
                "('user_oldest', 'tenant_demo', 'first-admin', 'admin', 1, 'hash', '2024-01-01'), "
                "('user_newer', 'tenant_demo', 'next-admin', 'admin', 1, 'hash', '2024-02-01'), "
                "('user_cross_tenant_admin', 'tenant_acme', 'acme-admin', 'admin', 1, 'hash', '2024-03-01'), "
                "('user_collision_admin', 'tenant-acme', 'collision-admin', 'admin', 1, 'hash', '2024-04-01')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO api_jobs (id, tenant_id, status) VALUES "
                "('job_demo', 'tenant_demo', 'queued'), "
                "('job_acme', 'tenant_acme', 'queued'), "
                "('job_no_admin', 'tenant_no_admin', 'queued')"
            )
        )


def _use_isolated_database(monkeypatch: pytest.MonkeyPatch, engine) -> None:
    """Point the startup migration at a test-only engine without touching development data."""
    monkeypatch.setattr(database, "database_url", str(engine.url))
    monkeypatch.setattr(database, "engine", engine)


def _column_names(engine, table_name: str) -> set[str]:
    """Return live SQLite columns after a migration attempt."""
    return {column["name"] for column in inspect(engine).get_columns(table_name)}


def _has_index(engine, table_name: str, columns: tuple[str, ...], *, unique: bool | None = None) -> bool:
    """Check index coverage by columns rather than requiring an implementation-specific index name."""
    with engine.connect() as conn:
        index_rows = conn.execute(text(f"PRAGMA index_list({table_name})")).mappings().all()
        for index_row in index_rows:
            if unique is not None and bool(index_row["unique"]) is not unique:
                continue
            index_name = str(index_row["name"])
            indexed_columns = tuple(
                str(row["name"])
                for row in conn.execute(text(f"PRAGMA index_info({index_name})")).mappings().all()
            )
            if indexed_columns == columns:
                return True
    return False


def _marker_count(engine) -> int:
    """Read only the planned tenant-control marker, not unrelated startup migration markers."""
    with engine.connect() as conn:
        return int(
            conn.execute(
                text("SELECT COUNT(*) FROM app_data_migrations WHERE id = :id"),
                {"id": _SYSTEM_TENANT_MARKER},
            ).scalar_one()
        )


def _tenant_rows(engine) -> dict[str, tuple[str, str, int, str | None]]:
    """Load the full legacy tenant backfill outcome for deterministic cross-database comparison."""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT id, slug, status, lifecycle_version, initial_admin_user_id "
                "FROM tenants ORDER BY id"
            )
        ).all()
    return {row[0]: (row[1], row[2], row[3], row[4]) for row in rows}


def _assert_control_schema(engine) -> None:
    """Require all live columns and index constraints that make the backfill safe and queryable."""
    assert {"slug", "status", "lifecycle_version", "initial_admin_user_id"} <= _column_names(
        engine, "tenants"
    )
    assert {"auth_version", "must_change_password"} <= _column_names(engine, "users")
    assert {
        "tenant_lifecycle_version",
        "terminal_reason",
        "outcome_unknown",
    } <= _column_names(engine, "api_jobs")
    assert _has_index(engine, "tenants", ("slug",), unique=True)
    assert _has_index(engine, "tenants", ("status",))
    assert _has_index(engine, "tenants", ("initial_admin_user_id",))


def test_legacy_tenants_users_and_durable_work_receive_complete_control_backfill(monkeypatch, tmp_path) -> None:
    """Backfill every tenant/user/job while choosing only the oldest active same-tenant administrator."""
    engine = create_engine(f"sqlite:///{tmp_path / 'tenant-control.db'}")
    _create_legacy_tenant_schema(engine)
    _use_isolated_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()

    _assert_control_schema(engine)
    assert _tenant_rows(engine) == {
        "tenant-acme": (ANY, "active", 1, "user_collision_admin"),
        "tenant_acme": (ANY, "active", 1, "user_cross_tenant_admin"),
        "tenant_demo": ("demo", "active", 1, "user_oldest"),
        "tenant_no_admin": (ANY, "active", 1, None),
    }
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT id, auth_version, must_change_password FROM users ORDER BY id")
        ).all() == [
            ("user_collision_admin", 1, 0),
            ("user_cross_tenant_admin", 1, 0),
            ("user_inactive", 1, 0),
            ("user_newer", 1, 0),
            ("user_non_admin", 1, 0),
            ("user_oldest", 1, 0),
        ]
        assert conn.execute(
            text("SELECT id, tenant_lifecycle_version FROM api_jobs ORDER BY id")
        ).all() == [("job_acme", 1), ("job_demo", 1), ("job_no_admin", 1)]
    assert _marker_count(engine) == 1


def test_fresh_sqlmodel_password_policy_schema_enforces_length_order(tmp_path) -> None:
    """Fresh create_all must enforce the same bounded min/max policy as startup migration DDL."""
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh-policy.db'}")
    SQLModel.metadata.create_all(engine)

    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO installation_password_policies "
                "(scope, min_length, max_length, complexity_enabled, "
                "require_uppercase, require_lowercase, require_digit, require_special, updated_at) "
                "VALUES ('system', 12, 8, 0, 1, 1, 1, 1, CURRENT_TIMESTAMP)"
            )
        )


def test_tenant_admin_backfill_preserves_existing_valid_pointer(monkeypatch, tmp_path) -> None:
    """Startup repair must preserve an explicit same-tenant active administrator pointer."""
    engine = create_engine(f"sqlite:///{tmp_path / 'tenant-pointer-preserve.db'}")
    _create_legacy_tenant_schema(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE tenants ADD COLUMN initial_admin_user_id VARCHAR"))
        conn.execute(
            text(
                "UPDATE tenants SET initial_admin_user_id = 'user_newer' "
                "WHERE id = 'tenant_demo'"
            )
        )
    _use_isolated_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()

    assert _tenant_rows(engine)["tenant_demo"][3] == "user_newer"


@pytest.mark.parametrize("pointer", ["user_cross_tenant_admin", "user_inactive"])
def test_tenant_admin_backfill_rejects_existing_non_active_same_tenant_pointer(
    monkeypatch,
    tmp_path,
    pointer: str,
) -> None:
    """Startup repair must fail closed when an existing pointer is not an active same-tenant admin."""
    engine = create_engine(f"sqlite:///{tmp_path / f'tenant-pointer-invalid-{pointer}.db'}")
    _create_legacy_tenant_schema(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE tenants ADD COLUMN initial_admin_user_id VARCHAR"))
        conn.execute(
            text(
                "UPDATE tenants SET initial_admin_user_id = :pointer "
                "WHERE id = 'tenant_demo'"
            ),
            {"pointer": pointer},
        )
    _use_isolated_database(monkeypatch, engine)

    with pytest.raises(RuntimeError, match="initial administrator"):
        database._migrate_sqlite_skill_schema()


def test_legacy_slug_map_is_normalized_unique_repeatable_and_identical_across_databases(monkeypatch, tmp_path) -> None:
    """Require deterministic collision handling rather than an iteration-order-dependent slug suffix."""
    first_engine = create_engine(f"sqlite:///{tmp_path / 'tenant-collision-one.db'}")
    second_engine = create_engine(f"sqlite:///{tmp_path / 'tenant-collision-two.db'}")
    _create_legacy_tenant_schema(first_engine)
    _create_legacy_tenant_schema(second_engine)

    _use_isolated_database(monkeypatch, first_engine)
    database._migrate_sqlite_skill_schema()
    _assert_control_schema(first_engine)
    first_map = _tenant_rows(first_engine)
    database._migrate_sqlite_skill_schema()
    _assert_control_schema(first_engine)
    repeated_map = _tenant_rows(first_engine)

    _use_isolated_database(monkeypatch, second_engine)
    database._migrate_sqlite_skill_schema()
    _assert_control_schema(second_engine)
    second_map = _tenant_rows(second_engine)

    assert first_map == repeated_map == second_map
    slugs = [row[0] for row in first_map.values()]
    assert len(slugs) == len(set(slugs))
    assert first_map["tenant_demo"][0] == "demo"
    assert first_map["tenant_acme"][0].startswith("tenant-acme")
    assert first_map["tenant-acme"][0].startswith("tenant-acme")
    assert all(_SLUG_PATTERN.fullmatch(slug) for slug in slugs)
    assert _marker_count(first_engine) == _marker_count(second_engine) == 1


def test_live_schema_repair_backfills_and_restores_indexes_even_with_tenant_marker(monkeypatch, tmp_path) -> None:
    """Repair a marked interrupted migration from live schema state, then restore data and uniqueness."""
    engine = create_engine(f"sqlite:///{tmp_path / 'tenant-marker-repair.db'}")
    _create_legacy_tenant_schema(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE app_data_migrations (id VARCHAR PRIMARY KEY, "
                "applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(text("INSERT INTO app_data_migrations (id) VALUES (:id)"), {"id": _SYSTEM_TENANT_MARKER})
        conn.execute(text("ALTER TABLE tenants ADD COLUMN slug VARCHAR"))
    _use_isolated_database(monkeypatch, engine)

    database._migrate_sqlite_skill_schema()

    _assert_control_schema(engine)
    assert _tenant_rows(engine)["tenant_demo"] == ("demo", "active", 1, "user_oldest")
    assert _marker_count(engine) == 1


def test_injected_tenant_control_ddl_failure_rolls_back_columns_data_and_marker(monkeypatch, tmp_path) -> None:
    """Require one immediate transaction that leaves no partial tenant-control migration behind."""
    engine = create_engine(f"sqlite:///{tmp_path / 'tenant-rollback.db'}")
    _create_legacy_tenant_schema(engine)
    _use_isolated_database(monkeypatch, engine)

    def fail_tenant_control_ddl(_conn, _cursor, statement, *_args) -> None:
        """Inject failure only after the planned tenant status DDL follows the prior slug change."""
        if "ALTER TABLE tenants ADD COLUMN status" in statement:
            raise RuntimeError("injected tenant-control migration failure")

    event.listen(engine, "before_cursor_execute", fail_tenant_control_ddl)
    with pytest.raises(RuntimeError, match="injected tenant-control migration failure"):
        database._migrate_sqlite_skill_schema()
    event.remove(engine, "before_cursor_execute", fail_tenant_control_ddl)

    assert "slug" not in _column_names(engine, "tenants")
    assert "auth_version" not in _column_names(engine, "users")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM tenants")).scalar_one() == 4
        assert conn.execute(text("SELECT COUNT(*) FROM users")).scalar_one() == 6
        marker_table = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_data_migrations'")
        ).first()
    assert marker_table is None

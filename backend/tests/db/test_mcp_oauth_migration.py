"""Verify additive persistence for personal MCP OAuth grants and flows."""

from __future__ import annotations

from sqlalchemy import create_engine, inspect, text

from app.db import database


def test_mcp_oauth_migration_is_additive_and_idempotent(monkeypatch, tmp_path) -> None:
    """Upgrade one legacy MCP server without changing its default authorization behavior."""
    engine = create_engine(f"sqlite:///{tmp_path / 'mcp-oauth.db'}")
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE mcp_servers (
                    id VARCHAR PRIMARY KEY,
                    tenant_id VARCHAR NOT NULL,
                    name VARCHAR NOT NULL,
                    transport VARCHAR NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO mcp_servers (id, tenant_id, name, transport) "
                "VALUES ('server_1', 'tenant_1', 'legacy', 'streamable_http')"
            )
        )

    monkeypatch.setattr(database, "database_url", str(engine.url))
    monkeypatch.setattr(database, "engine", engine)

    database.init_db()
    database.init_db()

    inspector = inspect(engine)
    assert {column["name"] for column in inspector.get_columns("mcp_servers")} >= {
        "auth_mode",
        "oauth_client_id",
        "oauth_client_metadata_url",
        "oauth_redirect_uri",
    }
    assert {"mcp_user_oauth_grants", "mcp_oauth_flows"} <= set(
        inspector.get_table_names()
    )
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT auth_mode FROM mcp_servers WHERE id = 'server_1'")
        ).scalar_one() == "none"


def test_mcp_oauth_grant_identity_is_unique(monkeypatch, tmp_path) -> None:
    """Prevent two credential rows for the same tenant, server, and user."""
    from sqlalchemy.exc import IntegrityError
    from sqlmodel import Session

    from app.db.models import MCPUserOAuthGrant

    engine = create_engine(f"sqlite:///{tmp_path / 'mcp-oauth-unique.db'}")
    monkeypatch.setattr(database, "database_url", str(engine.url))
    monkeypatch.setattr(database, "engine", engine)
    database.init_db()

    with Session(engine) as db:
        db.add(
            MCPUserOAuthGrant(
                tenant_id="tenant_1",
                server_id="server_1",
                user_id="user_1",
                encrypted_payload="encrypted-a",
            )
        )
        db.add(
            MCPUserOAuthGrant(
                tenant_id="tenant_1",
                server_id="server_1",
                user_id="user_1",
                encrypted_payload="encrypted-b",
            )
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
        else:
            raise AssertionError("duplicate personal MCP grant was accepted")

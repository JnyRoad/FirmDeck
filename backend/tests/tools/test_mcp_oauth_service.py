"""Behavior tests for encrypted, user-bound MCP OAuth grant storage."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from sqlalchemy import create_engine
from sqlmodel import Session, SQLModel, select

from app.db.models import MCPUserOAuthGrant


def _engine(tmp_path):
    """Create an isolated schema for real encryption and persistence behavior."""
    engine = create_engine(f"sqlite:///{tmp_path / 'grant.db'}")
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.mark.asyncio
async def test_grant_storage_encrypts_tokens_and_returns_non_secret_status(tmp_path) -> None:
    """Catch plaintext token persistence or token projection through status responses."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    storage = MCPGrantTokenStorage(
        engine=engine,
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
    )
    client_info = OAuthClientInformationFull(
        client_id="staffdeck-public",
        redirect_uris=["https://staffdeck.example/oauth/callback"],
        token_endpoint_auth_method="none",
        issuer="https://issuer.example",
    )
    tokens = OAuthToken(
        access_token="access-super-secret",
        refresh_token="refresh-super-secret",
        expires_in=3600,
        scope="tools.read tools.call",
    )

    await storage.set_client_info(client_info)
    await storage.set_tokens(tokens)

    with Session(engine) as db:
        row = db.exec(select(MCPUserOAuthGrant)).one()
        assert "access-super-secret" not in row.encrypted_payload
        assert "refresh-super-secret" not in row.encrypted_payload
        assert row.status == "active"
        assert row.expires_at is not None
    assert await storage.get_tokens() == tokens
    assert await storage.get_client_info() == client_info
    status = storage.read_status()
    assert status.model_dump() == {
        "state": "connected",
        "expires_at": status.expires_at,
        "scopes": ["tools.read", "tools.call"],
        "error_code": None,
    }
    assert "token" not in repr(status).lower()


@pytest.mark.asyncio
async def test_grant_storage_isolates_users_on_the_same_server(tmp_path) -> None:
    """Catch a grant lookup that omits the current StaffDeck user."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    first = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    second = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_2")
    await first.set_tokens(OAuthToken(access_token="first-user-only", expires_in=60))

    assert await second.get_tokens() is None
    assert second.read_status().state == "disconnected"


@pytest.mark.asyncio
async def test_grant_storage_restores_absolute_expiry(tmp_path) -> None:
    """Catch restart behavior that treats a persisted access token as valid forever."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await storage.set_tokens(OAuthToken(access_token="short-lived", expires_in=1))

    restored = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    expiry = restored.token_expiry_epoch()
    assert expiry is not None
    assert expiry > datetime.now(UTC).timestamp()


@pytest.mark.asyncio
async def test_grant_storage_never_reuses_tokens_after_oauth_configuration_changes(
    tmp_path,
) -> None:
    """Catch a token issued for an old server identity being sent to new configuration."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    original = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        config_fingerprint="original-config",
    )
    await original.set_tokens(OAuthToken(access_token="old-config-token", expires_in=60))

    changed = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        config_fingerprint="changed-config",
    )

    assert await changed.get_tokens() is None
    assert changed.token_expiry_epoch() is None
    assert changed.read_status().state == "reconnect_required"


def test_configuration_mismatch_does_not_decrypt_the_stale_grant(tmp_path) -> None:
    """Catch changed configuration touching credential payloads it is forbidden to reuse."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    with Session(engine) as db:
        db.add(
            MCPUserOAuthGrant(
                tenant_id="tenant_1",
                server_id="server_1",
                user_id="user_1",
                config_fingerprint="old-config",
                encrypted_payload="not-a-valid-encrypted-payload",
                status="active",
            )
        )
        db.commit()

    changed = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        config_fingerprint="new-config",
    )

    assert changed.read_status().state == "reconnect_required"


@pytest.mark.asyncio
async def test_grant_storage_rejects_a_stale_rotating_token_write(tmp_path) -> None:
    """Catch an older refresh result overwriting a newly rotated refresh credential."""
    from app.tools.mcp_oauth_service import MCPGrantConflict, MCPGrantTokenStorage

    engine = _engine(tmp_path)
    seed = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await seed.set_tokens(
        OAuthToken(access_token="initial", refresh_token="refresh-1", expires_in=60)
    )
    first = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    stale = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await first.get_tokens()
    await stale.get_tokens()

    await first.set_tokens(
        OAuthToken(access_token="newest", refresh_token="refresh-2", expires_in=60)
    )
    with pytest.raises(MCPGrantConflict):
        await stale.set_tokens(
            OAuthToken(access_token="older", refresh_token="refresh-old", expires_in=60)
        )

    restored = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    assert (await restored.get_tokens()).refresh_token == "refresh-2"


@pytest.mark.asyncio
async def test_disconnect_and_refresh_failure_are_owner_scoped_and_credential_free(
    tmp_path,
    caplog,
) -> None:
    """Catch lifecycle mutations crossing users or logging either user's credential."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    first = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    second = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_2")
    await first.set_tokens(OAuthToken(access_token="first-never-log", expires_in=60))
    await second.set_tokens(OAuthToken(access_token="second-never-log", expires_in=60))

    with caplog.at_level("INFO", logger="app.tools.mcp_oauth_service"):
        first.disconnect()
        second.mark_reconnect_required()

    assert await first.get_tokens() is None
    assert (await second.get_tokens()) is None
    assert second.read_status().state == "reconnect_required"
    rendered = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "first-never-log" not in rendered
    assert "second-never-log" not in rendered
    events = [getattr(record, "oauth_event", None) for record in caplog.records]
    assert events == ["mcp_oauth.disconnected", "mcp_oauth.refresh_failed"]


def test_grant_operation_lock_is_shared_only_by_the_same_owner(tmp_path) -> None:
    """Catch concurrent refreshes escaping serialization or blocking unrelated users."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine = _engine(tmp_path)
    first = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    same_owner = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    other_user = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_2")

    assert first.operation_lock() is same_owner.operation_lock()
    assert first.operation_lock() is not other_user.operation_lock()

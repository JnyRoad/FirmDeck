"""Browser-flow lifecycle tests for MCP OAuth state and callback coordination."""

from __future__ import annotations

import pytest
from mcp.shared.auth import AuthorizationCodeResult
from sqlalchemy import create_engine
from sqlmodel import Session, SQLModel, select

from app.db.models import MCPOAuthFlow


def _coordinator(tmp_path):
    """Create a real isolated flow table and coordinator."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowCoordinator

    engine = create_engine(f"sqlite:///{tmp_path / 'flow.db'}")
    SQLModel.metadata.create_all(engine)
    return engine, MCPOAuthFlowCoordinator(engine)


@pytest.mark.asyncio
async def test_flow_stores_only_state_digest_and_rejects_replay(tmp_path) -> None:
    """Catch raw state persistence or a callback being accepted more than once."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    engine, coordinator = _coordinator(tmp_path)
    received: AuthorizationCodeResult | None = None

    async def operation(redirect_handler, callback_handler) -> None:
        """Simulate the official SDK's continuous redirect/callback sequence."""
        nonlocal received
        await redirect_handler("https://auth.example/authorize?state=raw-secret-state")
        received = await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        operation=operation,
    )
    with Session(engine) as db:
        row = db.exec(select(MCPOAuthFlow)).one()
        assert row.state_digest != "raw-secret-state"
        assert "raw-secret-state" not in repr(row)

    result = await coordinator.complete_callback(
        state="raw-secret-state",
        code="authorization-code",
        iss="https://auth.example",
    )
    await coordinator.wait_until_finished(started.flow_id)

    assert result == "completed"
    assert received == AuthorizationCodeResult(
        code="authorization-code",
        state="raw-secret-state",
        iss="https://auth.example",
    )
    with pytest.raises(MCPOAuthFlowError, match="MCP_OAUTH_CALLBACK_INVALID"):
        await coordinator.complete_callback(
            state="raw-secret-state",
            code="replayed-code",
            iss="https://auth.example",
        )
    assert coordinator._pending_by_id == {}
    assert coordinator._pending_by_digest == {}


@pytest.mark.asyncio
async def test_flow_rejects_callback_after_process_restart(tmp_path) -> None:
    """Catch a persisted state being accepted without its live SDK PKCE coroutine."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowCoordinator, MCPOAuthFlowError

    engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Create a pending SDK wait that the replacement coordinator cannot resume."""
        await redirect_handler("https://auth.example/authorize?state=restart-state")
        await callback_handler()

    await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        operation=operation,
    )
    restarted = MCPOAuthFlowCoordinator(engine)

    with pytest.raises(MCPOAuthFlowError, match="MCP_OAUTH_FLOW_EXPIRED"):
        await restarted.complete_callback(
            state="restart-state",
            code="authorization-code",
            iss="https://auth.example",
        )
    coordinator.cancel_all()


@pytest.mark.asyncio
async def test_provider_denial_finishes_without_authorization_code(tmp_path) -> None:
    """Catch provider denial being misclassified as a malformed callback."""
    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Wait as the SDK would, allowing the coordinator to signal denial."""
        await redirect_handler("https://auth.example/authorize?state=denied-state")
        await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        operation=operation,
    )

    result = await coordinator.complete_callback(
        state="denied-state",
        error="access_denied",
    )
    await coordinator.wait_until_finished(started.flow_id, allow_failure=True)

    assert result == "denied"
    status = coordinator.read_flow_status(started.flow_id)
    assert status == "denied"
    assert "state=denied-state" in started.authorization_url


@pytest.mark.asyncio
async def test_flow_security_events_never_log_state_or_authorization_code(
    tmp_path,
    caplog,
) -> None:
    """Catch callback credentials entering lifecycle logs while preserving audit context."""
    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Complete one real coordinator lifecycle with deliberately sensitive values."""
        await redirect_handler("https://auth.example/authorize?state=state-never-log")
        await callback_handler()

    with caplog.at_level("INFO", logger="app.tools.mcp_oauth_flow"):
        started = await coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            operation=operation,
        )
        await coordinator.complete_callback(
            state="state-never-log",
            code="code-never-log",
            iss="https://auth.example",
        )
        await coordinator.wait_until_finished(started.flow_id)

    rendered = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "state-never-log" not in rendered
    assert "code-never-log" not in rendered
    events = [getattr(record, "oauth_event", None) for record in caplog.records]
    assert "mcp_oauth.started" in events
    assert "mcp_oauth.completed" in events

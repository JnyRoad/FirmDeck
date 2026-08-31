"""API behavior tests for current-user MCP OAuth lifecycle routes."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlmodel import Session, SQLModel

from app.db.models import MCPServer, Tenant, User, utc_now


def _db(tmp_path) -> tuple[object, Session]:
    """Create an isolated tenant with one protected remote MCP server."""
    engine = create_engine(f"sqlite:///{tmp_path / 'api.db'}")
    SQLModel.metadata.create_all(engine)
    db = Session(engine)
    db.add(Tenant(id="tenant_1", name="Tenant"))
    db.add(
        MCPServer(
            id="server_1",
            tenant_id="tenant_1",
            name="protected",
            transport="streamable_http",
            url="https://mcp.example/mcp",
            auth_mode="oauth_personal",
            oauth_client_id="staffdeck-public",
            oauth_redirect_uri="https://staffdeck.example/api/enterprise/mcp-servers/oauth/callback",
        )
    )
    db.commit()
    return engine, db


def _user(user_id: str, tenant_id: str = "tenant_1") -> User:
    """Build a signed-in user identity without persisting authentication credentials."""
    return User(
        id=user_id,
        tenant_id=tenant_id,
        username=user_id,
        password_hash="unused",
    )


@pytest.mark.asyncio
async def test_status_and_start_are_scoped_to_current_user(tmp_path, monkeypatch) -> None:
    """Catch a server-level grant lookup or a start flow bound to the wrong user."""
    import app.api.mcp_oauth as api
    from app.tools.mcp_oauth_flow import MCPOAuthStartResult
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine, db = _db(tmp_path)
    first_storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    from mcp.shared.auth import OAuthToken

    await first_storage.set_tokens(OAuthToken(access_token="first-only", expires_in=3600))
    assert api.get_mcp_oauth_status("server_1", "tenant_1", db, _user("user_1")).state == "connected"
    second_status = api.get_mcp_oauth_status(
        "server_1", "tenant_1", db, _user("user_2")
    )
    assert second_status.state == "disconnected"
    assert "first-only" not in repr(second_status)

    captured: dict[str, object] = {}

    class FakeCoordinator:
        async def start(self, **kwargs):
            """Capture ownership and execute the adapter factory without a network."""
            captured.update(kwargs)

            async def redirect_handler(_url: str) -> None:
                """Satisfy the operation handler shape for this route test."""

            async def callback_handler():
                """The fake adapter never requests a browser callback."""
                raise AssertionError("callback should not be awaited by fake adapter")

            await kwargs["operation"](redirect_handler, callback_handler)
            return MCPOAuthStartResult(
                authorization_url="https://auth.example/authorize",
                flow_id="flow_1",
                expires_at=utc_now() + timedelta(minutes=10),
            )

    class FakeAdapter:
        def __init__(self, **kwargs):
            """Capture the owner-bound storage selected by the route."""
            captured["storage"] = kwargs["storage"]

        async def discover(self) -> dict[str, object]:
            """Complete the start operation without external I/O."""
            return {"tools": []}

    monkeypatch.setattr(api, "_coordinator_for_engine", lambda _engine: FakeCoordinator())
    monkeypatch.setattr(api, "MCPSDKAdapter", FakeAdapter)
    started = await api.start_mcp_oauth(
        "server_1",
        api.MCPOAuthStartRequest(tenant_id="tenant_1"),
        db,
        _user("user_2"),
    )

    assert started.flow_id == "flow_1"
    assert captured["user_id"] == "user_2"
    assert captured["storage"].user_id == "user_2"
    db.close()


def test_status_rejects_cross_tenant_user(tmp_path) -> None:
    """Catch query tenant input overriding the authenticated user's tenant."""
    import app.api.mcp_oauth as api

    _engine, db = _db(tmp_path)
    with pytest.raises(HTTPException) as exc_info:
        api.get_mcp_oauth_status("server_1", "tenant_1", db, _user("other", "tenant_2"))

    assert exc_info.value.status_code == 403
    db.close()


@pytest.mark.asyncio
async def test_disconnect_removes_only_the_current_users_grant(tmp_path) -> None:
    """Catch the disconnect route deleting a peer user's grant for the same server."""
    from mcp.shared.auth import OAuthToken

    import app.api.mcp_oauth as api
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    engine, db = _db(tmp_path)
    first = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    second = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_2")
    await first.set_tokens(OAuthToken(access_token="first", expires_in=3600))
    await second.set_tokens(OAuthToken(access_token="second", expires_in=3600))

    api.disconnect_mcp_oauth("server_1", "tenant_1", db, _user("user_1"))
    api.disconnect_mcp_oauth("server_1", "tenant_1", db, _user("user_1"))

    assert first.read_status().state == "disconnected"
    assert second.read_status().state == "connected"
    db.close()


@pytest.mark.asyncio
async def test_callback_redirects_provider_denial_without_echoing_details(monkeypatch) -> None:
    """Catch denial details or authorization codes leaking into the browser redirect."""
    import app.api.mcp_oauth as api

    class FakeCoordinator:
        async def complete_callback(self, **kwargs):
            """Return a valid provider denial while capturing no secret externally."""
            assert kwargs["error"] == "access_denied"
            return "denied"

    monkeypatch.setattr(api, "_coordinator_for_engine", lambda _engine: FakeCoordinator())
    response = await api.mcp_oauth_callback(
        state="secret-state",
        code=None,
        iss="https://issuer.example",
        error="access_denied",
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/workspace/tools?mcp_oauth=denied"
    assert "secret-state" not in response.headers["location"]


@pytest.mark.asyncio
async def test_callback_redirects_expired_and_invalid_flows_to_recoverable_ui(
    monkeypatch,
) -> None:
    """Catch browser callbacks stranding users on JSON errors instead of safe recovery UI."""
    import app.api.mcp_oauth as api
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    class FakeCoordinator:
        def __init__(self) -> None:
            """Alternate between an expired and invalid credential-free outcome."""
            self.calls = 0

        async def complete_callback(self, **kwargs):
            """Raise only stable application codes without echoing callback input."""
            del kwargs
            self.calls += 1
            code = (
                "MCP_OAUTH_FLOW_EXPIRED"
                if self.calls == 1
                else "MCP_OAUTH_CALLBACK_INVALID"
            )
            raise MCPOAuthFlowError(code)

    coordinator = FakeCoordinator()
    monkeypatch.setattr(api, "_coordinator_for_engine", lambda _engine: coordinator)

    expired = await api.mcp_oauth_callback(
        state="expired-secret-state",
        code="expired-secret-code",
        iss=None,
        error=None,
    )
    invalid = await api.mcp_oauth_callback(
        state=None,
        code=None,
        iss=None,
        error=None,
    )

    assert expired.headers["location"] == "/workspace/tools?mcp_oauth=expired"
    assert invalid.headers["location"] == "/workspace/tools?mcp_oauth=failed"
    assert "secret" not in expired.headers["location"]


def test_saved_protected_server_discovery_uses_current_user_sdk_grant(
    tmp_path,
    monkeypatch,
) -> None:
    """Catch saved protected discovery bypassing the owner-bound official SDK adapter."""
    import asyncio

    from mcp.shared.auth import OAuthToken

    import app.api.tools as tools_api
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.tool_schema import MCPDiscoverRequest

    engine, db = _db(tmp_path)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    asyncio.run(storage.set_tokens(OAuthToken(access_token="private-token", expires_in=3600)))
    captured: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, **kwargs):
            """Capture the exact personal store chosen for discovery."""
            captured.update(kwargs)

        async def discover(self) -> dict[str, object]:
            """Return a normalized official-SDK discovery envelope without network I/O."""
            return {
                "tools": [
                    {
                        "name": "search",
                        "title": "Search",
                        "description": "Search private data",
                        "input_schema": {"type": "object"},
                        "output_schema": {},
                        "annotations": {},
                        "meta": {},
                        "app": None,
                    }
                ],
                "server_capabilities": {"tools": {}},
                "server_info": {"name": "protected"},
            }

    monkeypatch.setattr(tools_api, "MCPSDKAdapter", FakeAdapter)
    current_user = _user("user_1")
    current_user.role = "admin"
    response = tools_api.discover_mcp_tools(
        "server_1",
        MCPDiscoverRequest(tenant_id="tenant_1"),
        db,
        current_user,
        None,
    )

    assert response.success is True
    assert [tool.name for tool in response.tools] == ["search"]
    assert captured["storage"].user_id == "user_1"
    db.close()

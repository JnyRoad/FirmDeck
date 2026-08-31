"""Contract tests for the official MCP SDK compatibility boundary."""

from __future__ import annotations

import asyncio
import json
import threading
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest
from mcp.shared.auth import AuthorizationCodeResult, OAuthToken
from mcp.types import ReadResourceResult, TextResourceContents
from sqlalchemy import create_engine
from sqlmodel import SQLModel


def test_adapter_rejects_an_unpinned_sdk_version() -> None:
    """Catch SDK upgrades that bypass the adapter's pinned compatibility review."""
    from app.tools.mcp_sdk_adapter import assert_supported_sdk_version

    assert assert_supported_sdk_version("2.1.1") == "2.1.1"


@pytest.mark.asyncio
async def test_adapter_rejects_private_network_targets_before_transport(tmp_path) -> None:
    """Catch OAuth discovery or token requests reaching a private network target."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'private-target.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    transport_called = False

    async def private_transport(request: httpx2.Request) -> httpx2.Response:
        """Record any request that escaped the adapter's network policy boundary."""
        nonlocal transport_called
        transport_called = True
        return httpx2.Response(500, request=request)

    adapter = MCPSDKAdapter(
        server_url="https://127.0.0.1/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        transport=httpx2.MockTransport(private_transport),
    )

    with pytest.raises(MCPAdapterError) as exc_info:
        await adapter.discover()

    assert exc_info.value.code == "MCP_OAUTH_PROVIDER_UNSUPPORTED"
    assert transport_called is False


@pytest.mark.asyncio
async def test_adapter_rejects_private_authorization_server_before_transport(tmp_path) -> None:
    """Catch protected-resource metadata redirecting OAuth traffic to a private host."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'private-issuer.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    private_transport_called = False

    async def redirected_transport(request: httpx2.Request) -> httpx2.Response:
        """Advertise a private issuer and record whether a request reaches that host."""
        nonlocal private_transport_called
        if request.url.host == "127.0.0.1":
            private_transport_called = True
            return httpx2.Response(500, request=request)
        if "oauth-protected-resource" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "resource": "https://93.184.216.34/mcp",
                    "authorization_servers": ["https://127.0.0.1"],
                },
                request=request,
            )
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    'Bearer resource_metadata="https://93.184.216.34/'
                    '.well-known/oauth-protected-resource"'
                )
            },
            request=request,
        )

    adapter = MCPSDKAdapter(
        server_url="https://93.184.216.34/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        transport=httpx2.MockTransport(redirected_transport),
    )

    with pytest.raises(MCPAdapterError) as exc_info:
        await adapter.discover()

    assert exc_info.value.code == "MCP_OAUTH_PROVIDER_UNSUPPORTED"
    assert private_transport_called is False


@pytest.mark.asyncio
async def test_adapter_rejects_private_browser_authorization_target(tmp_path) -> None:
    """Catch authorization metadata opening a private-network browser target."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'private-browser-target.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        public_client_id="staffdeck-public",
        redirect_uri="https://staffdeck.example/oauth/callback",
    )
    redirect_called = False
    authorization_url = ""

    async def metadata_transport(request: httpx2.Request) -> httpx2.Response:
        """Serve public metadata that advertises one private authorization endpoint."""
        if "oauth-protected-resource" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "resource": "https://93.184.216.34/mcp",
                    "authorization_servers": ["https://93.184.216.34"],
                },
                request=request,
            )
        if "oauth-authorization-server" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "issuer": "https://93.184.216.34",
                    "authorization_endpoint": "https://127.0.0.1/authorize",
                    "token_endpoint": "https://93.184.216.34/token",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                },
                request=request,
            )
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    'Bearer resource_metadata="https://93.184.216.34/'
                    '.well-known/oauth-protected-resource"'
                )
            },
            request=request,
        )

    async def capture_redirect(url: str) -> None:
        """Record any browser navigation that escaped URL validation."""
        nonlocal authorization_url, redirect_called
        authorization_url = url
        redirect_called = True

    async def complete_callback() -> AuthorizationCodeResult:
        """Complete the controlled flow if unsafe navigation is not rejected."""
        state = parse_qs(urlparse(authorization_url).query)["state"][0]
        return AuthorizationCodeResult(code="authorization-code", state=state)

    adapter = MCPSDKAdapter(
        server_url="https://93.184.216.34/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=complete_callback,
        transport=httpx2.MockTransport(metadata_transport),
    )

    with pytest.raises(MCPAdapterError) as exc_info:
        await adapter.discover()

    assert exc_info.value.code == "MCP_OAUTH_PROVIDER_UNSUPPORTED"
    assert redirect_called is False


@pytest.mark.asyncio
async def test_adapter_cancellation_while_waiting_does_not_strand_operation_lock() -> None:
    """Catch cancellation leaving the owner-scoped threading lock acquired forever."""
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    class TrackingLock:
        """Expose when the worker thread starts waiting on one real lock."""

        def __init__(self) -> None:
            """Hold the lock initially so cancellation occurs during acquisition."""
            self.inner = threading.Lock()
            self.inner.acquire()
            self.attempted = threading.Event()

        def acquire(self) -> bool:
            """Record the wait before blocking on the real lock."""
            self.attempted.set()
            return self.inner.acquire()

        def release(self) -> None:
            """Release whichever owner currently holds the real lock."""
            self.inner.release()

    class LockOnlyStorage:
        """Provide only the storage hook reached before the cancelled SDK session."""

        def __init__(self, lock: TrackingLock) -> None:
            """Retain the exact lock whose lifecycle the test observes."""
            self.lock = lock

        def operation_lock(self) -> TrackingLock:
            """Return the owner-scoped lock used by the adapter."""
            return self.lock

    lock = TrackingLock()
    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=LockOnlyStorage(lock),  # type: ignore[arg-type]
        redirect_uri="https://staffdeck.example/oauth/callback",
        url_validator=lambda _url: None,
    )

    task = asyncio.create_task(adapter.discover())
    assert await asyncio.to_thread(lock.attempted.wait, 1)
    task.cancel()
    lock.release()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.05)

    reacquired = lock.inner.acquire(blocking=False)
    if reacquired:
        lock.inner.release()
    assert reacquired is True


class _OAuthMCPServer:
    """Controlled HTTP boundary that exercises the real SDK OAuth and MCP transports."""

    def __init__(self) -> None:
        """Track credential-free protocol evidence for assertions."""
        self.token_form: dict[str, list[str]] = {}
        self.authorization_headers: list[str] = []
        self.request_headers: list[tuple[str, dict[str, str]]] = []

    async def handle(self, request: httpx2.Request) -> httpx2.Response:
        """Serve OAuth metadata/token endpoints and a legacy MCP JSON-RPC endpoint."""
        path = request.url.path
        self.request_headers.append((path, dict(request.headers)))
        if "oauth-protected-resource" in path:
            return httpx2.Response(
                200,
                json={
                    "resource": "https://mcp.example.test/mcp",
                    "authorization_servers": ["https://auth.example.test"],
                },
                request=request,
            )
        if "oauth-authorization-server" in path:
            return httpx2.Response(
                200,
                json={
                    "issuer": "https://auth.example.test",
                    "authorization_endpoint": "https://auth.example.test/authorize",
                    "token_endpoint": "https://auth.example.test/token",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                    "authorization_response_iss_parameter_supported": True,
                },
                request=request,
            )
        if path == "/token":
            self.token_form = parse_qs((await request.aread()).decode())
            return httpx2.Response(
                200,
                json={
                    "access_token": "issued-access-token",
                    "refresh_token": "issued-refresh-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": "tools.read tools.call",
                },
                request=request,
            )
        if path == "/mcp" and request.method == "DELETE":
            return httpx2.Response(204, request=request)
        if path != "/mcp":
            return httpx2.Response(404, request=request)

        authorization = request.headers.get("Authorization", "")
        self.authorization_headers.append(authorization)
        if authorization != "Bearer issued-access-token":
            return httpx2.Response(
                401,
                headers={
                    "WWW-Authenticate": (
                        'Bearer resource_metadata="https://mcp.example.test/'
                        '.well-known/oauth-protected-resource"'
                    )
                },
                request=request,
            )
        payload = json.loads((await request.aread()).decode())
        method = payload.get("method")
        request_id = payload.get("id")
        if method == "server/discover":
            result = {
                "supportedVersions": ["2026-07-28"],
                "capabilities": {"tools": {}},
                "resultType": "complete",
                "ttlMs": 0,
                "cacheScope": "public",
                "_meta": {
                    "io.modelcontextprotocol/serverInfo": {
                        "name": "oauth-mock",
                        "version": "1.0",
                    }
                },
            }
        elif method == "tools/list":
            result = {
                "resultType": "complete",
                "ttlMs": 0,
                "cacheScope": "private",
                "tools": [
                    {
                        "name": "echo",
                        "title": "Echo",
                        "description": "Return the supplied text",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                        },
                    }
                ]
            }
        elif method == "tools/call":
            text_value = payload["params"]["arguments"]["text"]
            result = {
                "resultType": "complete",
                "content": [{"type": "text", "text": text_value}],
                "structuredContent": {"text": text_value},
                "isError": False,
            }
        else:
            return httpx2.Response(202, request=request)
        return httpx2.Response(
            200,
            json={"jsonrpc": "2.0", "id": request_id, "result": result},
            headers={"content-type": "application/json"},
            request=request,
        )


@pytest.mark.asyncio
async def test_adapter_uses_official_pkce_flow_and_normalizes_results(tmp_path) -> None:
    """Catch bypasses of SDK PKCE/discovery or incompatible result conversion."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'adapter.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        public_client_id="staffdeck-public",
        redirect_uri="https://staffdeck.example/oauth/callback",
    )
    server = _OAuthMCPServer()
    authorization_url = ""

    async def capture_redirect(url: str) -> None:
        """Capture the SDK-built URL instead of opening a real browser."""
        nonlocal authorization_url
        authorization_url = url

    async def complete_callback() -> AuthorizationCodeResult:
        """Return the same state and issuer a real provider callback would carry."""
        state = parse_qs(urlparse(authorization_url).query)["state"][0]
        return AuthorizationCodeResult(
            code="authorization-code",
            state=state,
            iss="https://auth.example.test",
        )

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={"Cookie": "mcp-session", "X-Api-Key": "mcp-api-key"},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=complete_callback,
        transport=httpx2.MockTransport(server.handle),
        url_validator=lambda _url: None,
    )

    discovery = await adapter.discover()
    result = await adapter.call_tool("echo", {"text": "hello"})

    auth_query = parse_qs(urlparse(authorization_url).query)
    assert auth_query["code_challenge_method"] == ["S256"]
    assert auth_query["client_id"] == ["staffdeck-public"]
    assert server.token_form["code_verifier"][0]
    assert discovery["tools"] == [
        {
            "name": "echo",
            "title": "Echo",
            "description": "Return the supplied text",
            "input_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
            },
            "output_schema": {},
            "annotations": {},
            "meta": {},
            "app": None,
        }
    ]
    assert discovery["server_info"] == {"name": "oauth-mock", "version": "1.0"}
    assert result["data"] == {"text": "hello"}
    assert result["is_error"] is False
    assert "Bearer issued-access-token" in server.authorization_headers
    mcp_headers = [headers for path, headers in server.request_headers if path == "/mcp"]
    oauth_headers = [headers for path, headers in server.request_headers if path != "/mcp"]
    assert mcp_headers
    assert all(headers.get("cookie") == "mcp-session" for headers in mcp_headers)
    assert all(headers.get("x-api-key") == "mcp-api-key" for headers in mcp_headers)
    assert all("cookie" not in headers for headers in oauth_headers)
    assert all("x-api-key" not in headers for headers in oauth_headers)


@pytest.mark.asyncio
async def test_adapter_primes_persisted_absolute_expiry(tmp_path) -> None:
    """Catch an SDK restart that forgets when the stored access token expires."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'expiry.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await storage.set_tokens(OAuthToken(access_token="stored", expires_in=60))
    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        transport=httpx2.MockTransport(_OAuthMCPServer().handle),
        url_validator=lambda _url: None,
    )

    provider = adapter.build_oauth_provider()
    await provider._initialize()

    assert provider.context.token_expiry_time == pytest.approx(
        storage.token_expiry_epoch(), abs=0.01
    )


@pytest.mark.asyncio
async def test_adapter_maps_provider_forbidden_without_exposing_response_body(tmp_path) -> None:
    """Catch missing-scope responses becoming generic errors or leaking provider prose."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'forbidden.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await storage.set_tokens(OAuthToken(access_token="stored-access", expires_in=3600))

    async def forbidden(request: httpx2.Request) -> httpx2.Response:
        """Return a sensitive provider body that must remain below the adapter boundary."""
        return httpx2.Response(
            403,
            text="scope tools.call missing; token=stored-access",
            request=request,
        )

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        transport=httpx2.MockTransport(forbidden),
        url_validator=lambda _url: None,
    )

    with pytest.raises(MCPAdapterError) as exc_info:
        await adapter.discover()

    assert exc_info.value.code == "MCP_INSUFFICIENT_SCOPE"
    assert "stored-access" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_adapter_reads_app_resources_through_the_owner_bound_sdk_client(tmp_path) -> None:
    """Catch protected MCP App resources bypassing the official OAuth SDK boundary."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'resource.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://staffdeck.example/oauth/callback",
        url_validator=lambda _url: None,
    )

    class FakeClient:
        """Return one SDK resource model without opening a transport."""

        async def read_resource(self, uri: str) -> ReadResourceResult:
            """Preserve the requested URI and MCP Apps metadata."""
            return ReadResourceResult(
                contents=[
                    TextResourceContents(
                        uri=uri,
                        mimeType="text/html;profile=mcp-app",
                        text="<main>OAuth app</main>",
                        _meta={"ui": {"connectDomains": ["https://api.example.test"]}},
                    )
                ]
            )

    async def with_fake_client(operation):
        """Exercise only the adapter conversion boundary."""
        return await operation(FakeClient())

    adapter._with_client = with_fake_client  # type: ignore[method-assign]

    result = await adapter.read_resource("ui://protected/app")

    assert result == {
        "contents": [
            {
                "uri": "ui://protected/app",
                "mimeType": "text/html;profile=mcp-app",
                "_meta": {"ui": {"connectDomains": ["https://api.example.test"]}},
                "text": "<main>OAuth app</main>",
            }
        ],
        "ttlMs": 0,
        "cacheScope": "private",
        "resultType": "complete",
    }

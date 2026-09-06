"""Contract tests for the official MCP SDK compatibility boundary."""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import suppress
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest
from mcp.shared.auth import (
    AuthorizationCodeResult,
    OAuthClientInformationFull,
    OAuthMetadata,
    OAuthToken,
)
from mcp.types import ReadResourceResult, TextResourceContents
from sqlalchemy import create_engine
from sqlmodel import SQLModel


def test_adapter_rejects_an_unpinned_sdk_version() -> None:
    """Catch SDK upgrades that bypass the adapter's pinned compatibility review."""
    from app.tools.mcp_sdk_adapter import assert_supported_sdk_version

    assert assert_supported_sdk_version("2.1.1") == "2.1.1"
    with pytest.raises(RuntimeError, match="expected 2.1.1, got 2.1.2"):
        assert_supported_sdk_version("2.1.2")


def test_adapter_recovers_a_wrapped_oauth_flow_error() -> None:
    """Preserve the authorization signal when the SDK wraps its flow exception."""
    from mcp.client.auth import OAuthFlowError

    from app.tools.mcp_sdk_adapter import _find_adapter_error

    error = _find_adapter_error(
        ExceptionGroup("sdk task group", [OAuthFlowError("provider rejected")]),
        oauth_error_code="MCP_TOKEN_REFRESH_FAILED",
    )

    assert error is not None
    assert error.code == "MCP_TOKEN_REFRESH_FAILED"


def test_public_transport_rejects_an_incompatible_httpcore_pool() -> None:
    """Fail closed if an SDK upgrade removes the resolver boundary injection point."""
    from app.tools.mcp_sdk_adapter import _PublicOnlyAsyncHTTPTransport

    transport = object.__new__(_PublicOnlyAsyncHTTPTransport)
    transport._pool = object()  # type: ignore[attr-defined]

    with pytest.raises(RuntimeError, match="network backend"):
        transport._install_public_network_backend()


def test_adapter_maps_wrapped_grant_conflict_to_flow_conflict() -> None:
    """Keep a cross-worker grant race from escaping the start route as a server error."""
    from app.tools.mcp_oauth_service import MCPGrantConflict
    from app.tools.mcp_sdk_adapter import _find_adapter_error

    error = _find_adapter_error(
        ExceptionGroup("sdk task group", [MCPGrantConflict("owner changed")])
    )

    assert error is not None
    assert error.code == "MCP_OAUTH_FLOW_CONFLICT"


@pytest.mark.asyncio
async def test_provider_restores_persisted_token_endpoint_for_refresh(tmp_path) -> None:
    """Refresh through the discovered authorization server after an application restart."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'restart-refresh.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    metadata = OAuthMetadata(
        issuer="https://issuer.example.test",
        authorization_endpoint="https://issuer.example.test/authorize",
        token_endpoint="https://tokens.example.test/custom-refresh",
    )
    await storage.bind_authorization_server(str(metadata.issuer), metadata)
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="persisted-client",
            token_endpoint_auth_method="none",
            issuer=str(metadata.issuer),
        )
    )
    await storage.set_tokens(
        OAuthToken(
            access_token="expired-access",
            refresh_token="persisted-refresh",
            expires_in=0,
        )
    )

    restored = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    provider = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=restored,
        redirect_uri="https://firmdeck.example/oauth/callback",
        transport=httpx2.MockTransport(lambda request: httpx2.Response(500, request=request)),
        url_validator=lambda _url: None,
    ).build_oauth_provider()

    await provider._initialize()
    request = await provider._refresh_token()

    assert str(request.url) == "https://tokens.example.test/custom-refresh"
    assert provider.context.auth_server_url.rstrip("/") == "https://issuer.example.test"


@pytest.mark.asyncio
async def test_provider_does_not_guess_refresh_endpoint_without_persisted_metadata(
    tmp_path,
) -> None:
    """Fall back to full discovery instead of sending refresh credentials to the MCP origin."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-refresh.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await storage.bind_authorization_server("https://issuer.example.test")
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="persisted-client",
            token_endpoint_auth_method="none",
            issuer="https://issuer.example.test",
        )
    )
    await storage.set_tokens(
        OAuthToken(
            access_token="expired-access",
            refresh_token="persisted-refresh",
            expires_in=0,
        )
    )

    restored = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    provider = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=restored,
        redirect_uri="https://firmdeck.example/oauth/callback",
        transport=httpx2.MockTransport(lambda request: httpx2.Response(500, request=request)),
        url_validator=lambda _url: None,
    ).build_oauth_provider()

    await provider._initialize()

    assert provider.context.current_tokens is None
    assert provider.context.auth_server_url == "https://issuer.example.test"


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
        redirect_uri="https://firmdeck.example/oauth/callback",
        transport=httpx2.MockTransport(private_transport),
    )

    with pytest.raises(MCPAdapterError) as exc_info:
        await adapter.discover()

    assert exc_info.value.code == "MCP_OAUTH_PROVIDER_UNSUPPORTED"
    assert transport_called is False


@pytest.mark.asyncio
async def test_public_network_backend_connects_to_the_validated_numeric_address() -> None:
    """Bind DNS validation and TCP connection so rebinding cannot swap in a private IP."""
    from app.tools.mcp_sdk_adapter import _PublicOnlyNetworkBackend

    connected_hosts: list[str] = []
    sentinel_stream = object()

    class FakeBackend:
        async def connect_tcp(self, host: str, port: int, **_kwargs):
            """Record the exact address handed to the real connection layer."""
            connected_hosts.append(host)
            assert port == 443
            return sentinel_stream

        async def connect_unix_socket(self, *_args, **_kwargs):
            """Reject an unexpected non-TCP connection path."""
            raise AssertionError("unexpected unix socket")

        async def sleep(self, _seconds: float) -> None:
            """Satisfy the backend protocol for this connection-only test."""

    def public_dns(*_args, **_kwargs):
        """Return a public address that must be pinned into connect_tcp."""
        return [(2, 1, 6, "", ("93.184.216.34", 443))]

    backend = _PublicOnlyNetworkBackend(
        resolver=public_dns,
        network_backend=FakeBackend(),  # type: ignore[arg-type]
    )
    stream = await backend.connect_tcp("rebind.example.test", 443)

    assert stream is sentinel_stream
    assert connected_hosts == ["93.184.216.34"]


@pytest.mark.asyncio
async def test_public_network_backend_rejects_private_dns_at_connection_time() -> None:
    """Revalidate the connection-time DNS result instead of trusting an earlier lookup."""
    import httpcore2

    from app.tools.mcp_sdk_adapter import _PublicOnlyNetworkBackend

    class UnexpectedBackend:
        async def connect_tcp(self, *_args, **_kwargs):
            """Expose any private address that reaches the TCP connector."""
            raise AssertionError("private address reached connector")

        async def connect_unix_socket(self, *_args, **_kwargs):
            """Reject an unexpected non-TCP connection path."""
            raise AssertionError("unexpected unix socket")

        async def sleep(self, _seconds: float) -> None:
            """Satisfy the backend protocol for this rejection-only test."""

    def rebound_dns(*_args, **_kwargs):
        """Model a hostname switching to a loopback address after preflight validation."""
        return [(2, 1, 6, "", ("127.0.0.1", 443))]

    backend = _PublicOnlyNetworkBackend(
        resolver=rebound_dns,
        network_backend=UnexpectedBackend(),  # type: ignore[arg-type]
    )

    with pytest.raises(httpcore2.ConnectError):
        await backend.connect_tcp("rebind.example.test", 443)


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
        redirect_uri="https://firmdeck.example/oauth/callback",
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
        public_client_id="firmdeck-public",
        redirect_uri="https://firmdeck.example/oauth/callback",
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
        redirect_uri="https://firmdeck.example/oauth/callback",
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

        def acquire(self, blocking: bool = True) -> bool:
            """Record each attempt and preserve the real lock's blocking contract."""
            self.attempted.set()
            return self.inner.acquire(blocking=blocking)

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
        redirect_uri="https://firmdeck.example/oauth/callback",
        url_validator=lambda _url: None,
    )

    task = asyncio.create_task(adapter.discover())
    assert await asyncio.to_thread(lock.attempted.wait, 1)
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=0.1)
    finally:
        lock.release()
        with suppress(asyncio.CancelledError):
            await task

    reacquired = lock.inner.acquire(blocking=False)
    if reacquired:
        lock.inner.release()
    assert reacquired is True


@pytest.mark.asyncio
async def test_adapter_bounds_operation_lock_wait_by_request_timeout() -> None:
    """Return a stable conflict instead of waiting forever behind a stalled owner request."""
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    lock = threading.Lock()
    lock.acquire()

    class LockOnlyStorage:
        """Expose the deliberately held owner lock without reaching SDK storage calls."""

        def operation_lock(self) -> threading.Lock:
            """Return the held lock used to exercise the acquisition deadline."""
            return lock

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=LockOnlyStorage(),  # type: ignore[arg-type]
        redirect_uri="https://firmdeck.example/oauth/callback",
        timeout_seconds=0.01,
        url_validator=lambda _url: None,
    )

    try:
        with pytest.raises(MCPAdapterError, match="MCP_OAUTH_FLOW_CONFLICT"):
            await asyncio.wait_for(adapter.discover(), timeout=0.2)
    finally:
        lock.release()


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
        public_client_id="firmdeck-public",
        redirect_uri="https://firmdeck.example/oauth/callback",
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
        headers={
            "Cookie": "mcp-session",
            "Proxy-Authorization": "Basic must-not-leak",
            "X-Api-Key": "mcp-api-key",
        },
        storage=storage,
        redirect_uri="https://firmdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=complete_callback,
        transport=httpx2.MockTransport(server.handle),
        url_validator=lambda _url: None,
    )

    discovery = await adapter.discover()
    result = await adapter.call_tool("echo", {"text": "hello"})

    auth_query = parse_qs(urlparse(authorization_url).query)
    assert auth_query["code_challenge_method"] == ["S256"]
    assert auth_query["client_id"] == ["firmdeck-public"]
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
    assert all("proxy-authorization" not in headers for headers in mcp_headers)
    assert all("cookie" not in headers for headers in oauth_headers)
    assert all("proxy-authorization" not in headers for headers in oauth_headers)
    assert all("x-api-key" not in headers for headers in oauth_headers)
    assert storage.read_authorization_server() == "https://auth.example.test"


@pytest.mark.asyncio
async def test_adapter_clears_old_issuer_tokens_before_re_registration_denial(tmp_path) -> None:
    """Prevent a rejected issuer migration from pairing old tokens with new credentials."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'issuer-switch.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(engine, "tenant_1", "server_1", "user_1")
    await storage.bind_authorization_server(
        "https://old-auth.example.test",
        OAuthMetadata(
            issuer="https://old-auth.example.test",
            authorization_endpoint="https://old-auth.example.test/authorize",
            token_endpoint="https://old-auth.example.test/token",
        ),
    )
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="old-client",
            client_secret="old-secret",
            token_endpoint_auth_method="client_secret_post",
            issuer="https://old-auth.example.test",
        )
    )
    await storage.set_tokens(
        OAuthToken(
            access_token="old-access",
            refresh_token="old-refresh",
            expires_in=3600,
        )
    )
    requests: list[tuple[str, str, str]] = []

    async def switched_issuer(request: httpx2.Request) -> httpx2.Response:
        """Advertise a replacement issuer and allow registration before user denial."""
        requests.append(
            (request.url.host or "", request.url.path, request.headers.get("Authorization", ""))
        )
        if "oauth-protected-resource" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "resource": "https://mcp.example.test/mcp",
                    "authorization_servers": ["https://new-auth.example.test"],
                },
                request=request,
            )
        if "oauth-authorization-server" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "issuer": "https://new-auth.example.test",
                    "authorization_endpoint": "https://new-auth.example.test/authorize",
                    "token_endpoint": "https://new-auth.example.test/token",
                    "registration_endpoint": "https://new-auth.example.test/register",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                },
                request=request,
            )
        if request.url.path == "/register":
            return httpx2.Response(
                201,
                json={
                    "client_id": "new-client",
                    "redirect_uris": ["https://firmdeck.example/oauth/callback"],
                    "token_endpoint_auth_method": "none",
                },
                request=request,
            )
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

    async def capture_redirect(_url: str) -> None:
        """Accept the generated browser target without opening a browser."""

    async def deny_callback() -> AuthorizationCodeResult:
        """Stop after replacement registration, as when the user rejects authorization."""
        raise RuntimeError("authorization denied")

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://firmdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=deny_callback,
        transport=httpx2.MockTransport(switched_issuer),
        url_validator=lambda _url: None,
    )

    with pytest.raises(MCPAdapterError):
        await adapter.discover()

    assert await storage.get_tokens() is None
    client_info = await storage.get_client_info()
    assert client_info is not None
    assert client_info.client_id == "new-client"
    assert client_info.issuer == "https://new-auth.example.test"
    assert all(
        authorization != "Bearer old-access"
        for host, _path, authorization in requests
        if host == "new-auth.example.test"
    )


@pytest.mark.asyncio
async def test_adapter_redacts_token_endpoint_error_body_from_sdk_logs(
    tmp_path,
    caplog,
) -> None:
    """Prevent upstream OAuth exception logging from exposing provider response secrets."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'oauth-log-redaction.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        public_client_id="firmdeck-public",
        redirect_uri="https://firmdeck.example/oauth/callback",
    )
    server = _OAuthMCPServer()
    authorization_url = ""

    async def sensitive_token_error(request: httpx2.Request) -> httpx2.Response:
        """Return a provider body containing a sentinel that must never enter logs."""
        if request.url.path == "/token":
            return httpx2.Response(
                400,
                text="invalid_grant refresh_token=SECRET-BODY",
                request=request,
            )
        return await server.handle(request)

    async def capture_redirect(url: str) -> None:
        """Retain only the generated state needed for the controlled callback."""
        nonlocal authorization_url
        authorization_url = url

    async def complete_callback() -> AuthorizationCodeResult:
        """Drive the flow through the token endpoint failure."""
        state = parse_qs(urlparse(authorization_url).query)["state"][0]
        return AuthorizationCodeResult(
            code="authorization-code",
            state=state,
            iss="https://auth.example.test",
        )

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://firmdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=complete_callback,
        transport=httpx2.MockTransport(sensitive_token_error),
        url_validator=lambda _url: None,
    )

    with caplog.at_level("ERROR", logger="mcp.client.auth.oauth2"):
        with pytest.raises(MCPAdapterError):
            await adapter.discover()

    rendered = caplog.text + "\n".join(repr(record.__dict__) for record in caplog.records)
    assert "SECRET-BODY" not in rendered


def test_adapter_redacts_invalid_refresh_response_from_sdk_logs(caplog) -> None:
    """Prevent SDK refresh validation errors from exposing token response fields."""
    import logging

    from app.tools import mcp_sdk_adapter as _adapter_module

    del _adapter_module
    logger = logging.getLogger("mcp.client.auth.oauth2")
    with caplog.at_level("ERROR", logger=logger.name):
        try:
            raise ValueError("access_token=['SECRET-REFRESH-BODY']")
        except ValueError:
            logger.exception("Invalid refresh response")

    rendered = caplog.text + "\n".join(repr(record.__dict__) for record in caplog.records)
    assert "SECRET-REFRESH-BODY" not in rendered


@pytest.mark.asyncio
async def test_adapter_keeps_configured_public_client_across_issuer_switch(tmp_path) -> None:
    """Prevent an issuer migration from silently replacing a configured public client with DCR."""
    from app.tools.mcp_oauth_service import MCPGrantTokenStorage
    from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

    engine = create_engine(f"sqlite:///{tmp_path / 'public-client-switch.db'}")
    SQLModel.metadata.create_all(engine)
    storage = MCPGrantTokenStorage(
        engine,
        "tenant_1",
        "server_1",
        "user_1",
        public_client_id="configured-public",
        redirect_uri="https://firmdeck.example/oauth/callback",
    )
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="configured-public",
            redirect_uris=["https://firmdeck.example/oauth/callback"],
            token_endpoint_auth_method="none",
            issuer="https://old-auth.example.test",
        )
    )
    await storage.set_tokens(OAuthToken(access_token="old-public-token", expires_in=3600))
    authorization_url = ""
    registration_called = False

    async def switched_public_issuer(request: httpx2.Request) -> httpx2.Response:
        """Advertise a new issuer that intentionally has no registration endpoint."""
        nonlocal registration_called
        if "oauth-protected-resource" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "resource": "https://mcp.example.test/mcp",
                    "authorization_servers": ["https://new-auth.example.test"],
                },
                request=request,
            )
        if "oauth-authorization-server" in request.url.path:
            return httpx2.Response(
                200,
                json={
                    "issuer": "https://new-auth.example.test",
                    "authorization_endpoint": "https://new-auth.example.test/authorize",
                    "token_endpoint": "https://new-auth.example.test/token",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                },
                request=request,
            )
        if request.url.path == "/register":
            registration_called = True
            return httpx2.Response(404, request=request)
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

    async def capture_redirect(url: str) -> None:
        """Capture the configured client ID before ending the controlled flow."""
        nonlocal authorization_url
        authorization_url = url

    async def deny_callback() -> AuthorizationCodeResult:
        """Stop before token exchange after the authorization URL is inspected."""
        raise RuntimeError("authorization denied")

    adapter = MCPSDKAdapter(
        server_url="https://mcp.example.test/mcp",
        headers={},
        storage=storage,
        redirect_uri="https://firmdeck.example/oauth/callback",
        redirect_handler=capture_redirect,
        callback_handler=deny_callback,
        transport=httpx2.MockTransport(switched_public_issuer),
        url_validator=lambda _url: None,
    )

    with pytest.raises(MCPAdapterError):
        await adapter.discover()

    assert registration_called is False
    assert parse_qs(urlparse(authorization_url).query)["client_id"] == [
        "configured-public"
    ]
    client_info = await storage.get_client_info()
    assert client_info is not None
    assert client_info.issuer == "https://new-auth.example.test"


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
        redirect_uri="https://firmdeck.example/oauth/callback",
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
        redirect_uri="https://firmdeck.example/oauth/callback",
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
        redirect_uri="https://firmdeck.example/oauth/callback",
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

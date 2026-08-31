"""Official MCP SDK compatibility boundary for OAuth-protected remote servers."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable
from importlib.metadata import version as distribution_version
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpcore2
import httpx2
import mcp
from mcp.client.auth import OAuthClientProvider, OAuthFlowError, TokenStorage
from mcp.client.client import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import (
    AuthorizationCodeResult,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthMetadata,
)

from app.tools.mcp_client import (
    MCPClientError,
    _normalize_tool_definition,
    _tool_result_envelope,
    _validate_remote_mcp_url,
)
from app.tools.mcp_oauth_service import MCPGrantConflict

SUPPORTED_MCP_SDK_VERSION = "2.1.1"
_ResultT = TypeVar("_ResultT")


class _OAuthSDKLogSanitizer(logging.Filter):
    """Strip upstream OAuth exception bodies before application handlers format them."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Keep the lifecycle signal while removing provider-controlled exception text."""
        safe_messages = {
            "Invalid refresh response": "MCP OAuth refresh response was invalid",
            "OAuth flow error": "MCP OAuth flow failed",
        }
        if record.name == "mcp.client.auth.oauth2" and record.getMessage() in safe_messages:
            record.msg = safe_messages[record.getMessage()]
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        return True


_oauth_sdk_logger = logging.getLogger("mcp.client.auth.oauth2")
if not any(isinstance(item, _OAuthSDKLogSanitizer) for item in _oauth_sdk_logger.filters):
    _oauth_sdk_logger.addFilter(_OAuthSDKLogSanitizer())


class _PublicOnlyNetworkBackend(httpcore2.AsyncNetworkBackend):
    """Resolve once, validate every answer, then connect to the chosen numeric address."""

    def __init__(
        self,
        *,
        resolver: Callable[..., list[Any]] = socket.getaddrinfo,
        network_backend: httpcore2.AsyncNetworkBackend | None = None,
    ) -> None:
        """Allow controlled resolver/backend injection for connection-boundary tests."""
        self._resolver = resolver
        self._network_backend = network_backend or httpcore2.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore2.AsyncNetworkStream:
        """Connect only to a numeric public address from this exact DNS resolution."""
        try:
            resolved = await asyncio.to_thread(
                self._resolver,
                host,
                port,
                type=socket.SOCK_STREAM,
            )
            addresses = {
                ipaddress.ip_address(sockaddr[0])
                for *_prefix, sockaddr in resolved
            }
        except (OSError, ValueError) as exc:
            raise httpcore2.ConnectError("MCP OAuth target could not be resolved") from exc
        if not addresses or any(not address.is_global for address in addresses):
            raise httpcore2.ConnectError("MCP OAuth target resolved to a non-public address")

        last_error: Exception | None = None
        for address in sorted(addresses, key=str):
            try:
                return await self._network_backend.connect_tcp(
                    str(address),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except httpcore2.NetworkError as exc:
                last_error = exc
        raise httpcore2.ConnectError("MCP OAuth public target connection failed") from last_error

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Any = None,
    ) -> httpcore2.AsyncNetworkStream:
        """Reject Unix sockets because every supported target is public HTTPS."""
        del path, timeout, socket_options
        raise httpcore2.ConnectError("MCP OAuth does not support Unix sockets")

    async def sleep(self, seconds: float) -> None:
        """Delegate retry timing to the selected async network backend."""
        await self._network_backend.sleep(seconds)


class _PublicOnlyAsyncHTTPTransport(httpx2.AsyncHTTPTransport):
    """Use the pinned public-only resolver for every real SDK TCP connection."""

    def __init__(self) -> None:
        """Replace the locked transport's resolver before it opens any connection."""
        super().__init__(trust_env=False, retries=0)
        self._pool._network_backend = _PublicOnlyNetworkBackend()


class MCPAdapterError(RuntimeError):
    """Expose one stable StaffDeck error code without upstream OAuth response text."""

    def __init__(self, code: str) -> None:
        """Retain only the safe error code at the application boundary."""
        super().__init__(code)
        self.code = code


def assert_supported_sdk_version(candidate: str | None = None) -> str:
    """Reject an SDK version that has not passed StaffDeck compatibility review."""
    resolved = candidate or distribution_version(mcp.__name__)
    if resolved != SUPPORTED_MCP_SDK_VERSION:
        raise RuntimeError(
            "Unsupported MCP SDK version; "
            f"expected {SUPPORTED_MCP_SDK_VERSION}, got {resolved}"
        )
    return resolved


def _validate_oauth_target_url(raw_url: str) -> None:
    """Require every OAuth bridge request target to use public HTTPS."""
    if urlsplit(raw_url).scheme.lower() != "https":
        raise MCPAdapterError("MCP_OAUTH_PROVIDER_UNSUPPORTED")
    try:
        _validate_remote_mcp_url(raw_url)
    except MCPClientError as exc:
        raise MCPAdapterError("MCP_OAUTH_PROVIDER_UNSUPPORTED") from exc


def _find_adapter_error(exc: BaseException) -> MCPAdapterError | None:
    """Recover a safe adapter error wrapped by an SDK task-group exception."""
    if isinstance(exc, MCPAdapterError):
        return exc
    if isinstance(exc, MCPGrantConflict):
        return MCPAdapterError("MCP_OAUTH_FLOW_CONFLICT")
    if isinstance(exc, BaseExceptionGroup):
        for nested in exc.exceptions:
            found = _find_adapter_error(nested)
            if found is not None:
                return found
    return None


class _ExpiryAwareOAuthClientProvider(OAuthClientProvider):
    """Pinned SDK 2.1.1 shim that restores expiry and authorization-server metadata."""

    async def _initialize(self) -> None:
        """Load SDK state, then restore expiry omitted by the upstream storage protocol."""
        await super()._initialize()
        expiry_reader = getattr(self.context.storage, "token_expiry_epoch", None)
        if callable(expiry_reader):
            self.context.token_expiry_time = expiry_reader()
        issuer_reader = getattr(self.context.storage, "read_authorization_server", None)
        metadata_reader = getattr(self.context.storage, "read_oauth_metadata", None)
        issuer = issuer_reader() if callable(issuer_reader) else None
        metadata = metadata_reader() if callable(metadata_reader) else None
        if isinstance(metadata, OAuthMetadata):
            self.context.oauth_metadata = metadata
            self.context.auth_server_url = issuer or str(metadata.issuer)
        elif isinstance(issuer, str) and issuer:
            self.context.auth_server_url = issuer
            tokens = self.context.current_tokens
            if tokens is not None and tokens.refresh_token:
                if self.context.is_token_valid():
                    tokens.refresh_token = None
                else:
                    self.context.clear_tokens()


class MCPSDKAdapter:
    """Run OAuth streamable-HTTP operations through the official MCP Python SDK."""

    def __init__(
        self,
        *,
        server_url: str,
        headers: dict[str, str],
        storage: TokenStorage,
        redirect_uri: str,
        redirect_handler: Callable[[str], Awaitable[None]] | None = None,
        callback_handler: Callable[[], Awaitable[AuthorizationCodeResult]] | None = None,
        client_metadata_url: str | None = None,
        transport: httpx2.AsyncBaseTransport | None = None,
        timeout_seconds: float = 30,
        url_validator: Callable[[str], None] | None = None,
    ) -> None:
        """Capture only public connection policy and an owner-bound token store."""
        assert_supported_sdk_version()
        self.server_url = server_url
        self.headers = {
            key: value for key, value in headers.items() if key.lower() != "authorization"
        }
        self.storage = storage
        self.redirect_uri = redirect_uri
        self.redirect_handler = redirect_handler
        self.callback_handler = callback_handler
        self.client_metadata_url = client_metadata_url
        self.transport = transport or _PublicOnlyAsyncHTTPTransport()
        self.timeout_seconds = timeout_seconds
        self.url_validator = url_validator or _validate_oauth_target_url
        self._server_http_url = httpx2.URL(server_url)

    async def _handle_redirect(self, authorization_url: str) -> None:
        """Validate one browser authorization target before invoking the caller handler."""
        self.url_validator(authorization_url)
        if self.redirect_handler is not None:
            await self.redirect_handler(authorization_url)

    def build_oauth_provider(self) -> _ExpiryAwareOAuthClientProvider:
        """Build the sole supported SDK provider with PKCE authorization-code metadata."""
        metadata = OAuthClientMetadata(
            client_name="StaffDeck",
            redirect_uris=[self.redirect_uri],
            token_endpoint_auth_method="none",
        )
        return _ExpiryAwareOAuthClientProvider(
            server_url=self.server_url,
            client_metadata=metadata,
            storage=self.storage,
            redirect_handler=self._handle_redirect if self.redirect_handler is not None else None,
            callback_handler=self.callback_handler,
            client_metadata_url=self.client_metadata_url,
        )

    async def _with_client(self, operation: Callable[[Client], Awaitable[_ResultT]]) -> _ResultT:
        """Open one bounded SDK client session and map OAuth failures to stable safe codes."""
        self.url_validator(self.server_url)
        provider = self.build_oauth_provider()
        last_response_status: int | None = None
        lock_reader = getattr(self.storage, "operation_lock", None)
        operation_lock = lock_reader() if callable(lock_reader) else None

        async def observe_response(response: httpx2.Response) -> None:
            """Remember only the status needed for safe mapping after SDK task-group wrapping."""
            nonlocal last_response_status
            last_response_status = response.status_code

        async def prepare_request(request: httpx2.Request) -> None:
            """Enforce the network boundary and attach static headers only to the MCP server."""
            self.url_validator(str(request.url))
            authorization_server = provider.context.auth_server_url
            if authorization_server is None and provider.context.oauth_metadata is not None:
                authorization_server = str(provider.context.oauth_metadata.issuer)
            binding_writer = getattr(self.storage, "bind_authorization_server", None)
            if authorization_server and callable(binding_writer):
                tokens_cleared, client_info_cleared = await binding_writer(
                    authorization_server,
                    provider.context.oauth_metadata,
                )
                if tokens_cleared:
                    provider.context.clear_tokens()
                if client_info_cleared:
                    provider.context.client_info = None
                public_client_id = getattr(self.storage, "public_client_id", None)
                if (
                    not client_info_cleared
                    and provider.context.client_info is None
                    and isinstance(public_client_id, str)
                    and public_client_id
                ):
                    public_client = OAuthClientInformationFull(
                        client_id=public_client_id,
                        redirect_uris=[self.redirect_uri],
                        token_endpoint_auth_method="none",
                        issuer=authorization_server,
                    )
                    provider.context.client_info = public_client
                    await self.storage.set_client_info(public_client)
            if request.url == self._server_http_url:
                request.headers.update(self.headers)

        lock_acquired = False
        if operation_lock is not None:
            while not operation_lock.acquire(blocking=False):
                await asyncio.sleep(0.01)
            lock_acquired = True
        try:
            try:
                async with httpx2.AsyncClient(
                    auth=provider,
                    transport=self.transport,
                    timeout=self.timeout_seconds,
                    follow_redirects=False,
                    trust_env=False,
                    event_hooks={
                        "request": [prepare_request],
                        "response": [observe_response],
                    },
                ) as http_client:
                    sdk_transport = streamable_http_client(
                        self.server_url,
                        http_client=http_client,
                        terminate_on_close=True,
                    )
                    async with Client(
                        sdk_transport,
                        mode="auto",
                        read_timeout_seconds=self.timeout_seconds,
                        cache=None,
                    ) as client:
                        return await operation(client)
            except OAuthFlowError as exc:
                status_reader = getattr(self.storage, "read_status", None)
                status = status_reader() if callable(status_reader) else None
                code = (
                    "MCP_TOKEN_REFRESH_FAILED"
                    if status is not None
                    and status.state == "connected"
                    and self.redirect_handler is None
                    else "MCP_AUTHORIZATION_REQUIRED"
                )
                raise MCPAdapterError(code) from exc
            except MCPAdapterError:
                raise
            except httpx2.HTTPError as exc:
                status = (
                    exc.response.status_code
                    if isinstance(exc, httpx2.HTTPStatusError)
                    else None
                )
                code = "MCP_INSUFFICIENT_SCOPE" if status == 403 else "MCP_ERROR"
                raise MCPAdapterError(code) from exc
            except Exception as exc:  # noqa: BLE001 - SDK task groups wrap transport failures.
                adapter_error = _find_adapter_error(exc)
                if adapter_error is not None:
                    raise adapter_error from exc
                code = (
                    "MCP_INSUFFICIENT_SCOPE"
                    if last_response_status == 403
                    else "MCP_AUTHORIZATION_REQUIRED"
                    if last_response_status == 401
                    else "MCP_ERROR"
                )
                raise MCPAdapterError(code) from exc
        finally:
            if operation_lock is not None and lock_acquired:
                operation_lock.release()

    async def discover(self) -> dict[str, Any]:
        """List and normalize tools while retaining negotiated server metadata."""

        async def operation(client: Client) -> dict[str, Any]:
            """Convert official SDK models into the existing StaffDeck discovery envelope."""
            result = await client.list_tools()
            tools = [
                _normalize_tool_definition(
                    tool.model_dump(by_alias=True, mode="json", exclude_none=True)
                )
                for tool in result.tools
            ]
            capabilities = client.server_capabilities.model_dump(
                by_alias=True,
                mode="json",
                exclude_none=True,
            )
            server_info = (
                client.server_info.model_dump(by_alias=True, mode="json", exclude_none=True)
                if client.server_info is not None
                else {}
            )
            return {
                "tools": tools,
                "server_capabilities": capabilities,
                "server_info": server_info,
            }

        return await self._with_client(operation)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Invoke one tool and preserve the existing StaffDeck result envelope."""

        async def operation(client: Client) -> dict[str, Any]:
            """Translate the official SDK result without discarding structured content."""
            result = await client.call_tool(name, arguments)
            raw = result.model_dump(by_alias=True, mode="json", exclude_none=True)
            return _tool_result_envelope(raw)

        return await self._with_client(operation)

    async def read_resource(self, uri: str) -> dict[str, Any]:
        """Read one MCP resource through the same owner-bound OAuth client session."""

        async def operation(client: Client) -> dict[str, Any]:
            """Serialize the official SDK resource result for existing Apps extraction."""
            result = await client.read_resource(uri)
            return result.model_dump(by_alias=True, mode="json", exclude_none=True)

        return await self._with_client(operation)

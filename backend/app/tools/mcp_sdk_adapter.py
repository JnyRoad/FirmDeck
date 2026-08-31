"""Official MCP SDK compatibility boundary for OAuth-protected remote servers."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from importlib.metadata import version as distribution_version
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx2
import mcp
from mcp.client.auth import OAuthClientProvider, OAuthFlowError, TokenStorage
from mcp.client.client import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata

from app.tools.mcp_client import (
    MCPClientError,
    _normalize_tool_definition,
    _tool_result_envelope,
    _validate_remote_mcp_url,
)

SUPPORTED_MCP_SDK_VERSION = "2.1.1"
_ResultT = TypeVar("_ResultT")


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
    if isinstance(exc, BaseExceptionGroup):
        for nested in exc.exceptions:
            found = _find_adapter_error(nested)
            if found is not None:
                return found
    return None


class _ExpiryAwareOAuthClientProvider(OAuthClientProvider):
    """Pinned SDK 2.1.1 shim that restores StaffDeck's persisted absolute expiry."""

    async def _initialize(self) -> None:
        """Load SDK state, then restore expiry omitted by the upstream storage protocol."""
        await super()._initialize()
        expiry_reader = getattr(self.context.storage, "token_expiry_epoch", None)
        if callable(expiry_reader):
            self.context.token_expiry_time = expiry_reader()


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
        self.transport = transport
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
            if request.url == self._server_http_url:
                request.headers.update(self.headers)

        lock_acquired = False
        if operation_lock is not None:
            acquire_task = asyncio.create_task(asyncio.to_thread(operation_lock.acquire))
            try:
                await asyncio.shield(acquire_task)
                lock_acquired = True
            except asyncio.CancelledError:
                if await acquire_task:
                    operation_lock.release()
                raise
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

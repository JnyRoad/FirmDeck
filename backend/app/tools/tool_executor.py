from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from collections.abc import Coroutine
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx
from sqlalchemy import Engine
from sqlmodel import Session, select

from app.agents.branching import visible_tool_rows
from app.config import get_settings
from app.contracts.errors import InternalErrorContext, JsonValue
from app.db.models import MCPServer, Tool
from app.i18n.language_context import LanguageContext
from app.security.internal_service import INTERNAL_SERVICE_HEADER, internal_service_token
from app.tools.a2a_client import A2AClient, A2AClientError
from app.tools.http_request import prepare_get_request
from app.tools.mcp_client import (
    MCPClientError,
    execute_mcp_tool,
    execute_mcp_tool_result,
)
from app.tools.mcp_oauth_policy import mcp_oauth_config_fingerprint
from app.tools.mcp_oauth_service import MCPGrantTokenStorage
from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter
from app.tools.tool_schema import MCPAppDescriptor, ToolCall, ToolError, ToolResult

SECRET_PATTERN = re.compile(r"\$\{secret\.([A-Z0-9_]+)\}")
_AsyncResultT = TypeVar("_AsyncResultT")


@dataclass(frozen=True)
class ToolExecutionPolicy:
    timeout_seconds: float


class ToolExecutor:
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()

    def execute(
        self,
        tenant_id: str,
        tool_call: ToolCall,
        active_skill_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
        invocation_id: str | None = None,
        timeout_seconds_override: float | None = None,
        language_context: LanguageContext | dict[str, Any] | None = None,
        user_id: str | None = None,
        a2a_worker_owner: str | None = None,
        a2a_worker_generation: int | None = None,
    ) -> ToolResult:
        """Execute one configured tool while preserving success data and sanitizing failures."""
        language_context = language_context or tool_call.language_context
        with self.db.no_autoflush:
            tool = self.db.exec(
                select(Tool).where(Tool.tenant_id == tenant_id, Tool.name == tool_call.name)
            ).first()
        if not tool:
            return self._error(tool_call.name, "NOT_FOUND", "工具不存在或未配置。")
        if not tool.enabled:
            return self._error(tool.name, "DISABLED", "工具当前未启用。")
        if agent_id and tool.id not in {
            row.id
            for row in visible_tool_rows(self.db, tenant_id, agent_id, include_inactive=False)
        }:
            return self._error(tool.name, "NOT_ALLOWED", "当前员工未启用该工具。")
        if (
            active_skill_id
            and tool.allowed_skills_json
            and active_skill_id not in tool.allowed_skills_json
        ):
            return self._error(tool.name, "NOT_ALLOWED", "当前技能不允许调用该工具。")

        if (tool.tool_type or "http") == "mcp":
            return self._execute_mcp_tool(
                tool,
                tool_call.arguments,
                agent_id=agent_id,
                session_id=session_id,
                active_skill_id=active_skill_id,
                invocation_id=invocation_id,
                timeout_seconds_override=timeout_seconds_override,
                user_id=user_id,
            )
        if (tool.tool_type or "http") == "a2a":
            return self._execute_a2a_tool(
                tool,
                tool_call.arguments,
                agent_id=agent_id,
                session_id=session_id,
                invocation_id=invocation_id,
                timeout_seconds_override=timeout_seconds_override,
                language_context=language_context,
                worker_owner=a2a_worker_owner,
                worker_generation=a2a_worker_generation,
            )
        if (tool.tool_type or "http") != "http":
            return self._error(
                tool.name, "UNSUPPORTED_TOOL_TYPE", f"不支持的工具类型：{tool.tool_type}"
            )

        headers = self._request_headers(
            tool.url,
            self._resolve_headers(tool.headers_json or {}, tool.auth_json or {}),
        )
        policy = self._execution_policy(
            tool,
            timeout_seconds_override=timeout_seconds_override,
        )
        try:
            with httpx.Client(timeout=policy.timeout_seconds) as client:
                if tool.method.upper() == "GET":
                    request_url, request_kwargs = prepare_get_request(tool.url, tool_call.arguments)
                    response = client.request(
                        tool.method.upper(), request_url, headers=headers, **request_kwargs
                    )
                else:
                    response = client.request(
                        tool.method.upper(), tool.url, headers=headers, json=tool_call.arguments
                    )
                response.raise_for_status()
                return ToolResult(
                    tool_name=tool.name,
                    success=True,
                    data=self._response_data(response),
                    error=None,
                )
        except httpx.TimeoutException as exc:
            return self._error(
                tool.name,
                "TIMEOUT",
                f"工具调用超过 {policy.timeout_seconds:g} 秒未返回。",
                params={"timeout_seconds": policy.timeout_seconds},
                retryable=True,
                request_id=invocation_id,
                trace_id=session_id,
                internal_context=InternalErrorContext(
                    source="http_tool",
                    exception_type=type(exc).__name__,
                    raw_message=str(exc),
                ),
            )
        except httpx.HTTPStatusError as exc:
            return self._error(
                tool.name,
                "HTTP_ERROR",
                f"工具返回异常状态码：{exc.response.status_code}",
                params={"status_code": exc.response.status_code},
                request_id=invocation_id,
                trace_id=session_id,
                internal_context=InternalErrorContext(
                    source="http_tool",
                    exception_type=type(exc).__name__,
                    raw_message=str(exc),
                    upstream_status=exc.response.status_code,
                ),
            )
        except Exception as exc:  # noqa: BLE001 - provider execution must fail closed.
            return self._error(
                tool.name,
                "EXECUTION_ERROR",
                str(exc),
                request_id=invocation_id,
                trace_id=session_id,
            )

    def _execute_a2a_tool(
        self,
        tool: Tool,
        arguments: dict[str, Any],
        *,
        agent_id: str | None = None,
        session_id: str | None = None,
        invocation_id: str | None = None,
        timeout_seconds_override: float | None = None,
        language_context: LanguageContext | dict[str, Any] | None = None,
        worker_owner: str | None = None,
        worker_generation: int | None = None,
    ) -> ToolResult:
        """Invoke an A2A agent and wait for its durable Task lifecycle."""

        headers = self._request_headers(
            tool.url,
            self._resolve_headers(tool.headers_json or {}, tool.auth_json or {}),
        )
        headers.setdefault("Content-Type", "application/json")
        config = tool.config_json if isinstance(tool.config_json, dict) else {}
        a2a_version = str(config.get("a2a_version") or "1.0").strip()
        if a2a_version:
            headers.setdefault("A2A-Version", a2a_version)
        try:
            data = A2AClient(
                self.db,
                tool,
                headers=headers,
                timeout_seconds=timeout_seconds_override,
                agent_id=agent_id,
                session_id=session_id,
                invocation_id=invocation_id,
                language_context=language_context,
                worker_owner=worker_owner,
                worker_generation=worker_generation,
            ).execute(arguments)
            return ToolResult(tool_name=tool.name, success=True, data=data, error=None)
        except A2AClientError as exc:
            descriptor = exc.occurrence.descriptor
            return self._error(
                tool.name,
                descriptor.code,
                descriptor.code,
                params=descriptor.params,
                retryable=descriptor.retryable,
                request_id=invocation_id or descriptor.request_id,
                trace_id=session_id or descriptor.trace_id,
                internal_context=exc.occurrence.internal,
            )
        except httpx.HTTPStatusError as exc:
            return self._error(
                tool.name,
                "A2A_HTTP_ERROR",
                f"A2A Agent 返回异常状态码：{exc.response.status_code}",
                params={"status_code": exc.response.status_code},
                request_id=invocation_id,
                trace_id=session_id,
                internal_context=InternalErrorContext(
                    source="a2a",
                    exception_type=type(exc).__name__,
                    raw_message=str(exc),
                    upstream_status=exc.response.status_code,
                ),
            )
        except Exception as exc:  # noqa: BLE001 - provider execution must fail closed.
            return self._error(
                tool.name,
                "A2A_EXECUTION_ERROR",
                str(exc),
                request_id=invocation_id,
                trace_id=session_id,
            )

    def _execute_mcp_tool(
        self,
        tool: Tool,
        arguments: dict[str, Any],
        *,
        agent_id: str | None = None,
        session_id: str | None = None,
        active_skill_id: str | None = None,
        invocation_id: str | None = None,
        timeout_seconds_override: float | None = None,
        user_id: str | None = None,
    ) -> ToolResult:
        """Execute MCP while keeping successful envelopes raw and failures canonical."""
        try:
            server, config, tool_name = self._resolve_mcp_config(tool)
            policy = self._execution_policy(
                tool,
                timeout_seconds_override=timeout_seconds_override,
            )
            if server.auth_mode == "oauth_personal":
                envelope = self._execute_oauth_mcp_tool(
                    server,
                    tool_name=tool_name,
                    arguments=arguments,
                    user_id=user_id,
                    timeout_seconds=policy.timeout_seconds,
                )
            elif config.get("apps_mode") == "auto":
                envelope = execute_mcp_tool_result(
                    config,
                    arguments,
                    timeout_seconds=policy.timeout_seconds,
                    tool_name=tool_name,
                )
            else:
                envelope = {
                    "data": execute_mcp_tool(
                        config,
                        arguments,
                        timeout_seconds=policy.timeout_seconds,
                        tool_name=tool_name,
                    ),
                    "meta": {},
                }
            app_config = (tool.config_json or {}).get("mcp_apps")
            app_descriptor: MCPAppDescriptor | None = None
            if isinstance(app_config, dict) and config.get("apps_mode") == "auto":
                resource_uri = str(app_config.get("resource_uri") or "").strip()
                visibility = app_config.get("visibility")
                if not isinstance(visibility, list):
                    visibility = ["model", "app"]
                if resource_uri and "app" in visibility:
                    app_descriptor = MCPAppDescriptor(
                        server_id=str(tool.mcp_server_id),
                        resource_uri=resource_uri,
                        tool_name=tool.name,
                        visibility=[str(value) for value in visibility],
                        tenant_id=tool.tenant_id,
                        agent_id=agent_id,
                        session_id=session_id,
                        active_skill_id=active_skill_id,
                        initial_result=envelope.get("data"),
                        initial_meta=(
                            envelope.get("meta")
                            if isinstance(envelope.get("meta"), dict)
                            else {}
                        ),
                    )
            return ToolResult(
                tool_name=tool.name,
                success=True,
                data=envelope.get("data"),
                error=None,
                mcp_app=app_descriptor,
                mcp_metadata=(
                    envelope.get("meta") if isinstance(envelope.get("meta"), dict) else {}
                ),
            )
        except MCPAdapterError as exc:
            return self._error(
                tool.name,
                exc.code,
                exc.code,
                request_id=invocation_id,
                trace_id=session_id,
            )
        except MCPClientError as exc:
            descriptor = exc.occurrence.descriptor
            return self._error(
                tool.name,
                descriptor.code,
                descriptor.code,
                params=descriptor.params,
                retryable=descriptor.retryable,
                request_id=invocation_id or descriptor.request_id,
                trace_id=session_id or descriptor.trace_id,
                internal_context=exc.occurrence.internal,
            )
        except Exception as exc:  # noqa: BLE001 - provider execution must fail closed.
            return self._error(
                tool.name,
                "MCP_EXECUTION_ERROR",
                str(exc),
                request_id=invocation_id,
                trace_id=session_id,
            )

    def _execution_policy(
        self,
        tool: Tool,
        *,
        timeout_seconds_override: float | None = None,
    ) -> ToolExecutionPolicy:
        execution = (tool.config_json or {}).get("execution")
        raw_timeout = execution.get("timeout_seconds") if isinstance(execution, dict) else None
        try:
            timeout_seconds = float(raw_timeout)
        except (TypeError, ValueError):
            timeout_seconds = self.settings.tool_timeout_seconds
        if not 1 <= timeout_seconds <= 3600:
            timeout_seconds = self.settings.tool_timeout_seconds
        if timeout_seconds_override is not None:
            timeout_seconds = min(timeout_seconds, max(float(timeout_seconds_override), 0.1))
        return ToolExecutionPolicy(timeout_seconds=timeout_seconds)

    def _resolve_mcp_config(
        self,
        tool: Tool,
    ) -> tuple[MCPServer, dict[str, Any], str | None]:
        """Resolve an MCP tool through its persisted MCP server relation."""
        tool_config = tool.config_json or {}
        tool_name = (
            str(tool_config.get("tool") or tool_config.get("tool_name") or "").strip() or None
        )
        if not tool.mcp_server_id:
            raise MCPClientError("MCP 工具未关联 Server。")
        server = self.db.get(MCPServer, tool.mcp_server_id)
        if server is None or server.tenant_id != tool.tenant_id:
            raise MCPClientError("MCP 工具关联的 Server 不存在或已删除。")
        if not server.enabled:
            raise MCPClientError("MCP 工具关联的 Server 当前已停用。")
        return server, self._server_client_config(server), tool_name

    def _execute_oauth_mcp_tool(
        self,
        server: MCPServer,
        *,
        tool_name: str | None,
        arguments: dict[str, Any],
        user_id: str | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """Invoke a protected server only with the current user's encrypted SDK grant."""
        if (
            not user_id
            or server.transport != "streamable_http"
            or not server.url
            or not server.oauth_redirect_uri
            or not tool_name
        ):
            raise MCPAdapterError("MCP_AUTHORIZATION_REQUIRED")
        bind = self.db.get_bind()
        if not isinstance(bind, Engine):
            raise MCPAdapterError("MCP_AUTHORIZATION_REQUIRED")

        storage = MCPGrantTokenStorage(
            bind,
            server.tenant_id,
            server.id,
            user_id,
            public_client_id=server.oauth_client_id,
            client_metadata_url=server.oauth_client_metadata_url,
            redirect_uri=server.oauth_redirect_uri,
            config_fingerprint=mcp_oauth_config_fingerprint(server),
            enforce_owner_binding=True,
        )
        status = storage.read_status()
        if status.state != "connected":
            code = (
                "MCP_TOKEN_REFRESH_FAILED"
                if status.state == "reconnect_required"
                else "MCP_AUTHORIZATION_REQUIRED"
            )
            raise MCPAdapterError(code)
        adapter = MCPSDKAdapter(
            server_url=server.url,
            headers=dict(server.headers_json or {}),
            storage=storage,
            redirect_uri=server.oauth_redirect_uri,
            client_metadata_url=server.oauth_client_metadata_url,
            timeout_seconds=timeout_seconds,
        )
        try:
            return _run_coroutine(adapter.call_tool(tool_name, arguments))
        except MCPAdapterError as exc:
            if exc.code == "MCP_TOKEN_REFRESH_FAILED":
                storage.mark_reconnect_required()
            raise

    def _server_client_config(self, server: MCPServer) -> dict[str, Any]:
        transport = server.transport or "streamable_http"
        config: dict[str, Any] = {"transport": transport}
        if transport in {"streamable_http", "sse"}:
            config["url"] = server.url or ""
            if server.headers_json:
                config["headers"] = dict(server.headers_json)
        elif transport == "stdio":
            config["command"] = server.command or ""
            config["args"] = list(server.args_json or [])
            if server.env_json:
                config["env"] = dict(server.env_json)
            if server.cwd:
                config["cwd"] = server.cwd
        elif transport == "builtin":
            config["server"] = "builtin.demo"
        config["apps_mode"] = server.apps_mode or "disabled"
        return config

    def _response_data(self, response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, UnicodeDecodeError):
            return response.text

    def _resolve_headers(self, headers: dict[str, Any], auth: dict[str, Any]) -> dict[str, str]:
        resolved = {key: self._resolve_secret(str(value)) for key, value in headers.items()}
        auth_type = str(auth.get("type") or "").strip().lower()
        if auth_type == "bearer" and auth.get("token"):
            resolved["Authorization"] = f"Bearer {self._resolve_secret(str(auth['token']))}"
        elif auth_type == "basic" and "Authorization" not in resolved:
            basic = auth.get("basic")
            if (
                isinstance(basic, dict)
                and basic.get("username") is not None
                and basic.get("password") is not None
            ):
                username = self._resolve_secret(str(basic["username"]))
                password = self._resolve_secret(str(basic["password"]))
                credentials = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
                resolved["Authorization"] = f"Basic {credentials}"
        elif auth_type not in {"bearer", "basic"}:
            # Auth JSON is also allowed as a literal header map for integrations
            # that use custom schemes (for example X-API-Key or a vendor token).
            for key, value in auth.items():
                if key == "type" or value is None:
                    continue
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                resolved[str(key)] = self._resolve_secret(str(value))
        return resolved

    def _request_headers(
        self,
        url: str,
        headers: dict[str, str],
        *,
        normalized_tool_base_url: str | None = None,
    ) -> dict[str, str]:
        if not self._is_internal_mock_url(url, normalized_tool_base_url=normalized_tool_base_url):
            return headers
        resolved = dict(headers)
        resolved[INTERNAL_SERVICE_HEADER] = internal_service_token()
        return resolved

    def _is_internal_mock_url(
        self,
        url: str,
        *,
        normalized_tool_base_url: str | None = None,
    ) -> bool:
        target = urlsplit(url)
        if not target.path.startswith("/api/mock/"):
            return False
        if not target.scheme and not target.netloc:
            return True
        configured = urlsplit(normalized_tool_base_url or self.settings.normalized_tool_base_url)
        return (
            target.scheme.lower(),
            target.hostname,
            target.port or _default_port(target.scheme),
        ) == (
            configured.scheme.lower(),
            configured.hostname,
            configured.port or _default_port(configured.scheme),
        )

    def _resolve_secret(self, value: str) -> str:
        def repl(match: re.Match[str]) -> str:
            return os.getenv(match.group(1), "")

        return SECRET_PATTERN.sub(repl, value)

    def _error(
        self,
        tool_name: str,
        code: str,
        message: str,
        *,
        params: dict[str, JsonValue] | None = None,
        retryable: bool = False,
        request_id: str | None = None,
        trace_id: str | None = None,
        internal_context: InternalErrorContext | None = None,
    ) -> ToolResult:
        """Build a failed ToolResult whose serialized form cannot contain diagnostic prose."""
        private_context = internal_context or InternalErrorContext(
            source="tool_executor",
            raw_message=message,
            upstream_code=code,
        )
        return ToolResult(
            tool_name=tool_name,
            success=False,
            data=None,
            error=ToolError(
                code=code,
                message=code,
                params=params or {},
                retryable=retryable,
                request_id=request_id,
                trace_id=trace_id,
                internal_context=private_context,
            ),
        )


def _default_port(scheme: str) -> int | None:
    return 443 if scheme.lower() == "https" else 80 if scheme.lower() == "http" else None


def _run_coroutine(coroutine: Coroutine[Any, Any, _AsyncResultT]) -> _AsyncResultT:
    """Run one SDK operation from both sync workers and event-loop-owned call paths."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coroutine)
    # Some recovery and test paths call the synchronous executor while already owning
    # an event loop. Keep the SDK lifecycle isolated instead of nesting asyncio.run().
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="mcp-oauth") as executor:
        return executor.submit(asyncio.run, coroutine).result()

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.branching import ensure_private_resource_binding
from app.db.models import A2ATaskEvent, A2ATaskRun, AgentProfile, MCPServer, Tenant, Tool
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.security.internal_service import INTERNAL_SERVICE_HEADER, internal_service_token
from app.tools.mcp_client import MCPClientError
from app.tools.tool_executor import ToolExecutor
from app.tools.tool_schema import ToolCall


def test_tool_error_keeps_remote_cause_private_and_preserves_correlation() -> None:
    """Expose canonical Tool error fields without serializing an MCP diagnostic message."""
    raw_provider_error = "MCP response secret=do-not-publish path=/private/mcp.sock"
    executor = object.__new__(ToolExecutor)

    result = executor._error(
        "mcp.remote",
        "MCP_ERROR",
        raw_provider_error,
        retryable=True,
        params={"transport": "stdio"},
        request_id="req-tool",
        trace_id="trace-tool",
    )

    assert result.error is not None
    assert result.error.model_dump(mode="json") == {
        "code": "INTERNAL_ERROR",
        "message": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": "req-tool",
        "trace_id": "trace-tool",
        "deprecated_fields": ["message"],
    }
    assert result.error.internal_context is not None
    assert result.error.internal_context.raw_message == raw_provider_error
    assert raw_provider_error not in repr(result.model_dump(mode="json"))


def test_mcp_client_error_exposes_safe_descriptor_and_private_diagnostic() -> None:
    """Keep MCP transport prose in InternalErrorContext while preserving request and trace IDs."""
    raw_provider_error = "HTTP MCP body contains api_key=do-not-publish"
    error = MCPClientError(
        raw_provider_error,
        request_id="req-mcp",
        trace_id="trace-mcp",
        params={"transport": "http"},
    )

    assert error.to_public_payload() == {
        "code": "MCP_ERROR",
        "params": {"transport": "http"},
        "retryable": False,
        "request_id": "req-mcp",
        "trace_id": "trace-mcp",
    }
    assert error.occurrence.internal is not None
    assert error.occurrence.internal.raw_message == raw_provider_error
    assert raw_provider_error not in repr(error.to_public_payload())


def test_tool_success_preserves_raw_external_content() -> None:
    """Return successful provider content byte-for-byte at the data projection boundary."""
    raw_content = {"text": "原始正文 <b>do not translate</b>", "citation": "外部来源.pdf#页=7"}
    response = httpx.Response(
        200,
        json=raw_content,
        request=httpx.Request("GET", "https://provider.example.test/raw"),
    )
    executor = object.__new__(ToolExecutor)

    assert executor._response_data(response) == raw_content


def test_resolve_secret_header(monkeypatch):
    monkeypatch.setenv("ORDER_API_TOKEN", "token-123")
    executor = object.__new__(ToolExecutor)

    headers = executor._resolve_headers(
        {"Authorization": "Bearer ${secret.ORDER_API_TOKEN}"},
        {},
    )

    assert headers["Authorization"] == "Bearer token-123"


def test_resolve_basic_auth_header(monkeypatch):
    monkeypatch.setenv("TOOL_PASSWORD", "123456")
    executor = object.__new__(ToolExecutor)

    headers = executor._resolve_headers(
        {},
        {
            "type": " basic ",
            "basic": {"username": "admin", "password": "${secret.TOOL_PASSWORD}"},
        },
    )

    assert headers["Authorization"] == "Basic YWRtaW46MTIzNDU2"


def test_explicit_authorization_header_takes_precedence_over_basic_auth():
    executor = object.__new__(ToolExecutor)

    headers = executor._resolve_headers(
        {"Authorization": "Custom value"},
        {"type": "basic", "basic": {"username": "admin", "password": "123456"}},
    )

    assert headers["Authorization"] == "Custom value"


def test_unknown_auth_type_is_forwarded_as_literal_headers(monkeypatch):
    monkeypatch.setenv("VENDOR_TOKEN", "token-123")
    executor = object.__new__(ToolExecutor)

    headers = executor._resolve_headers(
        {"Content-Type": "application/json"},
        {
            "X-API-Key": "${secret.VENDOR_TOKEN}",
            "X-Scope": "staff",
            "X-Options": {"region": "cn"},
        },
    )

    assert headers["X-API-Key"] == "token-123"
    assert headers["X-Scope"] == "staff"
    assert headers["X-Options"] == '{"region":"cn"}'


def test_internal_mock_request_adds_service_token_only_for_configured_origin() -> None:
    executor = object.__new__(ToolExecutor)
    executor.settings = type(
        "Settings",
        (),
        {"normalized_tool_base_url": "http://127.0.0.1:5173"},
    )()

    internal = executor._request_headers(
        "http://127.0.0.1:5173/api/mock/order/query",
        {"Content-Type": "application/json"},
    )
    external = executor._request_headers(
        "https://example.test/api/mock/order/query",
        {"Content-Type": "application/json"},
    )

    assert internal[INTERNAL_SERVICE_HEADER] == internal_service_token()
    assert INTERNAL_SERVICE_HEADER not in external


def test_execute_rejects_tool_not_bound_to_current_employee() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        owner = AgentProfile(id="agent_owner", tenant_id="tenant_demo", name="员工 A")
        other = AgentProfile(id="agent_other", tenant_id="tenant_demo", name="员工 B")
        tool = Tool(
            id="tool_private",
            tenant_id="tenant_demo",
            name="private.lookup",
            method="POST",
            url="https://example.test/private",
            enabled=True,
        )
        db.add(owner)
        db.add(other)
        db.add(tool)
        db.flush()
        ensure_private_resource_binding(db, "tenant_demo", owner.id, "tool", tool.id, "active")
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name=tool.name, arguments={}),
            agent_id=other.id,
        )

        assert result.success is False
        assert result.error is not None
        assert result.error.code == "NOT_ALLOWED"


def test_execute_builtin_mcp_tool_success() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_builtin", tenant_id="tenant_demo", name="builtin", transport="builtin"
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.demo_echo",
                display_name="MCP Demo Echo",
                tool_type="mcp",
                method="POST",
                url="mcp://builtin.demo/echo",
                mcp_server_id="server_builtin",
                config_json={"tool": "echo"},
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name="mcp.demo_echo", arguments={"text": "hello mcp"}),
        )

        assert result.success is True
        assert result.data == {"text": "hello mcp", "length": 9}


def test_execution_policy_uses_tool_timeout_and_falls_back_for_invalid_values() -> None:
    executor = object.__new__(ToolExecutor)
    executor.settings = type("Settings", (), {"tool_timeout_seconds": 8.0})()

    configured = Tool(
        tenant_id="tenant_demo",
        name="slow.lookup",
        method="POST",
        url="https://example.test/slow",
        config_json={"execution": {"timeout_seconds": 20}},
    )
    invalid = Tool(
        tenant_id="tenant_demo",
        name="bad.lookup",
        method="POST",
        url="https://example.test/bad",
        config_json={"execution": {"timeout_seconds": 9999}},
    )

    assert executor._execution_policy(configured).timeout_seconds == 20
    assert (
        executor._execution_policy(
            configured,
            timeout_seconds_override=3.5,
        ).timeout_seconds
        == 3.5
    )
    assert executor._execution_policy(invalid).timeout_seconds == 8


def test_execute_http_tool_passes_configured_timeout_to_client(monkeypatch) -> None:
    captured: dict[str, float] = {}

    class FakeClient:
        def __init__(self, *, timeout: float):
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            return httpx.Response(200, json={"ok": True}, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="slow.lookup",
                method="POST",
                url="https://example.test/slow",
                config_json={"execution": {"timeout_seconds": 20}},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo", ToolCall(name="slow.lookup", arguments={})
        )

    assert result.success is True
    assert captured["timeout"] == 20


def test_execute_a2a_tool_sends_standard_send_message_request(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *, timeout: float):
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, url, *, headers=None, json=None):
            captured.update(url=url, headers=headers, payload=json)
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": json["id"], "result": {"kind": "message", "parts": [{"text": "done"}]}},
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="a2a.finance",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                config_json={
                    "a2a_version": "1.0",
                    "accepted_output_modes": ["text/plain"],
                    "execution": {"timeout_seconds": 25},
                },
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.finance", arguments={"query": "查询报销制度"}),
        )

    assert result.success is True
    assert result.data["state"] == "completed"
    assert result.data["task"] == {"kind": "message", "parts": [{"text": "done"}]}
    assert captured["timeout"] == pytest.approx(25, abs=0.01)
    assert captured["headers"]["A2A-Version"] == "1.0"
    assert captured["payload"]["method"] == "SendMessage"
    assert captured["payload"]["params"]["message"]["parts"] == [{"text": "查询报销制度"}]


def test_execute_a2a_waits_for_working_task_and_persists_lifecycle(monkeypatch) -> None:
    calls: list[str] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, *, headers=None):
            return httpx.Response(
                200,
                json={
                    "protocolVersion": "1.0",
                    "supportedInterfaces": [
                        {
                            "url": "https://agent.example.test/a2a",
                            "protocolBinding": "JSONRPC",
                            "protocolVersion": "1.0",
                        }
                    ],
                    "capabilities": {"streaming": False},
                },
                request=httpx.Request("GET", url),
            )

        def post(self, url, *, headers=None, json=None):
            method = json["method"]
            calls.append(method)
            if method == "SendMessage":
                result = {
                    "id": "remote-task-1",
                    "contextId": "ctx-1",
                    "status": {"state": "working"},
                }
            else:
                result = {
                    "id": "remote-task-1",
                    "contextId": "ctx-1",
                    "status": {
                        "state": "completed",
                        "message": {"parts": [{"text": "done"}]},
                    },
                }
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": json["id"], "result": result},
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_wait",
                tenant_id="tenant_demo",
                name="a2a.wait",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                config_json={"poll_interval_seconds": 0.001},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.wait", arguments={"query": "run"}),
            session_id="session-1",
        )
        runs = list(db.exec(select(A2ATaskRun)).all())
        events = list(db.exec(select(A2ATaskEvent)).all())

    assert result.success is True
    assert result.data["state"] == "completed"
    assert result.data["task_id"] == "remote-task-1"
    assert calls == ["SendMessage", "GetTask"]
    assert len(runs) == 1
    assert runs[0].status == "completed"
    assert {event.event_type for event in events} >= {
        "submitted",
        "message_result",
        "task_polled",
        "completed",
    }


def test_execute_a2a_same_invocation_returns_persisted_result_without_resending(
    monkeypatch,
) -> None:
    calls: list[str] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, *, headers=None):
            raise RuntimeError("no agent card")

        def post(self, url, *, headers=None, json=None):
            calls.append(json["method"])
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": json["id"],
                    "result": {
                        "id": "remote-idempotent",
                        "status": {"state": "completed"},
                    },
                },
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_idempotent",
                tenant_id="tenant_demo",
                name="a2a.idempotent",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                enabled=True,
            )
        )
        db.commit()

        first = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.idempotent", arguments={"query": "run"}),
            invocation_id="call-1",
        )
        second = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.idempotent", arguments={"query": "run"}),
            invocation_id="call-1",
        )
        runs = list(db.exec(select(A2ATaskRun)).all())

    assert first.success is True
    assert second.success is True
    assert second.data == first.data
    assert calls == ["SendMessage"]
    assert len(runs) == 1


def test_execute_a2a_same_invocation_resumes_remote_working_task(monkeypatch) -> None:
    calls: list[str] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, url, *, headers=None, json=None):
            calls.append(json["method"])
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": json["id"],
                    "result": {
                        "id": "remote-recover",
                        "contextId": "context-recover",
                        "status": {"state": "completed"},
                    },
                },
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_recover",
                tenant_id="tenant_demo",
                name="a2a.recover",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                config_json={"discover_agent_card": False, "poll_interval_seconds": 0.001},
                enabled=True,
            )
        )
        db.add(
            A2ATaskRun(
                id="a2arun_recover",
                direction="client",
                tenant_id="tenant_demo",
                tool_id="tool_a2a_recover",
                invocation_id="call-recover",
                endpoint_url="https://agent.example.test/a2a",
                remote_task_id="remote-recover",
                context_id="context-recover",
                status="working",
                request_json={
                    "arguments": {"query": "run"},
                    "message": {
                        "messageId": "message-recover",
                        "role": "ROLE_USER",
                        "parts": [{"text": "run"}],
                    },
                },
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.recover", arguments={"query": "run"}),
            invocation_id="call-recover",
        )
        recovered = db.get(A2ATaskRun, "a2arun_recover")

    assert result.success is True
    assert calls == ["GetTask"]
    assert recovered is not None
    assert recovered.status == "completed"
    assert recovered.recovery_attempts == 1


def test_execute_a2a_continues_input_required_task_in_same_session(monkeypatch) -> None:
    messages: list[dict[str, object]] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, *, headers=None):
            raise RuntimeError("no agent card")

        def post(self, url, *, headers=None, json=None):
            message = json["params"]["message"]
            messages.append(message)
            first = len(messages) == 1
            result = {
                "id": "remote-task-input",
                "contextId": "ctx-input",
                "status": {
                    "state": "input-required" if first else "completed",
                    "message": {
                        "parts": [{"text": "请提供姓名" if first else "张三已查询"}]
                    },
                },
            }
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": json["id"], "result": result},
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_continue",
                tenant_id="tenant_demo",
                name="a2a.continue",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                enabled=True,
            )
        )
        db.commit()

        first = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.continue", arguments={"query": "查询员工"}),
            session_id="session-continue",
        )
        second = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.continue", arguments={"query": "张三"}),
            session_id="session-continue",
        )

    assert first.success is True
    assert first.data["awaiting_input"] is True
    assert second.success is True
    assert second.data["state"] == "completed"
    assert messages[1]["taskId"] == "remote-task-input"
    assert messages[1]["contextId"] == "ctx-input"


def test_execute_a2a_stream_merges_artifact_before_terminal_status(monkeypatch) -> None:
    class FakeStreamResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        def iter_lines(self):
            artifact = {
                "jsonrpc": "2.0",
                "id": "1",
                "result": {
                    "artifactUpdate": {
                        "taskId": "stream-task",
                        "contextId": "stream-context",
                        "artifact": {
                            "artifactId": "report",
                            "parts": [{"file": {"name": "report.txt", "bytes": "aGVsbG8="}}],
                        },
                    }
                },
            }
            completed = {
                "jsonrpc": "2.0",
                "id": "1",
                "result": {
                    "statusUpdate": {
                        "taskId": "stream-task",
                        "contextId": "stream-context",
                        "status": {"state": "completed"},
                        "final": True,
                    }
                },
            }
            return iter(
                [
                    "id: 1",
                    f"data: {json.dumps(artifact)}",
                    "",
                    "id: 2",
                    f"data: {json.dumps(completed)}",
                    "",
                ]
            )

    class FakeClient:
        def __init__(self, *, timeout: float):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, *, headers=None):
            return httpx.Response(
                200,
                json={"capabilities": {"streaming": True}},
                request=httpx.Request("GET", url),
            )

        def stream(self, method, url, *, headers=None, json=None):
            return FakeStreamResponse()

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="a2a.stream",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                enabled=True,
            )
        )
        db.commit()
        result = ToolExecutor(db).execute(
            "tenant_demo", ToolCall(name="a2a.stream", arguments={"query": "report"})
        )

    assert result.success is True
    assert result.data["state"] == "completed"
    assert result.data["artifacts"][0]["artifactId"] == "report"


def test_execute_mcp_tool_passes_configured_timeout(monkeypatch) -> None:
    captured: dict[str, float] = {}

    def fake_execute(config, arguments, *, timeout_seconds, tool_name):
        captured["timeout"] = timeout_seconds
        return {"ok": True}

    monkeypatch.setattr("app.tools.tool_executor.execute_mcp_tool", fake_execute)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_builtin_timeout",
                tenant_id="tenant_demo",
                name="builtin-timeout",
                transport="builtin",
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.timeout.echo",
                tool_type="mcp",
                method="POST",
                url="mcp://builtin.demo/echo",
                mcp_server_id="server_builtin_timeout",
                config_json={
                    "tool": "echo",
                    "execution": {"timeout_seconds": 20},
                },
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo", ToolCall(name="mcp.timeout.echo", arguments={"text": "hi"})
        )

    assert result.success is True
    assert captured["timeout"] == 20


def test_protected_mcp_tool_without_user_identity_fails_closed(monkeypatch) -> None:
    """Catch protected MCP execution falling back to legacy anonymous dispatch."""

    def fail_legacy(*_args, **_kwargs):
        """Prove the existing client is unreachable for OAuth-protected servers."""
        raise AssertionError("legacy MCP client must not receive protected execution")

    monkeypatch.setattr("app.tools.tool_executor.execute_mcp_tool", fail_legacy)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_oauth",
                tenant_id="tenant_demo",
                name="oauth",
                transport="streamable_http",
                url="https://mcp.example/mcp",
                auth_mode="oauth_personal",
                oauth_client_id="staffdeck-public",
                oauth_redirect_uri="https://staffdeck.example/oauth/callback",
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.protected",
                tool_type="mcp",
                method="POST",
                url="mcp://oauth/protected",
                mcp_server_id="server_oauth",
                config_json={"tool": "protected"},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="mcp.protected", arguments={}),
        )

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "MCP_AUTHORIZATION_REQUIRED"


def test_protected_mcp_tool_uses_current_user_grant_and_official_adapter(monkeypatch) -> None:
    """Catch a protected invocation using another user's grant or static Authorization header."""
    from mcp.shared.auth import OAuthToken

    from app.tools.mcp_oauth_service import MCPGrantTokenStorage

    captured: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, **kwargs):
            """Capture the sanitized owner-bound adapter configuration."""
            captured.update(kwargs)

        async def call_tool(self, name: str, arguments: dict[str, object]):
            """Return the existing StaffDeck tool-result envelope without network access."""
            captured["tool_name"] = name
            captured["arguments"] = arguments
            return {"data": {"ok": True}, "meta": {"provider": "official-sdk"}}

    monkeypatch.setattr("app.tools.tool_executor.MCPSDKAdapter", FakeAdapter)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_oauth",
                tenant_id="tenant_demo",
                name="oauth",
                transport="streamable_http",
                url="https://mcp.example/mcp",
                headers_json={"Authorization": "Bearer forbidden-static", "X-Public": "ok"},
                auth_mode="oauth_personal",
                oauth_client_id="staffdeck-public",
                oauth_redirect_uri="https://staffdeck.example/oauth/callback",
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.protected",
                tool_type="mcp",
                method="POST",
                url="mcp://oauth/protected",
                mcp_server_id="server_oauth",
                config_json={"tool": "protected"},
                enabled=True,
            )
        )
        db.commit()
        storage = MCPGrantTokenStorage(
            db.get_bind(),
            "tenant_demo",
            "server_oauth",
            "user_current",
        )
        asyncio.run(storage.set_tokens(OAuthToken(access_token="current-only", expires_in=3600)))

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="mcp.protected", arguments={"query": "hello"}),
            user_id="user_current",
        )

    assert result.success is True
    assert result.data == {"ok": True}
    assert result.mcp_metadata == {"provider": "official-sdk"}
    assert captured["storage"].user_id == "user_current"
    assert captured["headers"] == {"Authorization": "Bearer forbidden-static", "X-Public": "ok"}
    assert captured["tool_name"] == "protected"


def test_execute_builtin_mcp_tool_unknown_config_returns_error() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_builtin", tenant_id="tenant_demo", name="builtin", transport="builtin"
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.bad",
                display_name="Bad MCP",
                tool_type="mcp",
                method="POST",
                url="mcp://builtin.demo/missing",
                mcp_server_id="server_builtin",
                config_json={"tool": "missing"},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name="mcp.bad", arguments={}),
        )

        assert result.success is False
        assert result.error is not None
        assert result.error.code == "MCP_ERROR"


def test_execute_stdio_mcp_tool_success() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_stdio",
                tenant_id="tenant_demo",
                name="stdio",
                transport="stdio",
                command=sys.executable,
                args_json=[str(_mock_mcp_server_path())],
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.real_echo",
                display_name="Real MCP Echo",
                tool_type="mcp",
                method="POST",
                url="mcp://stdio/mock/echo",
                mcp_server_id="server_stdio",
                config_json={"tool": "echo"},
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name="mcp.real_echo", arguments={"text": "hello real mcp"}),
        )

        assert result.success is True
        assert result.data == {"text": "hello real mcp", "length": 14}


def test_execute_stdio_mcp_tool_error_is_stable() -> None:
    """Keep stdio provider validation prose private while returning the stable MCP code."""
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            MCPServer(
                id="server_stdio",
                tenant_id="tenant_demo",
                name="stdio",
                transport="stdio",
                command=sys.executable,
                args_json=[str(_mock_mcp_server_path())],
            )
        )
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="mcp.real_sum",
                display_name="Real MCP Sum",
                tool_type="mcp",
                method="POST",
                url="mcp://stdio/mock/sum",
                mcp_server_id="server_stdio",
                config_json={"tool": "sum"},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name="mcp.real_sum", arguments={"numbers": ["bad"]}),
        )

        assert result.success is False
        assert result.error is not None
        assert result.error.code == "MCP_ERROR"
        assert result.error.message == "MCP_ERROR"
        assert result.error.deprecated_fields == ["message"]
        assert result.error.internal_context is not None
        assert "numbers" in str(result.error.internal_context.raw_message)
        assert "numbers" not in repr(result.model_dump(mode="json"))


def test_execute_get_tool_preserves_query_string_when_arguments_empty(monkeypatch) -> None:
    requested: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            requested.update({"method": method, "url": url, "params": params})
            return httpx.Response(
                200,
                json={"current": {"temperature_2m": 27.4}},
                request=httpx.Request(method, url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                tenant_id="tenant_demo",
                name="weather.forecast",
                display_name="天气查询",
                method="GET",
                url=(
                    "https://api.open-meteo.com/v1/forecast"
                    "?latitude=39.90&longitude=116.40&current=temperature_2m"
                ),
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            tenant_id="tenant_demo",
            tool_call=ToolCall(name="weather.forecast", arguments={}),
        )

    assert result.success is True
    assert result.data == {"current": {"temperature_2m": 27.4}}
    assert requested == {
        "method": "GET",
        "url": (
            "https://api.open-meteo.com/v1/forecast"
            "?latitude=39.90&longitude=116.40&current=temperature_2m"
        ),
        "params": None,
    }


def _mock_mcp_server_path() -> Path:
    return Path(__file__).resolve().parents[1] / "mock_servers" / "mcp_stdio_server.py"


def _test_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _a2a_en_us_context() -> LanguageContext:
    """Build the explicit outbound A2A locale snapshot used by contract tests."""
    return LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def test_execute_a2a_sends_locale_metadata_and_persists_the_same_snapshot(monkeypatch) -> None:
    """Keep A2A message text raw while carrying the immutable locale in protocol metadata."""
    captured: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *, timeout: float):
            del timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, *, headers=None):
            raise RuntimeError("agent card unavailable")

        def post(self, url, *, headers=None, json=None):
            captured["payload"] = json
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": json["id"],
                    "result": {"id": "remote-locale", "status": {"state": "completed"}},
                },
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    context = _a2a_en_us_context()
    raw_text = "原始用户输入，不应被翻译"
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_locale",
                tenant_id="tenant_demo",
                name="a2a.locale",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                config_json={"discover_agent_card": False},
                enabled=True,
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.locale", arguments={"text": raw_text}),
            invocation_id="call-locale",
            session_id="session-locale",
            language_context=context,
        )
        run = db.exec(select(A2ATaskRun)).one()

    expected = context.model_dump(mode="json")
    assert result.success is True
    assert run.language_context_json == expected
    payload = captured["payload"]
    assert payload["params"]["message"]["parts"] == [{"text": raw_text}]
    assert payload["params"]["metadata"]["language_context"] == expected


def test_execute_a2a_recovery_reuses_persisted_locale_metadata(monkeypatch) -> None:
    """Recovery must use the durable locale snapshot instead of a changed current preference."""
    captured: list[dict[str, object]] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
            del timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, url, *, headers=None, json=None):
            captured.append(json)
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": json["id"],
                    "result": {"id": "remote-recovery", "status": {"state": "completed"}},
                },
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    stored_context = _a2a_en_us_context()
    current_context = stored_context.model_copy(
        update={"ui_locale": SupportedLocale.ZH_CN, "agent_reply_locale": SupportedLocale.ZH_CN}
    )
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            Tool(
                id="tool_a2a_recovery_locale",
                tenant_id="tenant_demo",
                name="a2a.recovery-locale",
                tool_type="a2a",
                method="POST",
                url="https://agent.example.test/a2a",
                config_json={"discover_agent_card": False},
                enabled=True,
            )
        )
        db.add(
            A2ATaskRun(
                id="a2arun-recovery-locale",
                direction="client",
                tenant_id="tenant_demo",
                tool_id="tool_a2a_recovery_locale",
                invocation_id="call-recovery-locale",
                endpoint_url="https://agent.example.test/a2a",
                status="submitted",
                request_json={
                    "arguments": {"text": "raw recovery input"},
                    "message": {
                        "messageId": "message-recovery-locale",
                        "role": "ROLE_USER",
                        "parts": [{"text": "raw recovery input"}],
                    },
                },
                language_context_json=stored_context.model_dump(mode="json"),
            )
        )
        db.commit()

        result = ToolExecutor(db).execute(
            "tenant_demo",
            ToolCall(name="a2a.recovery-locale", arguments={"text": "changed input"}),
            invocation_id="call-recovery-locale",
            language_context=current_context,
        )

    assert result.success is True
    assert len(captured) == 1
    assert captured[0]["params"]["message"]["parts"] == [{"text": "raw recovery input"}]
    assert captured[0]["params"]["metadata"]["language_context"] == stored_context.model_dump(
        mode="json"
    )

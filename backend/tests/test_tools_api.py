import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.branching import ensure_open_gallery_binding, ensure_private_resource_binding
from app.api import tools as tools_api
from app.api.tools import (
    _a2a_task_run_read,
    _discover_response,
    _ensure_tool_visible,
    _normalize_probe_url,
    _read_execution_policy,
    _tool_config,
    cancel_a2a_task_run,
    delete_tool,
    get_codex_a2a_adapter,
    list_a2a_task_runs,
    list_tools,
)
from app.api.tools import (
    probe_tool as _probe_tool,
)
from app.api.tools import (
    test_tool as _test_tool,
)
from app.config import get_settings
from app.db.models import (
    A2ATaskEvent,
    A2ATaskRun,
    AgentProfile,
    AgentResourceBinding,
    Tenant,
    Tool,
    User,
)
from app.security.internal_service import INTERNAL_SERVICE_HEADER, internal_service_token
from app.security.permissions import require_agent_scope_viewer
from app.tools.tool_schema import (
    MCPServerConnection,
    ToolCall,
    ToolExecutionPolicy,
    ToolProbeRequest,
    ToolResult,
    ToolTestRequest,
)


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="ops", role="admin", password_hash="test"
    )


def _member_user() -> User:
    return User(
        id="user_member",
        tenant_id="tenant_demo",
        username="member",
        role="member",
        password_hash="test",
    )


def probe_tool(request: ToolProbeRequest, db: Session):
    return _probe_tool(request, db, _member_user())


def test_direct_tool_test_forwards_authenticated_user_identity(monkeypatch) -> None:
    """Catch direct MCP tests dropping the authenticated user's personal grant identity."""
    captured: dict[str, object] = {}

    def fake_execute(self, tenant_id: str, tool_call: ToolCall, **kwargs):
        """Capture the API-to-executor identity boundary without external I/O."""
        del self
        captured.update({"tenant_id": tenant_id, "tool_call": tool_call, **kwargs})
        return ToolResult(tool_name=tool_call.name, success=True, data={"ok": True})

    monkeypatch.setattr("app.api.tools.ToolExecutor.execute", fake_execute)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall",
                tenant_id="tenant_demo",
                name="Open Gallery",
                is_overall=True,
            )
        )
        tool = Tool(
            id="tool_direct",
            tenant_id="tenant_demo",
            name="mcp.direct",
            tool_type="mcp",
            method="POST",
            url="mcp://server/direct",
            enabled=True,
        )
        db.add(tool)
        db.flush()
        ensure_open_gallery_binding(db, "tenant_demo", "tool", tool.id, "active")
        db.commit()

        result = _test_tool(
            tool.id,
            ToolTestRequest(tenant_id="tenant_demo", arguments={"query": "hello"}),
            "agent_overall",
            db,
            _member_user(),
        )

    assert result.success is True
    assert captured["user_id"] == "user_member"


def test_delete_tool_removes_tenant_tool() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        tool = Tool(
            tenant_id="tenant_demo",
            name="product.lookup",
            display_name="商品查询",
            method="POST",
            url="/api/mock/product/lookup",
        )
        db.add(tool)
        db.commit()
        db.refresh(tool)

        result = delete_tool(tool.id, "tenant_demo", db, current_user=_admin_user())

        assert result == {"status": "deleted"}
        assert db.get(Tool, tool.id) is None


def test_a2a_run_listing_includes_events_and_cancel_is_persisted() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall", tenant_id="tenant_demo", name="开放广场", is_overall=True
            )
        )
        tool = Tool(
            id="tool_a2a",
            tenant_id="tenant_demo",
            name="codex.remote",
            display_name="Codex",
            tool_type="a2a",
            method="POST",
            url="https://codex.example.test/api/a2a",
        )
        db.add(tool)
        db.flush()
        ensure_open_gallery_binding(db, "tenant_demo", "tool", tool.id, "active")
        run = A2ATaskRun(
            id="a2arun_demo",
            owner_scope="tenant",
            tenant_id="tenant_demo",
            system_runtime_key=None,
            tenant_lifecycle_version=1,
            tool_id=tool.id,
            endpoint_url=tool.url,
            remote_task_id="remote_1",
            status="working",
            artifacts_json=[{"name": "report.md"}],
        )
        db.add(run)
        db.add(
            A2ATaskEvent(
                run_id=run.id,
                sequence=1,
                event_type="task.created",
                data_json={"status": "working"},
            )
        )
        db.commit()

        rows = list_a2a_task_runs(tool.id, "tenant_demo", None, 20, db)

        assert len(rows) == 1
        assert rows[0].remote_task_id == "remote_1"
        assert rows[0].artifacts == [{"name": "report.md"}]
        assert [(event.sequence, event.event_type) for event in rows[0].events] == [
            (1, "task.created")
        ]

        cancelled = cancel_a2a_task_run(
            tool.id,
            run.id,
            "tenant_demo",
            None,
            db,
            _admin_user(),
        )

        assert cancelled.cancel_requested is True
        assert db.get(A2ATaskRun, run.id).cancel_requested is True


def test_codex_a2a_adapter_status_never_returns_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.api.tools.get_settings",
        lambda: SimpleNamespace(
            codex_a2a_enabled=True,
            codex_a2a_command="codex",
            codex_a2a_workspace_root="/srv/codex",
            codex_a2a_timeout_seconds=1800.0,
            codex_a2a_token="secret-token",
        ),
    )

    result = get_codex_a2a_adapter()

    payload = result.model_dump()
    assert payload == {
        "available": True,
        "endpoint_url": "/api/a2a/codex",
        "agent_card_url": "/.well-known/agent-card.json",
        "timeout_seconds": 1800.0,
    }
    assert "secret-token" not in repr(payload)


def test_tenant_codex_a2a_connection_helper_returns_only_sanitized_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep tenant-facing connection metadata free of installation control and execution content."""
    runtime_secret = "tenant-helper-installation-secret"
    raw_prompt = "tenant helper must never return this prompt"
    monkeypatch.setattr(
        "app.api.tools.get_settings",
        lambda: SimpleNamespace(
            codex_a2a_enabled=True,
            codex_a2a_command="codex --dangerous",
            codex_a2a_workspace_root="/srv/private-workspace",
            codex_a2a_timeout_seconds=900.0,
            codex_a2a_token=runtime_secret,
            codex_a2a_prompt=raw_prompt,
        ),
    )
    app = FastAPI()
    app.include_router(tools_api.router)
    app.dependency_overrides[require_agent_scope_viewer] = lambda: _member_user()
    client = TestClient(app)

    response = client.get(
        "/api/enterprise/tools/a2a/codex-adapter",
        params={"tenant_id": "tenant_demo"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "available": True,
        "endpoint_url": "/api/a2a/codex",
        "agent_card_url": "/.well-known/agent-card.json",
        "timeout_seconds": 900.0,
    }
    serialized = response.text
    assert all(
        value not in serialized
        for value in (runtime_secret, raw_prompt, "codex --dangerous", "/srv/private-workspace")
    )


def test_tool_config_namespaces_execution_and_preserves_existing_policy() -> None:
    created = _tool_config(
        {"tool": "sum"},
        ToolExecutionPolicy(timeout_seconds=20),
    )
    updated_by_legacy_client = _tool_config(
        {"tool": "echo", "obsolete": False},
        None,
        existing={**created, "obsolete": True},
    )

    assert created == {"tool": "sum", "execution": {"timeout_seconds": 20.0}}
    assert updated_by_legacy_client == {
        "tool": "echo",
        "obsolete": False,
        "execution": {"timeout_seconds": 20.0},
    }


def test_tool_config_rejects_untyped_execution_and_reads_invalid_legacy_safely() -> None:
    config = _tool_config(
        {"tool": "sum", "execution": {"timeout_seconds": 3601}},
        None,
    )

    assert config == {"tool": "sum"}
    assert _read_execution_policy({"execution": {"timeout_seconds": 3601}}) is None


def test_delete_tool_is_tenant_scoped() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(Tenant(id="tenant_other", name="Other"))
        tool = Tool(
            tenant_id="tenant_other",
            name="product.lookup",
            display_name="商品查询",
            method="POST",
            url="/api/mock/product/lookup",
        )
        db.add(tool)
        db.commit()
        db.refresh(tool)

        with pytest.raises(HTTPException) as exc_info:
            delete_tool(tool.id, "tenant_demo", db, current_user=_admin_user())

        assert exc_info.value.status_code == 404
        assert db.get(Tool, tool.id) is not None


def test_open_gallery_delete_tool_hides_gallery_without_removing_agent_binding() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall", tenant_id="tenant_demo", name="开放广场", is_overall=True
            )
        )
        db.add(
            AgentProfile(
                id="agent_branch", tenant_id="tenant_demo", name="研发员工", is_overall=False
            )
        )
        tool = Tool(
            id="tool_weather",
            tenant_id="tenant_demo",
            name="weather.forecast",
            display_name="天气查询",
            method="POST",
            url="/api/mock/weather",
        )
        db.add(tool)
        db.add(
            AgentResourceBinding(
                tenant_id="tenant_demo",
                agent_id="agent_branch",
                resource_type="tool",
                resource_id=tool.id,
                status="active",
            )
        )
        db.commit()
        ensure_open_gallery_binding(db, "tenant_demo", "tool", tool.id, "active")
        db.commit()

        result = delete_tool(
            tool.id,
            "tenant_demo",
            db,
            agent_id="agent_overall",
            current_user=_admin_user(),
        )

        assert result == {"status": "hidden"}
        assert db.get(Tool, tool.id) is not None
        branch_binding = db.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.tenant_id == "tenant_demo",
                AgentResourceBinding.agent_id == "agent_branch",
                AgentResourceBinding.resource_type == "tool",
                AgentResourceBinding.resource_id == tool.id,
            )
        ).one()
        assert branch_binding.status == "active"
        assert list_tools("tenant_demo", bucket=None, agent_id="agent_overall", db=db) == []
        assert list_tools("tenant_demo", bucket=None, agent_id="agent_branch", db=db) == []


def test_open_gallery_tool_read_returns_persisted_creator_metadata() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall", tenant_id="tenant_demo", name="开放广场", is_overall=True
            )
        )
        tool = Tool(
            id="tool_weather",
            tenant_id="tenant_demo",
            name="weather.forecast",
            display_name="天气查询",
            method="POST",
            url="/api/mock/weather",
        )
        db.add(tool)
        db.commit()
        ensure_open_gallery_binding(
            db,
            "tenant_demo",
            "tool",
            tool.id,
            "active",
            metadata_json={"creator_name": "admin", "created_by_username": "admin"},
        )
        db.commit()

        rows = list_tools("tenant_demo", bucket=None, agent_id="agent_overall", db=db)

        assert len(rows) == 1
        assert rows[0].metadata["creator_name"] == "admin"
        assert rows[0].metadata["created_by_username"] == "admin"


def test_private_tool_is_not_visible_without_employee_scope() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        agent = AgentProfile(id="agent_private", tenant_id="tenant_demo", name="研发员工")
        tool = Tool(
            id="tool_private",
            tenant_id="tenant_demo",
            name="private.lookup",
            method="POST",
            url="https://example.test/private",
        )
        db.add(agent)
        db.add(tool)
        db.flush()
        ensure_private_resource_binding(db, "tenant_demo", agent.id, "tool", tool.id, "active")
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            _ensure_tool_visible(db, "tenant_demo", tool, None)

        assert exc_info.value.status_code == 404


def test_agent_without_tool_binding_does_not_see_open_gallery_tools() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall", tenant_id="tenant_demo", name="开放广场", is_overall=True
            )
        )
        db.add(
            AgentProfile(
                id="agent_branch", tenant_id="tenant_demo", name="研发员工", is_overall=False
            )
        )
        tool = Tool(
            id="tool_weather",
            tenant_id="tenant_demo",
            name="weather.forecast",
            display_name="天气查询",
            method="POST",
            url="/api/mock/weather",
        )
        db.add(tool)
        db.commit()
        ensure_open_gallery_binding(db, "tenant_demo", "tool", tool.id, "active")
        db.commit()

        rows = list_tools("tenant_demo", bucket=None, agent_id="agent_branch", db=db)

        assert rows == []


def test_invalid_agent_id_does_not_fall_back_to_open_gallery_tools() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(
            AgentProfile(
                id="agent_overall", tenant_id="tenant_demo", name="开放广场", is_overall=True
            )
        )
        tool = Tool(
            id="tool_weather",
            tenant_id="tenant_demo",
            name="weather.forecast",
            display_name="天气查询",
            method="POST",
            url="/api/mock/weather",
        )
        db.add(tool)
        db.commit()
        ensure_open_gallery_binding(db, "tenant_demo", "tool", tool.id, "active")
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            list_tools("tenant_demo", bucket=None, agent_id="agent_missing", db=db)

        assert exc_info.value.status_code == 404


def test_probe_tool_success_infers_output_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.api.tools.get_settings",
        lambda: SimpleNamespace(
            normalized_tool_base_url="http://localhost:5173",
            tool_timeout_seconds=30.0,
        ),
    )

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            assert method == "POST"
            assert url == "http://localhost:5173/api/mock/member/benefit-reconcile"
            assert headers[INTERNAL_SERVICE_HEADER] == internal_service_token()
            assert json == {"user_id": "user_demo", "order_id": "A12345"}
            return httpx.Response(
                200,
                json={
                    "found": True,
                    "missing_benefits": [{"benefit_id": "coupon_001", "amount": 30}],
                },
            )

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="member.benefit_reconcile",
                method="POST",
                url="/api/mock/member/benefit-reconcile",
                sample_arguments={"user_id": "user_demo", "order_id": "A12345"},
            ),
            db,
        )

        assert result.success is True
        assert result.status_code == 200
        assert result.inferred_output_schema["properties"]["found"]["type"] == "boolean"
        assert result.inferred_output_schema["properties"]["missing_benefits"]["type"] == "array"


def test_probe_tool_forwards_custom_auth_json_as_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    requested: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            requested.update(headers=headers, json=json)
            return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="vendor.lookup",
                method="POST",
                url="https://vendor.example.test/lookup",
                headers={"Content-Type": "application/json"},
                auth={"X-API-Key": "api-key", "Authorization": "Token vendor-token"},
                sample_arguments={"query": "staff"},
            ),
            db,
        )

    assert result.success is True
    assert requested["headers"] == {
        "Content-Type": "application/json",
        "X-API-Key": "api-key",
        "Authorization": "Token vendor-token",
    }
    assert requested["json"] == {"query": "staff"}


def test_probe_mcp_tool_success_infers_output_schema() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="mcp.demo_sum",
                tool_type="mcp",
                method="POST",
                url="mcp://builtin.demo/sum",
                mcp_config={"server": "builtin.demo", "tool": "sum"},
                sample_arguments={"numbers": [1, 2, 3]},
            ),
            db,
        )

        assert result.success is True
        assert result.status_code == 200
        assert result.data_preview == {"numbers": [1, 2, 3], "total": 6, "count": 3}
        assert result.inferred_output_schema["properties"]["total"]["type"] == "integer"


def test_probe_get_tool_preserves_query_string_when_arguments_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
            return httpx.Response(200, json={"current": {"temperature_2m": 27.4}})

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="weather.forecast",
                method="GET",
                url=(
                    "https://api.open-meteo.com/v1/forecast"
                    "?latitude=39.90&longitude=116.40&current=temperature_2m"
                ),
                sample_arguments={},
            ),
            db,
        )

    assert result.success is True
    assert requested == {
        "method": "GET",
        "url": (
            "https://api.open-meteo.com/v1/forecast"
            "?latitude=39.90&longitude=116.40&current=temperature_2m"
        ),
        "params": None,
    }


def test_probe_get_tool_sends_sample_arguments_as_query_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: dict[str, object] = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            requested.update({"method": method, "url": url, "params": params, "json": json})
            return httpx.Response(200, json={"timezone": "Asia/Shanghai"})

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="weather.forecast",
                method="GET",
                url="https://api.open-meteo.com/v1/forecast",
                sample_arguments={
                    "latitude": "39.90",
                    "longitude": "116.40",
                    "current": "temperature_2m,wind_speed_10m",
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min",
                    "timezone": "Asia/Shanghai",
                },
            ),
            db,
        )

    assert result.success is True
    assert requested == {
        "method": "GET",
        "url": "https://api.open-meteo.com/v1/forecast",
        "params": {
            "latitude": "39.90",
            "longitude": "116.40",
            "current": "temperature_2m,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min",
            "timezone": "Asia/Shanghai",
        },
        "json": None,
    }


def test_probe_mcp_tool_error_is_stable() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="mcp.bad",
                tool_type="mcp",
                method="POST",
                url="mcp://builtin.demo/missing",
                mcp_config={"server": "builtin.demo", "tool": "missing"},
                sample_arguments={},
            ),
            db,
        )

        assert result.success is False
        assert result.status_code == 400
        assert result.error is not None
        assert result.error.code == "MCP_ERROR"


def test_probe_stdio_mcp_tool_success_infers_output_schema() -> None:
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="mcp.real_product_lookup",
                tool_type="mcp",
                method="POST",
                url="mcp://stdio/mock/product_lookup",
                mcp_config={
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": [str(_mock_mcp_server_path())],
                    "tool": "product_lookup",
                },
                sample_arguments={"product_id": "A1"},
            ),
            db,
        )

        assert result.success is True
        assert result.status_code == 200
        assert result.data_preview["found"] is True
        assert result.data_preview["price"] == 129.0
        assert result.inferred_output_schema["properties"]["price"]["type"] == "number"


def test_probe_tool_relative_url_uses_configured_tool_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TOOL_BASE_URL", "http://127.0.0.1:10086/")
    get_settings.cache_clear()
    try:
        assert _normalize_probe_url("/api/mock/member/benefit-reconcile") == (
            "http://127.0.0.1:10086/api/mock/member/benefit-reconcile"
        )
    finally:
        get_settings.cache_clear()


def test_probe_tool_http_error_returns_stable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def request(self, method, url, headers=None, json=None, params=None):
            return httpx.Response(404, json={"detail": "not found"})

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="missing.tool",
                method="POST",
                url="http://example.invalid/missing",
                sample_arguments={"query": "x"},
            ),
            db,
        )

        assert result.success is False
        assert result.status_code == 404
        assert result.error is not None
        assert result.error.code == "HTTP_ERROR"


def test_probe_tool_exception_does_not_publish_raw_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep an unexpected probe exception private while returning a canonical ToolError."""
    raw_provider_error = "connection failed with Authorization: Bearer do-not-publish"

    class FakeClient:
        """Raise one seeded provider failure from the real probe boundary."""

        def __init__(self, *args, **kwargs):
            """Accept the production client's constructor arguments."""

        def __enter__(self):
            """Return the fake context-managed client."""
            return self

        def __exit__(self, *args):
            """Leave the fake client without suppressing exceptions."""
            return

        def request(self, method, url, headers=None, json=None, params=None):
            """Raise the seeded remote diagnostic before any response exists."""
            raise RuntimeError(raw_provider_error)

    monkeypatch.setattr(httpx, "Client", FakeClient)
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.commit()

        result = probe_tool(
            ToolProbeRequest(
                tenant_id="tenant_demo",
                name="broken.tool",
                method="POST",
                url="http://example.invalid/broken",
                sample_arguments={"query": "raw-success-input"},
            ),
            db,
        )

    assert result.error is not None
    assert result.error.code == "PROBE_ERROR"
    assert result.error.params == {}
    assert result.error.retryable is False
    assert result.error.deprecated_fields == ["message"]
    assert result.error.internal_context is not None
    assert result.error.internal_context.raw_message == raw_provider_error
    assert raw_provider_error not in repr(result.model_dump(mode="json"))


def test_mcp_discovery_typed_error_keeps_provider_exception_private(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Require the typed discovery response to validate a stable code and exclude provider prose."""
    raw_provider_error = "MCP discovery leaked Authorization: Bearer do-not-publish"

    def fail_discovery(*_args, **_kwargs):
        """Raise the seeded provider exception from the real typed-response boundary."""
        raise RuntimeError(raw_provider_error)

    monkeypatch.setattr("app.api.tools.discover_mcp_server", fail_discovery)
    result = _discover_response(MCPServerConnection(transport="builtin"))

    assert result.error is not None
    assert result.error.code == "MCP_DISCOVER_UNEXPECTED"
    assert result.error.internal_context is not None
    assert result.error.internal_context.raw_message == raw_provider_error
    assert raw_provider_error not in repr(result.model_dump(mode="json"))


def test_a2a_run_read_projects_error_json_without_raw_message() -> None:
    """Never copy the persisted remote A2A message into the typed Tool API response."""
    raw_provider_error = "remote task failed token=do-not-publish"
    run = A2ATaskRun(
        owner_scope="tenant",
        tenant_id="tenant_demo",
        direction="client",
        system_runtime_key=None,
        tenant_lifecycle_version=1,
        endpoint_url="https://agent.example/a2a",
        status="failed",
        error_json={
            "code": "A2A_TASK_FAILED",
            "message": raw_provider_error,
            "request_id": "req-a2a-failed",
            "trace_id": "trace-a2a-failed",
        },
    )

    projected = _a2a_task_run_read(run, [])

    assert projected.error == {
        "code": "A2A_TASK_FAILED",
        "params": {},
        "retryable": True,
        "request_id": "req-a2a-failed",
        "trace_id": "trace-a2a-failed",
    }
    assert raw_provider_error not in repr(projected.model_dump(mode="json"))


def test_a2a_run_read_projects_locale_snapshot_and_legacy_default() -> None:
    """Expose the durable locale snapshot while backfilling legacy rows deterministically."""
    explicit = A2ATaskRun(
        owner_scope="tenant",
        tenant_id="tenant_demo",
        direction="client",
        system_runtime_key=None,
        tenant_lifecycle_version=1,
        endpoint_url="https://agent.example/a2a",
        language_context_json={
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "en-US",
            "ui_locale_source": "explicit_request",
            "agent_reply_locale_source": "explicit_request",
        },
    )
    legacy = A2ATaskRun(
        owner_scope="tenant",
        tenant_id="tenant_demo",
        direction="client",
        system_runtime_key=None,
        tenant_lifecycle_version=1,
        endpoint_url="https://agent.example/a2a",
        language_context_json=None,
    )

    assert _a2a_task_run_read(explicit, []).language_context["agent_reply_locale"] == "en-US"
    assert _a2a_task_run_read(legacy, []).language_context == {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "legacy_default",
        "agent_reply_locale_source": "legacy_default",
    }


def test_a2a_run_read_fails_closed_for_malformed_registered_error() -> None:
    """Reject unexpected persisted params instead of widening the public Tool contract."""
    raw_provider_error = "remote task leaked credential=do-not-publish"
    run = A2ATaskRun(
        owner_scope="tenant",
        tenant_id="tenant_demo",
        direction="client",
        system_runtime_key=None,
        tenant_lifecycle_version=1,
        endpoint_url="https://agent.example/a2a",
        status="failed",
        error_json={
            "code": "A2A_TASK_FAILED",
            "params": {"credential": raw_provider_error},
            "retryable": True,
        },
    )

    projected = _a2a_task_run_read(run, [])

    assert projected.error["code"] == "INTERNAL_ERROR"
    assert raw_provider_error not in repr(projected.model_dump(mode="json"))


def _test_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _mock_mcp_server_path() -> Path:
    return Path(__file__).resolve().parents[1] / "mock_servers" / "mcp_stdio_server.py"

"""RED contracts for tenant-owned A2A lifecycle admission and recovery fences."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, Self

import httpx
import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import A2ATaskRun, Tenant, Tool
from app.tools import a2a_client, a2a_recovery
from app.tools.tool_executor import ToolExecutor
from app.tools.tool_schema import ToolCall


def _engine(tmp_path: Path):
    """Create an isolated file-backed store so provider callbacks can commit lifecycle changes."""
    return create_engine(
        f"sqlite:///{tmp_path / 'a2a-lifecycle.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )


def _seed_tool(
    db: Session,
    *,
    tenant_status: str = "active",
    tenant_version: int = 1,
    config: dict[str, Any] | None = None,
) -> Tool:
    """Seed one tenant and its A2A tool with an explicitly controlled lifecycle version."""
    db.add(
        Tenant(
            id="tenant-a2a-lifecycle",
            slug="tenant-a2a-lifecycle",
            name="A2A lifecycle tenant",
            status=tenant_status,
            lifecycle_version=tenant_version,
        )
    )
    tool = Tool(
        id="tool-a2a-lifecycle",
        tenant_id="tenant-a2a-lifecycle",
        name="a2a.lifecycle",
        tool_type="a2a",
        method="POST",
        url="https://agent.example.test/a2a",
        config_json={"discover_agent_card": False, **(config or {})},
        enabled=True,
    )
    db.add(tool)
    db.commit()
    db.refresh(tool)
    return tool


def _response(url: str, result: dict[str, Any]) -> httpx.Response:
    """Wrap one provider result in the JSON-RPC response accepted by the real A2A client."""
    return httpx.Response(
        200,
        json={"jsonrpc": "2.0", "id": "provider-request", "result": result},
        request=httpx.Request("POST", url),
    )


def _terminal_state(run: A2ATaskRun) -> None:
    """Assert a lifecycle-blocked run is terminal and carries a non-retryable stable reason."""
    assert run.status in {"failed", "canceled", "cancelled", "rejected"}
    assert run.error_json["code"] == "TENANT_WORK_TERMINALIZED"
    assert run.error_json["retryable"] is False


class _PostClient:
    """Minimal synchronous provider double whose calls are visible to the contract assertions."""

    def __init__(self, calls: list[str], result_factory: Callable[[str], dict[str, Any]]) -> None:
        """Retain call evidence and a deterministic JSON-RPC result function."""
        self.calls = calls
        self.result_factory = result_factory

    def __enter__(self) -> Self:
        """Return the provider double without opening a network connection."""
        return self

    def __exit__(self, *_args: object) -> None:
        """Close the provider double; no external resource is held."""
        return

    def post(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Record one JSON-RPC method and return its controlled provider response."""
        del headers
        assert json is not None
        method = str(json["method"])
        self.calls.append(method)
        return _response(url, self.result_factory(method))


def test_suspended_tenant_a2a_is_denied_before_any_agent_call(tmp_path, monkeypatch) -> None:
    """A suspended tenant must not discover, submit, or persist a new outbound A2A run."""
    calls: list[str] = []
    provider = _PostClient(
        calls,
        lambda method: {"id": "remote-complete", "status": {"state": "completed"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as db:
        _seed_tool(db, tenant_status="suspended", tenant_version=2)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "blocked"}),
            invocation_id="invocation-suspended",
        )
        runs = list(db.exec(select(A2ATaskRun)).all())

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "TENANT_SUSPENDED"
    assert calls == []
    assert runs == []


def test_tenant_a2a_persists_the_current_admission_version(tmp_path, monkeypatch) -> None:
    """A new tenant-owned run must fence itself with the authoritative version at admission time."""
    provider = _PostClient(
        [],
        lambda method: {"id": "remote-versioned", "status": {"state": "completed"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as db:
        _seed_tool(db, tenant_version=7)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "versioned"}),
            invocation_id="invocation-versioned",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is True
    assert run.owner_scope == "tenant"
    assert run.tenant_id == "tenant-a2a-lifecycle"
    assert run.system_runtime_key is None
    assert run.tenant_lifecycle_version == 7


def test_tenant_a2a_poll_is_fenced_after_suspend_before_get_task(tmp_path, monkeypatch) -> None:
    """Suspension after SendMessage must stop the next GetTask request and terminalize the run."""
    calls: list[str] = []
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    def result_factory(method: str) -> dict[str, Any]:
        """Suspend the tenant after the provider accepts SendMessage, before polling can begin."""
        if method == "SendMessage":
            with Session(engine) as state:
                tenant = state.get(Tenant, "tenant-a2a-lifecycle")
                assert tenant is not None
                tenant.status = "suspended"
                tenant.lifecycle_version = 2
                state.add(tenant)
                state.commit()
            return {
                "id": "remote-working",
                "status": {"state": "working"},
            }
        return {"id": "remote-working", "status": {"state": "completed"}}

    provider = _PostClient(calls, result_factory)
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)

    with Session(engine) as db:
        _seed_tool(db, config={"poll_interval_seconds": 0.001})
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "poll"}),
            invocation_id="invocation-poll",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "TENANT_WORK_TERMINALIZED"
    assert calls == ["SendMessage"]
    _terminal_state(run)


def test_tenant_a2a_subscribe_is_fenced_after_suspend_before_stream_call(tmp_path, monkeypatch) -> None:
    """Suspension before a streaming continuation must prevent SubscribeToTask entirely."""
    calls: list[str] = []
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    class EmptyStream:
        """Represent an empty SSE response; the lifecycle fence should prevent constructing it."""

        def __enter__(self) -> Self:
            """Return the empty response context."""
            return self

        def __exit__(self, *_args: object) -> None:
            """Close the empty response context."""
            return

        def raise_for_status(self) -> None:
            """Keep the fake response successful if an implementation incorrectly reaches it."""
            return

        def iter_lines(self) -> Iterator[str]:
            """Yield no provider events so the assertion focuses on the forbidden call itself."""
            return iter(())

    class StreamingClient(_PostClient):
        """Provider double that advertises streaming and records both RPC and SSE methods."""

        def get(self, url: str, *, headers: dict[str, str] | None = None):
            """Return a streaming Agent Card for the discovery boundary."""
            del url, headers
            return httpx.Response(
                200,
                json={"capabilities": {"streaming": True}},
                request=httpx.Request("GET", "https://agent.example.test/card"),
            )

        def stream(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ):
            """Record the attempted streaming method without contacting a remote Agent."""
            del method, url, headers
            assert json is not None
            self.calls.append(str(json["method"]))
            return EmptyStream()

    def result_factory(method: str) -> dict[str, Any]:
        """Suspend before the client can subscribe to the accepted remote task."""
        if method == "SendMessage":
            with Session(engine) as state:
                tenant = state.get(Tenant, "tenant-a2a-lifecycle")
                assert tenant is not None
                tenant.status = "suspended"
                tenant.lifecycle_version = 2
                state.add(tenant)
                state.commit()
            return {"id": "remote-streaming", "status": {"state": "working"}}
        return {"id": "remote-streaming", "status": {"state": "completed"}}

    provider = StreamingClient(calls, result_factory)
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    with Session(engine) as db:
        _seed_tool(db, config={"poll_interval_seconds": 0.001})
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "subscribe"}),
            invocation_id="invocation-subscribe",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "TENANT_WORK_TERMINALIZED"
    assert calls == ["SendMessage"]
    _terminal_state(run)


def test_tenant_a2a_cancel_is_fenced_after_suspend(tmp_path, monkeypatch) -> None:
    """A cancellation request must not invoke the remote CancelTask after lifecycle suspension."""
    calls: list[str] = []
    provider = _PostClient(
        calls,
        lambda method: {"id": "remote-cancel", "status": {"state": "canceled"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as db:
        tool = _seed_tool(db, tenant_status="suspended", tenant_version=2)
        db.add(
            A2ATaskRun(
                id="a2a-run-cancel-fence",
                owner_scope="tenant",
                direction="client",
                tenant_id="tenant-a2a-lifecycle",
                system_runtime_key=None,
                tenant_lifecycle_version=1,
                tool_id=tool.id,
                invocation_id="invocation-cancel",
                endpoint_url=tool.url,
                remote_task_id="remote-cancel",
                status="working",
                cancel_requested=True,
                request_json={
                    "arguments": {"text": "cancel"},
                    "message": {
                        "messageId": "message-cancel",
                        "role": "ROLE_USER",
                        "parts": [{"text": "cancel"}],
                    },
                },
                result_json={"id": "remote-cancel", "status": {"state": "working"}},
            )
        )
        db.commit()
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "cancel"}),
            invocation_id="invocation-cancel",
        )
        run = db.get(A2ATaskRun, "a2a-run-cancel-fence")
        assert run is not None

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "TENANT_WORK_TERMINALIZED"
    assert calls == []
    _terminal_state(run)


def test_timeout_preserves_original_timeout_when_best_effort_cancel_returns_a2a_error(
    tmp_path,
    monkeypatch,
) -> None:
    """A provider CancelTask error cannot replace the original polling timeout."""
    calls: list[str] = []

    class CancelErrorClient:
        """Return a normal JSON-RPC provider error for the timeout cleanup call."""

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            return

        def post(
            self,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ) -> httpx.Response:
            del headers
            assert json is not None
            calls.append(str(json["method"]))
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": "cancel-timeout",
                    "error": {"message": "provider cancel unavailable"},
                },
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: CancelErrorClient())
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as db:
        tool = _seed_tool(db)
        run = A2ATaskRun(
            id="a2a-run-timeout-cancel-error",
            owner_scope="tenant",
            direction="client",
            tenant_id="tenant-a2a-lifecycle",
            system_runtime_key=None,
            tenant_lifecycle_version=1,
            tool_id=tool.id,
            endpoint_url=tool.url,
            remote_task_id="remote-timeout",
            status="working",
        )
        db.add(run)
        db.commit()

        client = a2a_client.A2AClient(db, tool, headers={}, timeout_seconds=1)
        with pytest.raises(a2a_client.A2AClientError) as error:
            client._wait_if_needed(
                run,
                {"id": "remote-timeout", "status": {"state": "working"}},
                deadline=time.monotonic() - 1,
            )

    assert error.value.code == "A2A_TIMEOUT"
    assert calls == ["CancelTask"]


def test_tenant_a2a_late_provider_success_becomes_unknown_outcome(tmp_path, monkeypatch) -> None:
    """A completed provider response racing suspension must never become ordinary durable success."""
    calls: list[str] = []
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    def result_factory(method: str) -> dict[str, Any]:
        """Commit suspension before returning a response whose external outcome is now unsafe to trust."""
        assert method == "SendMessage"
        with Session(engine) as state:
            tenant = state.get(Tenant, "tenant-a2a-lifecycle")
            assert tenant is not None
            tenant.status = "suspended"
            tenant.lifecycle_version = 2
            state.add(tenant)
            state.commit()
        return {"id": "remote-late", "status": {"state": "completed"}}

    provider = _PostClient(calls, result_factory)
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    with Session(engine) as db:
        _seed_tool(db)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "late"}),
            invocation_id="invocation-late",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "EXTERNAL_OUTCOME_UNKNOWN"
    assert calls == ["SendMessage"]
    assert run.status != "completed"
    assert run.error_json["code"] == "EXTERNAL_OUTCOME_UNKNOWN"
    assert run.error_json["retryable"] is False


@pytest.mark.parametrize(
    ("tenant_status", "tenant_version", "run_version"),
    [("suspended", 2, 2), ("active", 3, 1)],
)
def test_a2a_client_recovery_terminalizes_suspended_or_stale_work_without_executor_call(
    tmp_path,
    monkeypatch,
    tenant_status: str,
    tenant_version: int,
    run_version: int,
) -> None:
    """Recovery must require current tenant state and version before redispatching a durable run."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        tool = _seed_tool(
            db,
            tenant_status=tenant_status,
            tenant_version=tenant_version,
        )
        db.add(
            A2ATaskRun(
                id="a2a-run-recovery-fence",
                owner_scope="tenant",
                direction="client",
                tenant_id="tenant-a2a-lifecycle",
                system_runtime_key=None,
                tenant_lifecycle_version=run_version,
                tool_id=tool.id,
                invocation_id="invocation-recovery-fence",
                endpoint_url=tool.url,
                status="submitted",
                request_json={"arguments": {"text": "recovery"}},
            )
        )
        db.commit()

    executed: list[dict[str, Any]] = []

    def fake_execute(*_args: object, **kwargs: Any) -> None:
        """Capture an invalid recovery redispatch without making any provider request."""
        executed.append(kwargs)

    monkeypatch.setattr(a2a_recovery, "engine", engine)
    monkeypatch.setattr(a2a_recovery.ToolExecutor, "execute", fake_execute)

    a2a_recovery._recover_one("a2a-run-recovery-fence")

    with Session(engine) as db:
        run = db.get(A2ATaskRun, "a2a-run-recovery-fence")
        assert run is not None
        _terminal_state(run)
    assert executed == []


def test_tenant_a2a_completion_uses_conditional_write_after_lifecycle_check(
    tmp_path,
    monkeypatch,
) -> None:
    """A suspension racing the final admission check must prevent ordinary durable success."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    provider = _PostClient(
        [],
        lambda method: {"id": "remote-cas", "status": {"state": "completed"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    original_check = a2a_client.A2AClient._check_run_admission
    check_count = 0

    def suspend_after_final_check(client, run, *args, **kwargs) -> None:
        """Suspend the tenant immediately after the final read check returns active."""
        nonlocal check_count
        check_count += 1
        original_check(client, run, *args, **kwargs)
        if check_count == 2:
            with Session(engine) as state:
                tenant = state.get(Tenant, "tenant-a2a-lifecycle")
                assert tenant is not None
                tenant.status = "suspended"
                tenant.lifecycle_version = 2
                state.add(tenant)
                state.commit()

    monkeypatch.setattr(a2a_client.A2AClient, "_check_run_admission", suspend_after_final_check)

    with Session(engine) as db:
        _seed_tool(db)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "cas"}),
            invocation_id="invocation-cas",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "EXTERNAL_OUTCOME_UNKNOWN"
    assert run.status != "completed"
    assert run.error_json["code"] == "EXTERNAL_OUTCOME_UNKNOWN"


def test_tenant_a2a_artifact_hydration_rechecks_lifecycle_after_provider_get(
    tmp_path,
    monkeypatch,
) -> None:
    """A suspension during artifact hydration must prevent a stale completed result."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)

    class ArtifactClient(_PostClient):
        """Return one artifact while suspending the tenant during the remote GET."""

        def get(self, url: str, *, headers: dict[str, str] | None = None) -> httpx.Response:
            """Commit the lifecycle transition before returning artifact bytes."""
            del headers
            assert url == "https://artifact.example.test/result.txt"
            with Session(engine) as state:
                tenant = state.get(Tenant, "tenant-a2a-lifecycle")
                assert tenant is not None
                tenant.status = "suspended"
                tenant.lifecycle_version = 2
                state.add(tenant)
                state.commit()
            return httpx.Response(
                200,
                content=b"artifact bytes",
                request=httpx.Request("GET", url),
            )

    provider = ArtifactClient(
        [],
        lambda method: {
            "id": "remote-artifact",
            "status": {"state": "completed"},
            "artifacts": [
                {
                    "artifactId": "artifact-1",
                    "parts": [{"file": {"uri": "https://artifact.example.test/result.txt"}}],
                }
            ],
        },
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)

    with Session(engine) as db:
        _seed_tool(db)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "artifact"}),
            invocation_id="invocation-artifact",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "EXTERNAL_OUTCOME_UNKNOWN"
    assert run.status != "completed"
    assert run.error_json["code"] == "EXTERNAL_OUTCOME_UNKNOWN"


def test_tenant_a2a_transport_error_is_unknown_and_not_recovered_again(
    tmp_path,
    monkeypatch,
) -> None:
    """A request that may have reached the provider must become terminal unknown, never replayed."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    calls: list[str] = []

    class TransportDropClient(_PostClient):
        """Drop the response after recording that the provider request started."""

        def post(
            self,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ) -> httpx.Response:
            """Raise a transport error after the request is observable to the provider double."""
            del url, headers
            assert json is not None
            calls.append(str(json["method"]))
            raise httpx.ReadTimeout("provider response was lost")

    provider = TransportDropClient(
        calls,
        lambda method: {"id": "unused", "status": {"state": "completed"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)
    monkeypatch.setattr(a2a_recovery, "engine", engine)

    with Session(engine) as db:
        _seed_tool(db)
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "transport"}),
            invocation_id="invocation-transport",
        )
        run = db.exec(select(A2ATaskRun)).one()
        run_id = run.id

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "EXTERNAL_OUTCOME_UNKNOWN"
    assert run.status != "submitted"
    assert run.error_json["code"] == "EXTERNAL_OUTCOME_UNKNOWN"
    assert calls == ["SendMessage"]

    a2a_recovery._recover_one(run_id)

    assert calls == ["SendMessage"]


def test_tenant_a2a_stream_error_does_not_fallback_or_resend_business_message(
    tmp_path,
    monkeypatch,
) -> None:
    """A started streaming send must become unknown instead of issuing a second SendMessage."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    calls: list[str] = []

    class StreamingDropClient(_PostClient):
        """Advertise streaming and drop the stream after the provider request starts."""

        def get(self, url: str, *, headers: dict[str, str] | None = None) -> httpx.Response:
            """Return the streaming capability card without contacting a remote agent."""
            del headers
            return httpx.Response(
                200,
                json={"capabilities": {"streaming": True}},
                request=httpx.Request("GET", url),
            )

        def stream(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ):
            """Record the started streaming method and lose its response."""
            del method, url, headers
            assert json is not None
            calls.append(str(json["method"]))
            raise httpx.ReadTimeout("stream response was lost")

        def post(
            self,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ) -> httpx.Response:
            """Record any fallback JSON-RPC send so the test can reject a duplicate."""
            del headers
            assert json is not None
            calls.append(str(json["method"]))
            return _response(url, {"id": "remote-stream", "status": {"state": "completed"}})

    provider = StreamingDropClient(
        calls,
        lambda method: {"id": "unused", "status": {"state": "completed"}},
    )
    monkeypatch.setattr(a2a_client.httpx, "Client", lambda **_kwargs: provider)

    with Session(engine) as db:
        _seed_tool(db, config={"discover_agent_card": True})
        result = ToolExecutor(db).execute(
            "tenant-a2a-lifecycle",
            ToolCall(name="a2a.lifecycle", arguments={"text": "stream"}),
            invocation_id="invocation-stream-error",
        )
        run = db.exec(select(A2ATaskRun)).one()

    assert result.success is False
    assert result.error is not None
    assert result.error.code == "EXTERNAL_OUTCOME_UNKNOWN"
    assert run.status != "completed"
    assert run.error_json["code"] == "EXTERNAL_OUTCOME_UNKNOWN"
    assert calls == ["SendStreamingMessage"]


def test_a2a_recovery_claim_allows_only_one_concurrent_worker(
    tmp_path,
    monkeypatch,
) -> None:
    """Concurrent recovery scans must dispatch one durable run to only one worker."""
    engine = _engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        tool = _seed_tool(db)
        db.add(
            A2ATaskRun(
                id="a2a-run-recovery-claim",
                owner_scope="tenant",
                direction="client",
                tenant_id="tenant-a2a-lifecycle",
                system_runtime_key=None,
                tenant_lifecycle_version=1,
                tool_id=tool.id,
                invocation_id="invocation-recovery-claim",
                endpoint_url=tool.url,
                status="submitted",
                request_json={"arguments": {"text": "claim"}},
            )
        )
        db.commit()

    first_worker_entered = threading.Event()
    release_first_worker = threading.Event()
    second_worker_entered = threading.Event()
    executions = 0
    execution_lock = threading.Lock()

    def fake_execute(*_args: object, **_kwargs: object) -> None:
        """Hold the first dispatch open so a second recovery worker races the same row."""
        nonlocal executions
        with execution_lock:
            executions += 1
            worker_number = executions
        if worker_number == 1:
            first_worker_entered.set()
            release_first_worker.wait(timeout=2)
        else:
            second_worker_entered.set()

    monkeypatch.setattr(a2a_recovery, "engine", engine)
    monkeypatch.setattr(a2a_recovery.ToolExecutor, "execute", fake_execute)

    first = threading.Thread(target=a2a_recovery._recover_one, args=("a2a-run-recovery-claim",))
    second = threading.Thread(target=a2a_recovery._recover_one, args=("a2a-run-recovery-claim",))
    first.start()
    assert first_worker_entered.wait(timeout=2)
    second.start()
    second_worker_entered.wait(timeout=0.5)
    release_first_worker.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert executions == 1

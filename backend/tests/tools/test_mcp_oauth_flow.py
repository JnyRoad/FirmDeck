"""Browser-flow lifecycle tests for MCP OAuth state and callback coordination."""

from __future__ import annotations

import asyncio

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


async def _cancel_oauth_tasks() -> None:
    """Keep failing concurrency regressions from leaking background test tasks."""
    current = asyncio.current_task()
    tasks = [
        task
        for task in asyncio.all_tasks()
        if task is not current and task.get_name().startswith("mcp-oauth-")
    ]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


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
        browser_binding="browser-binding",
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
        browser_binding="browser-binding",
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
        browser_binding="browser-binding",
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
async def test_start_reserves_owner_before_the_sdk_emits_a_redirect(tmp_path) -> None:
    """Reject a duplicate start while the first SDK task is still doing discovery."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_entered = asyncio.Event()
    release_operation = asyncio.Event()

    async def operation(_redirect_handler, _callback_handler) -> None:
        operation_entered.set()
        await release_operation.wait()

    first = asyncio.create_task(
        coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="first-browser",
            operation=operation,
        )
    )
    await operation_entered.wait()
    duplicate = asyncio.create_task(
        coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="second-browser",
            operation=operation,
        )
    )
    try:
        await asyncio.sleep(0)
        assert duplicate.done()
        with pytest.raises(MCPOAuthFlowError, match="MCP_OAUTH_FLOW_CONFLICT"):
            await duplicate
    finally:
        release_operation.set()
        first.cancel()
        duplicate.cancel()
        await asyncio.gather(first, duplicate, return_exceptions=True)
        await _cancel_oauth_tasks()


@pytest.mark.asyncio
async def test_start_cancellation_cancels_the_sdk_operation(tmp_path) -> None:
    """Release the SDK task and owner reservation when the start request is cancelled."""
    _engine, coordinator = _coordinator(tmp_path)
    operation_entered = asyncio.Event()
    operation_cancelled = asyncio.Event()

    async def operation(_redirect_handler, _callback_handler) -> None:
        operation_entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            operation_cancelled.set()

    start_task = asyncio.create_task(
        coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="browser-binding",
            operation=operation,
        )
    )
    await operation_entered.wait()
    start_task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await start_task
        await asyncio.wait_for(operation_cancelled.wait(), timeout=0.2)
    finally:
        await _cancel_oauth_tasks()


@pytest.mark.asyncio
async def test_only_one_callback_can_claim_a_pending_flow(tmp_path) -> None:
    """Make callback delivery a single-winner durable state transition."""
    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        await redirect_handler("https://auth.example/authorize?state=single-winner-state")
        await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )
    try:
        results = await asyncio.gather(
            asyncio.to_thread(
                coordinator._transition_pending,
                started.flow_id,
                "callback_received",
            ),
            asyncio.to_thread(
                coordinator._transition_pending,
                started.flow_id,
                "denied",
                "MCP_AUTHORIZATION_REQUIRED",
            ),
        )
        assert sorted(results) == [False, True]
    finally:
        coordinator.cancel_all()
        await _cancel_oauth_tasks()


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
        browser_binding="browser-binding",
        operation=operation,
    )

    result = await coordinator.complete_callback(
        state="denied-state",
        error="access_denied",
        browser_binding="browser-binding",
    )
    await coordinator.wait_until_finished(started.flow_id, allow_failure=True)

    assert result == "denied"
    status = coordinator.read_flow_status(started.flow_id)
    assert status == "denied"
    assert "state=denied-state" in started.authorization_url


@pytest.mark.asyncio
async def test_provider_denial_survives_sdk_exception_wrapping(tmp_path) -> None:
    """Keep an explicit provider denial authoritative when the SDK wraps callback failure."""
    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Approximate a task group replacing the callback exception at its boundary."""
        await redirect_handler("https://auth.example/authorize?state=wrapped-denial-state")
        try:
            await callback_handler()
        except Exception as exc:
            raise RuntimeError("SDK task group wrapped callback denial") from exc

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )

    result = await coordinator.complete_callback(
        state="wrapped-denial-state",
        error="access_denied",
        browser_binding="browser-binding",
    )

    assert result == "denied"
    assert coordinator.read_flow_status(started.flow_id) == "denied"


@pytest.mark.asyncio
async def test_malformed_callback_releases_the_live_flow_immediately(tmp_path) -> None:
    """Catch a valid state without code/error blocking reconnect until the full TTL."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_count = 0

    async def operation(redirect_handler, callback_handler) -> None:
        """Wait as the SDK would so malformed callback cleanup is observable."""
        nonlocal operation_count
        operation_count += 1
        await redirect_handler(
            f"https://auth.example/authorize?state=malformed-state-{operation_count}"
        )
        try:
            await callback_handler()
        except Exception as exc:
            raise ExceptionGroup("SDK task group", [exc]) from exc

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )

    with pytest.raises(MCPOAuthFlowError, match="MCP_OAUTH_CALLBACK_INVALID"):
        await coordinator.complete_callback(
            state="malformed-state-1",
            browser_binding="browser-binding",
        )
    await coordinator.wait_until_finished(started.flow_id, allow_failure=True)

    assert coordinator.read_flow_status(started.flow_id) == "failed"
    assert coordinator._pending_by_id == {}
    assert coordinator._pending_by_digest == {}

    restarted = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )
    assert restarted.flow_id != started.flow_id
    coordinator.cancel_all()


@pytest.mark.asyncio
async def test_forwarded_authorization_url_cannot_complete_in_another_browser(tmp_path) -> None:
    """Bind the provider callback to the browser that initiated this account connection."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Keep one live SDK callback wait while both browser bindings are exercised."""
        await redirect_handler("https://auth.example/authorize?state=browser-bound-state")
        await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="initiating-browser",
        operation=operation,
    )

    with pytest.raises(MCPOAuthFlowError, match="MCP_OAUTH_CALLBACK_INVALID"):
        await coordinator.complete_callback(
            state="browser-bound-state",
            code="victim-authorization-code",
            browser_binding="different-browser",
        )
    assert coordinator.read_flow_status(started.flow_id) == "pending"

    result = await coordinator.complete_callback(
        state="browser-bound-state",
        code="initiator-authorization-code",
        browser_binding="initiating-browser",
    )
    assert result == "completed"


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
            browser_binding="browser-binding",
            operation=operation,
        )
        await coordinator.complete_callback(
            state="state-never-log",
            code="code-never-log",
            iss="https://auth.example",
            browser_binding="browser-binding",
        )
        await coordinator.wait_until_finished(started.flow_id)

    rendered = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "state-never-log" not in rendered
    assert "code-never-log" not in rendered
    assert "tenant_1" not in rendered
    assert "server_1" not in rendered
    assert "user_1" not in rendered
    assert all(getattr(record, "owner_fingerprint", None) is None for record in caplog.records)
    events = [getattr(record, "oauth_event", None) for record in caplog.records]
    assert "mcp_oauth.started" in events
    assert "mcp_oauth.completed" in events


@pytest.mark.asyncio
async def test_callback_bounds_token_exchange_by_the_persisted_flow_ttl(
    tmp_path,
    monkeypatch,
) -> None:
    """Expire and cancel an SDK task that stalls after receiving the callback code."""
    import app.tools.mcp_oauth_flow as flow

    monkeypatch.setattr(flow, "FLOW_TTL_SECONDS", 0.2)
    _engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Accept the callback and then model a token exchange that never returns."""
        await redirect_handler("https://auth.example/authorize?state=stall-after-code")
        await callback_handler()
        await asyncio.Event().wait()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )

    with pytest.raises(flow.MCPOAuthFlowError, match="MCP_OAUTH_FLOW_EXPIRED"):
        await asyncio.wait_for(
            coordinator.complete_callback(
                state="stall-after-code",
                code="authorization-code",
                browser_binding="browser-binding",
            ),
            timeout=1.0,
        )

    assert coordinator.read_flow_status(started.flow_id) == "expired"
    assert coordinator._pending_by_id == {}


@pytest.mark.asyncio
async def test_cancel_owner_releases_the_live_flow_for_immediate_reconnect(tmp_path) -> None:
    """Cancel only one owner's task and allow that account to start a replacement flow."""
    _engine, coordinator = _coordinator(tmp_path)
    operation_count = 0

    async def operation(redirect_handler, callback_handler) -> None:
        """Keep each controlled authorization alive until cancellation."""
        nonlocal operation_count
        operation_count += 1
        await redirect_handler(
            f"https://auth.example/authorize?state=cancel-owner-{operation_count}"
        )
        await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )

    await coordinator.cancel_owner("tenant_1", "server_1", "user_1")

    assert coordinator.read_flow_status(started.flow_id) == "cancelled"
    assert coordinator._pending_by_id == {}
    restarted = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )
    assert restarted.flow_id != started.flow_id
    coordinator.cancel_all()


@pytest.mark.asyncio
async def test_start_reconciles_a_flow_cancelled_by_server_configuration_change(
    tmp_path,
) -> None:
    """Allow reconnect after another request invalidates the durable server binding."""
    engine, coordinator = _coordinator(tmp_path)
    operation_count = 0

    async def operation(redirect_handler, callback_handler) -> None:
        """Keep each flow alive until durable cancellation or test cleanup."""
        nonlocal operation_count
        operation_count += 1
        await redirect_handler(
            f"https://auth.example/authorize?state=config-change-{operation_count}"
        )
        await callback_handler()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )
    with Session(engine) as db:
        row = db.get(MCPOAuthFlow, started.flow_id)
        assert row is not None
        row.status = "cancelled"
        db.add(row)
        db.commit()

    for _attempt in range(50):
        if not coordinator._pending_by_id:
            break
        await asyncio.sleep(0.01)
    assert coordinator._pending_by_id == {}

    restarted = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )

    assert restarted.flow_id != started.flow_id
    coordinator.cancel_all()


@pytest.mark.asyncio
async def test_server_invalidation_cancels_a_flow_before_redirect_persistence(tmp_path) -> None:
    """Close the race where a server changes before the SDK publishes its redirect URL."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_started = asyncio.Event()

    async def operation(redirect_handler, callback_handler) -> None:
        """Pause before redirect publication so invalidation hits the startup window."""
        operation_started.set()
        await asyncio.Event().wait()

    start_task = asyncio.create_task(
        coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="browser-binding",
            operation=operation,
        )
    )
    await operation_started.wait()

    coordinator.invalidate_server("tenant_1", "server_1")

    with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await asyncio.wait_for(start_task, timeout=0.2)
    assert coordinator._pending_owner_keys == set()
    assert coordinator._server_generations == {}


@pytest.mark.asyncio
async def test_owner_disconnect_cancels_a_flow_before_redirect_persistence(tmp_path) -> None:
    """Return a safe start error when disconnect wins before the redirect is stored."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_started = asyncio.Event()

    async def operation(redirect_handler, callback_handler) -> None:
        """Pause before redirect publication so owner cancellation has no flow row."""
        operation_started.set()
        await asyncio.Event().wait()

    start_task = asyncio.create_task(
        coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="browser-binding",
            operation=operation,
        )
    )
    await operation_started.wait()

    await coordinator.cancel_owner("tenant_1", "server_1", "user_1")

    with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await asyncio.wait_for(start_task, timeout=0.2)
    assert coordinator._pending_owner_keys == set()


@pytest.mark.asyncio
async def test_redirect_rechecks_server_generation_before_publishing(tmp_path) -> None:
    """Never publish an authorization URL after its server binding is invalidated."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    engine, coordinator = _coordinator(tmp_path)

    async def operation(redirect_handler, callback_handler) -> None:
        """Invalidate after task registration but immediately before redirect storage."""
        coordinator.invalidate_server("tenant_1", "server_1")
        await redirect_handler("https://auth.example/authorize?state=stale-redirect")

    with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="browser-binding",
            operation=operation,
        )

    with Session(engine) as db:
        assert db.exec(select(MCPOAuthFlow)).all() == []


@pytest.mark.asyncio
async def test_start_rejects_a_binding_invalidated_during_freshness_check(tmp_path) -> None:
    """Reject an API snapshot invalidated between its database read and task start."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_called = False

    async def operation(redirect_handler, callback_handler) -> None:
        """Fail the assertion if stale configuration reaches the SDK operation."""
        nonlocal operation_called
        operation_called = True

    def invalidate_during_validation() -> bool:
        coordinator.invalidate_server("tenant_1", "server_1")
        return True

    with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await coordinator.start(
            tenant_id="tenant_1",
            server_id="server_1",
            user_id="user_1",
            redirect_uri="https://staffdeck.example/oauth/callback",
            browser_binding="browser-binding",
            operation=operation,
            binding_is_current=invalidate_during_validation,
        )

    assert operation_called is False
    assert coordinator._server_generations == {}


@pytest.mark.asyncio
async def test_start_rejects_while_server_change_transaction_is_active(tmp_path) -> None:
    """Keep the fence visible from transaction begin until commit or rollback."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    operation_called = False
    coordinator.begin_server_change("tenant_1", "server_1")

    async def operation(redirect_handler, callback_handler) -> None:
        nonlocal operation_called
        operation_called = True

    try:
        with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
            await coordinator.start(
                tenant_id="tenant_1",
                server_id="server_1",
                user_id="user_1",
                redirect_uri="https://staffdeck.example/oauth/callback",
                browser_binding="browser-binding",
                operation=operation,
                binding_is_current=lambda: True,
            )
    finally:
        coordinator.end_server_change("tenant_1", "server_1")

    assert operation_called is False
    assert coordinator._changing_servers == {}
    assert coordinator._server_generations == {}


@pytest.mark.asyncio
async def test_invalidation_before_first_task_step_rejects_start_promptly(
    tmp_path,
    monkeypatch,
) -> None:
    """Wake the start future when invalidation cancels an unscheduled coroutine."""
    import app.tools.mcp_oauth_flow as flow

    _engine, coordinator = _coordinator(tmp_path)
    real_create_task = asyncio.create_task

    def create_cancelled_task(coroutine, *, name=None):
        task = real_create_task(coroutine, name=name)
        coordinator.invalidate_server("tenant_1", "server_1")
        task.cancel()
        return task

    monkeypatch.setattr(flow.asyncio, "create_task", create_cancelled_task)

    with pytest.raises(flow.MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await asyncio.wait_for(
            coordinator.start(
                tenant_id="tenant_1",
                server_id="server_1",
                user_id="user_1",
                redirect_uri="https://staffdeck.example/oauth/callback",
                browser_binding="browser-binding",
                operation=lambda _redirect, _callback: asyncio.sleep(0),
            ),
            timeout=0.2,
        )

    assert coordinator._pending_owner_keys == set()
    assert coordinator._server_generations == {}


@pytest.mark.asyncio
async def test_disconnect_during_callback_exchange_preserves_cancelled_terminal_state(
    tmp_path,
) -> None:
    """Translate an intentional task cancellation into the safe callback outcome."""
    from app.tools.mcp_oauth_flow import MCPOAuthFlowError

    _engine, coordinator = _coordinator(tmp_path)
    callback_received = asyncio.Event()

    async def operation(redirect_handler, callback_handler) -> None:
        """Model an exchange that stalls after the browser callback is delivered."""
        await redirect_handler("https://auth.example/authorize?state=disconnect-race")
        await callback_handler()
        callback_received.set()
        await asyncio.Event().wait()

    started = await coordinator.start(
        tenant_id="tenant_1",
        server_id="server_1",
        user_id="user_1",
        redirect_uri="https://staffdeck.example/oauth/callback",
        browser_binding="browser-binding",
        operation=operation,
    )
    callback_task = asyncio.create_task(
        coordinator.complete_callback(
            state="disconnect-race",
            code="authorization-code",
            browser_binding="browser-binding",
        )
    )
    await callback_received.wait()

    await coordinator.cancel_owner("tenant_1", "server_1", "user_1")

    with pytest.raises(MCPOAuthFlowError, match="MCP_AUTHORIZATION_REQUIRED"):
        await callback_task
    assert coordinator.read_flow_status(started.flow_id) == "cancelled"

"""Coordinate one-time browser callbacks with the official SDK's live OAuth coroutine."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock
from typing import Literal
from urllib.parse import parse_qs, urlparse

from mcp.shared.auth import AuthorizationCodeResult
from pydantic import BaseModel
from sqlalchemy import Engine, update
from sqlmodel import Session, select

from app.db.models import MCPOAuthFlow, new_id, utc_now

FLOW_TTL_SECONDS = 600
BINDING_POLL_SECONDS = 0.1
logger = logging.getLogger(__name__)


def _log_oauth_event(
    oauth_event: str,
    *,
    tenant_id: str | None = None,
    server_id: str | None = None,
    user_id: str | None = None,
    flow_id: str | None = None,
    error_code: str | None = None,
) -> None:
    """Write one credential-free structured lifecycle event for authorized diagnostics."""
    if oauth_event == "mcp_oauth.started":
        logger.info("MCP OAuth started", extra={"oauth_event": "mcp_oauth.started"})
    elif oauth_event == "mcp_oauth.completed":
        logger.info("MCP OAuth completed", extra={"oauth_event": "mcp_oauth.completed"})
    elif oauth_event == "mcp_oauth.cancelled":
        logger.info("MCP OAuth cancelled", extra={"oauth_event": "mcp_oauth.cancelled"})
    elif oauth_event == "mcp_oauth.expired":
        logger.info("MCP OAuth expired", extra={"oauth_event": "mcp_oauth.expired"})
    elif oauth_event == "mcp_oauth.denied":
        logger.info("MCP OAuth denied", extra={"oauth_event": "mcp_oauth.denied"})
    elif oauth_event == "mcp_oauth.failed":
        logger.info("MCP OAuth failed", extra={"oauth_event": "mcp_oauth.failed"})
    elif oauth_event == "mcp_oauth.invalid_browser_binding":
        logger.info(
            "MCP OAuth browser binding rejected",
            extra={"oauth_event": "mcp_oauth.invalid_browser_binding"},
        )
    elif oauth_event == "mcp_oauth.invalid_callback":
        logger.info(
            "MCP OAuth callback rejected",
            extra={"oauth_event": "mcp_oauth.invalid_callback"},
        )
    else:
        logger.info("MCP OAuth lifecycle event")


class MCPOAuthFlowError(RuntimeError):
    """Expose one credential-free lifecycle error code."""

    def __init__(self, code: str) -> None:
        """Store the stable code without raw callback or provider data."""
        super().__init__(code)
        self.code = code


class MCPOAuthStartResult(BaseModel):
    """Safe values returned to the initiating frontend before browser navigation."""

    authorization_url: str
    flow_id: str
    expires_at: datetime


@dataclass
class _PendingFlow:
    """Process-local state that must never survive restart or enter the database."""

    flow_id: str
    state_digest: str
    browser_binding_digest: str
    callback_future: asyncio.Future[AuthorizationCodeResult]
    task: asyncio.Task[None]


FlowOperation = Callable[
    [
        Callable[[str], Awaitable[None]],
        Callable[[], Awaitable[AuthorizationCodeResult]],
    ],
    Awaitable[None],
]
BindingValidator = Callable[[], bool]


class MCPOAuthFlowCoordinator:
    """Bridge an HTTP start/callback pair into one continuous SDK authorization operation."""

    def __init__(self, engine: Engine) -> None:
        """Create an empty process-local registry over a durable audit table."""
        self.engine = engine
        self._pending_by_digest: dict[str, _PendingFlow] = {}
        self._pending_by_id: dict[str, _PendingFlow] = {}
        self._pending_owner_keys: set[tuple[str, str, str]] = set()
        self._tasks_by_owner: dict[tuple[str, str, str], asyncio.Task[None]] = {}
        self._task_cancel_codes: dict[asyncio.Task[None], str] = {}
        self._server_generations: dict[tuple[str, str], int] = {}
        self._starting_servers: dict[tuple[str, str], int] = {}
        self._changing_servers: dict[tuple[str, str], int] = {}
        self._registry_guard = Lock()

    @staticmethod
    def _digest_state(state: str) -> str:
        """Create the only callback-state representation allowed in persistent storage."""
        return hashlib.sha256(state.encode("utf-8")).hexdigest()

    @staticmethod
    def browser_cookie_name(flow_id: str) -> str:
        """Return one host-only cookie name scoped to a single concurrent browser flow."""
        return f"staffdeck_mcp_oauth_{flow_id}"

    def browser_cookie_name_for_state(self, state: str) -> str | None:
        """Resolve the expected browser cookie without exposing its stored digest."""
        if not state:
            return None
        pending = self._pending_by_digest.get(self._digest_state(state))
        return self.browser_cookie_name(pending.flow_id) if pending is not None else None

    def _update_status(self, flow_id: str, status: str, error_code: str | None = None) -> None:
        """Update credential-free lifecycle fields without touching callback secrets."""
        with Session(self.engine) as db:
            row = db.get(MCPOAuthFlow, flow_id)
            if row is None:
                return
            row.status = status
            row.error_code = error_code
            row.updated_at = utc_now()
            db.add(row)
            db.commit()

    def _transition_pending(
        self,
        flow_id: str,
        status: str,
        error_code: str | None = None,
    ) -> bool:
        """Atomically let only one callback claim a still-pending flow."""
        with Session(self.engine) as db:
            result = db.execute(
                update(MCPOAuthFlow)
                .where(
                    MCPOAuthFlow.id == flow_id,
                    MCPOAuthFlow.status == "pending",
                )
                .values(
                    status=status,
                    error_code=error_code,
                    updated_at=utc_now(),
                )
            )
            db.commit()
            return result.rowcount == 1

    def _discard_pending(self, flow_id: str) -> None:
        """Release completed process-local futures while retaining durable audit state."""
        pending = self._pending_by_id.pop(flow_id, None)
        if pending is not None:
            self._pending_by_digest.pop(pending.state_digest, None)

    async def _wait_for_task_until_expiry(
        self,
        pending: _PendingFlow,
        expires_at: datetime,
    ) -> None:
        """Bound post-callback SDK work by the durable authorization deadline."""
        remaining = max((expires_at - utc_now()).total_seconds(), 0.0)
        try:
            await asyncio.wait_for(pending.task, timeout=remaining)
        except asyncio.CancelledError as exc:
            if self.read_flow_status(pending.flow_id) == "cancelled":
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED") from exc
            raise
        except TimeoutError as exc:
            self._update_status(pending.flow_id, "expired", "MCP_OAUTH_FLOW_EXPIRED")
            raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED") from exc

    async def cancel_owner(self, tenant_id: str, server_id: str, user_id: str) -> None:
        """Cancel every live authorization task owned by one disconnected account."""
        with Session(self.engine) as db:
            rows = db.exec(
                select(MCPOAuthFlow).where(
                    MCPOAuthFlow.tenant_id == tenant_id,
                    MCPOAuthFlow.server_id == server_id,
                    MCPOAuthFlow.user_id == user_id,
                    MCPOAuthFlow.status.in_({"pending", "callback_received"}),
                )
            ).all()
            flow_ids = {row.id for row in rows}
            for row in rows:
                row.status = "cancelled"
                row.error_code = "MCP_AUTHORIZATION_REQUIRED"
                row.updated_at = utc_now()
                db.add(row)
            db.commit()

        owner_key = (tenant_id, server_id, user_id)
        with self._registry_guard:
            owner_task = self._tasks_by_owner.get(owner_key)
            if owner_task is not None:
                self._task_cancel_codes[owner_task] = "MCP_AUTHORIZATION_REQUIRED"
        await self._stop_pending_tasks(flow_ids)
        if owner_task is not None and not owner_task.done():
            owner_task.cancel()
            await asyncio.gather(owner_task, return_exceptions=True)

    def begin_server_change(self, tenant_id: str, server_id: str) -> None:
        """Fence starts and cancel live tasks before a server binding transaction."""
        server_key = (tenant_id, server_id)
        with self._registry_guard:
            self._changing_servers[server_key] = (
                self._changing_servers.get(server_key, 0) + 1
            )
            self._server_generations[server_key] = (
                self._server_generations.get(server_key, 0) + 1
            )
            tasks = [
                task
                for owner_key, task in self._tasks_by_owner.items()
                if owner_key[:2] == server_key and not task.done()
            ]
            for task in tasks:
                self._task_cancel_codes[task] = "MCP_AUTHORIZATION_REQUIRED"
            self._cleanup_server_generation_locked(server_key)
        for task in tasks:
            task.get_loop().call_soon_threadsafe(task.cancel)

    def end_server_change(self, tenant_id: str, server_id: str) -> None:
        """Release a server transaction fence after its commit or rollback completes."""
        server_key = (tenant_id, server_id)
        with self._registry_guard:
            changing = self._changing_servers.get(server_key, 0)
            if changing <= 0:
                raise RuntimeError("MCP OAuth server change fence is not active")
            self._server_generations[server_key] = (
                self._server_generations.get(server_key, 0) + 1
            )
            if changing == 1:
                self._changing_servers.pop(server_key, None)
            else:
                self._changing_servers[server_key] = changing - 1
            self._cleanup_server_generation_locked(server_key)

    def invalidate_server(self, tenant_id: str, server_id: str) -> None:
        """Apply one immediate server fence outside a wider database transaction."""
        self.begin_server_change(tenant_id, server_id)
        self.end_server_change(tenant_id, server_id)

    def _cleanup_server_generation_locked(self, server_key: tuple[str, str]) -> None:
        """Drop an idle server fence after every older start has observed it."""
        if self._starting_servers.get(server_key, 0) > 0:
            return
        if self._changing_servers.get(server_key, 0) > 0:
            return
        if any(owner_key[:2] == server_key for owner_key in self._pending_owner_keys):
            return
        if any(owner_key[:2] == server_key for owner_key in self._tasks_by_owner):
            return
        self._server_generations.pop(server_key, None)
        self._starting_servers.pop(server_key, None)

    def _release_owner_task(
        self,
        owner_key: tuple[str, str, str],
        task: asyncio.Task[None],
    ) -> None:
        """Remove only the task that still owns the process-local reservation."""
        with self._registry_guard:
            if self._tasks_by_owner.get(owner_key) is task:
                self._tasks_by_owner.pop(owner_key, None)
            self._task_cancel_codes.pop(task, None)
            self._pending_owner_keys.discard(owner_key)
            self._cleanup_server_generation_locked(owner_key[:2])

    async def _stop_pending_tasks(self, flow_ids: set[str]) -> None:
        """Wake or cancel selected SDK tasks after their durable flow is inactive."""
        tasks: list[asyncio.Task[None]] = []
        for flow_id in flow_ids:
            pending = self._pending_by_id.get(flow_id)
            if pending is None:
                continue
            if not pending.callback_future.done():
                pending.callback_future.set_exception(
                    MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
                )
            elif not pending.task.done():
                pending.task.cancel()
            tasks.append(pending.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _reconcile_inactive_owner_tasks(
        self,
        tenant_id: str,
        server_id: str,
        user_id: str,
    ) -> None:
        """Release process-local tasks invalidated by another committed request."""
        inactive_flow_ids: set[str] = set()
        with Session(self.engine) as db:
            for pending in self._pending_by_id.values():
                row = db.get(MCPOAuthFlow, pending.flow_id)
                if (
                    row is None
                    or (
                        row.tenant_id == tenant_id
                        and row.server_id == server_id
                        and row.user_id == user_id
                        and row.status not in {"pending", "callback_received"}
                    )
                ):
                    inactive_flow_ids.add(pending.flow_id)
        await self._stop_pending_tasks(inactive_flow_ids)

    async def start(
        self,
        *,
        tenant_id: str,
        server_id: str,
        user_id: str,
        redirect_uri: str,
        browser_binding: str,
        operation: FlowOperation,
        binding_is_current: BindingValidator | None = None,
    ) -> MCPOAuthStartResult:
        """Launch the SDK operation and return as soon as it emits an authorization URL."""
        if not browser_binding:
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        owner_key = (tenant_id, server_id, user_id)
        server_key = (tenant_id, server_id)
        await self._reconcile_inactive_owner_tasks(tenant_id, server_id, user_id)
        with self._registry_guard:
            if self._changing_servers.get(server_key, 0) > 0:
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            server_generation = self._server_generations.get(server_key, 0)
            self._starting_servers[server_key] = (
                self._starting_servers.get(server_key, 0) + 1
            )
        try:
            binding_current = binding_is_current is None or binding_is_current()
        except BaseException:
            with self._registry_guard:
                self._starting_servers[server_key] -= 1
                self._cleanup_server_generation_locked(server_key)
            raise
        with self._registry_guard:
            self._starting_servers[server_key] -= 1
            server_invalidated = (
                self._server_generations.get(server_key, 0) != server_generation
            )
            if not binding_current or server_invalidated:
                self._cleanup_server_generation_locked(server_key)
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            if self._changing_servers.get(server_key, 0) > 0:
                self._cleanup_server_generation_locked(server_key)
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            if owner_key in self._pending_owner_keys:
                self._cleanup_server_generation_locked(server_key)
                raise MCPOAuthFlowError("MCP_OAUTH_FLOW_CONFLICT")
            self._pending_owner_keys.add(owner_key)
        for pending in self._pending_by_id.values():
            with Session(self.engine) as db:
                row = db.get(MCPOAuthFlow, pending.flow_id)
                if (
                    row is not None
                    and row.tenant_id == tenant_id
                    and row.server_id == server_id
                    and row.user_id == user_id
                    and row.status in {"pending", "callback_received"}
                ):
                    with self._registry_guard:
                        self._pending_owner_keys.discard(owner_key)
                        self._cleanup_server_generation_locked(server_key)
                    raise MCPOAuthFlowError("MCP_OAUTH_FLOW_CONFLICT")

        loop = asyncio.get_running_loop()
        authorization_future: asyncio.Future[str] = loop.create_future()
        callback_future: asyncio.Future[AuthorizationCodeResult] = loop.create_future()
        flow_id = new_id("mcpflow")
        expires_at = utc_now() + timedelta(seconds=FLOW_TTL_SECONDS)

        async def redirect_handler(authorization_url: str) -> None:
            """Persist only the SDK-generated state digest and publish the browser target."""
            values = parse_qs(urlparse(authorization_url).query)
            states = values.get("state") or []
            if len(states) != 1 or not states[0]:
                raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
            state_digest = self._digest_state(states[0])
            with self._registry_guard:
                if (
                    self._server_generations.get(server_key, 0) != server_generation
                    or self._changing_servers.get(server_key, 0) > 0
                ):
                    raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            if binding_is_current is not None and not binding_is_current():
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            with Session(self.engine) as db:
                db.add(
                    MCPOAuthFlow(
                        id=flow_id,
                        tenant_id=tenant_id,
                        server_id=server_id,
                        user_id=user_id,
                        state_digest=state_digest,
                        redirect_uri=redirect_uri,
                        status="pending",
                        expires_at=expires_at,
                    )
                )
                db.commit()
            binding_current_after_write = (
                binding_is_current is None or binding_is_current()
            )
            with self._registry_guard:
                server_invalidated = (
                    self._server_generations.get(server_key, 0) != server_generation
                    or self._changing_servers.get(server_key, 0) > 0
                )
            if server_invalidated or not binding_current_after_write:
                self._update_status(
                    flow_id,
                    "cancelled",
                    "MCP_AUTHORIZATION_REQUIRED",
                )
                raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
            with self._registry_guard:
                pending = _PendingFlow(
                    flow_id=flow_id,
                    state_digest=state_digest,
                    browser_binding_digest=self._digest_state(browser_binding),
                    callback_future=callback_future,
                    task=task,
                )
                self._pending_by_digest[state_digest] = pending
                self._pending_by_id[flow_id] = pending
                _log_oauth_event(
                    "mcp_oauth.started",
                    tenant_id=tenant_id,
                    server_id=server_id,
                    user_id=user_id,
                    flow_id=flow_id,
                )
                if not authorization_future.done():
                    authorization_future.set_result(authorization_url)

        async def callback_handler() -> AuthorizationCodeResult:
            """Wait no longer than the persisted flow TTL for the browser callback."""
            while True:
                remaining = max((expires_at - utc_now()).total_seconds(), 0.0)
                if remaining <= 0:
                    self._update_status(flow_id, "expired", "MCP_OAUTH_FLOW_EXPIRED")
                    raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED")
                try:
                    return await asyncio.wait_for(
                        asyncio.shield(callback_future),
                        timeout=min(remaining, 0.1),
                    )
                except TimeoutError as exc:
                    durable_status = self.read_flow_status(flow_id)
                    if durable_status == "expired":
                        raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED") from exc
                    if durable_status not in {"pending", "callback_received"}:
                        raise MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED") from exc

        async def run_operation() -> None:
            """Run the SDK operation and close the durable audit state on every exit path."""
            try:
                await operation(redirect_handler, callback_handler)
            except asyncio.CancelledError:
                status = self.read_flow_status(flow_id)
                with self._registry_guard:
                    task_cancel_code = self._task_cancel_codes.get(task)
                    server_invalidated = (
                        self._server_generations.get(server_key, 0) != server_generation
                    )
                cancellation_code = (
                    task_cancel_code
                    or (
                        "MCP_AUTHORIZATION_REQUIRED"
                        if status == "cancelled" or server_invalidated
                        else "MCP_OAUTH_FLOW_EXPIRED"
                    )
                )
                if cancellation_code == "MCP_OAUTH_FLOW_EXPIRED":
                    self._update_status(flow_id, "expired", cancellation_code)
                _log_oauth_event(
                    "mcp_oauth.cancelled",
                    tenant_id=tenant_id,
                    server_id=server_id,
                    user_id=user_id,
                    flow_id=flow_id,
                    error_code=cancellation_code,
                )
                if (
                    cancellation_code == "MCP_AUTHORIZATION_REQUIRED"
                    and not authorization_future.done()
                ):
                    authorization_future.set_exception(MCPOAuthFlowError(cancellation_code))
                raise
            except Exception as exc:
                status = self.read_flow_status(flow_id)
                if status not in {"cancelled", "denied", "expired"}:
                    self._update_status(flow_id, "failed", "MCP_OAUTH_CALLBACK_INVALID")
                    _log_oauth_event(
                        "mcp_oauth.failed",
                        tenant_id=tenant_id,
                        server_id=server_id,
                        user_id=user_id,
                        flow_id=flow_id,
                        error_code="MCP_OAUTH_CALLBACK_INVALID",
                    )
                if not authorization_future.done():
                    authorization_future.set_exception(exc)
                raise
            else:
                self._update_status(flow_id, "completed")
                _log_oauth_event(
                    "mcp_oauth.completed",
                    tenant_id=tenant_id,
                    server_id=server_id,
                    user_id=user_id,
                    flow_id=flow_id,
                )
            finally:
                self._discard_pending(flow_id)
                self._release_owner_task(owner_key, task)

        try:
            task = asyncio.create_task(run_operation(), name=f"mcp-oauth-{flow_id}")
        except BaseException:
            with self._registry_guard:
                self._pending_owner_keys.discard(owner_key)
            raise
        with self._registry_guard:
            self._tasks_by_owner[owner_key] = task
            server_invalidated = (
                self._server_generations.get(server_key, 0) != server_generation
            )

        async def monitor_binding() -> None:
            """Cancel a live SDK task when another process commits a binding change."""
            if binding_is_current is None:
                return
            while not task.done():
                await asyncio.sleep(BINDING_POLL_SECONDS)
                try:
                    binding_current = binding_is_current()
                except BaseException:
                    binding_current = False
                if binding_current:
                    continue
                with self._registry_guard:
                    self._task_cancel_codes[task] = "MCP_AUTHORIZATION_REQUIRED"
                task.cancel()
                return

        binding_monitor_task = asyncio.create_task(
            monitor_binding(),
            name=f"mcp-oauth-binding-{flow_id}",
        )

        def finish_task(completed_task: asyncio.Task[None]) -> None:
            """Wake a start cancelled before its coroutine executes, then release it."""
            binding_monitor_task.cancel()
            if completed_task.cancelled() and not authorization_future.done():
                with self._registry_guard:
                    task_cancel_code = self._task_cancel_codes.get(completed_task)
                    invalidated = (
                        self._server_generations.get(server_key, 0) != server_generation
                    )
                if task_cancel_code or invalidated:
                    authorization_future.set_exception(
                        MCPOAuthFlowError(
                            task_cancel_code or "MCP_AUTHORIZATION_REQUIRED"
                        )
                    )
            self._release_owner_task(owner_key, completed_task)

        task.add_done_callback(finish_task)
        if server_invalidated:
            task.cancel()
        try:
            authorization_url = await asyncio.wait_for(
                asyncio.shield(authorization_future),
                timeout=min(FLOW_TTL_SECONDS, 30),
            )
        except asyncio.CancelledError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise
        except Exception:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise
        return MCPOAuthStartResult(
            authorization_url=authorization_url,
            flow_id=flow_id,
            expires_at=expires_at,
        )

    async def complete_callback(
        self,
        *,
        state: str,
        code: str | None = None,
        iss: str | None = None,
        error: str | None = None,
        browser_binding: str | None = None,
    ) -> Literal["completed", "denied"]:
        """Validate one callback, deliver it once, and wait for the SDK exchange result."""
        if not state:
            _log_oauth_event(
                "mcp_oauth.invalid_callback",
                error_code="MCP_OAUTH_CALLBACK_INVALID",
            )
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        state_digest = self._digest_state(state)
        with Session(self.engine) as db:
            row = db.exec(
                select(MCPOAuthFlow).where(MCPOAuthFlow.state_digest == state_digest)
            ).first()
            if row is None or row.status != "pending":
                _log_oauth_event(
                    "mcp_oauth.invalid_callback",
                    error_code="MCP_OAUTH_CALLBACK_INVALID",
                )
                raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
            if row.expires_at <= utc_now():
                row.status = "expired"
                row.error_code = "MCP_OAUTH_FLOW_EXPIRED"
                row.updated_at = utc_now()
                db.add(row)
                db.commit()
                _log_oauth_event(
                    "mcp_oauth.expired",
                    tenant_id=row.tenant_id,
                    server_id=row.server_id,
                    user_id=row.user_id,
                    flow_id=row.id,
                    error_code="MCP_OAUTH_FLOW_EXPIRED",
                )
                raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED")

        pending = self._pending_by_digest.get(state_digest)
        if pending is None:
            self._update_status(row.id, "expired", "MCP_OAUTH_FLOW_EXPIRED")
            _log_oauth_event(
                "mcp_oauth.expired",
                tenant_id=row.tenant_id,
                server_id=row.server_id,
                user_id=row.user_id,
                flow_id=row.id,
                error_code="MCP_OAUTH_FLOW_EXPIRED",
            )
            raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED")
        if not browser_binding or not secrets.compare_digest(
            self._digest_state(browser_binding),
            pending.browser_binding_digest,
        ):
            _log_oauth_event(
                "mcp_oauth.invalid_browser_binding",
                tenant_id=row.tenant_id,
                server_id=row.server_id,
                user_id=row.user_id,
                flow_id=row.id,
                error_code="MCP_OAUTH_CALLBACK_INVALID",
            )
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        if error:
            if not self._transition_pending(
                pending.flow_id,
                "denied",
                "MCP_AUTHORIZATION_REQUIRED",
            ):
                raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
            _log_oauth_event(
                "mcp_oauth.denied",
                tenant_id=row.tenant_id,
                server_id=row.server_id,
                user_id=row.user_id,
                flow_id=row.id,
                error_code="MCP_AUTHORIZATION_REQUIRED",
            )
            if not pending.callback_future.done():
                pending.callback_future.set_exception(
                    MCPOAuthFlowError("MCP_AUTHORIZATION_REQUIRED")
                )
            try:
                await self._wait_for_task_until_expiry(pending, row.expires_at)
            except MCPOAuthFlowError as exc:
                if exc.code == "MCP_OAUTH_FLOW_EXPIRED":
                    raise
            except Exception:  # The SDK may wrap the intentional callback denial.
                pass
            return "denied"
        if not code:
            if not self._transition_pending(
                pending.flow_id,
                "failed",
                "MCP_OAUTH_CALLBACK_INVALID",
            ):
                raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
            _log_oauth_event(
                "mcp_oauth.invalid_callback",
                tenant_id=row.tenant_id,
                server_id=row.server_id,
                user_id=row.user_id,
                flow_id=row.id,
                error_code="MCP_OAUTH_CALLBACK_INVALID",
            )
            if not pending.callback_future.done():
                pending.callback_future.set_exception(
                    MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
                )
            try:
                await self._wait_for_task_until_expiry(pending, row.expires_at)
            except MCPOAuthFlowError as exc:
                if exc.code == "MCP_OAUTH_FLOW_EXPIRED":
                    raise
            except Exception:  # The SDK may wrap the intentional callback failure.
                pass
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")

        if not self._transition_pending(pending.flow_id, "callback_received"):
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        if pending.callback_future.done():
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        pending.callback_future.set_result(
            AuthorizationCodeResult(code=code, state=state, iss=iss)
        )
        await self._wait_for_task_until_expiry(pending, row.expires_at)
        return "completed"

    async def wait_until_finished(
        self,
        flow_id: str,
        *,
        allow_failure: bool = False,
    ) -> None:
        """Await one operation in tests or callback handling without exposing its result."""
        pending = self._pending_by_id.get(flow_id)
        if pending is None:
            return
        try:
            await pending.task
        except Exception:
            if not allow_failure:
                raise

    def read_flow_status(self, flow_id: str) -> str | None:
        """Return one safe durable lifecycle state for status projection and tests."""
        with Session(self.engine) as db:
            row = db.get(MCPOAuthFlow, flow_id)
            return row.status if row else None

    def cancel_all(self) -> None:
        """Cancel process-local pending flows during shutdown or isolated test cleanup."""
        for pending in list(self._pending_by_id.values()):
            if not pending.callback_future.done():
                pending.callback_future.cancel()
            if not pending.task.done():
                pending.task.cancel()

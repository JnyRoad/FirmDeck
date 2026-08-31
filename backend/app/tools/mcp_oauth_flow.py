"""Coordinate one-time browser callbacks with the official SDK's live OAuth coroutine."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import parse_qs, urlparse

from mcp.shared.auth import AuthorizationCodeResult
from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session, select

from app.db.models import MCPOAuthFlow, new_id, utc_now

FLOW_TTL_SECONDS = 600
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
    logger.info(
        "MCP OAuth lifecycle event",
        extra={
            "oauth_event": oauth_event,
            "tenant_id": tenant_id,
            "server_id": server_id,
            "user_id": user_id,
            "flow_id": flow_id,
            "error_code": error_code,
        },
    )


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
    callback_future: asyncio.Future[AuthorizationCodeResult]
    task: asyncio.Task[None]


FlowOperation = Callable[
    [
        Callable[[str], Awaitable[None]],
        Callable[[], Awaitable[AuthorizationCodeResult]],
    ],
    Awaitable[None],
]


class MCPOAuthFlowCoordinator:
    """Bridge an HTTP start/callback pair into one continuous SDK authorization operation."""

    def __init__(self, engine: Engine) -> None:
        """Create an empty process-local registry over a durable audit table."""
        self.engine = engine
        self._pending_by_digest: dict[str, _PendingFlow] = {}
        self._pending_by_id: dict[str, _PendingFlow] = {}

    @staticmethod
    def _digest_state(state: str) -> str:
        """Create the only callback-state representation allowed in persistent storage."""
        return hashlib.sha256(state.encode("utf-8")).hexdigest()

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

    def _discard_pending(self, flow_id: str) -> None:
        """Release completed process-local futures while retaining durable audit state."""
        pending = self._pending_by_id.pop(flow_id, None)
        if pending is not None:
            self._pending_by_digest.pop(pending.state_digest, None)

    async def start(
        self,
        *,
        tenant_id: str,
        server_id: str,
        user_id: str,
        redirect_uri: str,
        operation: FlowOperation,
    ) -> MCPOAuthStartResult:
        """Launch the SDK operation and return as soon as it emits an authorization URL."""
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
            pending = _PendingFlow(
                flow_id=flow_id,
                state_digest=state_digest,
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
            remaining = max((expires_at - utc_now()).total_seconds(), 0.0)
            try:
                return await asyncio.wait_for(asyncio.shield(callback_future), timeout=remaining)
            except TimeoutError as exc:
                self._update_status(flow_id, "expired", "MCP_OAUTH_FLOW_EXPIRED")
                raise MCPOAuthFlowError("MCP_OAUTH_FLOW_EXPIRED") from exc

        async def run_operation() -> None:
            """Run the SDK operation and close the durable audit state on every exit path."""
            try:
                await operation(redirect_handler, callback_handler)
            except asyncio.CancelledError:
                self._update_status(flow_id, "expired", "MCP_OAUTH_FLOW_EXPIRED")
                _log_oauth_event(
                    "mcp_oauth.expired",
                    tenant_id=tenant_id,
                    server_id=server_id,
                    user_id=user_id,
                    flow_id=flow_id,
                    error_code="MCP_OAUTH_FLOW_EXPIRED",
                )
                raise
            except Exception as exc:
                status = self.read_flow_status(flow_id)
                if status not in {"denied", "expired"}:
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

        task = asyncio.create_task(run_operation(), name=f"mcp-oauth-{flow_id}")
        try:
            authorization_url = await asyncio.wait_for(
                asyncio.shield(authorization_future),
                timeout=min(FLOW_TTL_SECONDS, 30),
            )
        except Exception:
            task.cancel()
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
        if error:
            self._update_status(pending.flow_id, "denied", "MCP_AUTHORIZATION_REQUIRED")
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
                await pending.task
            except MCPOAuthFlowError:
                pass
            return "denied"
        if not code:
            _log_oauth_event(
                "mcp_oauth.invalid_callback",
                tenant_id=row.tenant_id,
                server_id=row.server_id,
                user_id=row.user_id,
                flow_id=row.id,
                error_code="MCP_OAUTH_CALLBACK_INVALID",
            )
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")

        self._update_status(pending.flow_id, "callback_received")
        if pending.callback_future.done():
            raise MCPOAuthFlowError("MCP_OAUTH_CALLBACK_INVALID")
        pending.callback_future.set_result(
            AuthorizationCodeResult(code=code, state=state, iss=iss)
        )
        await pending.task
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

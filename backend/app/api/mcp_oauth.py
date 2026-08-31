"""Current-user OAuth lifecycle API for protected remote MCP servers."""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import Engine
from sqlmodel import Session

from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.http import build_http_exception
from app.db import engine as database_engine
from app.db import get_session
from app.db.models import MCPServer, User
from app.security.auth import ensure_current_user_tenant, get_current_user
from app.tools.mcp_oauth_flow import (
    FLOW_TTL_SECONDS,
    MCPOAuthFlowCoordinator,
    MCPOAuthFlowError,
    MCPOAuthStartResult,
)
from app.tools.mcp_oauth_policy import (
    mcp_oauth_config_fingerprint,
    validate_mcp_oauth_redirect_uri,
)
from app.tools.mcp_oauth_service import MCPGrantStatus, MCPGrantTokenStorage
from app.tools.mcp_sdk_adapter import MCPAdapterError, MCPSDKAdapter

router = APIRouter(
    prefix="/api/enterprise/mcp-servers",
    tags=["enterprise:mcp-oauth"],
)
_coordinators: dict[int, MCPOAuthFlowCoordinator] = {}


class MCPOAuthStartRequest(BaseModel):
    """Identify the tenant whose current-user authorization should begin."""

    tenant_id: str = Field(min_length=1)


class MCPOAuthStatusRead(BaseModel):
    """Expose only credential-free authorization state to the current user."""

    server_id: str
    auth_mode: Literal["none", "oauth_personal"]
    state: Literal[
        "not_required",
        "disconnected",
        "authorizing",
        "connected",
        "reconnect_required",
    ]
    expires_at: datetime | None = None
    scopes: list[str] = Field(default_factory=list)
    error_code: str | None = None


def _coordinator_for_engine(engine: Engine) -> MCPOAuthFlowCoordinator:
    """Reuse one process-local callback registry for each database engine."""
    key = id(engine)
    coordinator = _coordinators.get(key)
    if coordinator is None:
        coordinator = MCPOAuthFlowCoordinator(engine)
        _coordinators[key] = coordinator
    return coordinator


def _session_engine(db: Session) -> Engine:
    """Resolve the engine required by owner-bound stores from the request session."""
    bind = db.get_bind()
    if not isinstance(bind, Engine):
        raise TypeError("MCP OAuth requires an engine-bound database session")
    return bind


def _get_server(db: Session, tenant_id: str, server_id: str) -> MCPServer:
    """Load one tenant-owned server without revealing cross-tenant existence."""
    row = db.get(MCPServer, server_id)
    if row is None or row.tenant_id != tenant_id:
        raise build_http_exception("TOOL_NOT_FOUND")
    return row


def _project_status(server: MCPServer, status: MCPGrantStatus) -> MCPOAuthStatusRead:
    """Combine shared server policy with the current user's non-secret grant state."""
    return MCPOAuthStatusRead(
        server_id=server.id,
        auth_mode="oauth_personal",
        state=status.state,
        expires_at=status.expires_at,
        scopes=status.scopes,
        error_code=status.error_code,
    )


@router.get("/{server_id}/oauth/status", response_model=MCPOAuthStatusRead)
def get_mcp_oauth_status(
    server_id: str,
    tenant_id: str = Query(..., min_length=1),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> MCPOAuthStatusRead:
    """Read OAuth state for exactly the signed-in StaffDeck user."""
    ensure_current_user_tenant(tenant_id, current_user)
    server = _get_server(db, tenant_id, server_id)
    if server.auth_mode != "oauth_personal":
        return MCPOAuthStatusRead(
            server_id=server.id,
            auth_mode="none",
            state="not_required",
        )
    storage = MCPGrantTokenStorage(
        _session_engine(db),
        tenant_id,
        server.id,
        current_user.id,
        client_metadata_url=server.oauth_client_metadata_url,
        config_fingerprint=mcp_oauth_config_fingerprint(server),
        enforce_owner_binding=True,
    )
    return _project_status(server, storage.read_status())


@router.post("/{server_id}/oauth/start", response_model=MCPOAuthStartResult)
async def start_mcp_oauth(
    server_id: str,
    request: MCPOAuthStartRequest,
    http_response: Response,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> MCPOAuthStartResult:
    """Start one SDK-owned OAuth 2.1 + PKCE flow for the signed-in user."""
    ensure_current_user_tenant(request.tenant_id, current_user)
    server = _get_server(db, request.tenant_id, server_id)
    if (
        server.auth_mode != "oauth_personal"
        or server.transport != "streamable_http"
        or not server.url
        or not server.oauth_redirect_uri
    ):
        raise build_http_exception("MCP_OAUTH_PROVIDER_UNSUPPORTED")
    try:
        redirect_uri = validate_mcp_oauth_redirect_uri(server.oauth_redirect_uri)
    except ValueError as exc:
        raise build_http_exception("MCP_OAUTH_PROVIDER_UNSUPPORTED") from exc

    engine = _session_engine(db)
    storage = MCPGrantTokenStorage(
        engine,
        request.tenant_id,
        server.id,
        current_user.id,
        public_client_id=server.oauth_client_id,
        client_metadata_url=server.oauth_client_metadata_url,
        redirect_uri=redirect_uri,
        config_fingerprint=mcp_oauth_config_fingerprint(server),
        enforce_owner_binding=True,
    )
    grant_state = storage.read_status().state
    if grant_state == "connected":
        raise build_http_exception("MCP_OAUTH_FLOW_CONFLICT")
    if grant_state == "reconnect_required":
        storage.disconnect()
    storage.begin_authorization()
    coordinator = _coordinator_for_engine(engine)
    browser_binding = secrets.token_urlsafe(32)

    async def operation(redirect_handler, callback_handler) -> None:
        """Keep the SDK coroutine alive while the coordinator bridges the callback."""
        adapter = MCPSDKAdapter(
            server_url=server.url or "",
            headers=dict(server.headers_json or {}),
            storage=storage,
            redirect_uri=redirect_uri,
            redirect_handler=redirect_handler,
            callback_handler=callback_handler,
            client_metadata_url=server.oauth_client_metadata_url,
        )
        await adapter.discover()

    try:
        result = await coordinator.start(
            tenant_id=request.tenant_id,
            server_id=server.id,
            user_id=current_user.id,
            redirect_uri=redirect_uri,
            browser_binding=browser_binding,
            operation=operation,
        )
    except (MCPOAuthFlowError, MCPAdapterError) as exc:
        entry = ERROR_REGISTRY.get(exc.code)
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        raise build_http_exception(entry.code) from exc
    http_response.set_cookie(
        key=MCPOAuthFlowCoordinator.browser_cookie_name(result.flow_id),
        value=browser_binding,
        max_age=FLOW_TTL_SECONDS,
        path="/api/enterprise/mcp-servers/oauth/callback",
        secure=urlsplit(redirect_uri).scheme.lower() == "https",
        httponly=True,
        samesite="lax",
    )
    return result


@router.delete("/{server_id}/oauth", status_code=204)
def disconnect_mcp_oauth(
    server_id: str,
    tenant_id: str = Query(..., min_length=1),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete only the signed-in user's encrypted grant for one server."""
    ensure_current_user_tenant(tenant_id, current_user)
    server = _get_server(db, tenant_id, server_id)
    MCPGrantTokenStorage(
        _session_engine(db),
        tenant_id,
        server.id,
        current_user.id,
        client_metadata_url=server.oauth_client_metadata_url,
        config_fingerprint=mcp_oauth_config_fingerprint(server),
        enforce_owner_binding=True,
    ).disconnect()


@router.get("/oauth/callback", include_in_schema=False)
async def mcp_oauth_callback(
    request: Request,
    state: str | None = Query(default=None),
    code: str | None = Query(default=None),
    iss: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    """Consume one provider callback and redirect without echoing callback secrets."""
    coordinator = _coordinator_for_engine(database_engine)
    cookie_name = coordinator.browser_cookie_name_for_state(state or "")
    browser_binding = request.cookies.get(cookie_name) if cookie_name else None
    try:
        outcome = await coordinator.complete_callback(
            state=state or "",
            code=code,
            iss=iss,
            error=error,
            browser_binding=browser_binding,
        )
    except (MCPOAuthFlowError, MCPAdapterError) as exc:
        outcome = "expired" if exc.code == "MCP_OAUTH_FLOW_EXPIRED" else "failed"
    response = RedirectResponse(
        url=f"/enterprise/tools?mcp_oauth={outcome}",
        status_code=302,
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    if cookie_name and outcome in {"completed", "denied"}:
        response.delete_cookie(
            cookie_name,
            path="/api/enterprise/mcp-servers/oauth/callback",
        )
    return response

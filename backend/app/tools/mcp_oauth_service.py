"""Encrypted personal OAuth storage used by the official MCP SDK adapter."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any, Literal

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import BaseModel, Field
from sqlalchemy import Engine, update
from sqlmodel import Session, select

from app.db.models import MCPUserOAuthGrant, utc_now
from app.security.encryption import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)
_operation_locks_guard = Lock()
_operation_locks: dict[tuple[int, str, str, str], Lock] = {}


class MCPGrantConflict(RuntimeError):
    """Raised when a stale operation tries to replace a newer rotated grant."""


class MCPGrantStatus(BaseModel):
    """Non-secret current-user projection of one personal MCP authorization grant."""

    state: Literal["disconnected", "authorizing", "connected", "reconnect_required"]
    expires_at: datetime | None = None
    scopes: list[str] = Field(default_factory=list)
    error_code: str | None = None


class MCPGrantTokenStorage:
    """Persist official SDK token/client models inside one encrypted owner-scoped row."""

    def __init__(
        self,
        engine: Engine,
        tenant_id: str,
        server_id: str,
        user_id: str,
        *,
        public_client_id: str | None = None,
        redirect_uri: str | None = None,
        config_fingerprint: str = "",
    ) -> None:
        """Bind every storage operation to one tenant, server, and StaffDeck user."""
        self.engine = engine
        self.tenant_id = tenant_id
        self.server_id = server_id
        self.user_id = user_id
        self.public_client_id = public_client_id
        self.redirect_uri = redirect_uri
        self.config_fingerprint = config_fingerprint
        self._loaded_version: int | None = None

    def _log_event(self, oauth_event: str, error_code: str | None = None) -> None:
        """Record one owner-scoped lifecycle event without token or client payload fields."""
        logger.info(
            "MCP OAuth grant lifecycle event",
            extra={
                "oauth_event": oauth_event,
                "tenant_id": self.tenant_id,
                "server_id": self.server_id,
                "user_id": self.user_id,
                "error_code": error_code,
            },
        )

    def operation_lock(self) -> Lock:
        """Return the process-wide lock serializing one owner grant's SDK operations."""
        key = (id(self.engine), self.tenant_id, self.server_id, self.user_id)
        with _operation_locks_guard:
            lock = _operation_locks.get(key)
            if lock is None:
                lock = Lock()
                _operation_locks[key] = lock
            return lock

    def _select_row(self, db: Session) -> MCPUserOAuthGrant | None:
        """Load only the exact grant owner tuple; never fall back to server scope."""
        return db.exec(
            select(MCPUserOAuthGrant).where(
                MCPUserOAuthGrant.tenant_id == self.tenant_id,
                MCPUserOAuthGrant.server_id == self.server_id,
                MCPUserOAuthGrant.user_id == self.user_id,
            )
        ).first()

    @staticmethod
    def _empty_payload() -> dict[str, Any]:
        """Create the encrypted document shape shared by token and client-info writes."""
        return {"tokens": None, "client_info": None}

    @staticmethod
    def _decode_payload(row: MCPUserOAuthGrant) -> dict[str, Any]:
        """Decrypt one row and normalize legacy/missing optional payload members."""
        payload = json.loads(decrypt_secret(row.encrypted_payload))
        if not isinstance(payload, dict):
            raise TypeError("MCP OAuth grant payload must be an object")
        return {
            "tokens": payload.get("tokens"),
            "client_info": payload.get("client_info"),
        }

    @staticmethod
    def _encode_payload(payload: dict[str, Any]) -> str:
        """Serialize deterministically before encryption without exposing the plaintext."""
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        return encrypt_secret(serialized)

    def _read(self) -> tuple[MCPUserOAuthGrant | None, dict[str, Any]]:
        """Read the owner row and remember its version for a later guarded write."""
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                return None, self._empty_payload()
            self._loaded_version = row.version
            if row.config_fingerprint != self.config_fingerprint:
                db.expunge(row)
                return row, self._empty_payload()
            payload = self._decode_payload(row)
            db.expunge(row)
            return row, payload

    def _write(
        self,
        payload: dict[str, Any],
        *,
        status: str,
        expires_at: datetime | None,
    ) -> None:
        """Create or atomically version-guard an encrypted grant update."""
        encrypted_payload = self._encode_payload(payload)
        now = utc_now()
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                if self._loaded_version is not None:
                    raise MCPGrantConflict("MCP OAuth grant changed during authorization")
                row = MCPUserOAuthGrant(
                    tenant_id=self.tenant_id,
                    server_id=self.server_id,
                    user_id=self.user_id,
                    config_fingerprint=self.config_fingerprint,
                    encrypted_payload=encrypted_payload,
                    expires_at=expires_at,
                    status=status,
                    version=1,
                    created_at=now,
                    updated_at=now,
                )
                db.add(row)
                db.commit()
                self._loaded_version = 1
                return

            if row.config_fingerprint != self.config_fingerprint:
                raise MCPGrantConflict("MCP OAuth configuration changed during authorization")

            expected_version = self._loaded_version or row.version
            result = db.execute(
                update(MCPUserOAuthGrant)
                .where(
                    MCPUserOAuthGrant.id == row.id,
                    MCPUserOAuthGrant.version == expected_version,
                )
                .values(
                    encrypted_payload=encrypted_payload,
                    config_fingerprint=self.config_fingerprint,
                    expires_at=expires_at,
                    status=status,
                    version=expected_version + 1,
                    updated_at=now,
                )
            )
            if result.rowcount != 1:
                db.rollback()
                raise MCPGrantConflict("MCP OAuth grant changed during authorization")
            db.commit()
            self._loaded_version = expected_version + 1

    async def get_tokens(self) -> OAuthToken | None:
        """Return the current user's SDK token model from encrypted storage."""
        row, payload = self._read()
        if (
            row is None
            or row.config_fingerprint != self.config_fingerprint
            or row.status in {"reconnect_required", "revoked"}
        ):
            return None
        raw_tokens = payload["tokens"]
        return OAuthToken.model_validate(raw_tokens) if raw_tokens else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        """Persist a token rotation and its absolute expiry as one guarded update."""
        _row, payload = self._read_for_write()
        payload["tokens"] = tokens.model_dump(mode="json")
        expires_at = None
        if tokens.expires_in is not None:
            expires_at = utc_now() + timedelta(seconds=max(tokens.expires_in, 0))
        self._write(payload, status="active", expires_at=expires_at)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        """Return persisted registration info or a configured public client identity."""
        _row, payload = self._read()
        raw_client = (
            payload["client_info"]
            if _row is not None and _row.config_fingerprint == self.config_fingerprint
            else None
        )
        if raw_client:
            return OAuthClientInformationFull.model_validate(raw_client)
        if self.public_client_id:
            redirect_uris = [self.redirect_uri] if self.redirect_uri else None
            return OAuthClientInformationFull(
                client_id=self.public_client_id,
                redirect_uris=redirect_uris,
                token_endpoint_auth_method="none",
            )
        return None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        """Persist SDK client registration because it may contain an issued client secret."""
        row, payload = self._read_for_write()
        payload["client_info"] = client_info.model_dump(mode="json")
        self._write(
            payload,
            status=row.status if row else "authorizing",
            expires_at=row.expires_at if row else None,
        )

    def _read_for_write(self) -> tuple[MCPUserOAuthGrant | None, dict[str, Any]]:
        """Reload the row only when this storage instance has no observed version yet."""
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                return None, self._empty_payload()
            if row.config_fingerprint != self.config_fingerprint:
                raise MCPGrantConflict("MCP OAuth configuration changed during authorization")
            if self._loaded_version is not None and row.version != self._loaded_version:
                raise MCPGrantConflict("MCP OAuth grant changed during authorization")
            self._loaded_version = row.version
            payload = self._decode_payload(row)
            db.expunge(row)
            return row, payload

    def token_expiry_epoch(self) -> float | None:
        """Restore the absolute expiry required by the pinned SDK compatibility shim."""
        row, _payload = self._read()
        if (
            row is None
            or row.config_fingerprint != self.config_fingerprint
            or row.expires_at is None
        ):
            return None
        return row.expires_at.replace(tzinfo=UTC).timestamp()

    def read_status(self) -> MCPGrantStatus:
        """Project lifecycle and scopes without returning any credential material."""
        row, payload = self._read()
        if row is None or row.status == "revoked":
            return MCPGrantStatus(state="disconnected")
        if row.config_fingerprint != self.config_fingerprint:
            return MCPGrantStatus(
                state="reconnect_required",
                error_code="MCP_AUTHORIZATION_REQUIRED",
            )
        if row.status == "authorizing":
            return MCPGrantStatus(state="authorizing", expires_at=row.expires_at)
        if row.status == "reconnect_required":
            return MCPGrantStatus(
                state="reconnect_required",
                expires_at=row.expires_at,
                error_code="MCP_TOKEN_REFRESH_FAILED",
            )
        raw_tokens = payload["tokens"] or {}
        scopes = str(raw_tokens.get("scope") or "").split()
        return MCPGrantStatus(
            state="connected",
            expires_at=row.expires_at,
            scopes=scopes,
        )

    def mark_reconnect_required(self) -> None:
        """Fail closed after refresh or provider rejection without deleting audit state."""
        row, payload = self._read_for_write()
        if row is None:
            return
        self._write(payload, status="reconnect_required", expires_at=row.expires_at)
        self._log_event("mcp_oauth.refresh_failed", "MCP_TOKEN_REFRESH_FAILED")

    def disconnect(self) -> None:
        """Delete only the bound user's grant; repeated disconnects are harmless."""
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                return
            db.delete(row)
            db.commit()
        self._loaded_version = None
        self._log_event("mcp_oauth.disconnected")

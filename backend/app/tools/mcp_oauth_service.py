"""Encrypted personal OAuth storage used by the official MCP SDK adapter."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any, Literal
from weakref import WeakKeyDictionary, WeakValueDictionary

from mcp.shared.auth import OAuthClientInformationFull, OAuthMetadata, OAuthToken
from pydantic import BaseModel, Field
from sqlalchemy import Engine, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.db.models import MCPServer, MCPUserOAuthGrant, User, utc_now
from app.security.encryption import decrypt_secret, encrypt_secret
from app.tools.mcp_oauth_policy import mcp_oauth_config_fingerprint

logger = logging.getLogger(__name__)
_operation_locks_guard = Lock()
_operation_locks: WeakKeyDictionary[
    Engine,
    WeakValueDictionary[tuple[str, str, str], Lock],
] = WeakKeyDictionary()


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
        client_metadata_url: str | None = None,
        redirect_uri: str | None = None,
        config_fingerprint: str = "",
        enforce_owner_binding: bool = False,
    ) -> None:
        """Bind every storage operation to one tenant, server, and StaffDeck user."""
        self.engine = engine
        self.tenant_id = tenant_id
        self.server_id = server_id
        self.user_id = user_id
        self.public_client_id = public_client_id
        self.client_metadata_url = client_metadata_url
        self.redirect_uri = redirect_uri
        self.config_fingerprint = config_fingerprint
        self.enforce_owner_binding = enforce_owner_binding
        self._loaded_version: int | None = None
        self._authorization_server: str | None = None
        self._oauth_metadata: dict[str, Any] | None = None

    def _log_event(self, oauth_event: str, error_code: str | None = None) -> None:
        """Record one owner-scoped lifecycle event without token or client payload fields."""
        logger.info(
            "MCP OAuth grant lifecycle event",
            extra={
                "oauth_event": oauth_event,
                "error_code": error_code,
            },
        )

    def operation_lock(self) -> Lock:
        """Return the process-wide lock serializing one owner grant's SDK operations."""
        key = (self.tenant_id, self.server_id, self.user_id)
        with _operation_locks_guard:
            engine_locks = _operation_locks.get(self.engine)
            if engine_locks is None:
                engine_locks = WeakValueDictionary()
                _operation_locks[self.engine] = engine_locks
            lock = engine_locks.get(key)
            if lock is None:
                lock = Lock()
                engine_locks[key] = lock
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

    def _empty_payload(self) -> dict[str, Any]:
        """Create the encrypted document shape shared by token and client-info writes."""
        return {
            "tokens": None,
            "client_info": None,
            "authorization_server": self._authorization_server,
            "oauth_metadata": self._oauth_metadata,
        }

    @staticmethod
    def _decode_payload(row: MCPUserOAuthGrant) -> dict[str, Any]:
        """Decrypt one row and normalize legacy/missing optional payload members."""
        payload = json.loads(decrypt_secret(row.encrypted_payload))
        if not isinstance(payload, dict):
            raise TypeError("MCP OAuth grant payload must be an object")
        return {
            "tokens": payload.get("tokens"),
            "client_info": payload.get("client_info"),
            "authorization_server": (
                payload.get("authorization_server")
                if isinstance(payload.get("authorization_server"), str)
                else None
            ),
            "oauth_metadata": (
                payload.get("oauth_metadata")
                if isinstance(payload.get("oauth_metadata"), dict)
                else None
            ),
        }

    def _remember_authorization_server(self, payload: dict[str, Any]) -> None:
        """Restore the issuer binding needed by later refresh and guarded writes."""
        bound = payload.get("authorization_server")
        if isinstance(bound, str) and bound:
            self._authorization_server = bound
        metadata = payload.get("oauth_metadata")
        if isinstance(metadata, dict):
            self._oauth_metadata = metadata

    def _decode_or_invalidate(
        self,
        db: Session,
        row: MCPUserOAuthGrant,
    ) -> tuple[dict[str, Any], bool]:
        """Fail closed and preserve a reconnect path when the grant cannot be decrypted."""
        try:
            return self._decode_payload(row), False
        except (TypeError, ValueError):
            payload = self._empty_payload()
            row.encrypted_payload = self._encode_payload(payload)
            row.expires_at = None
            row.status = "reconnect_required"
            row.version += 1
            row.updated_at = utc_now()
            db.add(row)
            db.commit()
            self._loaded_version = row.version
            self._log_event("mcp_oauth.decrypt_failed", "MCP_AUTHORIZATION_REQUIRED")
            return payload, True

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
            payload, _invalidated = self._decode_or_invalidate(db, row)
            self._remember_authorization_server(payload)
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
            if self.enforce_owner_binding:
                server = db.get(MCPServer, self.server_id)
                user = db.get(User, self.user_id)
                if (
                    server is None
                    or server.tenant_id != self.tenant_id
                    or user is None
                    or user.tenant_id != self.tenant_id
                    or mcp_oauth_config_fingerprint(server) != self.config_fingerprint
                ):
                    raise MCPGrantConflict("MCP OAuth owner binding changed during authorization")
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
                try:
                    db.commit()
                except IntegrityError as exc:
                    db.rollback()
                    raise MCPGrantConflict(
                        "MCP OAuth grant changed during authorization"
                    ) from exc
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
        payload["authorization_server"] = self._authorization_server
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
        previous = payload.get("client_info")
        replacement = client_info.model_dump(mode="json")
        binding_changed = bool(
            payload.get("tokens")
            and (
                not isinstance(previous, dict)
                or previous.get("client_id") != replacement.get("client_id")
                or previous.get("issuer") != replacement.get("issuer")
            )
        )
        if binding_changed:
            payload["tokens"] = None
        payload["client_info"] = replacement
        payload["authorization_server"] = (
            self._authorization_server or client_info.issuer
        )
        self._write(
            payload,
            status="authorizing" if binding_changed or row is None else row.status,
            expires_at=None if binding_changed or row is None else row.expires_at,
        )

    async def bind_authorization_server(
        self,
        issuer: str,
        oauth_metadata: OAuthMetadata | None = None,
    ) -> tuple[bool, bool]:
        """Bind tokens to one discovered issuer and clear state that cannot cross issuers."""
        normalized = issuer.strip()
        if not normalized:
            return False, False
        metadata_payload: dict[str, Any] | None = None
        if oauth_metadata is not None:
            metadata_issuer = str(oauth_metadata.issuer)
            if metadata_issuer.rstrip("/") != normalized.rstrip("/"):
                raise MCPGrantConflict("MCP OAuth metadata issuer changed during authorization")
            metadata_payload = oauth_metadata.model_dump(mode="json", exclude_none=True)
        row, payload = self._read_for_write()
        previous = payload.get("authorization_server")
        self._authorization_server = normalized
        if metadata_payload is not None:
            self._oauth_metadata = metadata_payload
        if row is None:
            return False, False
        if previous == normalized:
            if metadata_payload is None or payload.get("oauth_metadata") == metadata_payload:
                return False, False
            payload["oauth_metadata"] = metadata_payload
            self._write(payload, status=row.status, expires_at=row.expires_at)
            return False, False

        tokens_cleared = payload.get("tokens") is not None
        client_info_cleared = False
        raw_client = payload.get("client_info")
        if isinstance(raw_client, dict):
            portable_ids = {
                value
                for value in (self.public_client_id, self.client_metadata_url)
                if value
            }
            if raw_client.get("client_id") not in portable_ids:
                payload["client_info"] = None
                client_info_cleared = True
        payload["tokens"] = None
        payload["authorization_server"] = normalized
        payload["oauth_metadata"] = metadata_payload
        self._oauth_metadata = metadata_payload
        self._write(payload, status="authorizing", expires_at=None)
        return tokens_cleared, client_info_cleared

    def read_authorization_server(self) -> str | None:
        """Return the non-secret issuer binding for internal validation and tests."""
        row, payload = self._read()
        if row is None:
            return None
        bound = payload.get("authorization_server")
        return bound if isinstance(bound, str) and bound else None

    def read_oauth_metadata(self) -> OAuthMetadata | None:
        """Restore validated authorization-server endpoints for post-restart refresh."""
        row, payload = self._read()
        raw_metadata = payload.get("oauth_metadata")
        if row is None or not isinstance(raw_metadata, dict):
            return None
        try:
            return OAuthMetadata.model_validate(raw_metadata)
        except (TypeError, ValueError):
            return None

    def _read_for_write(self) -> tuple[MCPUserOAuthGrant | None, dict[str, Any]]:
        """Reload the row only when this storage instance has no observed version yet."""
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                return None, self._empty_payload()
            if row.config_fingerprint != self.config_fingerprint:
                raise MCPGrantConflict("MCP OAuth configuration changed during authorization")
            if row.status == "revoked":
                raise MCPGrantConflict("MCP OAuth grant was disconnected during authorization")
            if self._loaded_version is not None and row.version != self._loaded_version:
                raise MCPGrantConflict("MCP OAuth grant changed during authorization")
            if self._loaded_version is None:
                raise MCPGrantConflict("MCP OAuth grant changed during authorization")
            self._loaded_version = row.version
            payload, invalidated = self._decode_or_invalidate(db, row)
            if invalidated:
                db.expunge(row)
                raise MCPGrantConflict("MCP OAuth grant requires reconnection")
            self._remember_authorization_server(payload)
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

    def begin_authorization(self) -> None:
        """Advance a prior tombstone so only this replacement flow may write a grant."""
        with Session(self.engine) as db:
            row = self._select_row(db)
            if row is None:
                self._loaded_version = None
                return
            if row.status in {"revoked", "reconnect_required"}:
                row.config_fingerprint = self.config_fingerprint
                row.encrypted_payload = self._encode_payload(self._empty_payload())
                row.expires_at = None
                row.status = "authorizing"
                row.version += 1
                row.updated_at = utc_now()
                db.add(row)
                db.commit()
            self._loaded_version = row.version

    def disconnect(self) -> None:
        """Write an owner-scoped tombstone that fences every in-flight token write."""
        encrypted_payload = self._encode_payload(self._empty_payload())
        now = utc_now()
        with Session(self.engine) as db:
            result = db.execute(
                update(MCPUserOAuthGrant)
                .where(
                    MCPUserOAuthGrant.tenant_id == self.tenant_id,
                    MCPUserOAuthGrant.server_id == self.server_id,
                    MCPUserOAuthGrant.user_id == self.user_id,
                )
                .values(
                    config_fingerprint=self.config_fingerprint,
                    encrypted_payload=encrypted_payload,
                    expires_at=None,
                    status="revoked",
                    version=MCPUserOAuthGrant.version + 1,
                    updated_at=now,
                )
            )
            if result.rowcount == 0:
                db.add(
                    MCPUserOAuthGrant(
                        tenant_id=self.tenant_id,
                        server_id=self.server_id,
                        user_id=self.user_id,
                        config_fingerprint=self.config_fingerprint,
                        encrypted_payload=encrypted_payload,
                        expires_at=None,
                        status="revoked",
                        version=1,
                        created_at=now,
                        updated_at=now,
                    )
                )
                try:
                    db.commit()
                except IntegrityError:
                    db.rollback()
                    retry = db.execute(
                        update(MCPUserOAuthGrant)
                        .where(
                            MCPUserOAuthGrant.tenant_id == self.tenant_id,
                            MCPUserOAuthGrant.server_id == self.server_id,
                            MCPUserOAuthGrant.user_id == self.user_id,
                        )
                        .values(
                            config_fingerprint=self.config_fingerprint,
                            encrypted_payload=encrypted_payload,
                            expires_at=None,
                            status="revoked",
                            version=MCPUserOAuthGrant.version + 1,
                            updated_at=now,
                        )
                    )
                    if retry.rowcount != 1:
                        db.rollback()
                        raise MCPGrantConflict("MCP OAuth grant owner disappeared")
                    db.commit()
            else:
                db.commit()
            row = self._select_row(db)
            if row is None:
                raise MCPGrantConflict("MCP OAuth grant owner disappeared")
            self._loaded_version = row.version
        self._log_event("mcp_oauth.disconnected")

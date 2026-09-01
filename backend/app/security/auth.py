from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session

from app.config import get_settings
from app.contracts.http import build_http_exception
from app.db import get_session
from app.db.models import User
from app.security.tenant import TenantExecutionKind, TenantLifecycleDenied, require_active_tenant

TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14
security = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256${salt}${base64.urlsafe_b64encode(digest).decode('utf-8')}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        _algo, salt, _digest = stored_hash.split("$", 2)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    candidate = f"pbkdf2_sha256${salt}${base64.urlsafe_b64encode(digest).decode('utf-8')}"
    return hmac.compare_digest(candidate, stored_hash)


def create_access_token(user: User) -> str:
    """Issue one tenant-data-plane token for a valid versioned tenant user."""
    if not _is_nonempty_string(user.tenant_id):
        raise ValueError("Invalid tenant token principal")
    if not _is_nonempty_string(user.id) or not _is_nonempty_string(user.username):
        raise ValueError("Invalid tenant token principal")
    if not _is_positive_integer(user.auth_version):
        raise ValueError("Invalid tenant token principal")
    payload = {
        "tenant_id": user.tenant_id,
        "user_id": user.id,
        "username": user.username,
        "principal_type": "tenant_user",
        "aud": "tenant_data_plane",
        "auth_version": user.auth_version,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    body = _b64(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    signature = _sign(body)
    return f"{body}.{signature}"


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_session),
) -> User:
    """Authenticate a tenant bearer and reject temporary-password business access."""
    return _get_authenticated_user(credentials, db, allow_temporary_password=False)


def get_current_user_allowing_temporary(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> User:
    """Authenticate a tenant bearer for the narrowly scoped recovery endpoints."""
    return _get_authenticated_user(credentials, db, allow_temporary_password=True)


def authenticate_tenant_token(token: str, db: Session) -> User:
    """Apply the same tenant bearer checks to non-FastAPI callers such as the Public API."""
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    return _get_authenticated_user(credentials, db, allow_temporary_password=False)


def _get_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None,
    db: Session,
    *,
    allow_temporary_password: bool,
) -> User:
    """Resolve a current tenant user with auth-version and lifecycle admission checks."""
    if not credentials:
        raise build_http_exception("AUTH_NOT_AUTHENTICATED")
    payload = _decode_token(credentials.credentials)
    user = db.get(User, payload["user_id"])
    if (
        not user
        or user.tenant_id != payload["tenant_id"]
        or not _is_positive_integer(user.auth_version)
        or user.auth_version != payload["auth_version"]
    ):
        raise build_http_exception("AUTH_INVALID_USER_TOKEN")
    try:
        require_active_tenant(
            db,
            user.tenant_id,
            TenantExecutionKind.JOB_CLAIM,
            f"tenant-bearer:{user.id}",
        )
    except TenantLifecycleDenied as exc:
        # A bearer must not disclose whether its tenant row is missing/corrupt.  Suspension is
        # deliberately distinct so the UI can stop an existing tenant session immediately.
        if exc.code == "TENANT_SUSPENDED":
            raise build_http_exception("TENANT_SUSPENDED") from None
        raise build_http_exception("AUTH_INVALID_USER_TOKEN") from None
    if not allow_temporary_password and user.must_change_password:
        raise build_http_exception("TEMPORARY_PASSWORD_CHANGE_REQUIRED")
    return user


def ensure_current_user_tenant(tenant_id: str, current_user: User) -> None:
    """Ensure an authenticated principal belongs to the requested tenant."""
    if not isinstance(current_user, User):
        raise build_http_exception("AUTH_NOT_AUTHENTICATED")
    if tenant_id != current_user.tenant_id:
        raise build_http_exception("TENANT_MISMATCH")


def require_current_tenant(
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
) -> User:
    ensure_current_user_tenant(tenant_id, current_user)
    return current_user


def _decode_token(token: str) -> dict[str, Any]:
    """Decode and verify a signed token while keeping malformed-token causes private."""
    try:
        body, signature = token.split(".", 1)
    except ValueError as exc:
        raise build_http_exception("AUTH_INVALID_TOKEN") from exc
    if not hmac.compare_digest(_sign(body), signature):
        raise build_http_exception("AUTH_INVALID_TOKEN_SIGNATURE")
    try:
        payload = json.loads(
            base64.b64decode(_pad_b64(body), altchars=b"-_", validate=True).decode("utf-8")
        )
    except Exception as exc:
        raise build_http_exception("AUTH_INVALID_TOKEN_PAYLOAD") from exc
    if not _is_valid_tenant_payload(payload):
        raise build_http_exception("AUTH_INVALID_TOKEN_PAYLOAD")
    if payload["exp"] <= int(time.time()):
        raise build_http_exception("AUTH_TOKEN_EXPIRED")
    return payload


def _is_valid_tenant_payload(payload: object) -> bool:
    """Accept only the exact tenant token claim set with strict scalar types and domain values."""
    if not isinstance(payload, dict):
        return False
    if set(payload) != {
        "tenant_id",
        "user_id",
        "username",
        "principal_type",
        "aud",
        "auth_version",
        "exp",
    }:
        return False
    return (
        _is_nonempty_string(payload["tenant_id"])
        and _is_nonempty_string(payload["user_id"])
        and _is_nonempty_string(payload["username"])
        and payload["principal_type"] == "tenant_user"
        and payload["aud"] == "tenant_data_plane"
        and _is_positive_integer(payload["auth_version"])
        and _is_integer(payload["exp"])
    )


def _is_nonempty_string(value: object) -> bool:
    """Return whether a token identity claim is a non-empty string without coercion."""
    return isinstance(value, str) and bool(value)


def _is_integer(value: object) -> bool:
    """Return whether a token numeric claim is an integer rather than a boolean subtype."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_integer(value: object) -> bool:
    """Return whether an authentication version is a strict positive integer."""
    return _is_integer(value) and value > 0


def _sign(body: str) -> str:
    secret = get_settings().app_secret.encode("utf-8")
    return _b64(hmac.new(secret, body.encode("utf-8"), hashlib.sha256).digest())


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


def _pad_b64(value: str) -> bytes:
    return (value + "=" * (-len(value) % 4)).encode("utf-8")

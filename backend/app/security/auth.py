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
    payload = {
        "tenant_id": user.tenant_id,
        "user_id": user.id,
        "username": user.username,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    body = _b64(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    signature = _sign(body)
    return f"{body}.{signature}"


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_session),
) -> User:
    """Authenticate the bearer token and expose only registered auth failures at the API boundary."""
    if not credentials:
        raise build_http_exception("AUTH_NOT_AUTHENTICATED")
    payload = _decode_token(credentials.credentials)
    user = db.get(User, payload.get("user_id", ""))
    if not user or user.tenant_id != payload.get("tenant_id"):
        raise build_http_exception("AUTH_INVALID_USER_TOKEN")
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
        payload = json.loads(base64.urlsafe_b64decode(_pad_b64(body)).decode("utf-8"))
    except Exception as exc:
        raise build_http_exception("AUTH_INVALID_TOKEN_PAYLOAD") from exc
    if int(payload.get("exp", 0)) < int(time.time()):
        raise build_http_exception("AUTH_TOKEN_EXPIRED")
    return payload


def _sign(body: str) -> str:
    secret = get_settings().app_secret.encode("utf-8")
    return _b64(hmac.new(secret, body.encode("utf-8"), hashlib.sha256).digest())


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


def _pad_b64(value: str) -> bytes:
    return (value + "=" * (-len(value) % 4)).encode("utf-8")

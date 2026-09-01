"""Authenticate installation-scoped administrators in an isolated bearer-token domain."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Annotated, Any

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session

from app.config import get_settings
from app.contracts.http import build_http_exception
from app.db import get_session
from app.db.models import SystemAdmin

SYSTEM_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14
system_security = HTTPBearer(auto_error=False)


class SystemAuthUnavailable(RuntimeError):
    """Signal that the independent system signer is deliberately unavailable."""


def create_system_access_token(admin: SystemAdmin) -> str:
    """Issue one system-control-plane token using only the dedicated system secret."""
    secret = _require_system_secret()
    if not _is_nonempty_string(admin.id) or not _is_positive_integer(admin.auth_version):
        raise ValueError("Invalid system token principal")
    payload = {
        "principal_type": "system_admin",
        "aud": "system_control_plane",
        "sub": admin.id,
        "auth_version": admin.auth_version,
        "exp": int(time.time()) + SYSTEM_TOKEN_TTL_SECONDS,
    }
    body = _b64(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign(body, secret)}"


def decode_system_access_token(token: str) -> dict[str, Any]:
    """Verify a system token and return its strict claims or one generic credential denial."""
    secret = _require_system_secret()
    try:
        body, signature = token.split(".", 1)
        if not body or not hmac.compare_digest(
            _sign(body, secret).encode("ascii"), signature.encode("utf-8")
        ):
            raise ValueError
        payload = json.loads(
            base64.b64decode(_pad_b64(body), altchars=b"-_", validate=True).decode("utf-8")
        )
        if not _is_valid_system_payload(payload) or payload["exp"] <= int(time.time()):
            raise ValueError
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error):
        raise _invalid_system_credentials() from None
    return payload


def get_current_system_admin(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(system_security),
    ],
    db: Annotated[Session, Depends(get_session)],
) -> SystemAdmin:
    """Resolve an active version-matched system principal without exposing denial branches."""
    _require_system_secret()
    if credentials is None:
        raise _invalid_system_credentials()
    payload = decode_system_access_token(credentials.credentials)
    admin = db.get(SystemAdmin, payload["sub"])
    if (
        admin is None
        or admin.status != "active"
        or not _is_positive_integer(admin.auth_version)
        or admin.auth_version != payload["auth_version"]
    ):
        raise _invalid_system_credentials()
    return admin


def _require_system_secret() -> str:
    """Return a dedicated nontrivial signer or fail closed on unsafe configuration."""
    settings = get_settings()
    secret = settings.system_admin_secret
    tenant_secret = getattr(settings, "app_secret", None)
    if (
        not isinstance(secret, str)
        or len(secret) < 16
        or secret.strip() != secret
        or (isinstance(tenant_secret, str) and secret == tenant_secret)
    ):
        raise SystemAuthUnavailable("System authentication is unavailable")
    return secret


def _is_valid_system_payload(payload: object) -> bool:
    """Accept only the exact system claim set with strict scalar types and domain values."""
    if not isinstance(payload, dict):
        return False
    if set(payload) != {"principal_type", "aud", "sub", "auth_version", "exp"}:
        return False
    return (
        payload["principal_type"] == "system_admin"
        and payload["aud"] == "system_control_plane"
        and _is_nonempty_string(payload["sub"])
        and _is_positive_integer(payload["auth_version"])
        and _is_integer(payload["exp"])
    )


def _invalid_system_credentials() -> HTTPException:
    """Build the generic registered system-auth denial without exposing rejection branches."""
    return build_http_exception("SYSTEM_AUTH_INVALID_CREDENTIALS")


def _sign(body: str, secret: str) -> str:
    """Create the URL-safe HMAC signature for one system token body without side effects."""
    return _b64(hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())


def _b64(value: bytes) -> str:
    """Encode bytes as an unpadded URL-safe token segment."""
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


def _pad_b64(value: str) -> bytes:
    """Restore URL-safe base64 padding before strict payload decoding."""
    return (value + "=" * (-len(value) % 4)).encode("utf-8")


def _is_nonempty_string(value: object) -> bool:
    """Return whether an identity claim is a non-empty string without coercion."""
    return isinstance(value, str) and bool(value)


def _is_integer(value: object) -> bool:
    """Return whether a numeric claim is an integer rather than a boolean subtype."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_integer(value: object) -> bool:
    """Return whether an authentication version is a strict positive integer."""
    return _is_integer(value) and value > 0


__all__ = [
    "SystemAuthUnavailable",
    "create_system_access_token",
    "decode_system_access_token",
    "get_current_system_admin",
]

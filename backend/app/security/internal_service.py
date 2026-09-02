from __future__ import annotations

import hashlib
import hmac

from fastapi import Header

from app.config import get_settings
from app.contracts.http import build_http_exception

INTERNAL_SERVICE_HEADER = "X-UltraRAG-Internal-Token"
_INTERNAL_SERVICE_SCOPE = b"ultrarag-internal-mock-api-v1"


def internal_service_token() -> str:
    secret = get_settings().app_secret.encode("utf-8")
    return hmac.new(secret, _INTERNAL_SERVICE_SCOPE, hashlib.sha256).hexdigest()


def require_internal_service(
    token: str | None = Header(default=None, alias=INTERNAL_SERVICE_HEADER),
) -> None:
    """Authenticate internal service calls without exposing token comparison details."""
    if token is None or not hmac.compare_digest(token, internal_service_token()):
        raise build_http_exception("AUTH_INTERNAL_SERVICE_REQUIRED")

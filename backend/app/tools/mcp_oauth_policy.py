"""Security policy shared by MCP OAuth configuration and flow startup."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Protocol
from urllib.parse import SplitResult, urlsplit

MCP_OAUTH_CALLBACK_PATH = "/api/enterprise/mcp-servers/oauth/callback"
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


class MCPServerOAuthPolicy(Protocol):
    """Describe the persisted fields that bind a personal OAuth grant."""

    auth_mode: str
    transport: str
    url: str | None
    oauth_client_id: str | None
    oauth_client_metadata_url: str | None
    oauth_redirect_uri: str | None


def _origin(parsed: SplitResult) -> tuple[str, str, int]:
    """Normalize a parsed HTTP(S) URL into a comparable origin tuple."""
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise ValueError("OAuth redirect URI has an invalid port") from exc
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


def validate_mcp_oauth_redirect_uri(redirect_uri: str) -> str:
    """Require the fixed callback path on loopback or the configured public origin."""
    normalized = redirect_uri.strip()
    parsed = urlsplit(normalized)
    hostname = (parsed.hostname or "").lower()
    if (
        not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != MCP_OAUTH_CALLBACK_PATH
    ):
        raise ValueError("OAuth redirect URI must use the exact StaffDeck callback endpoint")

    public_url = os.environ.get("STAFFDECK_PUBLIC_URL", "").strip()
    if public_url:
        public = urlsplit(public_url)
        public_hostname = (public.hostname or "").lower()
        public_scheme = public.scheme.lower()
        if (
            not public.netloc
            or public.username
            or public.password
            or public.query
            or public.fragment
            or public_scheme not in {"http", "https"}
            or (public_scheme == "http" and public_hostname not in _LOOPBACK_HOSTS)
            or _origin(parsed) != _origin(public)
        ):
            raise ValueError("OAuth redirect URI must match STAFFDECK_PUBLIC_URL")
        return normalized

    if hostname not in _LOOPBACK_HOSTS or parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError("OAuth redirect URI must use HTTPS or loopback HTTP")
    return normalized


def mcp_oauth_config_fingerprint(server: MCPServerOAuthPolicy) -> str:
    """Hash the server and public-client identity that an OAuth grant may authorize."""
    payload = {
        "auth_mode": server.auth_mode,
        "transport": server.transport,
        "server_url": server.url or "",
        "client_id": server.oauth_client_id or "",
        "client_metadata_url": server.oauth_client_metadata_url or "",
        "redirect_uri": server.oauth_redirect_uri or "",
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()

"""Validation contracts for MCP server authorization policy."""

import pytest
from pydantic import ValidationError

from app.tools.tool_schema import MCPServerConnection, MCPServerCreateRequest


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> None:
    """Reload environment-backed settings independently for every policy test."""
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _request(**overrides):
    """Build the smallest valid server request and apply one policy variation."""
    values = {
        "tenant_id": "tenant_1",
        "name": "protected",
        "connection": MCPServerConnection(
            transport="streamable_http",
            url="https://mcp.example.test/mcp",
        ),
    }
    values.update(overrides)
    if values.get("auth_mode") == "oauth_personal" and "oauth_redirect_uri" not in overrides:
        values["oauth_redirect_uri"] = (
            "http://127.0.0.1/api/enterprise/mcp-servers/oauth/callback"
        )
    return MCPServerCreateRequest(**values)


@pytest.mark.parametrize("transport", ["stdio", "sse", "builtin"])
def test_personal_oauth_rejects_ineligible_transports(transport: str) -> None:
    """Catch OAuth routing into transports excluded from the initial delivery."""
    if transport == "stdio":
        connection = MCPServerConnection(transport=transport, command="python")
    else:
        connection = MCPServerConnection(transport=transport, url="https://example.test/mcp")

    with pytest.raises(ValidationError, match="streamable_http"):
        _request(connection=connection, auth_mode="oauth_personal")


def test_personal_oauth_accepts_one_public_client_identity() -> None:
    """Accept a pre-registered public client without accepting a client secret."""
    request = _request(auth_mode="oauth_personal", oauth_client_id="staffdeck-public")

    payload = request.model_dump()
    assert payload["auth_mode"] == "oauth_personal"
    assert payload["oauth_client_id"] == "staffdeck-public"
    assert "oauth_client_secret" not in payload


def test_personal_oauth_rejects_two_client_identification_modes() -> None:
    """Prevent ambiguous selection between a public client ID and CIMD URL."""
    with pytest.raises(ValidationError, match="only one"):
        _request(
            auth_mode="oauth_personal",
            oauth_client_id="staffdeck-public",
            oauth_client_metadata_url="https://staffdeck.example/.well-known/mcp-client.json",
        )


def test_personal_oauth_allows_sdk_dynamic_client_registration() -> None:
    """Preserve the official SDK path when no pre-registered client identity exists."""
    request = _request(auth_mode="oauth_personal")

    assert request.oauth_client_id is None
    assert request.oauth_client_metadata_url is None


def test_personal_oauth_requires_a_redirect_uri() -> None:
    """Reject a saved policy that cannot receive the authorization callback."""
    with pytest.raises(ValidationError, match="redirect URI"):
        _request(
            auth_mode="oauth_personal",
            oauth_client_id="staffdeck-public",
            oauth_redirect_uri=None,
        )


@pytest.mark.parametrize(
    "metadata_url",
    ["http://staffdeck.example/client.json", "https://staffdeck.example"],
)
def test_cimd_requires_https_non_root_url(metadata_url: str) -> None:
    """Reject a CIMD identity that the official SDK will refuse at construction."""
    with pytest.raises(ValidationError, match="metadata URL"):
        _request(
            auth_mode="oauth_personal",
            oauth_client_metadata_url=metadata_url,
        )


@pytest.mark.parametrize(
    "redirect_uri",
    ["http://staffdeck.example/oauth/callback", "file:///tmp/callback"],
)
def test_redirect_uri_requires_https_or_loopback_http(redirect_uri: str) -> None:
    """Reject callbacks that expose an authorization code over unsafe remote schemes."""
    with pytest.raises(ValidationError, match="redirect URI"):
        _request(auth_mode="oauth_personal", oauth_redirect_uri=redirect_uri)


def test_redirect_uri_requires_the_fixed_callback_path(monkeypatch) -> None:
    """Catch an authorization code being redirected to an unrelated application path."""
    monkeypatch.setenv("STAFFDECK_PUBLIC_URL", "https://staffdeck.example")

    with pytest.raises(ValidationError, match="redirect URI"):
        _request(
            auth_mode="oauth_personal",
            oauth_redirect_uri="https://staffdeck.example/another/callback",
        )


def test_redirect_uri_requires_the_configured_public_origin(monkeypatch) -> None:
    """Catch a remote callback being sent to a different StaffDeck deployment."""
    monkeypatch.setenv("STAFFDECK_PUBLIC_URL", "https://staffdeck.example")

    with pytest.raises(ValidationError, match="redirect URI"):
        _request(
            auth_mode="oauth_personal",
            oauth_redirect_uri=(
                "https://other.example/api/enterprise/mcp-servers/oauth/callback"
            ),
        )


def test_redirect_uri_rejects_loopback_when_public_origin_is_configured(monkeypatch) -> None:
    """Prevent production configuration from falling back to an unrelated loopback callback."""
    monkeypatch.setenv("STAFFDECK_PUBLIC_URL", "https://staffdeck.example")

    with pytest.raises(ValidationError, match="redirect URI"):
        _request(
            auth_mode="oauth_personal",
            oauth_redirect_uri=(
                "http://127.0.0.1:5188/api/enterprise/mcp-servers/oauth/callback"
            ),
        )


def test_redirect_uri_accepts_the_configured_public_callback(monkeypatch) -> None:
    """Accept the exact callback endpoint on the configured StaffDeck origin."""
    monkeypatch.setenv("STAFFDECK_PUBLIC_URL", "https://staffdeck.example")
    redirect_uri = "https://staffdeck.example/api/enterprise/mcp-servers/oauth/callback"

    request = _request(auth_mode="oauth_personal", oauth_redirect_uri=redirect_uri)

    assert request.oauth_redirect_uri == redirect_uri


def test_redirect_uri_uses_public_origin_loaded_from_dotenv(tmp_path, monkeypatch) -> None:
    """Honor the deployment origin when it exists only in the configured dotenv file."""
    from app.config import Settings
    from app.tools import mcp_oauth_policy

    dotenv = tmp_path / "oauth.env"
    dotenv.write_text("STAFFDECK_PUBLIC_URL=https://dotenv.example\n", encoding="utf-8")
    monkeypatch.delenv("STAFFDECK_PUBLIC_URL", raising=False)
    settings = Settings(_env_file=dotenv)
    monkeypatch.setattr(mcp_oauth_policy, "get_settings", lambda: settings)

    redirect_uri = "https://dotenv.example/api/enterprise/mcp-servers/oauth/callback"
    assert mcp_oauth_policy.validate_mcp_oauth_redirect_uri(redirect_uri) == redirect_uri

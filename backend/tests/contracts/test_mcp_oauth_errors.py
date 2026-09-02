"""Stable public error contracts for MCP OAuth authorization."""

import pytest

from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("MCP_AUTHORIZATION_REQUIRED", 401),
        ("MCP_OAUTH_CALLBACK_INVALID", 400),
        ("MCP_OAUTH_FLOW_EXPIRED", 410),
        ("MCP_TOKEN_REFRESH_FAILED", 401),
        ("MCP_INSUFFICIENT_SCOPE", 403),
        ("MCP_OAUTH_PROVIDER_UNSUPPORTED", 400),
        ("MCP_OAUTH_FLOW_CONFLICT", 409),
    ],
)
def test_mcp_oauth_error_is_public_and_credential_free(code: str, status: int) -> None:
    """Catch missing or secret-bearing authorization errors at the registry boundary."""
    entry = ERROR_REGISTRY.require(code)

    assert entry.default_http_status == status
    assert entry.visibility is ErrorVisibility.PUBLIC
    assert entry.params_schema == {}
    assert entry.message_key.startswith("errors.tool.mcpOAuth")

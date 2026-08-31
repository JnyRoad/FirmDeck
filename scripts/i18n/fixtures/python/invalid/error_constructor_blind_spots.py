"""Intentional registry and helper-boundary violations missed by the original checker."""

from __future__ import annotations

from app.contracts.domain_http import domain_http_error
from app.contracts.errors import ErrorDescriptor
from app.contracts.http import build_http_exception
from app.public_api.errors import PublicAPIError
from fastapi import HTTPException


def _forwarded_error(
    code: str,
    *,
    params: dict[str, object] | None = None,
) -> HTTPException:
    """Forward a local code and params to the canonical HTTP constructor."""
    return build_http_exception(code, params=params)


def _legacy_detail_error(status_code: int, code: str, message: str) -> HTTPException:
    """Represent a legacy helper that publishes its caller-owned message verbatim."""
    return HTTPException(
        status_code=status_code, detail={"code": code, "message": message}
    )


def unregistered_build_http_error() -> HTTPException:
    """Fixture violation: use an unregistered literal in the canonical HTTP constructor."""
    return build_http_exception(
        "UNREGISTERED_HTTP_ERROR", params={"record_id": "record"}
    )


def unregistered_domain_error() -> HTTPException:
    """Fixture violation: use an unregistered literal through the shared domain adapter."""
    return domain_http_error("UNREGISTERED_DOMAIN_ERROR", source="fixture")


def unregistered_local_wrapper_error() -> HTTPException:
    """Fixture violation: pass an unregistered literal through a local forwarding helper."""
    return _forwarded_error(
        "UNREGISTERED_WRAPPER_ERROR", params={"record_id": "record"}
    )


def unregistered_public_api_error() -> PublicAPIError:
    """Fixture violation: expose an unregistered Public API code and unsafe params."""
    return PublicAPIError(
        400,
        "UNREGISTERED_PUBLIC_ERROR",
        "Deprecated compatibility detail.",
        params={"raw": "provider diagnostic"},
    )


def registered_descriptor_with_invalid_params() -> ErrorDescriptor:
    """Fixture violation: use params that disagree with the registered descriptor schema."""
    return ErrorDescriptor(
        code="VALIDATION_ERROR",
        params={"raw": "provider diagnostic"},
        retryable=False,
    )


def registered_http_error_with_missing_params() -> HTTPException:
    """Fixture violation: omit a required registered parameter at an HTTP boundary."""
    return build_http_exception("VALIDATION_ERROR")


def dynamic_public_error(payload: dict[str, object]) -> PublicAPIError:
    """Fixture violation: publish a dynamic code without a visible registry guard."""
    code = str(payload.get("code") or "")
    return PublicAPIError(400, code, "Deprecated compatibility detail.")


def natural_detail_through_helper() -> HTTPException:
    """Fixture violation: publish developer-owned natural language through a helper."""
    return _legacy_detail_error(409, "UNREGISTERED_LEGACY_ERROR", "当前操作无法完成")

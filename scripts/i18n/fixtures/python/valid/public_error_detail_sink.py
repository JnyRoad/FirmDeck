"""Safe Public API detail projections accepted by the backend checker."""

from __future__ import annotations

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.projections import project_public_error_payload
from app.public_api.errors import PublicAPIError
from fastapi import Request


def problem_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    params: dict[str, object],
    detail: str,
):
    """Fixture implementation that assigns only canonical code data to its public payload."""
    payload = {"code": code, "params": params}
    payload["detail"] = "INTERNAL_ERROR"
    return payload


def safe_problem_response(request: Request):
    """Use a registered code in the deprecated field while canonical params stay structured."""
    entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
    return problem_response(
        request,
        status_code=entry.default_http_status,
        code=entry.code,
        params={},
        detail=entry.code,
    )


def safe_public_error() -> PublicAPIError:
    """Keep legacy detail itself on a stable registered code for compatibility callers."""
    return PublicAPIError(500, "INTERNAL_ERROR", "INTERNAL_ERROR", params={})


def safe_problem_implementation() -> dict[str, object]:
    """Assign only canonical code data to the deprecated public field."""
    canonical = project_public_error_payload({}, ERROR_REGISTRY, source="fixture")
    payload = {"code": "INTERNAL_ERROR", "params": {}}
    payload["detail"] = canonical["code"]
    return payload

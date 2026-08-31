"""Intentional Public API detail sinks that bypass the canonical stable projection."""

from __future__ import annotations

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
    """Fixture implementation that assigns its caller-owned detail to a public payload."""
    payload = {"code": code, "params": params}
    payload["detail"] = detail
    return payload


def unsafe_problem_response(request: Request, detail: str):
    """Fixture violation: pass caller-owned prose into the deprecated problem detail field."""
    return problem_response(
        request,
        status_code=502,
        code="INTERNAL_ERROR",
        params={},
        detail=detail,
    )


def unsafe_public_handler(request: Request, exc: PublicAPIError):
    """Fixture violation: forward PublicAPIError.detail instead of its registered code."""
    return problem_response(
        request,
        status_code=exc.status_code,
        code="INTERNAL_ERROR",
        params={},
        detail=exc.detail,
    )

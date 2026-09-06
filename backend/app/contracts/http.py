"""FastAPI compatibility adapters for canonical FirmDeck product errors."""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import HTTPException

from app.contracts.error_registry import ERROR_REGISTRY, ErrorRegistry
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext, JsonValue
from app.contracts.projections import project_problem_details


def build_http_exception(
    code: str,
    *,
    params: Mapping[str, JsonValue] | None = None,
    status_code: int | None = None,
    retryable: bool | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
    internal: InternalErrorContext | None = None,
    registry: ErrorRegistry = ERROR_REGISTRY,
) -> HTTPException:
    """Build a structured HTTP error while keeping optional diagnostics private."""
    entry = registry.get(code) or registry.require("INTERNAL_ERROR")
    descriptor = ErrorDescriptor(
        code=code,
        params=dict(params or {}),
        retryable=entry.retryable_default if retryable is None else retryable,
        request_id=request_id,
        trace_id=trace_id,
    )
    occurrence = ErrorOccurrence(descriptor=descriptor, internal=internal)
    detail = project_problem_details(occurrence, registry)
    effective_status = status_code if status_code is not None else entry.default_http_status
    # A compatibility endpoint may retain a historical status which differs from the
    # registry default; keep both FastAPI's status and the RFC-style detail synchronized.
    detail["status"] = effective_status
    exception = HTTPException(status_code=effective_status, detail=detail)
    if internal is not None:
        # The exception handler may use this private attribute for authorized diagnostics;
        # FastAPI serializes only ``detail`` and therefore cannot expose the raw cause.
        exception._internal_error_context = internal  # type: ignore[attr-defined]
    return exception


__all__ = ["build_http_exception"]

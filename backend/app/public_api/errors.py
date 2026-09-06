from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError as PydanticValidationError

from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext, JsonValue
from app.contracts.projections import project_public_error


class PublicAPIError(Exception):
    """Explicit Public API failure with a diagnostic-only legacy detail field."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str,
        *,
        params: dict[str, JsonValue] | None = None,
        retryable: bool = False,
        errors: list[dict[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Store stable error metadata while keeping legacy detail out of exception text."""
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.params = params or {}
        self.retryable = retryable
        self.errors = errors or []
        self.headers = headers or {}


def _request_correlation(request: Request) -> tuple[str, str | None]:
    """Read request and trace identifiers without inventing a trace at the error boundary."""
    request_id = str(getattr(request.state, "request_id", ""))
    trace_id = getattr(request.state, "trace_id", None) or request.headers.get("X-Trace-ID")
    return request_id, str(trace_id) if trace_id else None


def _safe_error_items(errors: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """Reduce validation diagnostics to stable location and machine-readable code fields."""
    safe_errors: list[dict[str, str]] = []
    for error in errors or []:
        raw_path = error.get("path", error.get("loc", []))
        if isinstance(raw_path, str):
            path = raw_path
        elif isinstance(raw_path, list | tuple):
            path = ".".join(str(item) for item in raw_path)
        else:
            path = ""
        code = str(error.get("code") or error.get("type") or "validation_error")
        safe_errors.append({"path": path, "code": code})
    return safe_errors


def _fallback_descriptor(
    *,
    request_id: str,
    trace_id: str | None,
) -> ErrorDescriptor:
    """Return the registered public-safe fallback while retaining request correlation."""
    fallback = ERROR_REGISTRY.require("INTERNAL_ERROR")
    return ErrorDescriptor(
        code=fallback.code,
        params={},
        retryable=fallback.retryable_default,
        request_id=request_id,
        trace_id=trace_id,
    )


def _canonical_payload(
    *,
    code: str,
    params: dict[str, JsonValue],
    retryable: bool,
    request_id: str,
    trace_id: str | None,
    internal: InternalErrorContext | None = None,
) -> dict[str, Any]:
    """Project only registered public fields while retaining private diagnostic context."""
    try:
        descriptor = ErrorDescriptor(
            code=code,
            params=params,
            retryable=retryable,
            request_id=request_id,
            trace_id=trace_id,
        )
    except PydanticValidationError:
        descriptor = _fallback_descriptor(request_id=request_id, trace_id=trace_id)
        return project_public_error(
            ErrorOccurrence(descriptor=descriptor, internal=internal),
            ERROR_REGISTRY,
        )
    return project_public_error(
        ErrorOccurrence(descriptor=descriptor, internal=internal),
        ERROR_REGISTRY,
    )


def problem_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    detail: str | None,
    params: dict[str, JsonValue] | None = None,
    retryable: bool = False,
    errors: list[dict[str, Any]] | None = None,
    headers: dict[str, str] | None = None,
    internal: InternalErrorContext | None = None,
) -> JSONResponse:
    """Render canonical error fields plus a deprecated stable-code v1 detail compatibility field."""
    request_id, trace_id = _request_correlation(request)
    canonical = _canonical_payload(
        code=code,
        params=params or {},
        retryable=retryable,
        request_id=request_id,
        trace_id=trace_id,
        internal=internal,
    )
    payload: dict[str, Any] = {
        "type": f"urn:firmdeck:error:{canonical['code'].lower()}",
        "title": canonical["code"],
        "status": status_code,
        **canonical,
    }
    if detail is not None:
        # TODO(i18n-governance): remove this stable-code compatibility field after Public API v2 migration.
        # The caller's detail is diagnostic input and must never cross this public boundary.
        payload["detail"] = canonical["code"]
        payload["deprecated_fields"] = ["detail"]
    safe_errors = _safe_error_items(errors)
    if safe_errors:
        payload["errors"] = safe_errors
    response_headers = {"X-Request-ID": request_id, **(headers or {})}
    if trace_id:
        response_headers["X-Trace-ID"] = trace_id
    return JSONResponse(
        payload,
        status_code=status_code,
        media_type="application/problem+json",
        headers=response_headers,
    )


async def public_api_error_handler(request: Request, exc: PublicAPIError) -> JSONResponse:
    """Project an explicit PublicAPIError while retaining only its stable v1 detail code."""
    # Workflow: resolve the exception code at the public boundary and fail closed
    # before the compatibility projection can expose an unregistered code.
    entry = ERROR_REGISTRY.get(exc.code)
    safe_params = exc.params
    safe_retryable = exc.retryable
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        safe_params = {}
        safe_retryable = entry.retryable_default
    return problem_response(
        request,
        status_code=exc.status_code,
        code=entry.code,
        detail=entry.code,
        params=safe_params,
        retryable=safe_retryable,
        errors=exc.errors,
        headers=exc.headers,
    )


async def public_http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Fail closed for arbitrary HTTP detail while retaining raw cause in private context only."""
    code = "INTERNAL_ERROR"
    params: dict[str, JsonValue] = {}
    if isinstance(exc.detail, str) and exc.detail.isupper():
        code = exc.detail
    elif isinstance(exc.detail, dict):
        candidate_code = exc.detail.get("code")
        candidate_params = exc.detail.get("params")
        if isinstance(candidate_code, str) and candidate_code.isupper():
            code = candidate_code
        if isinstance(candidate_params, dict):
            params = candidate_params
    # Workflow: arbitrary framework detail is diagnostic input, not a product
    # contract; only a registered public code may reach the response projector.
    entry = ERROR_REGISTRY.get(code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        params = {}
    return problem_response(
        request,
        status_code=exc.status_code,
        code=entry.code,
        detail=entry.code,
        params=params,
        headers=dict(exc.headers or {}),
        internal=InternalErrorContext(
            source="public_http_exception",
            exception_type=type(exc).__name__,
            raw_message=str(exc.detail),
            upstream_status=exc.status_code,
        ),
    )


async def public_validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Expose validation locations and stable codes without framework messages or rejected input."""
    errors = [
        {
            "path": ".".join(str(item) for item in error.get("loc", [])),
            "code": error.get("type", "validation_error"),
        }
        for error in exc.errors()
    ]
    return problem_response(
        request,
        status_code=422,
        code="VALIDATION_ERROR",
        detail="VALIDATION_ERROR",
        params={"error_count": len(errors)},
        errors=errors,
    )

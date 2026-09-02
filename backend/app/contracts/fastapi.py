"""FastAPI application-level adapters for StaffDeck-owned public error contracts."""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.contracts.errors import InternalErrorContext
from app.contracts.http import build_http_exception


async def request_validation_error_handler(
    _request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Project framework validation failures without rejected values or prose."""
    error_count = len(exc.errors())
    projected = build_http_exception(
        "VALIDATION_ERROR",
        params={"error_count": error_count},
        status_code=422,
        internal=InternalErrorContext(
            source="main-request-validation",
            exception_type=type(exc).__name__,
            upstream_status=422,
        ),
    )
    detail = projected.detail
    safe_detail = {
        "code": detail["code"],
        "message_key": detail["message_key"],
        "params": detail["params"],
        "retryable": detail["retryable"],
        "status": detail["status"],
    }
    return JSONResponse(
        status_code=projected.status_code,
        content={"detail": safe_detail},
    )


__all__ = ["request_validation_error_handler"]

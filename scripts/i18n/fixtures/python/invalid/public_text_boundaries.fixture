"""Intentional public natural-text and exception leakage violations."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse


def natural_http_detail() -> None:
    """Fixture violation: expose locale prose through HTTPException.detail."""
    raise HTTPException(status_code=404, detail="Document not found")


def natural_json_response() -> JSONResponse:
    """Fixture violation: expose a natural message instead of code and named params."""
    return JSONResponse({"message": "Operation failed"}, status_code=500)


def legacy_event(event_log) -> None:
    """Fixture violation: record a text-shaped product event."""
    event_log.record("tenant", "session", "step_result", {"status_text": "Working"})


def leaked_exception() -> JSONResponse:
    """Fixture violation: copy a raw exception into a public response field."""
    try:
        raise RuntimeError("private provider cause")
    except RuntimeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)

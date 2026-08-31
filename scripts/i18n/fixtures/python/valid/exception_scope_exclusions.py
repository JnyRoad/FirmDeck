"""Valid non-exception conversions and private diagnostics excluded from product checks."""

from __future__ import annotations

import logging

from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)
SYSTEM_PROMPT = "Preserve provider output, paths, and identifiers verbatim."


def refund_projection(raw_reason: object) -> JSONResponse:
    """Return a raw business reason without treating its string conversion as an exception leak."""
    return JSONResponse({"refund_reason": str(raw_reason)}, status_code=200)


def refund_projection_after_private_failure(raw_reason: object) -> JSONResponse:
    """Keep a non-exception business conversion valid even inside an except handler."""
    try:
        raise RuntimeError("private provider cause")
    except RuntimeError as caught:
        logger.debug("private provider failure", exc_info=caught)
        return JSONResponse({"refund_reason": str(raw_reason)}, status_code=200)


def retain_private_exception_diagnostics() -> None:
    """Format a caught exception only in private locals and logs, never in a public product sink."""
    try:
        raise RuntimeError("private provider cause")
    except RuntimeError as caught:
        raw_text = str(caught)
        raw_repr = repr(caught)
        raw_format = f"{caught}"
        logger.exception(
            "private provider failure text=%s repr=%s formatted=%s",
            raw_text,
            raw_repr,
            raw_format,
        )

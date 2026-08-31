"""Valid technical strings and raw data that the product localization checker must preserve."""

from __future__ import annotations

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)
SYSTEM_PROMPT = "Return strict JSON and preserve user-provided paths verbatim."


def log_private_failure(exc: Exception, raw_provider_message: str) -> None:
    """Retain technical evidence in logs without returning it from a product boundary."""
    logger.exception("provider call failed: %s", raw_provider_message, exc_info=exc)


def raise_registered_error() -> None:
    """Raise a safe structured descriptor rather than a localized natural-language detail."""
    raise HTTPException(
        status_code=500,
        detail={
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": "req_fixture",
            "trace_id": "trc_fixture",
        },
    )

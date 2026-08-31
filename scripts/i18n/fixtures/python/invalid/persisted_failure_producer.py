"""Persist raw exception data for cross-file public-boundary fixtures."""

from __future__ import annotations

import traceback


def persist_failed_delivery(delivery: object) -> None:
    """Fixture violation: persist exception prose and traceback for later API reads."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        delivery.failure_reason = str(exc)
        delivery.error_traceback = traceback.format_exc()

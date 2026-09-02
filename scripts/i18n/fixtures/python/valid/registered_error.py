"""Minimal valid backend error fixture for the future Python i18n checker."""

from __future__ import annotations

REGISTERED_ERROR_CODE = "knowledge.document_not_found"


def build_registered_error() -> dict[str, object]:
    """Return a safe canonical error example; this is side-effect free and cannot fail."""
    return {
        "code": REGISTERED_ERROR_CODE,
        "params": {"document_id": "doc_fixture"},
        "retryable": False,
        "request_id": "req_fixture",
        "trace_id": "trc_fixture",
    }

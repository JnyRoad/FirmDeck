"""Intentional canonical descriptor whose code is absent from the registry."""

from __future__ import annotations

from app.contracts.errors import ErrorDescriptor


def build_unregistered_descriptor() -> ErrorDescriptor:
    """Return the invalid descriptor so the AST checker can diagnose its literal code."""
    return ErrorDescriptor(
        code="PROVIDER_UNKNOWN_FAILURE",
        params={},
        retryable=False,
    )

"""Canonical Harness error projection with bounded empty-success passthrough."""

from __future__ import annotations

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.projections import project_public_error_payload


class AgentEvent:
    """Stand in for a durable Harness event sink."""


def _public_harness_error(value: object) -> object:
    """Pass through only empty success values and canonically project every failure."""
    if value is None or value == {}:
        return value
    return project_public_error_payload(value, ERROR_REGISTRY, source="fixture")


def public_harness_event(frame: object) -> AgentEvent:
    """Expose a Harness failure only through the structurally verified local projector."""
    return AgentEvent(data={"error": _public_harness_error(frame.error)})

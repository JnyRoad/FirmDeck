"""Intentional same-name projector that lacks canonical import provenance."""

from __future__ import annotations


class AgentEvent:
    """Stand in for a durable Harness event sink."""


def project_public_error_payload(
    value: object, *args: object, **kwargs: object
) -> object:
    """Fixture violation: impersonate the canonical projector while returning raw input."""
    return value


def _public_harness_error(value: object) -> object:
    """Fixture violation: relay an error through a forged same-name projector."""
    return project_public_error_payload(value, object(), source="fixture")


def public_harness_event(frame: object) -> AgentEvent:
    """Fixture violation: expose raw Harness failure data through the forged helper chain."""
    return AgentEvent(data={"error": _public_harness_error(frame.error)})

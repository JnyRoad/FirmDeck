"""Intentional descriptor validation, event, and private-cause contract violations."""

from __future__ import annotations


class ErrorDescriptor:
    """Stand in for the canonical descriptor constructor."""


class ToolError:
    """Stand in for the public Tool error model."""


class KnowledgeError:
    """Stand in for the Knowledge domain error model."""


class JobResponse:
    """Stand in for a public job failure response."""


def invalid_tool_error() -> object:
    """Fixture violation: bypass required registered params through ToolError."""
    return ToolError(code="VALIDATION_ERROR", message="legacy", params={})


def invalid_knowledge_error() -> object:
    """Fixture violation: bypass registered params through KnowledgeError details."""
    return KnowledgeError("VALIDATION_ERROR", details={"unexpected": "raw"})


def invalid_a2a_recovery_descriptor() -> object:
    """Fixture violation: use recovery params that drift from the registry schema."""
    return ErrorDescriptor(
        code="AGENT_REPLY_LOCALE_CONFLICT",
        params={"session": "zh-CN", "snapshot": "en-US"},
        retryable=False,
    )


def _public_harness_error(code: str) -> object:
    """Forward a Harness code into a public descriptor without a registry guard."""
    return ErrorDescriptor(code=code, params={}, retryable=False)


def unregistered_harness_error() -> object:
    """Fixture violation: publish an unregistered internal Harness classification."""
    return _public_harness_error("HARNESS_ACTION_INVALID")


def arbitrary_legacy_event(events: object, payload: dict[str, object]) -> None:
    """Fixture violation: persist an arbitrary payload through legacy EventLog.record."""
    events.record("tenant", "session", "run_failed", payload)


def public_job_without_private_cause() -> object:
    """Fixture violation: publish a stable job error while discarding the caught root cause."""
    try:
        raise RuntimeError
    except RuntimeError:
        return JobResponse(
            error=ErrorDescriptor(code="INTERNAL_ERROR", params={}, retryable=False)
        )

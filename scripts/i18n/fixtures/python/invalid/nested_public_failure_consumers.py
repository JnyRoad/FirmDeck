"""Intentional nested, replayed, and typed public failure projections."""

from __future__ import annotations


class RunResponse:
    """Stand in for a public run result."""


class WebhookDeliveryResponse:
    """Stand in for an authenticated webhook delivery response."""


class SkillStreamResponse:
    """Stand in for a public Skill stream snapshot."""


class AgentEvent:
    """Stand in for a replayed or streamed Agent event."""


def public_run_result(task: object) -> RunResponse:
    """Fixture violation: redact but retain an arbitrary nested task error."""
    return RunResponse(result={"tasks": [{"error": redact(task.error)}]})


def webhook_delivery(row: object) -> WebhookDeliveryResponse:
    """Fixture violation: expose a persisted webhook failure reason."""
    return WebhookDeliveryResponse(last_error=row.failure_reason)


def skill_stream_snapshot(job: object) -> SkillStreamResponse:
    """Fixture violation: expose a legacy string error from a Skill stream job."""
    return SkillStreamResponse(error=job.error)


def _unsafe_project_stored_job_error(row: object) -> object:
    """Fixture violation: redact but retain a persisted raw error object."""
    return redact(row.error_json)


def unsafe_projected_job_result(row: object) -> RunResponse:
    """Fixture violation: expose a helper that lacks canonical registry projection."""
    return RunResponse(error=_unsafe_project_stored_job_error(row))


def _public_harness_error(value: object) -> object:
    """Fixture violation: preserve arbitrary Harness error data without projection."""
    return value


def unsafe_harness_event(frame: object) -> AgentEvent:
    """Fixture violation: relay a Harness error through an unverified lookalike helper."""
    return AgentEvent(data={"error": _public_harness_error(frame.error)})


def replay_interrupted_turn(row: object) -> AgentEvent:
    """Fixture violation: replay persisted exception reason and traceback to chat clients."""
    return AgentEvent(
        data={
            "reason": row.failure_reason,
            "error_details": {"traceback": row.error_traceback},
        }
    )


def stream_codex_error(event: dict[str, object]) -> AgentEvent:
    """Fixture violation: relay a remote Codex error event without canonical projection."""
    if event.get("type") in {"error", "diagnostic"}:
        return AgentEvent(data={"codexEvent": event})
    return AgentEvent(data={"status": "ignored"})


def redact(value: object) -> object:
    """Stand in for redaction that does not canonicalize an error contract."""
    return value

"""Intentional fixed product prose at typed Agent, trace, progress, draft, and stream sinks."""

from __future__ import annotations


class AgentEvent:
    """Stand in for a durable Agent event model."""


class TaskExecutionResult:
    """Stand in for the Harness task result model."""


def _add_stream_status_event(
    db: object,
    tenant_id: str,
    session_id: str,
    message_id: str,
    phase: str,
    text: str,
) -> None:
    """Stand in for the legacy stream helper whose sixth argument is product text."""


def build_task_result(task_name: str) -> TaskExecutionResult:
    """Fixture violation: construct a task result with a fixed formatted reply fragment."""
    return TaskExecutionResult(reply_fragment=f"Completed {task_name}")


def overwrite_task_reply(result: TaskExecutionResult) -> None:
    """Fixture violation: assign fixed prose to an existing task result reply fragment."""
    result.reply_fragment = "Task completed"


def _project_harness_trace(value: object) -> dict[str, object]:
    """Fixture violation: add fixed prose to a public trace projection."""
    return {"text": "Running tool", "value": value}


def project_progress(step: int) -> dict[str, object]:
    """Fixture violation: add formatted prose to a public progress projection."""
    return {"detail": f"Processing step {step}"}


def draft_projection() -> dict[str, object]:
    """Fixture violation: add fixed status prose to a public draft projection."""
    return {"status_text": "Draft ready"}


def add_stream_status(events: list[object], attempt: int) -> AgentEvent:
    """Fixture violation: emit fixed prose through both stream-status event boundaries."""
    _add_stream_status_event(
        object(), "tenant", "session", "message", "phase", "Waiting for approval"
    )
    return AgentEvent(payload_json={"text": f"Retry {attempt}"})

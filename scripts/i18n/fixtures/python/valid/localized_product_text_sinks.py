"""Localized product text and explicit raw values accepted at known backend UI sinks."""

from __future__ import annotations

from app.i18n.raw_source import RawSourceMarker
from app.llm.prompts.language import localized_compat_text


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
    event_code: str,
    *,
    params: dict[str, object] | None = None,
) -> None:
    """Stand in for the canonical stream helper that accepts only code and params."""


def localized_task_result(context: object, previous: object) -> TaskExecutionResult:
    """Select task prose while preserving an already structured prior result error."""
    return TaskExecutionResult(
        reply_fragment=localized_compat_text(
            context,
            zh_cn="任务完成",
            en_us="Task completed",
        ),
        error=previous.error,
    )


def localized_task_assignment(result: TaskExecutionResult, context: object) -> None:
    """Assign only locale-selected prose to an existing task result."""
    result.reply_fragment = localized_compat_text(
        context,
        zh_cn="等待确认",
        en_us="Waiting for confirmation",
    )


def _project_harness_trace(value: object, context: object) -> dict[str, object]:
    """Project trace text through the controlled compatibility localizer."""
    return {
        "text": localized_compat_text(context, zh_cn="执行中", en_us="Running"),
        "value": value,
    }


def emit_localized_stream(events: list[object], context: object) -> AgentEvent:
    """Emit a registered status descriptor and a descriptor-only event payload."""
    _add_stream_status_event(
        object(),
        "tenant",
        "session",
        "message",
        "phase",
        "TASK_QUEUED",
        params={},
    )
    return AgentEvent(
        payload_json={"code": "TASK_QUEUED", "params": {}, "retryable": False}
    )


def emit_raw_success(source: object) -> AgentEvent:
    """Preserve successful provider output only through an exact raw source marker."""
    return AgentEvent(
        payload_json={"text": RawSourceMarker(pointer="/provider/output")}
    )


def build_prompt() -> dict[str, str]:
    """Keep prompt-only prose outside typed product projection functions."""
    return {"text": "Use the previous tool output exactly as supplied."}

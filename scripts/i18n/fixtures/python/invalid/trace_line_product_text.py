"""Intentional fixed prose returned by known trace-line product projection functions."""

from __future__ import annotations


def _event_trace_line(event_data: dict[str, object]) -> dict[str, object]:
    """Fixture violation: return fixed local, conditional, and joined trace prose."""
    fixed_text = "Preparing response"
    status_parts = ["Step ready", "Tool queued"]
    return {
        "text": fixed_text,
        "detail": "Retrying action"
        if event_data.get("retry")
        else "Waiting for action",
        "status_text": " · ".join(status_parts),
    }


def _harness_event_trace_line(provider_output: object) -> dict[str, object]:
    """Fixture violation: return fixed formatted prose from a nested trace-line payload."""
    return {"line": {"text": f"Calling {provider_output.name}"}}

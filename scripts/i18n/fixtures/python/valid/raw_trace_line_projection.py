"""Raw event, provider, and user values accepted in known trace-line projections."""

from __future__ import annotations


def _event_trace_line(
    event_data: dict[str, object],
    provider_output: object,
    user_input: str,
) -> dict[str, object]:
    """Return raw boundary values without adding developer-owned natural-language templates."""
    return {
        "text": event_data.get("text"),
        "detail": provider_output.detail,
        "status_text": user_input,
    }

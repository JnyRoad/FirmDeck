"""Small adapters for writing versioned product events at application boundaries."""

from __future__ import annotations

from typing import Any, Protocol

from app.contracts.errors import JsonValue
from app.contracts.events import EventVisibility, SystemEvent
from app.i18n.language_context import LanguageContext


class ProductEventRecorder(Protocol):
    """Describe the canonical event sink without coupling callers to persistence details."""

    def record_system_event(self, product_event: SystemEvent) -> Any:
        """Persist one validated product event and return the sink-specific receipt."""


def record_product_event(
    recorder: ProductEventRecorder,
    *,
    event_code: str,
    tenant_id: str,
    aggregate_type: str,
    aggregate_id: str,
    params: dict[str, JsonValue],
    language_context: LanguageContext,
    visibility: EventVisibility = EventVisibility.PUBLIC,
    request_id: str | None = None,
    trace_id: str | None = None,
    turn_id: str | None = None,
    client_turn_id: str | None = None,
) -> SystemEvent:
    """Create and persist one locale-independent event with an immutable replay snapshot."""
    # Workflow: the caller supplies only registry-shaped params; EventLog validates the envelope
    # and emits the bounded legacy projection after this function returns.
    event = SystemEvent(
        event_code=event_code,
        params=dict(params),
        request_id=request_id,
        trace_id=trace_id,
        tenant_id=tenant_id,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        turn_id=turn_id,
        client_turn_id=client_turn_id,
        visibility=visibility,
        language_context=language_context,
    )
    recorder.record_system_event(event)
    return event


__all__ = ["ProductEventRecorder", "record_product_event"]

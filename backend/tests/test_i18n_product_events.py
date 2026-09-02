"""Contract tests for localized, replay-safe feedback and memory job events."""

from __future__ import annotations

import pytest

from app.contracts.event_registry import EVENT_REGISTRY
from app.contracts.events import EventVisibility, SystemEvent
from app.i18n.language_context import LanguageContext, LocaleResolutionSource, SupportedLocale
from app.observability.product_events import record_product_event


def _language_context() -> LanguageContext:
    """Build one immutable locale snapshot used by every replay assertion."""
    return LanguageContext(
        version=1,
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
    )


@pytest.mark.parametrize(
    ("event_code", "legacy_event_type", "params"),
    [
        (
            "feedback.analysis.completed",
            "feedback_analysis_completed",
            {
                "feedback_id": "feedback-1",
                "message_id": "message-1",
                "rating": "down",
                "bucket": "missing_context",
                "status": "analyzed",
                "confidence": 0.75,
            },
        ),
        (
            "feedback.analysis.failed",
            "feedback_analysis_error",
            {"feedback_id": "feedback-1", "reason_code": "FEEDBACK_NOT_FOUND"},
        ),
        (
            "memory.capture.failed",
            "memory_error",
            {
                "reason_code": "MISSING_SESSION_OR_MODEL_CONFIG",
                "missing_session": True,
                "missing_model_config": False,
            },
        ),
        (
            "memory.capture.saved",
            "memory_saved",
            {"saved_count": 2, "async": True},
        ),
    ],
)
def test_job_event_is_registered_and_carries_only_safe_replay_context(
    event_code: str,
    legacy_event_type: str,
    params: dict[str, object],
) -> None:
    """Require stable params, visibility, locale snapshot, and correlation on each job event."""
    entry = EVENT_REGISTRY.require(event_code)
    assert entry.legacy_event_type == legacy_event_type
    assert entry.visibility is EventVisibility.PUBLIC
    assert entry.requires_language_context is True
    assert set(entry.params_schema) == set(params)

    class _Capture:
        """Capture the canonical event without touching a database or legacy observer."""

        def __init__(self) -> None:
            """Initialize the in-memory event sink."""
            self.events: list[SystemEvent] = []

        def record_system_event(self, event: SystemEvent) -> SystemEvent:
            """Retain the exact immutable event supplied by the product-event adapter."""
            self.events.append(event)
            return event

    capture = _Capture()
    context = _language_context()
    event = record_product_event(
        capture,
        event_code=event_code,
        tenant_id="tenant-demo",
        aggregate_type="chat_session",
        aggregate_id="session-demo",
        params=params,
        language_context=context,
        request_id="request-demo",
        trace_id="trace-demo",
        turn_id="turn-demo",
        client_turn_id="client-turn-demo",
    )

    assert event is capture.events[0]
    assert event.event_code == event_code
    assert event.params == params
    assert event.visibility is EventVisibility.PUBLIC
    assert event.language_context == context
    assert event.request_id == "request-demo"
    assert event.trace_id == "trace-demo"
    assert event.turn_id == "turn-demo"
    assert event.client_turn_id == "client-turn-demo"
    assert "message" not in event.params
    assert "text" not in event.params

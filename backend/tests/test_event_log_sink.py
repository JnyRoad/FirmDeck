from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.contracts.event_registry import (
    EventContractViolation,
    EventRegistry,
    EventRegistryEntry,
)
from app.contracts.events import EventVisibility, SystemEvent
from app.db.models import AgentEvent
from app.observability.event_log import EventLog


def _test_db() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_record_invokes_event_sink_with_traced_payload() -> None:
    received: list[tuple[str, dict]] = []

    def sink(event_type: str, payload: dict) -> None:
        received.append((event_type, dict(payload)))

    with _test_db() as db:
        events = EventLog(db, event_sink=sink)
        events.bind_turn("turn_1", "client_turn_1")
        events.record(
            "tenant_demo",
            "session_test",
            "step_result",
            {"reply": "ok"},
        )

    assert len(received) == 1
    event_type, payload = received[0]
    assert event_type == "step_result"
    assert payload["reply"] == "ok"
    assert payload["turn_id"] == "turn_1"
    assert payload["user_message_id"] == "turn_1"
    assert payload["client_turn_id"] == "client_turn_1"


@pytest.mark.parametrize(
    "event_type",
    [
        "harness_action_created",
        "harness_action_failed",
        "harness_action_repair_requested",
        "harness_action_sequence_accepted",
        "harness_completion_blocked",
        "harness_step_timeout",
        "harness_structured_result_adapted",
        "harness_tool_completed",
        "capability_search_completed",
        "capability_described",
        "harness_mcp_app_view",
    ],
)
def test_harness_trace_compatibility_events_are_exactly_allowlisted(
    event_type: str,
) -> None:
    """Keep every real Harness trace producer inside the reviewed legacy boundary."""
    with _test_db() as db:
        event = EventLog(db).record_legacy_event(
            "tenant_demo",
            "session_test",
            event_type,
            {"execution_engine": "harness_v2"},
        )

    assert event.event_type == event_type


def test_event_sink_none_does_not_raise() -> None:
    with _test_db() as db:
        events = EventLog(db)
        events.bind_turn("turn_1")
        event = events.record(
            "tenant_demo",
            "session_test",
            "step_result",
            {"reply": "ok"},
        )
    assert event.event_type == "step_result"
    assert event.payload_json["turn_id"] == "turn_1"


def test_event_sink_exception_does_not_propagate() -> None:
    def broken_sink(event_type: str, payload: dict) -> None:
        raise RuntimeError("sink exploded")

    with _test_db() as db:
        events = EventLog(db, event_sink=broken_sink)
        events.bind_turn("turn_1")
        event = events.record(
            "tenant_demo",
            "session_test",
            "step_result",
            {"reply": "ok"},
        )
    assert event.event_type == "step_result"


def test_record_system_event_persists_canonical_envelope_and_legacy_projection() -> None:
    """Store the validated envelope while preserving the registered legacy sink event name."""
    received: list[tuple[str, dict]] = []
    registry = EventRegistry()
    registry.register(
        EventRegistryEntry(
            event_code="agent.turn.retrying",
            message_key="chat.trace.reflectionRetry",
            params_schema={"attempt": "integer", "max_attempts": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="turn_retrying",
            requires_language_context=True,
        )
    )

    def sink(event_type: str, payload: dict) -> None:
        """Capture the public sink projection without mutating persisted event state."""
        received.append((event_type, dict(payload)))

    with _test_db() as db:
        events = EventLog(db, event_sink=sink, event_registry=registry)
        events.bind_turn("turn-bound", "client-bound")
        event = events.record_system_event(
            SystemEvent(
                event_code="agent.turn.retrying",
                params={"attempt": 2, "max_attempts": 3},
                request_id="req-1",
                trace_id="trace-1",
                tenant_id="tenant_demo",
                aggregate_type="chat_turn",
                aggregate_id="turn-bound",
                visibility=EventVisibility.PUBLIC,
                language_context={
                    "version": 1,
                    "ui_locale": "en-US",
                    "agent_reply_locale": "zh-CN",
                    "ui_locale_source": "explicit_request",
                    "agent_reply_locale_source": "session_snapshot",
                },
            )
        )

    assert event.event_type == "turn_retrying"
    assert event.payload_json["schema_version"] == 2
    assert event.payload_json["event_code"] == "agent.turn.retrying"
    assert event.payload_json["params"] == {"attempt": 2, "max_attempts": 3}
    assert event.payload_json["request_id"] == "req-1"
    assert event.payload_json["trace_id"] == "trace-1"
    assert event.payload_json["language_context"] == {
        "version": 1,
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "explicit_request",
        "agent_reply_locale_source": "session_snapshot",
    }
    assert "text" not in event.payload_json
    assert "status_text" not in event.payload_json
    assert event.payload_json["turn_id"] == "turn-bound"
    assert event.payload_json["client_turn_id"] == "client-bound"
    assert received == [("turn_retrying", event.payload_json)]


def test_record_system_event_does_not_emit_internal_event_to_product_sink() -> None:
    """Persist internal observability events while keeping them outside the product-facing sink."""
    received: list[tuple[str, dict]] = []
    registry = EventRegistry()
    registry.register(
        EventRegistryEntry(
            event_code="agent.trace.diagnostic",
            params_schema={"phase": "string"},
            visibility=EventVisibility.INTERNAL,
        )
    )

    def sink(event_type: str, payload: dict) -> None:
        """Capture accidental product emission; this test expects no calls or mutations."""
        received.append((event_type, dict(payload)))

    with _test_db() as db:
        event = EventLog(db, event_sink=sink, event_registry=registry).record_system_event(
            SystemEvent(
                event_code="agent.trace.diagnostic",
                params={"phase": "planner"},
                tenant_id="tenant_demo",
                aggregate_type="chat_session",
                aggregate_id="session_test",
                visibility=EventVisibility.INTERNAL,
            )
        )

    assert event.event_type == "agent.trace.diagnostic"
    assert event.payload_json["visibility"] == "internal"
    assert received == []


@pytest.mark.parametrize(
    ("event_code", "params"),
    [
        ("agent.turn.unknown", {"attempt": 1, "max_attempts": 3}),
        ("agent.turn.retrying", {"attempt": "one", "max_attempts": 3}),
    ],
)
def test_record_system_event_fails_closed_before_persistence_or_sink(
    event_code: str,
    params: dict,
) -> None:
    """Reject unknown or malformed product events without leaving a durable/public partial write."""
    received: list[tuple[str, dict]] = []
    registry = EventRegistry()
    registry.register(
        EventRegistryEntry(
            event_code="agent.turn.retrying",
            message_key="chat.trace.reflectionRetry",
            params_schema={"attempt": "integer", "max_attempts": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="turn_retrying",
            requires_language_context=True,
        )
    )

    def sink(event_type: str, payload: dict) -> None:
        """Capture any accidental sink emission from a rejected event."""
        received.append((event_type, dict(payload)))

    with _test_db() as db:
        events = EventLog(db, event_sink=sink, event_registry=registry)
        with pytest.raises(EventContractViolation):
            events.record_system_event(
                SystemEvent(
                    event_code=event_code,
                    params=params,
                    request_id="req-rejected",
                    trace_id="trace-rejected",
                    tenant_id="tenant_demo",
                    aggregate_type="chat_turn",
                    aggregate_id="turn-rejected",
                    visibility=EventVisibility.PUBLIC,
                    language_context={
                        "version": 1,
                        "ui_locale": "en-US",
                        "agent_reply_locale": "zh-CN",
                        "ui_locale_source": "explicit_request",
                        "agent_reply_locale_source": "session_snapshot",
                    },
                )
            )
        assert db.exec(select(AgentEvent)).all() == []

    assert received == []

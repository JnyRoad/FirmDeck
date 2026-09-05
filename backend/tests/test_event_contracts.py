"""Contract tests for versioned product events and their registry metadata."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.contracts.event_registry import (
    EventContractViolation,
    EventRegistry,
    EventRegistryEntry,
)
from app.contracts.events import EventVisibility, SystemEvent

_T007_EXPECTED_EVENTS = {
    "system.auth.rejected": ({"reason_code": "string"}, EventVisibility.INTERNAL, False),
    "system.control.conflict": ({"action": "string"}, EventVisibility.INTERNAL, False),
    "tenant.password.change.required": ({"tenant_id": "string"}, EventVisibility.INTERNAL, False),
    "tenant.lifecycle.suspended": (
        {"tenant_id": "string", "execution_kind": "string", "correlation_id": "string"},
        EventVisibility.INTERNAL,
        False,
    ),
    "tenant.lifecycle.check.failed": (
        {"tenant_id": "string", "execution_kind": "string", "correlation_id": "string"},
        EventVisibility.INTERNAL,
        False,
    ),
    "tenant.work.terminalized": (
        {"tenant_id": "string", "execution_kind": "string", "reason_code": "string"},
        EventVisibility.INTERNAL,
        False,
    ),
    "tenant.work.outcome.unknown": (
        {"tenant_id": "string", "execution_kind": "string", "correlation_id": "string"},
        EventVisibility.INTERNAL,
        False,
    ),
}

# knowledge-base-admin (data-model.md §8): draft publish/rebase/review notification events.
_KNOWLEDGE_ADMIN_EXPECTED_EVENTS = {
    "knowledge.version.published": (
        {
            "knowledge_base_id": "string",
            "version": "string",
            "stale_draft_count": "integer",
        },
        "events.knowledge.versionPublished",
    ),
    "knowledge.draft.rebased": (
        {
            "knowledge_base_id": "string",
            "draft_name": "string",
            "to_base_version": "string",
        },
        "events.knowledge.draftRebased",
    ),
    "knowledge.draft.reviewed": (
        {
            "knowledge_base_id": "string",
            "draft_name": "string",
            "staged": "integer",
            "pending": "integer",
        },
        "events.knowledge.draftReviewed",
    ),
}


def build_registry() -> EventRegistry:
    """Build an isolated registry with one turn event; this has no global side effects."""
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
    return registry


def build_event() -> SystemEvent:
    """Return one valid public turn event with stable trace and language snapshot fields."""
    return SystemEvent(
        event_code="agent.turn.retrying",
        occurred_at=datetime(2026, 8, 30, 12, 0, tzinfo=UTC),
        params={"attempt": 2, "max_attempts": 3},
        request_id="req-1",
        trace_id="trace-1",
        tenant_id="tenant-demo",
        aggregate_type="chat_turn",
        aggregate_id="turn-1",
        turn_id="turn-1",
        client_turn_id="client-1",
        visibility=EventVisibility.PUBLIC,
        language_context={
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "explicit_request",
            "agent_reply_locale_source": "session_snapshot",
        },
    )


def test_t007_system_tenant_events_are_registered_with_safe_internal_contracts() -> None:
    """Require lifecycle evidence to use registered safe params without a locale-bound projection."""
    from app.contracts.event_registry import EVENT_REGISTRY

    entries = EVENT_REGISTRY.entries()
    assert len(entries) == len({entry.event_code for entry in entries})
    for event_code, (params_schema, visibility, requires_language_context) in _T007_EXPECTED_EVENTS.items():
        entry = EVENT_REGISTRY.require(event_code)
        assert entry.params_schema == params_schema
        assert entry.visibility is visibility
        assert entry.requires_language_context is requires_language_context
        assert entry.message_key is None
        assert entry.raw_source_allowed is False
        assert entry.legacy_event_type is None


def test_knowledge_admin_events_are_registered_with_data_model_params() -> None:
    """Require each knowledge-base-admin notification event to be public and parameter-exact."""
    from app.contracts.event_registry import EVENT_REGISTRY

    entries = EVENT_REGISTRY.entries()
    assert len(entries) == len({entry.event_code for entry in entries})
    for event_code, (params_schema, message_key) in _KNOWLEDGE_ADMIN_EXPECTED_EVENTS.items():
        entry = EVENT_REGISTRY.require(event_code)
        assert entry.params_schema == params_schema
        assert entry.visibility is EventVisibility.PUBLIC
        assert entry.message_key == message_key
        assert entry.requires_language_context is True
        assert entry.raw_source_allowed is False
        assert entry.legacy_event_type is None


def test_system_event_serializes_only_stable_fields_and_language_snapshot() -> None:
    """Keep the canonical envelope versioned, locale-independent, and free of product prose."""
    payload = build_event().model_dump(mode="json")

    assert payload == {
        "schema_version": 2,
        "event_code": "agent.turn.retrying",
        "occurred_at": "2026-08-30T12:00:00Z",
        "params": {"attempt": 2, "max_attempts": 3},
        "request_id": "req-1",
        "trace_id": "trace-1",
        "tenant_id": "tenant-demo",
        "aggregate_type": "chat_turn",
        "aggregate_id": "turn-1",
        "turn_id": "turn-1",
        "client_turn_id": "client-1",
        "visibility": "public",
        "language_context": {
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "explicit_request",
            "agent_reply_locale_source": "session_snapshot",
        },
    }
    assert "message" not in payload


def test_event_registry_validates_params_visibility_and_language_context() -> None:
    """Reject malformed public events before arbitrary data reaches a product event boundary."""
    registry = build_registry()
    event = build_event()

    assert registry.validate(event) == event
    with pytest.raises(EventContractViolation, match="missing params"):
        registry.validate(event.model_copy(update={"params": {"attempt": 2}}))
    with pytest.raises(EventContractViolation, match="visibility"):
        registry.validate(event.model_copy(update={"visibility": EventVisibility.INTERNAL}))
    with pytest.raises(EventContractViolation, match="language_context"):
        registry.validate(event.model_copy(update={"language_context": None}))


def test_event_registry_rejects_duplicate_and_unknown_codes() -> None:
    """Keep event ownership unique and fail closed for unregistered producers."""
    registry = build_registry()
    with pytest.raises(EventContractViolation, match="already registered"):
        registry.register(registry.require("agent.turn.retrying"))
    with pytest.raises(EventContractViolation, match="unregistered event code"):
        registry.validate(build_event().model_copy(update={"event_code": "agent.turn.unknown"}))


def test_registry_exposes_bounded_legacy_projection_metadata() -> None:
    """Map canonical events to one explicit legacy event name without copying arbitrary payloads."""
    entry = build_registry().require("agent.turn.retrying")

    assert entry.legacy_event_type == "turn_retrying"
    assert entry.raw_source_allowed is False

"""T105 canonical registry contracts for team failure and skip events."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.contracts.event_registry import (
    EVENT_REGISTRY,
    EventContractViolation,
    EventRegistry,
    EventRegistryEntry,
)
from app.contracts.events import EventVisibility, SystemEvent
from app.contracts.i18n_contract import build_i18n_contract

TEAM_REASON_EVENT_CONTRACT = {
    "team.blackboard.entry.skipped": {
        "message_key": "teamDetailPage.event.blackboardEntrySkipped",
        "params": {"reason_code": "string"},
        "legacy_event_type": "blackboard_entry_skipped",
    },
    "team.task.bid.failed": {
        "message_key": "teamDetailPage.event.bidFailure",
        "params": {"reason_code": "string", "round": "integer"},
        "legacy_event_type": "bid_failed",
    },
    "team.task.review.failed": {
        "message_key": "teamDetailPage.event.reviewFailure",
        "params": {"reason_code": "string"},
        "legacy_event_type": "task_review_failed",
    },
    "team.task.escalated": {
        "message_key": "teamDetailPage.event.taskEscalation",
        "params": {"reason_code": "string"},
        "legacy_event_type": "task_escalated",
    },
}


def _event(code: str, params: dict[str, object]) -> SystemEvent:
    """Build a public event snapshot with the required source-turn language context."""
    return SystemEvent(
        event_code=code,
        occurred_at=datetime(2026, 8, 30, 12, 0, tzinfo=UTC),
        params=params,
        tenant_id="tenant-demo",
        aggregate_type="team_task",
        aggregate_id="task-1",
        visibility=EventVisibility.PUBLIC,
        language_context={
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "en-US",
            "ui_locale_source": "explicit_request",
            "agent_reply_locale_source": "session_snapshot",
        },
    )


def test_team_reason_events_are_canonical_and_exported_with_exact_metadata() -> None:
    """Require every team reason producer to have one public, localized registry entry."""
    contract = {
        item["event_code"]: item for item in build_i18n_contract()["events"]
    }
    for code, expected in TEAM_REASON_EVENT_CONTRACT.items():
        entry = EVENT_REGISTRY.get(code)
        assert entry is not None, f"missing registry entry: {code}"
        assert entry.message_key == expected["message_key"]
        assert entry.params_schema == expected["params"]
        assert entry.visibility is EventVisibility.PUBLIC
        assert entry.requires_language_context is True
        assert entry.raw_source_allowed is False
        assert entry.legacy_event_type == expected["legacy_event_type"]
        assert contract[code] == {
            "event_code": code,
            "message_key": expected["message_key"],
            "params": expected["params"],
            "visibility": "public",
            "raw_source_allowed": False,
            "requires_language_context": True,
            "legacy_event_type": expected["legacy_event_type"],
        }


@pytest.mark.parametrize(
    ("code", "params"),
    [
        ("team.blackboard.entry.skipped", {"reason_code": "duplicate_existing"}),
        ("team.task.bid.failed", {"reason_code": "execution_failed", "round": 2}),
        ("team.task.review.failed", {"reason_code": "repair_failed"}),
        ("team.task.escalated", {"reason_code": "execution_failed"}),
    ],
)
def test_team_reason_events_validate_exact_typed_params(
    code: str,
    params: dict[str, object],
) -> None:
    """Reject missing, extra, and wrongly typed reason parameters at the event boundary."""
    entry = EVENT_REGISTRY.get(code)
    assert entry is not None
    assert EVENT_REGISTRY.validate(_event(code, params)).params == params

    missing = dict(params)
    missing.pop("reason_code")
    with pytest.raises(EventContractViolation, match="missing params"):
        EVENT_REGISTRY.validate(_event(code, missing))

    extra = {**params, "raw_reason": "provider output"}
    with pytest.raises(EventContractViolation, match="unexpected params"):
        EVENT_REGISTRY.validate(_event(code, extra))

    if "round" in params:
        with pytest.raises(EventContractViolation, match="must be integer"):
            EVENT_REGISTRY.validate(_event(code, {**params, "round": "2"}))


def test_team_reason_registration_rejects_duplicate_and_conflicting_entries() -> None:
    """Keep team event ownership unique even when workers import registration repeatedly."""
    registry = EventRegistry()
    entry = EventRegistryEntry(
        event_code="team.task.bid.failed",
        message_key="teamDetailPage.event.bidFailure",
        params_schema={"reason_code": "string", "round": "integer"},
        visibility=EventVisibility.PUBLIC,
        legacy_event_type="bid_failed",
        requires_language_context=True,
    )
    registry.register(entry)
    with pytest.raises(EventContractViolation, match="already registered"):
        registry.register(entry)
    with pytest.raises(EventContractViolation, match="already registered"):
        registry.register(entry.model_copy(update={"message_key": "events.team.bidFailure"}))

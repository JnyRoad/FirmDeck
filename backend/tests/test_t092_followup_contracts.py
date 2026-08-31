from __future__ import annotations

from pathlib import Path

import pytest
from scripts.i18n.check_python import check_python_files
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.event_registry import EventContractViolation
from app.observability.event_log import EventLog

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
OWNED_PRODUCERS = tuple(
    REPOSITORY_ROOT / relative
    for relative in (
        "backend/app/core/agent_loop.py",
        "backend/app/core/harness_agent.py",
        "backend/app/core/harness_v2_engine.py",
        "backend/app/core/human_handoff_service.py",
        "backend/app/memory/jobs.py",
    )
)


def _test_db() -> Session:
    """Create an isolated database for event-boundary adapter tests."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_followup_owned_producers_have_no_unstructured_event_or_descriptor_findings() -> None:
    """Require all follow-up producers to use a typed event/error boundary."""
    entries = ERROR_REGISTRY.entries()
    diagnostics = check_python_files(
        OWNED_PRODUCERS,
        registered_error_codes={entry.code for entry in entries},
        registered_error_params={
            entry.code: set(entry.params_schema) for entry in entries
        },
    )
    assert diagnostics == []


def test_named_legacy_event_adapter_preserves_allowlist_and_fail_closed_behavior() -> None:
    """Expose an explicit migration adapter without weakening the legacy payload checks."""
    with _test_db() as db:
        events = EventLog(db)
        event = events.record_legacy_event(
            "tenant-demo",
            "session-demo",
            "step_result",
            {"reply": "保留原文"},
        )
        assert event.event_type == "step_result"
        with pytest.raises(EventContractViolation):
            events.record_legacy_event(
                "tenant-demo",
                "session-demo",
                "unknown-event",
                {},
            )

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.channels import _channel_http_error
from app.api.feedback import (
    _project_feedback_job_error,
    _project_feedback_job_result,
)
from app.api.teams import _project_team_payload
from app.contracts.event_registry import EventContractViolation
from app.core.harness_session_cleanup import stage_harness_session_execution_reset
from app.core.harness_turn_store import HarnessTurnStore
from app.db.models import (
    ChatSession,
    HarnessTurnRecord,
    ScheduledTask,
    ScheduledTaskRun,
)
from app.observability.event_log import (
    EventLog,
    get_legacy_event_usage,
    reset_legacy_event_usage,
)
from app.scheduled_tasks import service as scheduled_service
from app.session.session_schema import ChatTurnRequest
from app.teams.service import record_task_event


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_legacy_event_adapter_is_allowlisted_and_counted() -> None:
    """Allow one bounded legacy event and reject unknown or error-shaped payloads."""
    reset_legacy_event_usage()
    with Session(_engine()) as db:
        events = EventLog(db)
        events.record("tenant_demo", "session_demo", "step_result", {"reply": "保留原文"})
        with pytest.raises(EventContractViolation):
            events.record("tenant_demo", "session_demo", "unknown_event", {"reply": "不应写入"})
        with pytest.raises(EventContractViolation):
            events.record("tenant_demo", "session_demo", "step_result", {"error": "secret"})

    usage = get_legacy_event_usage()
    assert usage["hits"] == 1
    assert usage["boundary"] == "LEGACY-BE-TEXT-EVENT"
    assert usage["removal_conditions"]


def test_channel_http_error_binds_private_context_without_public_detail() -> None:
    """Keep channel/provider diagnostics on the exception object, not in its HTTP detail."""
    exception = _channel_http_error(502, "provider secret=/private/channel.sock")

    internal = getattr(exception, "_internal_error_context", None)
    assert internal is not None
    assert internal.raw_message == "provider secret=/private/channel.sock"
    assert exception.detail["code"] == "CHANNEL_UPSTREAM_ERROR"
    assert "provider secret" not in repr(exception.detail)
    assert "/private/channel.sock" not in repr(exception.detail)


def test_feedback_job_projection_is_safe_for_errors_and_preserves_success_content() -> None:
    """Strip nested failure prose while retaining explicitly successful business metadata."""
    result = _project_feedback_job_result(
        {
            "feedback_id": "feedback-1",
            "analysis_status": "analyzed",
            "summary": "原始分析摘要",
            "error": "provider secret",
        }
    )
    assert result["feedback_id"] == "feedback-1"
    assert result["summary"] == "原始分析摘要"
    assert "error" not in result

    error = _project_feedback_job_error(
        {"code": "FEEDBACK_NOT_FOUND", "params": {}, "message": "secret prose"}
    )
    assert error["code"] == "FEEDBACK_NOT_FOUND"
    assert "message" not in error
    assert "secret prose" not in repr(error)


def test_team_event_projection_and_persistence_fail_closed_on_nested_error() -> None:
    """Persist and expose only a canonical nested error while keeping raw success fields intact."""
    payload = {
        "from_status": "in_progress",
        "to_status": "review",
        "report": "保留的业务报告",
        "error": {"code": "UNKNOWN", "message": "provider secret"},
    }

    class _AddOnlyDB:
        """Capture a domain event without requiring unrelated relational fixtures."""

        def __init__(self) -> None:
            self.items: list[object] = []

        def add(self, item: object) -> None:
            self.items.append(item)

    event = record_task_event(
        _AddOnlyDB(),  # type: ignore[arg-type]
        team_id="team-1",
        task_id="task-1",
        actor_type="agent",
        actor_id="agent-1",
        event_type="task_failed",
        payload=payload,
    )
    assert event.payload_json["report"] == "保留的业务报告"
    assert event.payload_json["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    projected = _project_team_payload(payload)
    assert projected["report"] == "保留的业务报告"
    assert projected["error"]["code"] == "INTERNAL_ERROR"
    assert "provider secret" not in repr(projected)


def test_scheduled_outcome_needs_input_and_legacy_persisted_error_are_canonical() -> None:
    """Make every non-success scheduled outcome replay-safe and fail closed on legacy text."""
    outcome_error = scheduled_service._scheduled_outcome_error_json(
        {"status": "needs_input", "error": "请补充秘密信息"}
    )
    assert outcome_error is not None
    assert json.loads(outcome_error)["code"] == "INTERNAL_ERROR"
    assert "秘密信息" not in outcome_error

    run = ScheduledTaskRun(
        tenant_id="tenant-demo",
        scheduled_task_id="task-demo",
        agent_id="agent-demo",
        user_id="user-demo",
        scheduled_for=datetime(2026, 8, 30, tzinfo=UTC),
        error="legacy secret /private/scheduled.sqlite",
    )
    task = ScheduledTask(
        tenant_id="tenant-demo",
        agent_id="agent-demo",
        created_by_user_id="user-demo",
        title="日报",
        prompt="汇总",
        schedule_type="daily",
        schedule_json={"time": "09:00"},
    )
    projected = scheduled_service.scheduled_task_run_read(run, task)
    assert projected.error["code"] == "INTERNAL_ERROR"
    assert "legacy secret" not in repr(projected.error)


def test_session_reset_and_turn_cancel_persist_descriptor_only() -> None:
    """Persist reset/cancel outcomes as registry-shaped descriptors without natural-language errors."""
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-reset", tenant_id="tenant-demo")
        turn = HarnessTurnRecord(
            id="turn-reset",
            tenant_id="tenant-demo",
            session_id=session.id,
            client_turn_id="client-reset",
            request_digest="digest",
            lease_owner="lease",
            lease_expires_at=datetime(2026, 8, 30, tzinfo=UTC),
            status="started",
        )
        db.add_all([session, turn])
        db.commit()
        stage_harness_session_execution_reset(
            db,
            tenant_id="tenant-demo",
            session_id=session.id,
        )
        db.commit()
        db.refresh(turn)
        assert turn.error_json == {
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": None,
            "trace_id": None,
        }

        session2 = ChatSession(id="session-cancel", tenant_id="tenant-demo")
        db.add(session2)
        db.commit()
        store = HarnessTurnStore(db)
        request_record = store.claim(
            session2,
            ChatTurnRequest(
                tenant_id="tenant-demo",
                session_id=session2.id,
                client_turn_id="client-cancel",
                message="hello",
            ),
        ).record
        assert request_record is not None
        assert store.cancel(request_record) is True
        assert request_record.error_json == {
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": None,
            "trace_id": None,
        }

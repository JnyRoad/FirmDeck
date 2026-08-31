from datetime import UTC, datetime

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api import chat as chat_api
from app.db.models import (
    AgentEvent,
    ChatSession,
    HarnessTurnRecord,
    Message,
    ScheduledTask,
    ScheduledTaskRun,
)
from app.scheduled_tasks import service as scheduled_service
from app.scheduled_tasks.schema import ScheduledTaskDraftRead
from app.session.helpers import public_session
from app.session.session_schema import ChatTurnRequest, ChatTurnResponse


def _language_snapshot() -> dict[str, object]:
    """Return one mixed immutable locale snapshot that exposes accidental field coupling."""
    return {
        "version": 1,
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "explicit_request",
        "agent_reply_locale_source": "user_preference",
    }


def test_scheduled_task_shortcut_replays_same_turn_without_duplicate_side_effects(monkeypatch) -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    draft = ScheduledTaskDraftRead(
        should_create=True,
        tenant_id="tenant-demo",
        agent_id="agent-demo",
        title="每日提醒",
        prompt="每天提醒我",
        schedule_type="daily",
        schedule={"time": "09:00"},
    )
    monkeypatch.setattr(chat_api, "detect_scheduled_task_draft", lambda *args, **kwargs: draft)
    request = ChatTurnRequest(
        tenant_id="tenant-demo",
        session_id="session-demo",
        agent_id="agent-demo",
        user_id="user-demo",
        client_turn_id="scheduled-client-turn",
        interaction_mode="scheduled_task",
        message="每天九点提醒我",
    )

    with Session(engine) as db:
        chat_session = ChatSession(
            id="session-demo",
            tenant_id="tenant-demo",
            agent_id="agent-demo",
            user_id="user-demo",
        )
        db.add(chat_session)
        db.commit()

        first = chat_api._maybe_handle_scheduled_task_request(db, request, chat_session)
        second = chat_api._maybe_handle_scheduled_task_request(db, request, chat_session)

        assert first is not None and second is not None
        assert second[0].reply == first[0].reply
        assert len(db.exec(select(HarnessTurnRecord)).all()) == 1
        assert len(db.exec(select(Message)).all()) == 2
        assert len(
            db.exec(
                select(AgentEvent).where(AgentEvent.event_type == "assistant_message_created")
            ).all()
        ) == 1


def test_scheduled_task_shortcut_honors_pre_message_cancellation(monkeypatch) -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    detector_calls = 0

    def detect(*args, **kwargs):
        nonlocal detector_calls
        detector_calls += 1
        raise AssertionError("cancelled shortcut must not run the detector")

    monkeypatch.setattr(chat_api, "detect_scheduled_task_draft", detect)
    request = ChatTurnRequest(
        tenant_id="tenant-demo",
        session_id="session-cancelled-shortcut",
        agent_id="agent-demo",
        user_id="user-demo",
        client_turn_id="scheduled-cancelled-turn",
        interaction_mode="scheduled_task",
        message="每天九点提醒我",
    )

    with Session(engine) as db:
        chat_session = ChatSession(
            id=request.session_id,
            tenant_id=request.tenant_id,
            agent_id=request.agent_id,
            user_id=request.user_id,
        )
        db.add(chat_session)
        db.add(
            AgentEvent(
                tenant_id=request.tenant_id,
                session_id=request.session_id,
                event_type="stream_cancelled",
                payload_json={
                    "turn_id": request.client_turn_id,
                    "user_message_id": request.client_turn_id,
                    "client_turn_id": request.client_turn_id,
                },
            )
        )
        db.commit()

        assert chat_api._maybe_handle_scheduled_task_request(db, request, chat_session) is None
        assert detector_calls == 0
        assert db.exec(select(HarnessTurnRecord)).all() == []
        assert db.exec(select(Message)).all() == []


def test_scheduled_run_snapshots_task_language_context_when_first_enqueued() -> None:
    """Copy task locale provenance into the first durable run before creating its session."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    scheduled_for = datetime(2026, 8, 31, 1, 0, tzinfo=UTC)

    with Session(engine) as db:
        task = ScheduledTask(
            id="scheduled-language-first",
            tenant_id="tenant-demo",
            agent_id="agent-demo",
            created_by_user_id="user-demo",
            title="原始业务日报",
            prompt="只汇总《原始业务日报》",
            schedule_type="daily",
            schedule_json={"time": "09:00"},
            language_context_json=_language_snapshot(),
        )
        db.add(task)
        db.commit()

        run = scheduled_service._prepare_scheduled_task_run(
            db,
            task,
            scheduled_for,
            manual=True,
        )

        assert run.language_context_json == _language_snapshot()
        session = db.get(ChatSession, run.session_id)
        assert session is not None
        assert session.agent_reply_locale == "zh-CN"
        assert session.agent_reply_locale_source == "user_preference"
        assert session.session_kind == "scheduled_task"
        assert session.title == task.title
        assert task.title == "原始业务日报"
        assert task.prompt == "只汇总《原始业务日报》"


def test_scheduled_retry_executes_with_run_snapshot_not_mutated_task_preference(
    monkeypatch,
) -> None:
    """Reuse the persisted run snapshot during retry while leaving task input verbatim."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    captured_requests: list[ChatTurnRequest] = []

    class RecordingLoop:
        """Capture the scheduled ChatTurnRequest and return one complete raw reply."""

        def __init__(self, db: Session) -> None:
            self.db = db

        def handle_turn_stream(self, request: ChatTurnRequest):
            captured_requests.append(request)
            session = self.db.get(ChatSession, request.session_id)
            response = ChatTurnResponse(
                reply="原始执行结果",
                session_id=request.session_id,
                session_state=public_session(session),
            )
            yield {"event": "complete", "data": response.model_dump(mode="json")}

    monkeypatch.setattr(scheduled_service, "AgentLoop", RecordingLoop)
    monkeypatch.setattr(
        scheduled_service,
        "_ensure_scheduled_execution_agent",
        lambda _db, _task: object(),
    )
    monkeypatch.setattr(
        scheduled_service,
        "_scheduled_harness_outcome",
        lambda _db, _run, _result: {"status": "succeeded", "trace": {}},
    )

    with Session(engine) as db:
        task = ScheduledTask(
            id="scheduled-language-retry",
            tenant_id="tenant-demo",
            agent_id="agent-demo",
            created_by_user_id="user-demo",
            title="原始业务日报",
            prompt="只汇总《原始业务日报》",
            schedule_type="daily",
            schedule_json={"time": "09:00"},
            language_context_json={
                **_language_snapshot(),
                "ui_locale": "zh-CN",
                "agent_reply_locale": "en-US",
            },
        )
        session = ChatSession(
            id="scheduled-language-session",
            tenant_id=task.tenant_id,
            user_id=task.created_by_user_id,
            agent_id=task.agent_id,
        )
        run = ScheduledTaskRun(
            id="scheduled-language-run",
            tenant_id=task.tenant_id,
            scheduled_task_id=task.id,
            agent_id=task.agent_id,
            user_id=task.created_by_user_id,
            session_id=session.id,
            scheduled_for=datetime(2026, 8, 31, 1, 0, tzinfo=UTC),
            status="retrying",
            language_context_json=_language_snapshot(),
        )
        db.add(task)
        db.add(session)
        db.add(run)
        db.commit()

        retried = scheduled_service._prepare_scheduled_task_run(
            db,
            task,
            run.scheduled_for,
            manual=True,
        )
        scheduled_service._execute_prepared_scheduled_task(db, task, retried, manual=True)

        assert len(captured_requests) == 1
        request = captured_requests[0]
        assert request.language_context is not None
        assert request.language_context.model_dump(mode="json") == _language_snapshot()
        assert request.ui_locale == "en-US"
        assert request.agent_reply_locale == "zh-CN"
        assert "只汇总《原始业务日报》" in request.message
        assert retried.language_context_json == _language_snapshot()


def test_scheduled_execution_failure_projects_safe_run_and_stream_errors(
    monkeypatch,
) -> None:
    """Store canonical scheduled run errors and keep raw exception text out of persisted replay."""
    raw_cause = "scheduler crash secret=do-not-publish /private/scheduled.sqlite"

    class FailingLoop:
        """Raise one seeded runtime error before any completion event is produced."""

        def __init__(self, db: Session) -> None:
            self.db = db

        def handle_turn_stream(self, request: ChatTurnRequest):
            raise RuntimeError(raw_cause)
            yield request  # pragma: no cover

    monkeypatch.setattr(scheduled_service, "AgentLoop", FailingLoop)
    monkeypatch.setattr(
        scheduled_service,
        "_ensure_scheduled_execution_agent",
        lambda _db, _task: object(),
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as db:
        task = ScheduledTask(
            id="scheduled-safe-error",
            tenant_id="tenant-demo",
            agent_id="agent-demo",
            created_by_user_id="user-demo",
            title="原始业务日报",
            prompt="只汇总《原始业务日报》",
            schedule_type="daily",
            schedule_json={"time": "09:00"},
            timezone="UTC",
            status="active",
            language_context_json=_language_snapshot(),
        )
        session = ChatSession(
            id="scheduled-safe-session",
            tenant_id=task.tenant_id,
            user_id=task.created_by_user_id,
            agent_id=task.agent_id,
        )
        run = ScheduledTaskRun(
            id="scheduled-safe-run",
            tenant_id=task.tenant_id,
            scheduled_task_id=task.id,
            agent_id=task.agent_id,
            user_id=task.created_by_user_id,
            session_id=session.id,
            scheduled_for=datetime(2026, 8, 31, 1, 0, tzinfo=UTC),
            status="running",
            language_context_json=_language_snapshot(),
        )
        db.add(task)
        db.add(session)
        db.add(run)
        db.commit()

        scheduled_service._execute_prepared_scheduled_task(db, task, run, manual=True)

        db.refresh(run)
        assert run.status == "failed"
        assert raw_cause not in str(run.error)

        projected = scheduled_service.scheduled_task_run_read(run, task)
        assert projected.error == {
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": None,
            "trace_id": None,
        }

        events = db.exec(
            select(AgentEvent)
            .where(AgentEvent.session_id == session.id)
            .order_by(AgentEvent.created_at.asc())
        ).all()
        error_event = next(
            row for row in events if row.event_type == "scheduled_task_stream_event"
        )
        assert error_event.payload_json["data"]["error"] == projected.error
        assert error_event.payload_json["data"]["message"] == "INTERNAL_ERROR"
        assert raw_cause not in repr(error_event.payload_json)

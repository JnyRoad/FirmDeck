from __future__ import annotations

from datetime import timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.core.harness_recovery import RECOVERY_REPLY, recover_orphan_harness_runs
from app.db.models import (
    AgentEvent,
    ChatSession,
    HarnessAgentLoopRecord,
    HarnessRunRecord,
    HarnessSessionLeaseRecord,
    HarnessTaskFrameRecord,
    HarnessTurnRecord,
    Message,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _add_active_execution(
    db: Session,
    *,
    lease_expires_at,
    session_id: str = "session-orphan",
    language_context_json: dict | None = None,
) -> None:
    """Seed an active execution with an optional immutable source-turn snapshot."""
    session = ChatSession(
        id=session_id,
        tenant_id="tenant-demo",
        status="running",
        active_skill_id="after_sales_refund",
        active_step_id="confirm_refund_order",
        slots_json={"order_id": "ORDER-1"},
        agent_reply_locale=(
            language_context_json.get("agent_reply_locale")
            if isinstance(language_context_json, dict)
            else None
        ),
        agent_reply_locale_source=(
            language_context_json.get("agent_reply_locale_source")
            if isinstance(language_context_json, dict)
            else None
        ),
    )
    user_message = Message(
        id="msg-user",
        tenant_id=session.tenant_id,
        session_id=session.id,
        role="user",
        content="ORDER-1",
    )
    turn = HarnessTurnRecord(
        id="hturn-orphan",
        tenant_id=session.tenant_id,
        session_id=session.id,
        client_turn_id="client-turn-orphan",
        request_digest="sha256:orphan",
        lease_owner="turn-worker",
        lease_expires_at=lease_expires_at,
        user_message_id=user_message.id,
        language_context_json=language_context_json,
    )
    loop = HarnessAgentLoopRecord(
        id="hloop-orphan",
        tenant_id=session.tenant_id,
        session_id=session.id,
        loop_key="sop:after_sales_refund",
        kind="sop",
        skill_id="after_sales_refund",
        checkpoint_json={"cursor": "confirm_refund_order"},
    )
    frame = HarnessTaskFrameRecord(
        id="htask-orphan",
        tenant_id=session.tenant_id,
        session_id=session.id,
        source_turn_id=user_message.id,
        task_id="task-orphan",
        agent_loop_id=loop.id,
        kind="sop",
        decision="continue_sop",
        status="running",
        skill_id="after_sales_refund",
        step_id="confirm_refund_order",
        slots_json={"order_id": "ORDER-1"},
        attempt_no=3,
        lease_owner="frame-worker",
        lease_expires_at=lease_expires_at,
        language_context_json=language_context_json,
    )
    run = HarnessRunRecord(
        id="hrun-orphan",
        tenant_id=session.tenant_id,
        session_id=session.id,
        task_frame_record_id=frame.id,
        agent_loop_id=loop.id,
        task_id=frame.task_id,
        source_turn_id=frame.source_turn_id,
        attempt_no=frame.attempt_no,
        lease_owner=frame.lease_owner,
        lease_expires_at=lease_expires_at,
        language_context_json=language_context_json,
    )
    lease = HarnessSessionLeaseRecord(
        id="hslease-orphan",
        tenant_id=session.tenant_id,
        session_id=session.id,
        lease_owner="session-worker",
        lease_expires_at=lease_expires_at,
    )
    db.add_all([session, user_message, turn, loop, frame, run, lease])
    db.commit()


def test_startup_recovery_terminalizes_attempt_and_preserves_checkpoint() -> None:
    """Recover an orphan with a registered safe code and the legacy zh-CN reply locale."""
    engine = _engine()
    now = utc_now()
    with Session(engine) as db:
        _add_active_execution(db, lease_expires_at=now + timedelta(minutes=10))

        result = recover_orphan_harness_runs(db, startup=True, now=now)

        assert result.run_count == 1
        assert result.frame_count == 1
        assert result.turn_count == 1
        assert result.session_count == 1
        assert result.message_count == 1

        run = db.get(HarnessRunRecord, "hrun-orphan")
        frame = db.get(HarnessTaskFrameRecord, "htask-orphan")
        loop = db.get(HarnessAgentLoopRecord, "hloop-orphan")
        turn = db.get(HarnessTurnRecord, "hturn-orphan")
        session = db.get(ChatSession, "session-orphan")
        assert run is not None and run.status == "abandoned"
        assert run.result_json["error"]["code"] == "INTERNAL_ERROR"
        assert frame is not None and frame.status == "queued"
        assert frame.step_id == "confirm_refund_order"
        assert frame.slots_json == {"order_id": "ORDER-1"}
        assert loop is not None and loop.status == "suspended"
        assert loop.checkpoint_json == {"cursor": "confirm_refund_order"}
        assert turn is not None and turn.status == "failed"
        assert session is not None and session.status == "active"
        assert db.get(HarnessSessionLeaseRecord, "hslease-orphan") is None

        replies = list(
            db.exec(
                select(Message).where(
                    Message.session_id == "session-orphan",
                    Message.role == "assistant",
                )
            ).all()
        )
        assert [reply.content for reply in replies] == [RECOVERY_REPLY]
        events = list(
            db.exec(
                select(AgentEvent).where(AgentEvent.session_id == "session-orphan")
            ).all()
        )
        assert {event.event_type for event in events} == {
            "assistant_message_created",
            "harness_execution_recovered",
        }
        recovery_event = next(
            event
            for event in events
            if event.event_type == "harness_execution_recovered"
        )
        assert recovery_event.payload_json["schema_version"] == 2
        assert recovery_event.payload_json["event_code"] == "harness.execution.recovered"
        assert recovery_event.payload_json["params"] == {"error_code": "INTERNAL_ERROR"}
        assert "reply" not in recovery_event.payload_json

        repeated = recover_orphan_harness_runs(db, startup=True, now=now)
        assert repeated == repeated.__class__()
        replies = list(
            db.exec(
                select(Message).where(
                    Message.session_id == "session-orphan",
                    Message.role == "assistant",
                )
            ).all()
        )
        assert len(replies) == 1


def test_runtime_sweeper_ignores_live_execution() -> None:
    engine = _engine()
    now = utc_now()
    with Session(engine) as db:
        _add_active_execution(db, lease_expires_at=now + timedelta(minutes=10))

        result = recover_orphan_harness_runs(db, now=now)

        assert result == result.__class__()
        assert db.get(HarnessRunRecord, "hrun-orphan").status == "running"
        assert db.get(HarnessTurnRecord, "hturn-orphan").status == "started"
        assert db.get(ChatSession, "session-orphan").status == "running"


def test_runtime_sweeper_recovers_expired_execution() -> None:
    """Use the same registered recovery code for an expired execution sweep."""
    engine = _engine()
    now = utc_now()
    with Session(engine) as db:
        _add_active_execution(db, lease_expires_at=now - timedelta(seconds=1))

        result = recover_orphan_harness_runs(db, now=now)

        assert result.run_count == 1
        assert result.frame_count == 1
        assert result.turn_count == 1
        assert db.get(HarnessRunRecord, "hrun-orphan").status == "abandoned"
        assert db.get(HarnessTaskFrameRecord, "htask-orphan").status == "queued"
        turn = db.get(HarnessTurnRecord, "hturn-orphan")
        assert turn is not None and turn.error_json["code"] == "INTERNAL_ERROR"
        assert db.get(ChatSession, "session-orphan").status == "active"


def test_recovery_preserves_bound_snapshot_for_retry_and_raw_user_content() -> None:
    """Recovery must replay the source locale while keeping the original user message untouched."""
    context = LanguageContext(
        ui_locale="en-US",
        agent_reply_locale="zh-CN",
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    expected_snapshot = context.model_dump(mode="json")
    engine = _engine()
    now = utc_now()

    with Session(engine) as db:
        _add_active_execution(
            db,
            lease_expires_at=now - timedelta(seconds=1),
            language_context_json=expected_snapshot,
        )
        session = db.get(ChatSession, "session-orphan")
        assert session is not None
        # UI preference changes are independent of the already-bound reply locale.
        session.agent_reply_locale = "en-US"
        session.agent_reply_locale_source = "user_preference"
        db.add(session)
        db.commit()

        result = recover_orphan_harness_runs(db, now=now)

        assert result.message_count == 1
        run = db.get(HarnessRunRecord, "hrun-orphan")
        frame = db.get(HarnessTaskFrameRecord, "htask-orphan")
        turn = db.get(HarnessTurnRecord, "hturn-orphan")
        assert run is not None and run.language_context_json == expected_snapshot
        assert frame is not None and frame.language_context_json == expected_snapshot
        assert turn is not None and turn.language_context_json == expected_snapshot
        user_message = db.get(Message, "msg-user")
        assert user_message is not None
        assert user_message.content == "ORDER-1"
        recovery = db.exec(
            select(Message).where(
                Message.session_id == "session-orphan",
                Message.role == "assistant",
            )
        ).one()
        assert recovery.metadata_json["language_context"] == expected_snapshot
        assert recovery.content == RECOVERY_REPLY


def test_legacy_recovery_uses_controlled_default_snapshot() -> None:
    """Pre-migration recovery records use only the explicit zh-CN compatibility fallback."""
    engine = _engine()
    now = utc_now()
    with Session(engine) as db:
        _add_active_execution(db, lease_expires_at=now - timedelta(seconds=1))

        recover_orphan_harness_runs(db, now=now)

        recovery = db.exec(
            select(Message).where(
                Message.session_id == "session-orphan",
                Message.role == "assistant",
            )
        ).one()
        assert recovery.metadata_json["language_context"] == {
            "version": 1,
            "ui_locale": "zh-CN",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "legacy_default",
            "agent_reply_locale_source": "legacy_default",
        }


def test_recovery_reply_uses_persisted_agent_locale_not_ui_locale() -> None:
    """Render recovery prose from the durable reply locale without translating source content."""
    context = LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    engine = _engine()
    now = utc_now()

    with Session(engine) as db:
        _add_active_execution(
            db,
            lease_expires_at=now - timedelta(seconds=1),
            language_context_json=context.model_dump(mode="json"),
        )

        recover_orphan_harness_runs(db, now=now)

        recovery = db.exec(
            select(Message).where(
                Message.session_id == "session-orphan",
                Message.role == "assistant",
            )
        ).one()
        session = db.get(ChatSession, "session-orphan")

    assert recovery.content.startswith("This run ended because")
    assert "本轮执行" not in recovery.content
    assert session is not None
    assert session.summary == recovery.content[:120]

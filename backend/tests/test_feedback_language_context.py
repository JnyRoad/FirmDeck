"""Contract tests for feedback job locale snapshots and raw-content boundaries."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api import chat as chat_api
from app.api import feedback as feedback_api
from app.api.chat import session_read
from app.contracts.events import SystemEvent
from app.db.models import ChatSession, Message, MessageFeedback, Tenant, User
from app.feedback import jobs as feedback_jobs
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.public_api import jobs as public_jobs
from app.session.session_schema import MessageFeedbackRequest


def _context(ui_locale: str, agent_reply_locale: str) -> LanguageContext:
    """Build one immutable snapshot representing a persisted feedback turn."""
    return LanguageContext(
        version=1,
        ui_locale=SupportedLocale(ui_locale),
        agent_reply_locale=SupportedLocale(agent_reply_locale),
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
    )


@pytest.fixture()
def db_engine():
    """Create an isolated SQLite schema for endpoint and durable-job assertions."""
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    yield test_engine
    test_engine.dispose()


def _seed_feedback(
    db: Session,
    context: LanguageContext,
    *,
    business_text: str = "不要翻译的反馈原文 / raw feedback",
) -> tuple[User, ChatSession, Message, MessageFeedback]:
    """Seed a feedback row whose assistant message carries the authoritative turn snapshot."""
    tenant = Tenant(id="tenant-feedback", name="Feedback Tenant")
    user = User(
        id="user-feedback",
        tenant_id=tenant.id,
        username="feedback-user",
        display_name="Feedback User",
        password_hash="unused",
        ui_locale=context.ui_locale.value,
        agent_reply_locale=context.agent_reply_locale.value,
    )
    session = ChatSession(
        id="session-feedback",
        tenant_id=tenant.id,
        user_id=user.id,
        agent_reply_locale=context.agent_reply_locale.value,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT.value,
    )
    message = Message(
        id="message-feedback",
        tenant_id=tenant.id,
        session_id=session.id,
        role="assistant",
        content=business_text,
        metadata_json={
            "turn_id": "turn-feedback",
            "language_context": context.model_dump(mode="json"),
            "raw_business_text": business_text,
        },
    )
    feedback = MessageFeedback(
        id="feedback-row",
        tenant_id=tenant.id,
        session_id=session.id,
        message_id=message.id,
        user_id=user.id,
        rating="down",
        analysis_status="analyzed",
        analysis_bucket="skill_issue",
        analysis_summary=business_text,
    )
    db.add(tenant)
    db.add(user)
    db.add(session)
    db.add(message)
    db.add(feedback)
    db.commit()
    db.refresh(feedback)
    return user, session, message, feedback


@pytest.mark.parametrize(
    ("ui_locale", "agent_reply_locale"),
    [
        ("zh-CN", "zh-CN"),
        ("zh-CN", "en-US"),
        ("en-US", "zh-CN"),
        ("en-US", "en-US"),
    ],
)
def test_create_internal_job_persists_explicit_feedback_language_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    db_engine,
    ui_locale: str,
    agent_reply_locale: str,
) -> None:
    """Persist all four UI/reply combinations instead of silently re-resolving defaults."""
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    context = _context(ui_locale, agent_reply_locale)

    with Session(db_engine) as db:
        job = public_jobs.create_internal_job(
            db,
            tenant_id="tenant-feedback",
            kind="feedback.analyze",
            request_payload={"feedback_id": "feedback-row"},
            language_context=context,
        )

    assert job.language_context_json == context.model_dump(mode="json")


@pytest.mark.parametrize("entrypoint", ["chat", "feedback"])
@pytest.mark.parametrize(
    ("ui_locale", "agent_reply_locale"),
    [
        ("zh-CN", "zh-CN"),
        ("zh-CN", "en-US"),
        ("en-US", "zh-CN"),
        ("en-US", "en-US"),
    ],
)
def test_feedback_entrypoints_pass_authoritative_turn_snapshot_to_job(
    monkeypatch: pytest.MonkeyPatch,
    db_engine,
    entrypoint: str,
    ui_locale: str,
    agent_reply_locale: str,
) -> None:
    """Require chat and reanalyze entrypoints to pass the persisted turn context unchanged."""
    context = _context(ui_locale, agent_reply_locale)
    captured: dict[str, object] = {}

    def capture_enqueue(*args, **kwargs):
        """Capture the enqueue contract without starting an asynchronous worker."""
        captured.update(kwargs)
        return SimpleNamespace(id="job-feedback")

    target_module = chat_api if entrypoint == "chat" else feedback_api
    monkeypatch.setattr(target_module, "enqueue_feedback_analysis", capture_enqueue)

    with Session(db_engine) as db:
        user, session, message, feedback = _seed_feedback(db, context)
        if entrypoint == "chat":
            result = chat_api.upsert_message_feedback(
                message.id,
                MessageFeedbackRequest(tenant_id=session.tenant_id, rating="up"),
                current_user=user,
                db=db,
            )
        else:
            result = feedback_api.reanalyze_feedback(
                feedback.id,
                session.tenant_id,
                current_user=user,
                db=db,
            )

    assert result["job_id"] == "job-feedback" if entrypoint == "feedback" else result["id"] == feedback.id
    assert captured["language_context"] == context


def test_feedback_worker_replay_uses_job_snapshot_not_mutable_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep retries bound to the durable job snapshot even if a legacy payload is changed."""
    expected = _context("en-US", "zh-CN")
    conflicting = _context("zh-CN", "en-US")
    captured: list[SystemEvent] = []

    class _EventLog:
        """Capture worker events while preserving the EventLog boundary shape."""

        def __init__(self, _db) -> None:
            """Initialize the in-memory event sink."""

        def bind_turn(self, *_args, **_kwargs) -> None:
            """Accept worker correlation binding without a database."""

        def record_system_event(self, event: SystemEvent) -> SystemEvent:
            """Capture the canonical event emitted by the feedback worker."""
            captured.append(event)
            return event

    class _FeedbackService:
        """Return safe analysis metadata without loading business prose from a provider."""

        def __init__(self, _db) -> None:
            """Initialize the fake analysis service."""

        def analyze_feedback(self, _feedback_id: str):
            """Return bounded fields used by the registered product event."""
            return SimpleNamespace(
                id="feedback-row",
                tenant_id="tenant-feedback",
                session_id="session-feedback",
                message_id="message-feedback",
                rating="down",
                analysis_bucket="skill_issue",
                analysis_status="analyzed",
                analysis_confidence=0.5,
                analysis_summary="原始反馈不应进入事件参数",
            )

    monkeypatch.setattr(feedback_jobs, "EventLog", _EventLog)
    monkeypatch.setattr(feedback_jobs, "FeedbackAnalysisService", _FeedbackService)
    job = SimpleNamespace(
        tenant_id="tenant-feedback",
        request_json={
            "tenant_id": "tenant-feedback",
            "feedback_id": "feedback-row",
            "session_id": "session-feedback",
            "language_context": conflicting.model_dump(mode="json"),
        },
        language_context_json=expected.model_dump(mode="json"),
    )

    result = feedback_jobs.handle_feedback_analysis_job(None, job)

    assert result["feedback_id"] == "feedback-row"
    assert captured[0].language_context == expected
    assert "原始反馈不应进入事件参数" not in repr(captured[0].params)


def test_feedback_product_event_excludes_raw_business_content() -> None:
    """Keep feedback prose and provider output out of the registered event parameter schema."""
    captured: list[SystemEvent] = []

    class _EventLog:
        """Capture the product event without invoking persistence or legacy observers."""

        def record_system_event(self, event: SystemEvent) -> SystemEvent:
            """Retain the event for raw-content boundary assertions."""
            captured.append(event)
            return event

    row = SimpleNamespace(
        id="feedback-row",
        tenant_id="tenant-feedback",
        session_id="session-feedback",
        message_id="message-feedback",
        rating="down",
        analysis_bucket="skill_issue",
        analysis_status="analyzed",
        analysis_confidence=0.5,
        analysis_summary="用户输入原文、密钥=never-publish",
    )

    feedback_jobs._record_feedback_analysis_completed(
        _EventLog(),
        row,
        language_context=_context("zh-CN", "en-US"),
    )

    assert set(captured[0].params) == {
        "feedback_id",
        "message_id",
        "rating",
        "bucket",
        "status",
        "confidence",
    }
    assert "密钥=never-publish" not in repr(captured[0].params)


@pytest.mark.parametrize("agent_reply_locale", ["zh-CN", "en-US"])
def test_session_read_exposes_authoritative_agent_reply_locale_snapshot(
    agent_reply_locale: str,
) -> None:
    """Expose reply locale and source in list/detail payloads without exposing UI locale."""
    session = ChatSession(
        id="session-read",
        tenant_id="tenant-feedback",
        agent_reply_locale=agent_reply_locale,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT.value,
    )

    payload = session_read(session).model_dump()

    assert payload["agent_reply_locale"] == agent_reply_locale
    assert payload["agent_reply_locale_source"] == LocaleResolutionSource.SESSION_SNAPSHOT.value
    assert "ui_locale" not in payload

from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api import chat as chat_api
from app.api import scheduled_tasks as scheduled_api
from app.db.models import AgentProfile, ChatSession, Tenant, User
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.scheduled_tasks import service as scheduled_service
from app.scheduled_tasks.schema import ScheduledTaskDraftRead, ScheduledTaskDraftRequest
from app.session.helpers import public_session
from app.session.session_schema import ChatTurnRequest, ChatTurnResponse


def _english_context() -> LanguageContext:
    """Return an immutable mixed-locale snapshot that catches UI-locale coupling."""
    return LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def _test_engine():
    """Create one thread-safe in-memory database for a draft boundary test."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_identity(db: Session, *, with_session: bool) -> User:
    """Seed the minimal authenticated tenant, user, employee, and optional chat session."""
    user = User(
        id="user-locale",
        tenant_id="tenant-locale",
        username="locale-user",
        role="member",
        password_hash="x",
        ui_locale="zh-CN",
        agent_reply_locale="en-US",
    )
    db.add(Tenant(id="tenant-locale", name="Locale Tenant"))
    db.add(user)
    db.add(
        AgentProfile(
            id="agent-locale",
            tenant_id="tenant-locale",
            name="Locale Agent",
            status="active",
            is_overall=False,
            metadata_json={"owner_user_id": user.id},
        )
    )
    if with_session:
        db.add(
            ChatSession(
                id="session-locale",
                tenant_id="tenant-locale",
                user_id=user.id,
                agent_id="agent-locale",
            )
        )
    db.commit()
    db.refresh(user)
    return user


def _draft() -> ScheduledTaskDraftRead:
    """Return one valid English draft for locale propagation tests."""
    return ScheduledTaskDraftRead(
        should_create=True,
        tenant_id="tenant-locale",
        agent_id="agent-locale",
        title="Daily account review",
        prompt="Review account A1 every day",
        description="Tracks the requested account",
        schedule_type="daily",
        schedule={"time": "09:00"},
        confidence=0.9,
        reason="The user requested a daily review",
    )


@pytest.mark.parametrize(
    ("language_context", "expected_locale", "expected_title"),
    [
        (_english_context(), "en-US", "Daily account review"),
        (None, "zh-CN", "每日账户检查"),
    ],
)
def test_scheduled_draft_llm_prompt_uses_reply_locale_and_marks_raw_user_input(
    monkeypatch,
    language_context: LanguageContext | None,
    expected_locale: str,
    expected_title: str,
) -> None:
    """Constrain draft prose to reply locale while preserving the exact user message input."""
    engine = _test_engine()
    captured: dict[str, object] = {}
    raw_message = "每天检查《A1 原始账户》 RAW-123"

    class CapturingClient:
        """Capture the scheduled-draft model boundary and return locale-shaped output."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model initialization for the prompt contract test."""

        def generate_json(
            self,
            system_prompt: str,
            payload: dict[str, object],
        ) -> dict[str, object]:
            """Record the prompt payload and return the smallest valid localized draft."""
            captured["system_prompt"] = system_prompt
            captured["payload"] = payload
            is_english = payload["language_directive"]["new_prose_locale"] == "en-US"
            return {
                "should_create": True,
                "title": "Daily account review" if is_english else "每日账户检查",
                "prompt": "Review account A1 daily" if is_english else "每天检查 A1 账户",
                "description": "Tracks the account" if is_english else "跟踪该账户",
                "schedule_type": "daily",
                "schedule": {"time": "09:00"},
                "confidence": 0.9,
                "reason": "Daily cadence requested" if is_english else "用户要求每日执行",
            }

    monkeypatch.setattr(scheduled_service, "LLMClient", CapturingClient)
    monkeypatch.setattr(scheduled_service, "model_for_agent", lambda *args: object())
    with Session(engine) as db:
        _seed_identity(db, with_session=False)
        draft = scheduled_service.detect_scheduled_task_draft(
            db,
            "tenant-locale",
            "agent-locale",
            "user-locale",
            raw_message,
            timezone="America/Los_Angeles",
            language_context=language_context,
        )

    assert draft is not None
    assert draft.title == expected_title
    payload = captured["payload"]
    assert payload["language_directive"]["new_prose_locale"] == expected_locale
    assert payload["language_context"]["agent_reply_locale"] == expected_locale
    assert payload["user_message"] == raw_message
    assert payload["raw_source_markers"] == [
        {
            "json_pointer": "/user_message",
            "kind": "user_input",
            "policy": "preserve_verbatim",
        }
    ]
    assert "translate all" not in str(captured).lower()
    assert "翻译全部" not in str(captured)


def test_standalone_scheduled_draft_endpoint_resolves_explicit_language_context(
    monkeypatch,
) -> None:
    """Resolve standalone draft locale fields once and pass the immutable snapshot to detection."""
    engine = _test_engine()
    captured: dict[str, object] = {}

    def capture_detector(*_args: object, **kwargs: object) -> ScheduledTaskDraftRead:
        """Capture the endpoint-owned language snapshot without invoking a model."""
        captured.update(kwargs)
        return _draft()

    monkeypatch.setattr(scheduled_api, "detect_scheduled_task_draft", capture_detector)
    with Session(engine) as db:
        user = _seed_identity(db, with_session=False)
        response = scheduled_api.create_chat_scheduled_task_draft(
            ScheduledTaskDraftRequest(
                tenant_id="tenant-locale",
                agent_id="agent-locale",
                message="每天检查《A1 原始账户》",
                ui_locale="zh-CN",
                agent_reply_locale="en-US",
            ),
            user,
            db,
        )

    assert response.title == "Daily account review"
    context = captured["language_context"]
    assert isinstance(context, LanguageContext)
    assert context == _english_context()


def test_chat_sync_scheduled_draft_passes_resolved_turn_language_context(monkeypatch) -> None:
    """Carry the authenticated sync turn snapshot into scheduled-draft detection."""
    engine = _test_engine()
    captured_contexts: list[object] = []

    def capture_detector(
        *_args: object,
        **kwargs: object,
    ) -> ScheduledTaskDraftRead | None:
        """Exercise the pre-Harness and post-Harness sync detector calls in order."""
        captured_contexts.append(kwargs.get("language_context"))
        return None if len(captured_contexts) == 1 else _draft()

    class CompletingLoop:
        """Return one completed ordinary turn so the sync fallback detector runs."""

        def __init__(self, db: Session) -> None:
            """Retain the test session used to project a valid response state."""
            self.db = db

        def handle_turn(self, request: ChatTurnRequest) -> ChatTurnResponse:
            """Return a minimal response without invoking any external model."""
            session = self.db.get(ChatSession, request.session_id)
            return ChatTurnResponse(
                reply="Ordinary turn completed",
                session_id=request.session_id or "",
                ui_locale=request.ui_locale,
                agent_reply_locale=request.agent_reply_locale,
                language_context=request.language_context,
                session_state=public_session(session),
            )

    monkeypatch.setattr(chat_api, "detect_scheduled_task_draft", capture_detector)
    monkeypatch.setattr(chat_api, "AgentLoop", CompletingLoop)
    monkeypatch.setattr(
        chat_api,
        "_schedule_session_title_summary",
        lambda *args, **kwargs: None,
    )
    with Session(engine) as db:
        user = _seed_identity(db, with_session=True)
        response = chat_api.chat_turn(
            ChatTurnRequest(
                tenant_id="tenant-locale",
                session_id="session-locale",
                agent_id="agent-locale",
                client_turn_id="sync-locale-turn",
                message="每天检查《A1 原始账户》",
                interaction_mode="scheduled_task",
                ui_locale="zh-CN",
                agent_reply_locale="en-US",
            ),
            user,
            db,
        )

    assert response.agent_reply_locale is SupportedLocale.EN_US
    assert captured_contexts == [_english_context(), _english_context()]


def test_chat_stream_scheduled_draft_passes_resolved_turn_language_context(monkeypatch) -> None:
    """Carry the authenticated stream turn snapshot into background draft detection."""
    engine = _test_engine()
    captured_contexts: list[object] = []
    detected = threading.Event()

    def capture_detector(
        *_args: object,
        **kwargs: object,
    ) -> ScheduledTaskDraftRead | None:
        """Exercise the pre-Harness and post-Harness stream detector calls in order."""
        captured_contexts.append(kwargs.get("language_context"))
        if len(captured_contexts) == 2:
            detected.set()
            return _draft()
        return None

    class CompletingStreamLoop:
        """Yield one ordinary terminal response so the stream fallback detector runs."""

        def __init__(self, _db: Session) -> None:
            """Avoid external runtime construction for the stream boundary test."""

        def handle_turn_stream(self, request: ChatTurnRequest):
            """Yield the minimum complete event consumed by the stream worker."""
            yield {
                "event": "complete",
                "data": {
                    "reply": "Ordinary stream completed",
                    "sessionId": request.session_id,
                },
            }

    class ImmediateThread:
        """Run the stream worker synchronously so the locale assertion is deterministic."""

        def __init__(self, *, target: object, daemon: bool = False) -> None:
            """Store the worker target while accepting the production daemon argument."""
            self._target = target

        def start(self) -> None:
            """Execute the captured worker target immediately."""
            self._target()

    monkeypatch.setattr(chat_api, "detect_scheduled_task_draft", capture_detector)
    monkeypatch.setattr(chat_api, "AgentLoop", CompletingStreamLoop)
    monkeypatch.setattr(
        chat_api,
        "_schedule_session_title_summary",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(chat_api, "engine", engine)
    monkeypatch.setattr(
        chat_api,
        "threading",
        SimpleNamespace(Event=threading.Event, Thread=ImmediateThread),
    )
    with Session(engine) as db:
        user = _seed_identity(db, with_session=True)
        response = chat_api.chat_stream(
            ChatTurnRequest(
                tenant_id="tenant-locale",
                session_id="session-locale",
                agent_id="agent-locale",
                client_turn_id="stream-locale-turn",
                message="每天检查《A1 原始账户》",
                interaction_mode="scheduled_task",
                ui_locale="zh-CN",
                agent_reply_locale="en-US",
            ),
            user,
            db,
        )

    assert response.media_type == "text/event-stream"
    assert detected.is_set()
    assert captured_contexts == [_english_context(), _english_context()]

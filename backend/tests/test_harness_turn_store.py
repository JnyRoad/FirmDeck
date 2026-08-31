from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.harness_turn_store import (
    HarnessTurnConflict,
    HarnessTurnStore,
    _request_digest,
)
from app.core.harness_v2_engine import _with_recoverable_first_session
from app.db.models import ChatSession
from app.i18n.language_context import SupportedLocale
from app.session.session_schema import (
    ChatTurnRequest,
    ChatTurnResponse,
    SessionPublic,
)


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _request(message: str = "hello") -> ChatTurnRequest:
    return ChatTurnRequest(
        tenant_id="tenant-demo",
        session_id="session-1",
        client_turn_id="turn-client-1",
        message=message,
    )


def test_harness_turn_receipt_replays_completed_response() -> None:
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)

        claim = store.claim(session, _request())
        assert claim.record is not None
        assert claim.replay is None
        store.bind_user_message(claim.record, "message-1")
        expected = ChatTurnResponse(
            reply="done",
            session_id=session.id,
            session_state=SessionPublic(
                session_id=session.id,
                tenant_id=session.tenant_id,
            ),
        )
        store.complete(claim.record, expected)

        replay = store.claim(session, _request())
        assert replay.replay == expected


def test_harness_turn_receipt_blocks_in_progress_and_mismatched_reuse() -> None:
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)
        store.claim(session, _request())

        try:
            store.claim(session, _request())
        except HarnessTurnConflict as exc:
            assert "不会重复执行" in str(exc)
        else:  # pragma: no cover - defensive assertion
            raise AssertionError("duplicate in-progress turn was not blocked")

        try:
            store.claim(session, _request("different"))
        except HarnessTurnConflict as exc:
            assert "不能用于不同" in str(exc)
        else:  # pragma: no cover - defensive assertion
            raise AssertionError("mismatched client_turn_id reuse was not blocked")


def test_harness_turn_terminal_receipt_allows_only_cancel_or_completion() -> None:
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)

        cancelled = store.claim(session, _request()).record
        assert cancelled is not None
        assert store.cancel(cancelled) is True
        assert cancelled.status == "cancelled"
        try:
            store.begin_completion(cancelled)
        except HarnessTurnConflict:
            pass
        else:  # pragma: no cover - defensive assertion
            raise AssertionError("cancelled receipt allowed normal completion")

        completing_request = _request().model_copy(
            update={"client_turn_id": "turn-client-2"}
        )
        completing = store.claim(session, completing_request).record
        assert completing is not None
        store.begin_completion(completing)
        assert completing.status == "finalizing"
        assert store.cancel(completing) is False
        response = ChatTurnResponse(
            reply="done",
            session_id=session.id,
            session_state=SessionPublic(
                session_id=session.id,
                tenant_id=session.tenant_id,
            ),
        )
        store.complete(completing, response)
        assert completing.status == "completed"


def test_first_turn_retry_without_returned_session_id_replays_original() -> None:
    engine = _engine()
    original_request = ChatTurnRequest(
        tenant_id="tenant-demo",
        user_id="user-1",
        client_turn_id="turn-client-first",
        message="first message",
    )
    recovered_request = _with_recoverable_first_session(original_request)
    assert recovered_request.session_id

    with Session(engine) as db:
        session = ChatSession(
            id=str(recovered_request.session_id),
            tenant_id=original_request.tenant_id,
            user_id=original_request.user_id,
        )
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)
        first = store.claim(session, original_request)
        expected = ChatTurnResponse(
            reply="done",
            session_id=session.id,
            session_state=SessionPublic(
                session_id=session.id,
                tenant_id=session.tenant_id,
                user_id=session.user_id,
            ),
        )
        store.complete(first.record, expected)

        retry_request = _with_recoverable_first_session(
            original_request.model_copy()
        )
        retry_session = db.get(ChatSession, retry_request.session_id)
        assert retry_session is not None
        retry = store.claim(retry_session, original_request.model_copy())

        assert retry.replay == expected
        assert retry.replay.session_id == recovered_request.session_id


def test_turn_claim_binds_independent_locales_and_replays_the_snapshot() -> None:
    """Resolve locale choices before claiming a receipt and replay the exact completed snapshot."""
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        request = _request().model_copy(
            update={"ui_locale": "en-US", "agent_reply_locale": "zh-CN"}
        )
        store = HarnessTurnStore(db)

        claim = store.claim(session, request)

        assert claim.record is not None
        assert request.ui_locale is SupportedLocale.EN_US
        assert request.agent_reply_locale is SupportedLocale.ZH_CN
        assert request.language_context is not None
        assert request.language_context.ui_locale is SupportedLocale.EN_US
        assert request.language_context.agent_reply_locale is SupportedLocale.ZH_CN
        assert session.agent_reply_locale == "zh-CN"
        assert session.agent_reply_locale_source == "explicit_request"
        assert claim.record.language_context_json == request.language_context.model_dump(mode="json")

        expected = ChatTurnResponse(
            reply="done",
            session_id=session.id,
            ui_locale=SupportedLocale.EN_US,
            agent_reply_locale=SupportedLocale.ZH_CN,
            language_context=request.language_context,
            session_state=SessionPublic(
                session_id=session.id,
                tenant_id=session.tenant_id,
            ),
        )
        store.complete(claim.record, expected)

        replay = store.claim(session, request)

        assert replay.replay == expected
        assert replay.replay is not None
        assert replay.replay.language_context == request.language_context


def test_same_client_turn_id_with_different_locale_is_rejected_and_digest_changes() -> None:
    """Treat locale changes as a distinct request and reject them under one client turn ID."""
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)
        first = _request().model_copy(
            update={"ui_locale": "en-US", "agent_reply_locale": "zh-CN"}
        )
        second = _request().model_copy(
            update={"ui_locale": "zh-CN", "agent_reply_locale": "en-US"}
        )

        store.claim(session, first)

        assert _request_digest(first) != _request_digest(second)
        try:
            store.claim(session, second)
        except HarnessTurnConflict as exc:
            assert "不能用于不同" in str(exc)
        else:  # pragma: no cover - defensive assertion
            raise AssertionError("locale mutation reused the existing client turn")


def test_completed_replay_prefers_durable_snapshot_over_new_session_preference() -> None:
    """Replay the original turn snapshot even after a later session preference change."""
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()
        store = HarnessTurnStore(db)
        first = _request().model_copy(
            update={"ui_locale": "en-US", "agent_reply_locale": "zh-CN"}
        )
        claim = store.claim(session, first)
        assert claim.record is not None
        expected = ChatTurnResponse(
            reply="done",
            session_id=session.id,
            session_state=SessionPublic(
                session_id=session.id,
                tenant_id=session.tenant_id,
            ),
        )
        store.complete(claim.record, expected)

        session.agent_reply_locale = SupportedLocale.EN_US.value
        session.agent_reply_locale_source = "explicit_request"
        db.add(session)
        db.commit()

        retry = _request().model_copy(update={"client_turn_id": first.client_turn_id})
        replay = store.claim(session, retry)

        assert replay.replay == expected
        assert replay.replay is not None
        assert replay.replay.ui_locale is SupportedLocale.EN_US
        assert replay.replay.agent_reply_locale is SupportedLocale.ZH_CN


def test_legacy_turn_request_remains_usable_without_explicit_locale_fields() -> None:
    """Keep old callers valid while assigning the deterministic compatibility language snapshot."""
    engine = _engine()
    with Session(engine) as db:
        session = ChatSession(id="session-1", tenant_id="tenant-demo")
        db.add(session)
        db.commit()

        claim = HarnessTurnStore(db).claim(session, _request())

        assert claim.record is not None
        assert claim.record.language_context_json == {
            "version": 1,
            "ui_locale": "zh-CN",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "legacy_default",
            "agent_reply_locale_source": "legacy_default",
        }

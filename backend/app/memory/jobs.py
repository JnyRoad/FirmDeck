from __future__ import annotations

import logging
from typing import Any

from sqlmodel import Session, select

from app.async_jobs import AsyncJob, enqueue_async_job
from app.db import engine
from app.db.models import AgentEvent, ChatSession, Message, ModelConfig
from app.i18n.language_context import LanguageContext, resolve_compatible_language_context
from app.memory.service import MemoryService, memory_read
from app.observability import EventLog
from app.observability.product_events import record_product_event
from app.observability.spans import bind_span_sink
from app.session.session_schema import ChatTurnRequest, StepAgentResult
from app.tools.tool_schema import ToolResult

logger = logging.getLogger(__name__)


def enqueue_memory_capture(
    request: ChatTurnRequest,
    session_id: str,
    step_result: StepAgentResult,
    tool_result: ToolResult | None,
    model_config_id: str,
) -> AsyncJob:
    payload = {
        "request": request.model_dump(mode="json"),
        "language_context": (
            request.language_context.model_dump(mode="json")
            if request.language_context is not None
            else None
        ),
        "session_id": session_id,
        "step_result": step_result.model_dump(mode="json"),
        "tool_result": tool_result.model_dump(mode="json") if tool_result else None,
        "model_config_id": model_config_id,
    }
    return enqueue_async_job(
        "memory.capture_turn",
        run_memory_capture_job,
        payload,
        metadata={
            "tenant_id": request.tenant_id,
            "session_id": session_id,
            "user_id": request.user_id,
        },
    )


def run_memory_capture_job(payload: dict[str, Any]) -> None:
    """Rebuild one durable turn and capture memory under its immutable locale snapshot."""
    request = ChatTurnRequest.model_validate(payload["request"])
    session_id = str(payload["session_id"])
    model_config_id = str(payload["model_config_id"])
    step_result = StepAgentResult.model_validate(payload["step_result"])
    tool_result = ToolResult.model_validate(payload["tool_result"]) if payload.get("tool_result") else None
    language_context = _language_context_from_payload(payload, request)
    with Session(engine) as db:
        events = EventLog(db)
        events.bind_turn(
            "",
            request.client_turn_id,
            language_context=language_context,
        )
        chat_session = db.get(ChatSession, session_id)
        model_config = db.get(ModelConfig, model_config_id)
        if not chat_session or not model_config:
            _record_memory_capture_failed(
                events,
                tenant_id=request.tenant_id,
                session_id=session_id,
                reason_code="MISSING_SESSION_OR_MODEL_CONFIG",
                missing_session=not bool(chat_session),
                missing_model_config=not bool(model_config),
                language_context=language_context,
                client_turn_id=request.client_turn_id,
            )
            db.commit()
            return

        user_events = db.exec(
            select(AgentEvent)
            .where(
                AgentEvent.tenant_id == request.tenant_id,
                AgentEvent.session_id == session_id,
                AgentEvent.event_type == "user_message_received",
            )
            .order_by(AgentEvent.created_at.desc(), AgentEvent.id.desc())
        ).all()
        latest_user_event = next(
            (
                event
                for event in user_events
                if request.client_turn_id
                and str((event.payload_json or {}).get("client_turn_id") or "")
                == request.client_turn_id
            ),
            user_events[0] if user_events else None,
        )
        latest_user_payload = dict(latest_user_event.payload_json or {}) if latest_user_event else {}
        turn_id = str(
            latest_user_payload.get("turn_id")
            or latest_user_payload.get("user_message_id")
            or latest_user_payload.get("message_id")
            or ""
        )
        conversation_messages = _conversation_messages_for_turn(
            db, request.tenant_id, session_id, turn_id
        )
        if not conversation_messages:
            _record_memory_capture_failed(
                events,
                tenant_id=request.tenant_id,
                session_id=session_id,
                reason_code="MISSING_CONVERSATION_HISTORY",
                missing_session=False,
                missing_model_config=False,
                language_context=language_context,
                turn_id=turn_id,
                client_turn_id=request.client_turn_id,
            )
            db.commit()
            return

        def persist_span(event_type: str, event_payload: dict[str, Any]) -> None:
            traced_payload = dict(event_payload)
            if turn_id:
                traced_payload.setdefault("turn_id", turn_id)
                traced_payload.setdefault("user_message_id", turn_id)
            if request.client_turn_id:
                traced_payload.setdefault("client_turn_id", request.client_turn_id)
            events.record_legacy_event(
                request.tenant_id,
                session_id,
                event_type,
                traced_payload,
            )
            db.commit()

        try:
            with bind_span_sink(persist_span):
                rows = MemoryService(db).capture_turn(
                    request,
                    chat_session,
                    step_result,
                    tool_result,
                    model_config,
                    conversation_messages,
                    language_context=language_context,
                )
        except Exception:
            logger.exception(
                "memory capture failed tenant_id=%s session_id=%s turn_id=%s",
                request.tenant_id,
                session_id,
                turn_id,
            )
            _record_memory_capture_failed(
                events,
                tenant_id=request.tenant_id,
                session_id=session_id,
                reason_code="MEMORY_CAPTURE_FAILED",
                missing_session=False,
                missing_model_config=False,
                language_context=language_context,
                turn_id=turn_id,
                client_turn_id=request.client_turn_id,
            )
            db.commit()
            return

        saved = [memory_read(row) for row in rows]
        if saved:
            _record_memory_capture_saved(
                events,
                tenant_id=request.tenant_id,
                session_id=session_id,
                saved_count=len(saved),
                language_context=language_context,
                turn_id=turn_id,
                client_turn_id=request.client_turn_id,
            )
        db.commit()


def _language_context_from_payload(
    payload: dict[str, Any],
    request: ChatTurnRequest,
) -> LanguageContext:
    """Resolve the persisted turn locale before any memory worker event is replayed."""
    return resolve_compatible_language_context(
        snapshot=payload.get("language_context") or request.language_context,
        legacy_ui_locale=request.ui_locale,
        legacy_agent_reply_locale=request.agent_reply_locale,
    )


def _record_memory_capture_failed(
    events: EventLog,
    *,
    tenant_id: str,
    session_id: str,
    reason_code: str,
    missing_session: bool,
    missing_model_config: bool,
    language_context: LanguageContext,
    turn_id: str | None = None,
    client_turn_id: str | None = None,
) -> None:
    """Record bounded failure metadata while keeping raw worker causes in private logs only."""
    record_product_event(
        events,
        event_code="memory.capture.failed",
        tenant_id=tenant_id,
        aggregate_type="chat_session",
        aggregate_id=session_id,
        params={
            "reason_code": reason_code,
            "missing_session": missing_session,
            "missing_model_config": missing_model_config,
        },
        language_context=language_context,
        turn_id=turn_id,
        client_turn_id=client_turn_id,
    )


def _record_memory_capture_saved(
    events: EventLog,
    *,
    tenant_id: str,
    session_id: str,
    saved_count: int,
    language_context: LanguageContext,
    turn_id: str | None = None,
    client_turn_id: str | None = None,
) -> None:
    """Record only the count of saved memories so business content remains raw and untranslated."""
    record_product_event(
        events,
        event_code="memory.capture.saved",
        tenant_id=tenant_id,
        aggregate_type="chat_session",
        aggregate_id=session_id,
        params={"saved_count": saved_count, "async": True},
        language_context=language_context,
        turn_id=turn_id,
        client_turn_id=client_turn_id,
    )


def _conversation_messages_for_turn(
    db: Session,
    tenant_id: str,
    session_id: str,
    turn_id: str,
) -> list[dict[str, str]]:
    if not turn_id:
        return []
    rows = list(
        db.exec(
            select(Message)
            .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
            .order_by(Message.created_at.desc())
            .limit(100)
        ).all()
    )
    rows.reverse()
    target_index = next(
        (
            index
            for index in range(len(rows) - 1, -1, -1)
            if rows[index].role == "assistant"
            and str(
                (rows[index].metadata_json or {}).get("turn_id")
                or (rows[index].metadata_json or {}).get("user_message_id")
                or ""
            )
            == turn_id
        ),
        None,
    )
    if target_index is None:
        return []
    return [
        {"role": row.role, "content": row.content}
        for row in rows[: target_index + 1]
        if row.role in {"user", "assistant"} and row.content.strip()
    ][-12:]

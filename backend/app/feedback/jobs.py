from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from app.db import engine
from app.db.models import AgentEvent, APIJob, ChatSession, HarnessTurnRecord, Message, User
from app.feedback.service import FeedbackAnalysisService
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_compatible_language_context,
    resolve_language_context,
)
from app.observability import EventLog
from app.observability.product_events import record_product_event
from app.public_api.jobs import create_internal_job, register_job_handler


def enqueue_feedback_analysis(
    tenant_id: str,
    feedback_id: str,
    session_id: str | None = None,
    *,
    language_context: LanguageContext | None = None,
) -> APIJob:
    """Persist a feedback-analysis job with an immutable source-turn locale snapshot."""
    # Workflow: callers resolve the authoritative session/turn context first; legacy callers
    # omit it and remain on the documented compatibility default until migrated.
    request_payload: dict[str, Any] = {
        "tenant_id": tenant_id,
        "feedback_id": feedback_id,
        "session_id": session_id,
    }
    if language_context is not None:
        request_payload["language_context"] = language_context.model_dump(mode="json")
    with Session(engine) as db:
        return create_internal_job(
            db,
            tenant_id=tenant_id,
            kind="feedback.analyze",
            request_payload=request_payload,
            language_context=language_context,
        )


def resolve_feedback_language_context(
    db: Session,
    *,
    tenant_id: str,
    session_id: str,
    message_id: str,
) -> LanguageContext:
    """Resolve feedback locale from the exact turn snapshot before mutable preferences."""
    # Workflow: inspect the linked assistant message, harness receipt, and exact session events
    # in descending authority order; never inspect or transform message content itself.
    chat_session = db.get(ChatSession, session_id)
    if chat_session is None or chat_session.tenant_id != tenant_id:
        return resolve_compatible_language_context(
            snapshot=None,
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )

    message = db.get(Message, message_id)
    metadata = message.metadata_json or {} if message and message.tenant_id == tenant_id else {}
    context = _validated_language_context(metadata.get("language_context"))
    if context is not None:
        return context

    turn_ids = {
        str(metadata.get(key) or "").strip()
        for key in ("turn_id", "user_message_id", "client_turn_id")
        if str(metadata.get(key) or "").strip()
    }
    turn_ids.add(message_id)

    receipts = db.exec(
        select(HarnessTurnRecord)
        .where(
            HarnessTurnRecord.tenant_id == tenant_id,
            HarnessTurnRecord.session_id == session_id,
        )
        .order_by(HarnessTurnRecord.updated_at.desc())
    ).all()
    for receipt in receipts:
        if not turn_ids.intersection({receipt.id, receipt.client_turn_id, receipt.user_message_id or ""}):
            continue
        context = _validated_language_context(receipt.language_context_json)
        if context is not None:
            return context

    events = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.session_id == session_id,
        )
        .order_by(AgentEvent.created_at.desc(), AgentEvent.id.desc())
    ).all()
    for event in events:
        payload = event.payload_json or {}
        event_turn_ids = {
            str(payload.get(key) or "").strip()
            for key in ("turn_id", "user_message_id", "message_id", "client_turn_id")
            if str(payload.get(key) or "").strip()
        }
        if not turn_ids.intersection(event_turn_ids):
            continue
        context = _validated_language_context(payload.get("language_context"))
        if context is not None:
            return context

    user = db.get(User, chat_session.user_id) if chat_session.user_id else None
    return resolve_language_context(
        LanguageContextInputs(
            session_agent_reply_locale=chat_session.agent_reply_locale,
            user_ui_locale=user.ui_locale if user else None,
            user_agent_reply_locale=user.agent_reply_locale if user else None,
        )
    )


def _validated_language_context(value: Any) -> LanguageContext | None:
    """Validate one persisted locale payload without leaking malformed content downstream."""
    if not isinstance(value, dict):
        return None
    try:
        return LanguageContext.model_validate(value)
    except (TypeError, ValueError):
        return None


def run_feedback_analysis_job(payload: dict[str, Any]) -> None:
    tenant_id = str(payload.get("tenant_id") or "")
    feedback_id = str(payload.get("feedback_id") or "")
    session_id = str(payload.get("session_id") or "")
    language_context = _language_context_from_payload(payload)
    with Session(engine) as db:
        events = EventLog(db)
        events.bind_turn("", language_context=language_context)
        row = FeedbackAnalysisService(db).analyze_feedback(feedback_id)
        if row:
            _record_feedback_analysis_completed(
                events,
                row,
                language_context=language_context,
            )
            db.commit()
            return
        if tenant_id and session_id:
            _record_feedback_analysis_failed(
                events,
                tenant_id=tenant_id,
                session_id=session_id,
                feedback_id=feedback_id,
                language_context=language_context,
            )
            db.commit()


@register_job_handler("feedback.analyze")
def handle_feedback_analysis_job(db: Session, job: APIJob) -> dict[str, Any]:
    payload = dict(job.request_json or {})
    tenant_id = str(payload.get("tenant_id") or job.tenant_id)
    feedback_id = str(payload.get("feedback_id") or "")
    session_id = str(payload.get("session_id") or "")
    language_context = _language_context_from_job(job)
    events = EventLog(db)
    events.bind_turn("", language_context=language_context)
    row = FeedbackAnalysisService(db).analyze_feedback(feedback_id)
    if not row or row.tenant_id != tenant_id:
        if tenant_id and session_id:
            _record_feedback_analysis_failed(
                events,
                tenant_id=tenant_id,
                session_id=session_id,
                feedback_id=feedback_id,
                language_context=language_context,
            )
        raise LookupError("FEEDBACK_NOT_FOUND")
    _record_feedback_analysis_completed(
        events,
        row,
        language_context=language_context,
    )
    return {
        "feedback_id": row.id,
        "analysis_status": row.analysis_status,
        "analysis_bucket": row.analysis_bucket,
    }


def _language_context_from_payload(payload: dict[str, Any]) -> LanguageContext:
    """Resolve the durable locale snapshot carried by a legacy worker payload."""
    return resolve_compatible_language_context(
        snapshot=payload.get("language_context"),
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )


def _language_context_from_job(job: APIJob) -> LanguageContext:
    """Read the immutable locale snapshot captured when the internal job was enqueued."""
    return resolve_compatible_language_context(
        snapshot=job.language_context_json,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )


def _record_feedback_analysis_completed(
    events: EventLog,
    row: Any,
    *,
    language_context: LanguageContext,
) -> None:
    """Project analysis metadata into a registered event without copying feedback prose."""
    # Workflow: normalize nullable model output to bounded metadata, then let EventLog validate
    # and persist the canonical envelope plus its explicit legacy event-type projection.
    record_product_event(
        events,
        event_code="feedback.analysis.completed",
        tenant_id=row.tenant_id,
        aggregate_type="chat_session",
        aggregate_id=row.session_id,
        params={
            "feedback_id": row.id,
            "message_id": row.message_id,
            "rating": row.rating,
            "bucket": row.analysis_bucket or "unknown",
            "status": row.analysis_status or "unknown",
            "confidence": float(row.analysis_confidence or 0.0),
        },
        language_context=language_context,
    )


def _record_feedback_analysis_failed(
    events: EventLog,
    *,
    tenant_id: str,
    session_id: str,
    feedback_id: str,
    language_context: LanguageContext,
) -> None:
    """Record a stable failure code while keeping the old feedback event name for readers."""
    record_product_event(
        events,
        event_code="feedback.analysis.failed",
        tenant_id=tenant_id,
        aggregate_type="chat_session",
        aggregate_id=session_id,
        params={"feedback_id": feedback_id, "reason_code": "FEEDBACK_NOT_FOUND"},
        language_context=language_context,
    )

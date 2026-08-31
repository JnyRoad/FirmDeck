from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.api.chat import session_read
from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import JsonValue
from app.contracts.http import build_http_exception
from app.contracts.projections import project_public_error_payload
from app.db import get_session
from app.db.models import (
    AgentProfile,
    APIJob,
    ChatSession,
    Message,
    MessageFeedback,
    User,
    utc_now,
)
from app.feedback import feedback_analysis_read, feedback_summary
from app.feedback.jobs import enqueue_feedback_analysis, resolve_feedback_language_context
from app.feedback.service import _canonical_feedback_bucket
from app.security.auth import get_current_user
from app.security.permissions import agent_owned_by_user, is_admin_user
from app.security.tenant import ensure_tenant
from app.session.message_read import message_read

router = APIRouter(prefix="/api/enterprise/feedback", tags=["enterprise:feedback"])


def _project_feedback_job_error(candidate: object) -> dict[str, JsonValue]:
    """Project persisted feedback-job failure metadata to a validated public descriptor."""
    return project_public_error_payload(
        candidate,
        ERROR_REGISTRY,
        source="feedback.api",
    )


def _project_feedback_job_result(candidate: object) -> dict[str, Any]:
    """Keep successful feedback metadata/raw summary while dropping nested failure prose."""
    if not isinstance(candidate, Mapping):
        return {}
    result: dict[str, Any] = {}
    for key, value in candidate.items():
        if key in {"error", "error_json", "failure"}:
            if isinstance(value, Mapping) and isinstance(value.get("code"), str):
                result[str(key)] = _project_feedback_job_error(value)
            continue
        if key in {"traceback", "exception"}:
            continue
        if isinstance(value, Mapping):
            result[str(key)] = _project_feedback_job_result(value)
        elif isinstance(value, list):
            result[str(key)] = [
                _project_feedback_job_result(item) if isinstance(item, Mapping) else item
                for item in value
            ]
        else:
            result[str(key)] = value
    return result


def _project_feedback_analysis(row: MessageFeedback) -> dict[str, Any]:
    """Project feedback analysis while preserving authored summary/reason text and safe metadata."""
    analysis = feedback_analysis_read(row)
    metadata = analysis.get("metadata")
    projected_metadata = _project_feedback_job_result(metadata)
    # ``evidence`` is model-owned source content.  The generic job sanitizer
    # intentionally strips diagnostic-shaped keys, so restore this one
    # explicitly raw field after sanitizing the surrounding metadata.
    if isinstance(metadata, Mapping) and isinstance(metadata.get("evidence"), list):
        projected_metadata["evidence"] = list(metadata["evidence"])
    analysis["metadata"] = projected_metadata
    return analysis


def _feedback_job_error_for_response(job: APIJob) -> dict[str, JsonValue]:
    """Project a feedback job's persisted error without exposing its raw storage field at the route."""
    return _project_feedback_job_error(job.error_json) if job.error_json else {}


@router.get("/summary")
def get_feedback_summary(
    tenant_id: str = Query(...),
    agent_id: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return locale-neutral feedback aggregates for frontend localization."""
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    owned_session_ids = _owned_session_ids(db, tenant_id, current_user, agent_id)
    if not owned_session_ids:
        return feedback_summary([])
    rows = list(
        db.exec(
            select(MessageFeedback)
            .where(
                MessageFeedback.tenant_id == tenant_id,
                MessageFeedback.session_id.in_(owned_session_ids),  # type: ignore[attr-defined]
            )
            .order_by(MessageFeedback.updated_at.desc())
            .limit(limit)
        ).all()
    )
    return feedback_summary(rows)


@router.get("/sessions")
def list_feedback_sessions(
    tenant_id: str = Query(...),
    rating: str = Query(default="down"),
    agent_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[dict]:
    """List owned feedback sessions with stable analysis IDs and typed parameters."""
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    owned_session_ids = _owned_session_ids(db, tenant_id, current_user, agent_id)
    if not owned_session_ids:
        return []
    feedback_rows = list(
        db.exec(
            select(MessageFeedback)
            .where(
                MessageFeedback.tenant_id == tenant_id,
                MessageFeedback.rating == rating,
                MessageFeedback.session_id.in_(owned_session_ids),  # type: ignore[attr-defined]
            )
            .order_by(MessageFeedback.updated_at.desc())
            .limit(limit)
        ).all()
    )
    grouped: dict[str, list[MessageFeedback]] = {}
    for row in feedback_rows:
        grouped.setdefault(row.session_id, []).append(row)

    results: list[dict] = []
    for session_id, rows in grouped.items():
        chat_session = db.get(ChatSession, session_id)
        if not chat_session or chat_session.tenant_id != tenant_id:
            continue
        if agent_id and chat_session.agent_id != agent_id:
            continue
        latest = max(rows, key=lambda item: item.updated_at)
        latest_analysis = _project_feedback_analysis(latest)
        latest_message = db.get(Message, latest.message_id)
        user = db.get(User, chat_session.user_id) if chat_session.user_id else None
        down_rows = [item for item in rows if item.rating == "down"]
        bucket_counts: dict[str, int] = {}
        for item in down_rows:
            bucket = _canonical_feedback_bucket(item.analysis_bucket)
            bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
        primary_bucket = max(bucket_counts.items(), key=lambda item: item[1])[0] if bucket_counts else None
        results.append(
            {
                "session_id": chat_session.id,
                "tenant_id": chat_session.tenant_id,
                "agent_id": chat_session.agent_id,
                "user_id": chat_session.user_id,
                "username": user.username if user else None,
                "display_name": user.display_name if user else None,
                "title": chat_session.title,
                "summary": chat_session.summary,
                "status": chat_session.status,
                "feedback_count": len(rows),
                "latest_feedback_at": latest.updated_at.isoformat(),
                "latest_message_id": latest.message_id,
                "latest_message": latest_message.content if latest_message else "",
                "analysis_status": latest_analysis["status"],
                "analysis_status_params": latest_analysis["status_params"],
                "analysis_bucket": latest_analysis["bucket"],
                "analysis_bucket_params": latest_analysis["bucket_params"],
                "analysis_summary": latest_analysis["summary"],
                "analysis_evidence": latest_analysis["evidence"],
                "primary_bucket": primary_bucket,
                "primary_bucket_params": (
                    {"count": bucket_counts.get(primary_bucket, 0)}
                    if primary_bucket is not None
                    else {}
                ),
                "bucket_counts": bucket_counts,
                "updated_at": chat_session.updated_at.isoformat(),
            }
        )
    return sorted(results, key=lambda item: item["latest_feedback_at"], reverse=True)


@router.get("/sessions/{session_id}")
def get_feedback_session_detail(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return one owned feedback session while delegating analysis projection to the canonical helper."""
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    chat_session = _get_owned_chat_session(db, tenant_id, current_user, session_id)

    messages = list(
        db.exec(
            select(Message)
            .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
            .order_by(Message.created_at)
        ).all()
    )
    feedback_rows = list(
        db.exec(
            select(MessageFeedback)
            .where(MessageFeedback.tenant_id == tenant_id, MessageFeedback.session_id == session_id)
            .order_by(MessageFeedback.updated_at.desc())
        ).all()
    )
    feedback_by_message = {row.message_id: row for row in feedback_rows}
    user = db.get(User, chat_session.user_id) if chat_session.user_id else None
    return {
        "session": {
            **session_read(chat_session).model_dump(),
            "username": user.username if user else None,
            "display_name": user.display_name if user else None,
        },
        "messages": [_message_with_feedback(message, feedback_by_message.get(message.id)) for message in messages],
        "feedback": [
            {
                "id": row.id,
                "message_id": row.message_id,
                "user_id": row.user_id,
                "rating": row.rating,
                "analysis": _project_feedback_analysis(row),
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in feedback_rows
        ],
    }


@router.post("/{feedback_id}/reanalyze")
def reanalyze_feedback(
    feedback_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Reset feedback analysis and enqueue it with the authoritative turn locale snapshot."""
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    row = db.get(MessageFeedback, feedback_id)
    if not row or row.tenant_id != tenant_id:
        raise build_http_exception("FEEDBACK_NOT_FOUND")
    chat_session = _get_owned_chat_session(db, tenant_id, current_user, row.session_id)
    language_context = resolve_feedback_language_context(
        db,
        tenant_id=tenant_id,
        session_id=chat_session.id,
        message_id=row.message_id,
    )
    now = utc_now()
    row.analysis_status = "pending"
    row.analysis_bucket = None
    row.analysis_reason = None
    row.analysis_summary = None
    row.analysis_confidence = None
    row.analysis_json = {"retry_requested_at": now.isoformat()}
    row.analyzed_at = None
    row.updated_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    job = enqueue_feedback_analysis(
        row.tenant_id,
        row.id,
        row.session_id,
        language_context=language_context,
    )
    return {
        "feedback_id": row.id,
        "analysis_status": row.analysis_status,
        "analysis_status_params": {},
        "job_id": job.id,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/jobs/{job_id}")
def get_feedback_analysis_job(
    job_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return a feedback analysis job with safe result/error projections."""
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    job = db.get(APIJob, job_id)
    if (
        not job
        or job.tenant_id != tenant_id
        or job.kind != "feedback.analyze"
        or job.credential_id != "internal"
    ):
        raise build_http_exception("FEEDBACK_ANALYSIS_JOB_NOT_FOUND")
    feedback_id = str((job.request_json or {}).get("feedback_id") or "")
    row = db.get(MessageFeedback, feedback_id) if feedback_id else None
    if row:
        _get_owned_chat_session(db, tenant_id, current_user, row.session_id)
    return {
        "id": job.id,
        "feedback_id": feedback_id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "result": _project_feedback_job_result(job.result_json),
        "error": _feedback_job_error_for_response(job),
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "updated_at": job.updated_at.isoformat(),
    }


def _message_with_feedback(message: Message, feedback: MessageFeedback | None) -> dict:
    payload = message_read(message, feedback.rating if feedback else None).model_dump()
    if feedback:
        payload["feedback_id"] = feedback.id
        payload["feedback_updated_at"] = feedback.updated_at.isoformat()
        payload["feedback_analysis"] = _project_feedback_analysis(feedback)
    return payload


def _owned_session_ids(
    db: Session,
    tenant_id: str,
    current_user: User,
    agent_id: str | None = None,
) -> list[str]:
    conditions = [ChatSession.tenant_id == tenant_id]
    if agent_id:
        conditions.append(ChatSession.agent_id == agent_id)
    if not _can_view_all_agent_feedback(db, tenant_id, agent_id, current_user):
        conditions.append(ChatSession.user_id == current_user.id)
    return list(db.exec(select(ChatSession.id).where(*conditions)).all())


def _get_owned_chat_session(db: Session, tenant_id: str, current_user: User, session_id: str) -> ChatSession:
    row = db.get(ChatSession, session_id)
    if not row or row.tenant_id != tenant_id:
        raise build_http_exception("SESSION_NOT_FOUND")
    if row.user_id == current_user.id or is_admin_user(current_user):
        return row
    agent = db.get(AgentProfile, row.agent_id) if row.agent_id else None
    if (
        agent
        and agent.tenant_id == tenant_id
        and not agent.is_overall
        and agent_owned_by_user(agent, current_user)
    ):
        return row
    raise build_http_exception("SESSION_NOT_FOUND")


def _can_view_all_agent_feedback(
    db: Session,
    tenant_id: str,
    agent_id: str | None,
    current_user: User,
) -> bool:
    if is_admin_user(current_user):
        return bool(agent_id)
    if not agent_id:
        return False
    agent = db.get(AgentProfile, agent_id)
    if not agent or agent.tenant_id != tenant_id or agent.is_overall:
        return False
    return agent_owned_by_user(agent, current_user)


def _ensure_request_tenant(tenant_id: str, current_user: User) -> None:
    if tenant_id != current_user.tenant_id:
        raise build_http_exception("TENANT_MISMATCH")

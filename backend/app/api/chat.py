from __future__ import annotations

import json
import logging
import mimetypes
import re
import threading
import time
from collections.abc import Iterator
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import and_, or_, update
from sqlmodel import Session, select
from starlette.background import BackgroundTask

from app.agents.branching import model_for_agent, visible_published_skills
from app.channels.service_outbox import stage_channel_delivery
from app.contracts.domain_http import domain_http_error
from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext, JsonValue
from app.contracts.projections import project_public_error
from app.core import AgentLoop
from app.core.cancellation import cancel_chat_turn, is_chat_turn_cancelled
from app.core.capability_manifest import CapabilityManifestBuilder
from app.core.conversation_projection import ConversationProjection
from app.core.harness_session_cleanup import (
    HarnessWorkspaceArtifactConflictError,
    open_harness_task_artifact,
)
from app.core.harness_turn_store import HarnessTurnStore, _prepare_turn_language_context
from app.core.slash_commands import SlashCommandRead, slash_command_catalog
from app.db import engine, get_session
from app.db.models import (
    AgentEvent,
    AgentProfile,
    ChatSession,
    HarnessTaskFrameRecord,
    HarnessTurnRecord,
    HumanHandoffRequest,
    Message,
    MessageFeedback,
    ScheduledTaskRun,
    Skill,
    SkillFeedback,
    Team,
    User,
    new_id,
    utc_now,
)
from app.feedback.jobs import enqueue_feedback_analysis, resolve_feedback_language_context
from app.harness import (
    HarnessArtifactAccessError,
    normalize_harness_artifact_path,
)
from app.i18n.language_context import (
    LanguageContext,
    normalize_locale,
    resolve_compatible_language_context,
)
from app.llm import LLMClient, LLMError
from app.llm.prompts.language import (
    language_prompt_contract,
    localized_cancelled_reply,
    localized_compat_text,
    localized_interrupted_reply,
)
from app.observability.spans import (
    bind_span_sink,
    llm_operation,
    reset_span_sink,
    set_span_sink,
)
from app.scheduled_tasks.schema import ScheduledTaskDraftRead
from app.scheduled_tasks.service import detect_scheduled_task_draft
from app.security.auth import get_current_user
from app.security.permissions import agent_owned_by_user, is_admin_user
from app.security.tenant import ensure_tenant
from app.session.attachments import (
    parse_chat_attachment,
    validate_chat_turn_attachments,
)
from app.session.cleanup import (
    purge_chat_session_records,
    remove_chat_session_workspace,
)
from app.session.helpers import public_session
from app.session.message_read import message_read
from app.session.message_visibility import (
    internal_message_turn_ids,
    visible_message_content,
    visible_message_rows,
)
from app.session.origin import pilotdeck_origin_session_ids
from app.session.session_kinds import is_team_tl_session, team_tl_session_filter
from app.session.session_schema import (
    ChatAttachmentRead,
    ChatSessionCreateRequest,
    ChatSessionRead,
    ChatSessionUpdateRequest,
    ChatTurnRequest,
    ChatTurnResponse,
    MessageFeedbackRequest,
    MessageRead,
)
from app.skills.nesting import discoverable_sops
from app.teams.service import get_team_leader
from app.teams.wakeup import build_tl_chat_context, process_tl_reply

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)
STREAM_REPLY_CHUNK_SIZE = 96
STREAM_RELAY_POLL_SECONDS = 0.08
STREAM_RELAY_HEARTBEAT_SECONDS = 5.0
STREAM_RELAY_IDLE_TIMEOUT_SECONDS = 660.0
MAX_CHAT_ATTACHMENT_BYTES = 12 * 1024 * 1024
MAX_CHAT_ATTACHMENTS = 8
SESSION_TITLE_SUMMARY_EVENT = "session_title_summarized"
EVENT_PAYLOAD_META_KEYS = {"id", "event", "type", "event_type", "created_at", "data"}
STREAM_RELAY_EVENT_ALIASES = {
    "router_decision_created": "router_decision",
    "stream_status": "status",
}
STREAM_RELAY_TERMINAL_EVENTS = {
    "complete",
    "error_occurred",
    "stream_cancelled",
    "stream_interrupted",
}
SPAN_EVENT_TYPES = {
    "llm_call_started",
    "llm_call_finished",
    "llm_call_failed",
    "knowledge_span_started",
    "knowledge_span_finished",
    "knowledge_span_failed",
}
_LEGACY_PUBLIC_ERROR_ALIASES = {
    "LLM_ERROR": "MODEL_UPSTREAM_ERROR",
    "HARNESS_V2_ERROR": "INTERNAL_ERROR",
    "SERVICE_RESTARTED": "INTERNAL_ERROR",
    "HARNESS_EXECUTION_LOST": "INTERNAL_ERROR",
    "HARNESS_SESSION_BUSY": "INTERNAL_ERROR",
    "HARNESS_TURN_CONFLICT": "INTERNAL_ERROR",
}


def _chat_error(
    code: str,
    status_code: int | None = None,
    *,
    params: dict[str, object] | None = None,
    cause: BaseException | None = None,
) -> HTTPException:
    """Build a canonical chat-boundary error while keeping raw causes diagnostic-only."""
    return domain_http_error(
        code,
        source="chat.api",
        status_code=status_code,
        params=params,
        cause=cause,
    )


KNOWLEDGE_TRACE_PHASES = {
    "knowledge",
    "okf_route",
    "okf_only",
    "document_route",
    "document_route_lexical",
    "bucket_route",
    "bucket_route_lexical",
    "section_expand",
    "read_chunks",
    "evidence_pack",
    "no_visible_knowledge",
    "no_documents",
    "no_buckets",
}
SESSION_TITLE_PROMPT = """You are StaffDeck's session title editor.

Based on the first user request and the employee reply, generate a short, readable,
specific session title.

Requirements:
- Output one JSON object in the form {"title": "..."}.
- Output only the title JSON; do not include analysis, alternatives, or explanations.
- Write the newly generated title in the Agent reply locale from the language contract.
- Prefer 4 to 18 characters when natural for that locale, with a maximum of 24 Unicode characters.
- Avoid generic titles such as "New task", "Task record", or "User inquiry".
- Do not include punctuation, quotation marks, numbering, employee names, or user salutations.
- If the intent is unclear, return the shortest phrase that best describes the user request.
"""
_session_title_summary_jobs: set[str] = set()
_session_title_summary_jobs_lock = threading.Lock()


class HumanHandoffRead(BaseModel):
    id: str
    tenant_id: str
    session_id: str
    agent_id: str | None = None
    requester_user_id: str | None = None
    assignee_user_id: str | None = None
    trigger_skill_id: str | None = None
    trigger_step_id: str | None = None
    context_summary: str | None = None
    pending_question: str | None = None
    status: str
    human_reply: str | None = None
    metadata: dict[str, object]
    created_at: str
    updated_at: str
    answered_at: str | None = None


class ChatTurnCancelRequest(BaseModel):
    tenant_id: str
    turn_id: str


class HumanHandoffReplyRequest(BaseModel):
    tenant_id: str
    reply: str


def session_read(
    row: ChatSession, *, is_scheduled: bool = False, team_name: str | None = None
) -> ChatSessionRead:
    """Project a session while retaining its authoritative Agent reply locale snapshot."""
    return ChatSessionRead(
        id=row.id,
        tenant_id=row.tenant_id,
        user_id=row.user_id,
        agent_id=row.agent_id,
        title=row.title,
        active_skill_id=row.active_skill_id,
        active_step_id=row.active_step_id,
        status=row.status,
        agent_reply_locale=row.agent_reply_locale,
        agent_reply_locale_source=row.agent_reply_locale_source,
        summary=row.summary,
        last_agent_question=row.last_agent_question,
        is_scheduled=is_scheduled,
        team_id=row.team_id,
        team_name=team_name,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


def human_handoff_read(row: HumanHandoffRequest) -> HumanHandoffRead:
    """Project one handoff row while stripping raw resume failure text from public metadata."""
    metadata = dict(row.metadata_json or {})
    if "resume_error" in metadata:
        metadata["resume_error"] = _project_error_candidate(
            metadata.get("resume_error"),
            source="chat.handoff_resume",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
    return HumanHandoffRead(
        id=row.id,
        tenant_id=row.tenant_id,
        session_id=row.session_id,
        agent_id=row.agent_id,
        requester_user_id=row.requester_user_id,
        assignee_user_id=row.assignee_user_id,
        trigger_skill_id=row.trigger_skill_id,
        trigger_step_id=row.trigger_step_id,
        context_summary=row.context_summary,
        pending_question=row.pending_question,
        status=row.status,
        human_reply=row.human_reply,
        metadata=metadata,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
        answered_at=row.answered_at.isoformat() if row.answered_at else None,
    )


def _user_message_metadata(request: ChatTurnRequest) -> dict[str, object]:
    """Project request metadata consistently with the AgentLoop conversation projection."""
    return ConversationProjection.user_message_metadata(request)


def _language_context_payload(request: ChatTurnRequest) -> dict[str, object]:
    """Return the serialized immutable locale snapshot for compatibility event envelopes."""
    if request.language_context is None:
        return {}
    return {"language_context": request.language_context.model_dump(mode="json")}


def _schedule_session_title_summary(
    tenant_id: str,
    user_id: str,
    session_id: str,
    agent_id: str | None,
    *,
    language_context: LanguageContext | None = None,
) -> None:
    """Queue one title job with the originating immutable reply-locale snapshot."""
    if not session_id:
        return
    job_key = f"{tenant_id}:{user_id}:{session_id}"
    with _session_title_summary_jobs_lock:
        if job_key in _session_title_summary_jobs:
            return
        _session_title_summary_jobs.add(job_key)

    def run() -> None:
        try:
            _summarize_session_title_once(
                tenant_id,
                user_id,
                session_id,
                agent_id,
                language_context=language_context,
            )
        finally:
            with _session_title_summary_jobs_lock:
                _session_title_summary_jobs.discard(job_key)

    thread = threading.Thread(
        target=run,
        daemon=True,
    )
    thread.start()


def _summarize_session_title_once(
    tenant_id: str,
    user_id: str,
    session_id: str,
    agent_id: str | None,
    *,
    language_context: LanguageContext | None = None,
) -> None:
    """Generate and persist one title using the turn snapshot or the session's bound locale."""
    resolved_language_context = language_context
    try:
        for attempt in range(8):
            messages: list[Message] = []
            model_config = None
            effective_agent_id = agent_id
            with Session(engine) as db:
                session = db.exec(
                    select(ChatSession).where(
                        ChatSession.id == session_id,
                        ChatSession.tenant_id == tenant_id,
                        ChatSession.user_id == user_id,
                    )
                ).first()
                if not session:
                    return
                if (session.title or "").strip():
                    return
                session_language_context = resolve_compatible_language_context(
                    snapshot=None,
                    legacy_ui_locale=None,
                    legacy_agent_reply_locale=session.agent_reply_locale,
                )
                if resolved_language_context is None:
                    resolved_language_context = session_language_context
                elif (
                    session.agent_reply_locale
                    and session_language_context.agent_reply_locale
                    is not resolved_language_context.agent_reply_locale
                ):
                    logger.error(
                        "session title locale snapshot conflicts with bound session locale",
                        extra={"tenant_id": tenant_id, "session_id": session_id},
                    )
                    return
                existing = db.exec(
                    select(AgentEvent).where(
                        AgentEvent.tenant_id == tenant_id,
                        AgentEvent.session_id == session_id,
                        AgentEvent.event_type == SESSION_TITLE_SUMMARY_EVENT,
                    )
                ).first()
                if existing:
                    return
                messages = db.exec(
                    select(Message)
                    .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
                    .order_by(Message.created_at)
                    .limit(6)
                ).all()
                if not any(row.role == "user" for row in messages):
                    messages = []
                else:
                    effective_agent_id = agent_id or session.agent_id
                    model_config = model_for_agent(db, tenant_id, effective_agent_id)

            if not messages:
                if attempt < 7:
                    time.sleep(0.25)
                    continue
                return

            payload = {
                "current_title": "",
                "messages": [
                    {"role": row.role, "content": row.content[:1200]}
                    for row in messages
                    if row.role in {"user", "assistant"}
                ],
            }
            title = ""
            title_source = "first_user_fallback"
            if model_config:
                try:
                    title_turn_id = next((row.id for row in messages if row.role == "user"), "")

                    def persist_title_span(
                        event_type: str, event_payload: dict[str, object]
                    ) -> None:
                        traced_payload = dict(event_payload)
                        if title_turn_id:
                            traced_payload.setdefault("turn_id", title_turn_id)
                            traced_payload.setdefault("user_message_id", title_turn_id)
                        with Session(engine) as span_db:
                            _persist_relay_only_event(
                                span_db,
                                tenant_id,
                                session_id,
                                event_type,
                                traced_payload,
                            )

                    with bind_span_sink(persist_title_span), llm_operation("session.title"):
                        raw = LLMClient(model_config).generate_json(
                            _session_title_prompt(resolved_language_context),
                            payload,
                        )
                    title = _normalize_auto_title(str(raw.get("title") or ""))
                    if title:
                        title_source = "first_turn_summary"
                except LLMError:
                    title = ""
            if not title:
                title = _fallback_session_title(messages)
            if not title:
                return

            with Session(engine) as db:
                session = db.exec(
                    select(ChatSession).where(
                        ChatSession.id == session_id,
                        ChatSession.tenant_id == tenant_id,
                        ChatSession.user_id == user_id,
                    )
                ).first()
                if not session:
                    return
                if (session.title or "").strip():
                    return
                existing = db.exec(
                    select(AgentEvent).where(
                        AgentEvent.tenant_id == tenant_id,
                        AgentEvent.session_id == session_id,
                        AgentEvent.event_type == SESSION_TITLE_SUMMARY_EVENT,
                    )
                ).first()
                if existing:
                    return
                session.title = title
                db.add(session)
                db.add(
                    AgentEvent(
                        tenant_id=tenant_id,
                        session_id=session_id,
                        event_type=SESSION_TITLE_SUMMARY_EVENT,
                        payload_json={
                            "title": title,
                            "source": title_source,
                            "agent_id": effective_agent_id,
                            "language_context": resolved_language_context.model_dump(mode="json"),
                        },
                    )
                )
                db.commit()
                return
    except (LLMError, Exception):
        return


def _session_title_summary_payload(db: Session, tenant_id: str, session_id: str) -> dict[str, str] | None:
    event = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.session_id == session_id,
            AgentEvent.event_type == SESSION_TITLE_SUMMARY_EVENT,
        )
        .order_by(AgentEvent.created_at.desc())
        .limit(1)
    ).first()
    payload = event.payload_json if event else None
    title = payload.get("title") if isinstance(payload, dict) else None
    if not isinstance(title, str) or not title.strip():
        return None
    return {"sessionId": session_id, "title": title.strip()}


def _normalize_auto_title(value: str) -> str:
    title = value.strip().strip("\"'“”‘’`")
    for token in ("\n", "\r", "\t", "：", ":", "。", "，", ",", "；", ";"):
        title = title.replace(token, " ")
    title = " ".join(part for part in title.split() if part)
    return title[:24]


def _session_title_prompt(language_context: LanguageContext | None) -> str:
    """Attach the immutable Agent reply-locale contract to the title-generation prompt."""
    contract = language_prompt_contract(language_context, ())
    directive = contract["language_directive"]["instruction"]
    return f"{SESSION_TITLE_PROMPT}\n\nLanguage contract:\n{directive}"


def _fallback_session_title(messages: list[Message]) -> str:
    first_user = next((row.content for row in messages if row.role == "user" and row.content.strip()), "")
    if not first_user:
        return ""
    return _normalize_auto_title(first_user)


def _normalized_session_event_payload(row: AgentEvent) -> dict[str, object]:
    """Normalize one stored session event into the authenticated replay/detail envelope."""
    payload = _sanitized_session_event_payload(row.event_type, row.payload_json or {})
    event_name = str(payload.get("event") or payload.get("type") or row.event_type)
    data = payload.get("data")
    if not isinstance(data, dict):
        data = {key: value for key, value in payload.items() if key not in EVENT_PAYLOAD_META_KEYS}
    normalized: dict[str, object] = {
        **payload,
        "id": str(payload.get("id") or row.id),
        "event": event_name,
        "type": str(payload.get("type") or event_name),
        "event_type": str(payload.get("event_type") or event_name),
        "created_at": str(payload.get("created_at") or row.created_at.isoformat()),
        "data": data,
    }
    if "run_id" not in normalized and data.get("run_id"):
        normalized["run_id"] = str(data.get("run_id"))
    return normalized


def _apply_handoff_reply(
    db: Session,
    row: HumanHandoffRequest,
    reply: str,
    *,
    answered_by_user_id: str | None,
    source: str = "web",
) -> None:
    """把一条 pending handoff 置为 answered 并触发 SOP 恢复。

    供网页 API(reply_human_handoff)与飞书 intake 回复分支复用。
    调用前需已完成权限校验与状态校验;本函数负责落库 + 事件 + 异步恢复。
    source: "web" 或 "feishu",由调用方显式指定(不再靠 user_id 前缀推断)。
    """
    now = utc_now()
    row.status = "answered"
    row.human_reply = reply
    row.answered_at = now
    row.updated_at = now
    row.resume_payload_json = {
        **(row.resume_payload_json or {}),
        "answered_by_user_id": answered_by_user_id,
    }
    db.add(row)

    chat_session = db.get(ChatSession, row.session_id)
    language_context = resolve_compatible_language_context(
        snapshot=row.language_context_json,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=(
            chat_session.agent_reply_locale
            if chat_session and chat_session.tenant_id == row.tenant_id
            else None
        ),
    )
    if chat_session and chat_session.tenant_id == row.tenant_id:
        chat_session.status = "active"
        chat_session.awaiting_input_json = None
        summary_prefix = localized_compat_text(
            language_context,
            zh_cn="最近回复：",
            en_us="Latest reply: ",
        )
        chat_session.summary = f"{summary_prefix}{reply[:120]}"
        chat_session.updated_at = now
        db.add(chat_session)
    if row.language_context_json is None:
        row.language_context_json = language_context.model_dump(mode="json")
        db.add(row)
    db.add(
        AgentEvent(
            tenant_id=row.tenant_id,
            session_id=row.session_id,
            event_type="human_handoff_answered",
            payload_json={
                "handoff_id": row.id,
                "agent_id": row.agent_id,
                "trigger_skill_id": row.trigger_skill_id,
                "trigger_step_id": row.trigger_step_id,
                "answered_by_user_id": answered_by_user_id,
                "reply_preview": reply[:180],
                "source": source,
                "language_context": language_context.model_dump(mode="json"),
            },
            created_at=now,
        )
    )
    db.commit()
    db.refresh(row)
    _resume_human_handoff_async(row.id)


def _resume_human_handoff_async(handoff_id: str) -> None:
    thread = threading.Thread(target=_resume_human_handoff_worker, args=(handoff_id,), daemon=True)
    thread.start()


def _resume_human_handoff_worker(handoff_id: str) -> None:
    """Resume one answered handoff from its persisted locale snapshot and fail closed on errors."""
    try:
        with Session(engine) as db:
            handoff = db.get(HumanHandoffRequest, handoff_id)
            if not handoff or handoff.status != "answered" or not handoff.human_reply:
                return
            chat_session = db.get(ChatSession, handoff.session_id)
            if not chat_session or chat_session.tenant_id != handoff.tenant_id:
                return
            language_context = resolve_compatible_language_context(
                snapshot=handoff.language_context_json,
                legacy_ui_locale=None,
                legacy_agent_reply_locale=chat_session.agent_reply_locale,
            )
            if handoff.language_context_json is None:
                handoff.language_context_json = language_context.model_dump(mode="json")
            # The handoff snapshot is the execution boundary.  Align the legacy
            # scalar column before Harness validates the resumed request so a
            # later user-preference change cannot alter the reply locale.
            if chat_session.agent_reply_locale != language_context.agent_reply_locale.value:
                chat_session.agent_reply_locale = language_context.agent_reply_locale.value
                chat_session.agent_reply_locale_source = (
                    language_context.agent_reply_locale_source.value
                )
                chat_session.updated_at = utc_now()
                db.add(chat_session)
            db.add(handoff)
            metadata = dict(handoff.metadata_json or {})
            if metadata.get("resume_started_at"):
                return
            now = utc_now()
            metadata["resume_started_at"] = now.isoformat()
            handoff.metadata_json = metadata
            db.add(handoff)
            language_context = resolve_compatible_language_context(
                snapshot=handoff.language_context_json,
                legacy_ui_locale=None,
                legacy_agent_reply_locale=None,
            )
            db.add(
                AgentEvent(
                    tenant_id=handoff.tenant_id,
                    session_id=handoff.session_id,
                    event_type="human_handoff_resume_started",
                    payload_json={
                        "handoff_id": handoff.id,
                        "agent_id": handoff.agent_id,
                        "trigger_skill_id": handoff.trigger_skill_id,
                        "trigger_step_id": handoff.trigger_step_id,
                        "language_context": language_context.model_dump(mode="json"),
                    },
                    created_at=now,
                )
            )
            db.commit()

            # 会话属主是恢复请求的权威 user:渠道身份重绑(懒建账号→web 账号)会迁移
            # session.user_id,而 handoff.requester_user_id 是创建时的快照,可能已过期;
            # 优先旧快照会触发 harness 的 session-user 围栏校验失败。
            request = ChatTurnRequest(
                tenant_id=handoff.tenant_id,
                session_id=handoff.session_id,
                agent_id=handoff.agent_id or chat_session.agent_id,
                user_id=chat_session.user_id or handoff.requester_user_id or None,
                message=handoff.human_reply,
                channel="human_handoff_resume",
                ui_locale=language_context.ui_locale,
                agent_reply_locale=language_context.agent_reply_locale,
                language_context=language_context,
                debug=False,
            )
            AgentLoop(db).handle_turn(request)
            # resume turn 完成后不再写 resume_finished_at 标记:
            # _inject_handoff_context 已改为用 request.channel == "human_handoff_resume"
            # 判定 resume turn,时序可靠,无需事后标记。
    except Exception as exc:
        logger.exception("人工转接恢复失败 handoff=%s", handoff_id)
        with Session(engine) as db:
            handoff = db.get(HumanHandoffRequest, handoff_id)
            if not handoff:
                return
            language_context = resolve_compatible_language_context(
                snapshot=handoff.language_context_json,
                legacy_ui_locale=None,
                legacy_agent_reply_locale=None,
            )
            error_payload = _project_error_candidate(
                exc,
                source="chat.handoff_resume",
                default_code="INTERNAL_ERROR",
                retryable=False,
            )
            metadata = dict(handoff.metadata_json or {})
            metadata["resume_failed_at"] = utc_now().isoformat()
            metadata["resume_error"] = error_payload
            handoff.status = "failed"
            handoff.metadata_json = metadata
            handoff.updated_at = utc_now()
            db.add(handoff)
            db.add(
                AgentEvent(
                    tenant_id=handoff.tenant_id,
                    session_id=handoff.session_id,
                    event_type="human_handoff_resume_failed",
                    payload_json={
                        "handoff_id": handoff.id,
                        "error": error_payload,
                        "language_context": language_context.model_dump(mode="json"),
                    },
                )
            )
            db.commit()


def _maybe_handle_scheduled_task_request(
    db: Session,
    request: ChatTurnRequest,
    chat_session: ChatSession,
) -> tuple[ChatTurnResponse, ScheduledTaskDraftRead] | None:
    """Persist scheduled-task shortcut messages with the turn's immutable language snapshot."""
    if request.interaction_mode != "scheduled_task" or not request.agent_id:
        return None
    if request.client_turn_id and is_chat_turn_cancelled(
        chat_session.id,
        request.client_turn_id,
        db=db,
        identity_kind="client",
    ):
        # Cancellation wins over the shortcut. Let the normal Harness path
        # claim and terminalize the logical turn instead of creating a draft.
        return None
    _prepare_scheduled_draft_language_context(db, request, chat_session)
    draft = detect_scheduled_task_draft(
        db,
        request.tenant_id,
        request.agent_id,
        request.user_id,
        request.message,
        chat_session.id,
        request.client_timezone,
        language_context=request.language_context,
    )
    if not draft or not draft.should_create:
        return None

    turn_store = HarnessTurnStore(db)
    turn_claim = turn_store.claim(chat_session, request)
    if turn_claim.replay is not None:
        return turn_claim.replay, draft

    reply = _scheduled_task_draft_reply(request.language_context)
    now = utc_now()
    intent_time = now + timedelta(microseconds=1)
    parse_time = now + timedelta(microseconds=2)
    draft_status_time = now + timedelta(microseconds=3)
    event_time = now + timedelta(microseconds=4)
    assistant_time = now + timedelta(microseconds=5)
    state_time = now + timedelta(microseconds=6)
    chat_session.updated_at = assistant_time
    summary_prefix = localized_compat_text(
        request.language_context,
        zh_cn="最近回复：",
        en_us="Latest reply: ",
    )
    chat_session.summary = f"{summary_prefix}{reply[:120]}"
    user_message = Message(
        tenant_id=request.tenant_id,
        session_id=chat_session.id,
        role="user",
        content=request.message,
        metadata_json=_user_message_metadata(request),
        created_at=now,
    )
    db.add(user_message)
    db.flush()
    turn_store.bind_user_message(turn_claim.record, user_message.id)
    draft_payload = draft.model_dump(mode="json")
    db.add(
        AgentEvent(
            tenant_id=request.tenant_id,
            session_id=chat_session.id,
            event_type="user_message_received",
            payload_json={
                **_language_context_payload(request),
                "message_id": user_message.id,
                "client_turn_id": request.client_turn_id,
                "message": request.message,
                "channel": request.channel,
                "user_id": request.user_id,
            },
            created_at=now,
        )
    )
    _add_stream_status_event(
        db,
        request.tenant_id,
        chat_session.id,
        user_message.id,
        "scheduled_task_intent",
        "chat.scheduled.intent",
        language_context=request.language_context,
        created_at=intent_time,
    )
    _add_stream_status_event(
        db,
        request.tenant_id,
        chat_session.id,
        user_message.id,
        "scheduled_task_parse",
        "chat.scheduled.plan",
        language_context=request.language_context,
        created_at=parse_time,
    )
    _add_stream_status_event(
        db,
        request.tenant_id,
        chat_session.id,
        user_message.id,
        "scheduled_task_draft",
        "chat.scheduled.draft",
        extra=draft_payload,
        language_context=request.language_context,
        created_at=draft_status_time,
    )
    assistant_message = Message(
        tenant_id=request.tenant_id,
        session_id=chat_session.id,
        role="assistant",
        content=reply,
        metadata_json={
            **_language_context_payload(request),
            "scheduled_task_draft": draft_payload,
            "user_message_id": user_message.id,
            "turn_id": user_message.id,
        },
        created_at=assistant_time,
    )
    db.add(assistant_message)
    stage_channel_delivery(db, chat_session, assistant_message)
    db.add(
        AgentEvent(
            tenant_id=request.tenant_id,
            session_id=chat_session.id,
            event_type="scheduled_task_draft_created",
            payload_json={
                **_language_context_payload(request),
                **draft_payload,
                "user_message_id": user_message.id,
                "turn_id": user_message.id,
            },
            created_at=event_time,
        )
    )
    db.add(
        AgentEvent(
            tenant_id=request.tenant_id,
            session_id=chat_session.id,
            event_type="assistant_message_created",
            payload_json={
                **_language_context_payload(request),
                "message_id": assistant_message.id,
                "assistant_message_id": assistant_message.id,
                "user_message_id": user_message.id,
                "turn_id": user_message.id,
                "reply": reply,
                "scheduled_task_draft": draft_payload,
            },
            created_at=assistant_time,
        )
    )
    state = public_session(chat_session)
    db.add(
        AgentEvent(
            tenant_id=request.tenant_id,
            session_id=chat_session.id,
            event_type="session_state_changed",
            payload_json={**_language_context_payload(request), **state.model_dump()},
            created_at=state_time,
        )
    )
    response = ChatTurnResponse(
        reply=reply,
        session_id=chat_session.id,
        ui_locale=request.ui_locale,
        agent_reply_locale=request.agent_reply_locale,
        language_context=request.language_context,
        session_state=public_session(chat_session),
    )
    turn_store.complete(turn_claim.record, response)
    db.refresh(chat_session)
    return response, draft


def _prepare_scheduled_draft_language_context(
    db: Session,
    request: ChatTurnRequest,
    chat_session: ChatSession,
) -> None:
    """Resolve a shortcut turn snapshot before its background draft model call."""
    if request.language_context is not None:
        return
    existing = None
    client_turn_id = str(request.client_turn_id or "").strip()
    if client_turn_id:
        existing = db.exec(
            select(HarnessTurnRecord).where(
                HarnessTurnRecord.tenant_id == chat_session.tenant_id,
                HarnessTurnRecord.session_id == chat_session.id,
                HarnessTurnRecord.client_turn_id == client_turn_id,
            )
        ).first()
    _prepare_turn_language_context(
        db,
        chat_session,
        request,
        existing=existing,
    )


def _add_stream_status_event(
    db: Session,
    tenant_id: str,
    session_id: str,
    user_message_id: str,
    phase: str,
    event_code: str,
    *,
    params: dict[str, object] | None = None,
    extra: dict | None = None,
    language_context: LanguageContext | None = None,
    created_at=None,
) -> None:
    """Persist one structured stream status plus the immutable locale snapshot used for replay."""
    payload = {
        "phase": phase,
        "code": event_code,
        "params": params or {},
        "user_message_id": user_message_id,
        "turn_id": user_message_id,
        **(extra or {}),
    }
    if language_context is not None:
        payload["language_context"] = language_context.model_dump(mode="json")
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=session_id,
            event_type="stream_status",
            payload_json=payload,
            created_at=created_at or utc_now(),
        )
    )


def _scheduled_task_draft_reply(language_context: LanguageContext | None) -> str:
    """Return the draft-ready Agent reply in the immutable reply locale; the card owns raw details."""
    return localized_compat_text(
        language_context,
        zh_cn="定时任务草案已准备好。确认下方卡片后才会创建并启用。",
        en_us="The scheduled task draft is ready. Confirm the card below to create and enable it.",
    )


def _scheduled_task_trace_data(payload: dict) -> dict[str, object]:
    """Expose only raw schedule fields needed for frontend-localized trace details."""
    return {
        "title": payload.get("title"),
        "schedule_type": payload.get("schedule_type"),
        "schedule": payload.get("schedule"),
    }


def _scheduled_task_trace_lines(
    payload: dict,
    *,
    state: str = "completed",
    event_type: str = "scheduled_task_draft_created",
) -> list[dict]:
    """Build scheduled-task stages from canonical fields and raw schedule details."""
    event_data = _scheduled_task_trace_data(payload)
    return [
        {
            "id": "scheduled_task_intent",
            "kind": "decision",
            "text": "",
            "event_type": event_type,
            "event_code": "chat.scheduled.intent",
            "params": {},
            "event_data": event_data,
            "state": "completed",
        },
        {
            "id": "scheduled_task_parse",
            "kind": "decision",
            "text": "",
            "event_type": event_type,
            "event_code": "chat.scheduled.plan",
            "params": {},
            "event_data": event_data,
            "state": "completed",
        },
        {
            "id": "scheduled_task_draft",
            "kind": "decision",
            "text": "",
            "event_type": event_type,
            "event_code": "chat.scheduled.draft",
            "params": {},
            "event_data": event_data,
            "state": state,
        },
    ]


def _persist_scheduled_task_draft(
    db: Session,
    tenant_id: str,
    session_id: str,
    draft: ScheduledTaskDraftRead,
    *,
    language_context: LanguageContext | None = None,
) -> None:
    """Persist a scheduled-task draft and retain the originating turn locale snapshot."""
    if not session_id:
        return
    payload = draft.model_dump(mode="json")
    if language_context is not None:
        payload["language_context"] = language_context.model_dump(mode="json")
    latest_assistant = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == session_id, Message.role == "assistant")
        .order_by(Message.created_at.desc())
    ).first()
    if latest_assistant:
        metadata = dict(latest_assistant.metadata_json or {})
        metadata["scheduled_task_draft"] = payload
        latest_assistant.metadata_json = metadata
        db.add(latest_assistant)
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=session_id,
            event_type="scheduled_task_draft_created",
            payload_json=payload,
            created_at=utc_now(),
        )
    )
    db.commit()


def _reply_chunks(reply: str) -> Iterator[str]:
    for index in range(0, len(reply), STREAM_REPLY_CHUNK_SIZE):
        yield reply[index : index + STREAM_REPLY_CHUNK_SIZE]


def _validate_chat_turn_attachments(
    request: ChatTurnRequest,
) -> ChatTurnRequest:
    """Validate attachment metadata while projecting validation failures to a stable chat code."""
    try:
        attachments = validate_chat_turn_attachments(
            request.attachments,
            max_attachments=MAX_CHAT_ATTACHMENTS,
            max_attachment_bytes=MAX_CHAT_ATTACHMENT_BYTES,
        )
    except ValueError as exc:
        raise _chat_error("CHAT_ATTACHMENT_INVALID", 400, cause=exc) from exc
    return request.model_copy(update={"attachments": attachments})


@router.get("/slash-commands", response_model=list[SlashCommandRead])
def list_slash_commands(
    tenant_id: str = Query(...),
    agent_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[SlashCommandRead]:
    _ensure_request_tenant(tenant_id, current_user)
    agent = _ensure_chat_agent_available(
        db,
        tenant_id,
        agent_id,
        current_user,
    )
    skills = discoverable_sops(visible_published_skills(db, tenant_id, agent.id))
    manifest = CapabilityManifestBuilder(db).build(
        tenant_id,
        agent.id,
        None,
        None,
    )
    return slash_command_catalog(skills, manifest)


@router.post("/attachments", response_model=list[ChatAttachmentRead])
async def upload_chat_attachments(
    tenant_id: str = Query(...),
    files: list[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ChatAttachmentRead]:
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    if not files:
        raise _chat_error("CHAT_ATTACHMENTS_REQUIRED", 400)
    if len(files) > MAX_CHAT_ATTACHMENTS:
        raise _chat_error(
            "CHAT_ATTACHMENT_LIMIT_EXCEEDED",
            400,
            params={"max_count": MAX_CHAT_ATTACHMENTS},
        )
    parsed: list[ChatAttachmentRead] = []
    from app.session.attachment_store import stage_chat_attachment

    for file in files:
        data = await file.read()
        if len(data) > MAX_CHAT_ATTACHMENT_BYTES:
            raise _chat_error(
                "CHAT_ATTACHMENT_TOO_LARGE",
                413,
                params={"max_bytes": MAX_CHAT_ATTACHMENT_BYTES},
            )
        attachment = parse_chat_attachment(
            file.filename or "uploaded-file",
            file.content_type,
            data,
            extract_text=False,
        )
        parsed.append(
            stage_chat_attachment(
                attachment,
                data,
                tenant_id=tenant_id,
                user_id=current_user.id,
            )
        )
    return parsed


@router.post("/turn", response_model=ChatTurnResponse)
def chat_turn(
    request: ChatTurnRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ChatTurnResponse:
    """Execute one authenticated chat turn with an immutable reply-locale snapshot."""
    _ensure_request_tenant(request.tenant_id, current_user)
    request = request.model_copy(
        update={
            "user_id": current_user.id,
            "context_injection": None,
            "message_visibility": "visible",
        }
    )
    request = _validate_chat_turn_attachments(request)
    team_tl_team: Team | None = None
    if request.session_id:
        chat_session = _ensure_chat_session_available(db, request.tenant_id, current_user.id, request.session_id)
        _ensure_team_session_human_writable(chat_session)
        request = _bind_request_to_session_agent(db, request, chat_session, current_user)
        team_tl_team = _team_tl_session_team(db, chat_session)
    else:
        _ensure_chat_agent_available(db, request.tenant_id, request.agent_id, current_user)
    ensure_tenant(db, request.tenant_id)
    if not request.message.strip() and not request.attachments:
        raise _chat_error("CHAT_MESSAGE_REQUIRED", 400)
    original_message = request.message
    if team_tl_team is not None:
        # 团队 TL 会话:注入团队上下文(花名册/未闭环任务/黑板/派任务格式)后再走正常引擎
        request = request.model_copy(
            update={
                "context_injection": build_tl_chat_context(
                    db, team_tl_team, original_message
                ),
                "interaction_mode": "team_tl",
            }
        )
    if request.session_id:
        scheduled_response = _maybe_handle_scheduled_task_request(db, request, chat_session)
        if scheduled_response:
            response, _draft = scheduled_response
            _schedule_session_title_summary(
                request.tenant_id,
                request.user_id,
                response.session_id,
                request.agent_id,
                language_context=response.language_context or request.language_context,
            )
            return response
    response = AgentLoop(db).handle_turn(request)
    _schedule_session_title_summary(
        request.tenant_id,
        request.user_id,
        response.session_id,
        request.agent_id,
        language_context=response.language_context or request.language_context,
    )
    if team_tl_team is not None:
        # TL 回复后处理:解析派任务块并创建任务(与 tl_chat 端点同语义);
        # 后处理失败不影响本轮回复
        try:
            process_tl_reply(
                db,
                team=team_tl_team,
                session=chat_session,
                user=current_user,
                user_message=original_message,
                reply=response.reply or "",
                client_turn_id=request.client_turn_id,
            )
        except (TypeError, ValueError):
            logger.exception("team TL reply post-processing failed")
    if request.interaction_mode == "scheduled_task" and request.agent_id:
        draft = detect_scheduled_task_draft(
            db,
            request.tenant_id,
            request.agent_id,
            request.user_id,
            request.message,
            response.session_id,
            request.client_timezone,
            language_context=request.language_context,
        )
        if draft and draft.should_create:
            _persist_scheduled_task_draft(
                db,
                request.tenant_id,
                response.session_id,
                draft,
                language_context=request.language_context,
            )
    return response


@router.post("/stream")
def chat_stream(
    request: ChatTurnRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> StreamingResponse:
    """Stream one authenticated chat turn while sanitizing persisted replay and failure events."""
    _ensure_request_tenant(request.tenant_id, current_user)
    request = request.model_copy(
        update={
            "user_id": current_user.id,
            "context_injection": None,
            "message_visibility": "visible",
        }
    )
    request = _validate_chat_turn_attachments(request)
    ensure_tenant(db, request.tenant_id)
    team_tl_team_id: str | None = None
    if request.session_id:
        chat_session = _ensure_chat_session_available(db, request.tenant_id, current_user.id, request.session_id)
        _ensure_team_session_human_writable(chat_session)
        request = _bind_request_to_session_agent(db, request, chat_session, current_user)
        team_tl_team = _team_tl_session_team(db, chat_session)
        team_tl_team_id = team_tl_team.id if team_tl_team is not None else None
    else:
        _ensure_chat_agent_available(db, request.tenant_id, request.agent_id, current_user)
    if not request.message.strip() and not request.attachments:
        raise _chat_error("CHAT_MESSAGE_REQUIRED", 400)
    original_message = request.message
    if team_tl_team_id is not None:
        # 团队 TL 会话:注入团队上下文(花名册/未闭环任务/黑板/派任务格式)后再走正常引擎
        request = request.model_copy(
            update={
                "context_injection": build_tl_chat_context(
                    db, db.get(Team, team_tl_team_id), original_message
                ),
                "interaction_mode": "team_tl",
            }
        )

    relay_ready = threading.Event()
    worker_done = threading.Event()
    source_session_id = {"value": request.session_id or ""}
    worker_terminal = {"seen": False}
    initial_cursor = _latest_event_cursor(db, request.tenant_id, request.session_id) if request.session_id else None

    def set_source_session(session_id: str) -> None:
        if not session_id:
            return
        source_session_id["value"] = session_id
        relay_ready.set()

    if source_session_id["value"]:
        relay_ready.set()

    def run_stream_worker() -> None:
        span_sink_token = None
        try:
            with Session(engine) as worker_db:
                span_turn_id = {"value": ""}

                def persist_span(event_type: str, payload: dict[str, object]) -> None:
                    session_id = source_session_id["value"] or request.session_id or ""
                    if not session_id:
                        return
                    turn_id = span_turn_id["value"]
                    event_payload = dict(payload)
                    if turn_id:
                        event_payload.setdefault("turn_id", turn_id)
                        event_payload.setdefault("user_message_id", turn_id)
                    if request.client_turn_id:
                        event_payload.setdefault("client_turn_id", request.client_turn_id)
                    context_payload = _language_context_payload(request)
                    if context_payload:
                        event_payload.setdefault("language_context", context_payload["language_context"])
                    _persist_relay_only_event(
                        worker_db,
                        request.tenant_id,
                        session_id,
                        event_type,
                        event_payload,
                    )

                span_sink_token = set_span_sink(persist_span)
                ensure_tenant(worker_db, request.tenant_id)
                if request.session_id:
                    chat_session = _ensure_chat_session_available(
                        worker_db,
                        request.tenant_id,
                        request.user_id,
                        request.session_id,
                    )
                    existing_turn = None
                    client_turn_id = str(request.client_turn_id or "").strip()
                    if client_turn_id:
                        existing_turn = worker_db.exec(
                            select(HarnessTurnRecord).where(
                                HarnessTurnRecord.tenant_id == chat_session.tenant_id,
                                HarnessTurnRecord.session_id == chat_session.id,
                                HarnessTurnRecord.client_turn_id == client_turn_id,
                            )
                        ).first()
                    _prepare_turn_language_context(
                        worker_db,
                        chat_session,
                        request,
                        existing=existing_turn,
                    )
                    if request.interaction_mode == "scheduled_task":
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            chat_session.id,
                            "stream_status",
                            {
                                **_language_context_payload(request),
                                "phase": "scheduled_task_intent",
                                "code": "chat.scheduled.intent",
                                "params": {},
                            },
                        )
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            chat_session.id,
                            "stream_status",
                            {
                                **_language_context_payload(request),
                                "phase": "scheduled_task_parse",
                                "code": "chat.scheduled.plan",
                                "params": {},
                            },
                        )
                    scheduled_response = _maybe_handle_scheduled_task_request(worker_db, request, chat_session)
                    if scheduled_response:
                        response, draft = scheduled_response
                        set_source_session(response.session_id)
                        message_id, client_turn_id = _resolve_turn_ids_from_events(
                            worker_db,
                            request.tenant_id,
                            response.session_id,
                            request.client_turn_id or "",
                        )
                        turn_payload = {
                            **_language_context_payload(request),
                            "turn_id": message_id,
                            "user_message_id": message_id,
                            "client_turn_id": client_turn_id or None,
                        }
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            response.session_id,
                            "stream_status",
                            {
                                "phase": "scheduled_task_draft",
                                "code": "chat.scheduled.draft",
                                "params": {},
                                **draft.model_dump(mode="json"),
                                **turn_payload,
                            },
                        )
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            response.session_id,
                            "scheduled_task_draft",
                            {**draft.model_dump(mode="json"), **turn_payload},
                        )
                        for chunk in _reply_chunks(response.reply):
                            _persist_relay_only_event(
                                worker_db,
                                request.tenant_id,
                                response.session_id,
                                "stream_delta",
                                {"content": chunk, **turn_payload},
                            )
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            response.session_id,
                            "stream_end",
                            turn_payload,
                        )
                        _persist_relay_only_event(
                            worker_db,
                            request.tenant_id,
                            response.session_id,
                            "complete",
                            {**response.model_dump(mode="json"), **turn_payload},
                        )
                        worker_terminal["seen"] = True
                        _schedule_session_title_summary(
                            request.tenant_id,
                            request.user_id,
                            response.session_id,
                            request.agent_id,
                            language_context=response.language_context or request.language_context,
                        )
                        return
                for item in AgentLoop(worker_db).handle_turn_stream(request):
                    event_name = str(item["event"])
                    data = item["data"] if isinstance(item.get("data"), dict) else {}
                    item_session_id = str(data.get("sessionId") or request.session_id or source_session_id["value"] or "")
                    if item_session_id:
                        set_source_session(item_session_id)
                    if event_name == "session_created" and item_session_id:
                        _persist_relay_only_event(worker_db, request.tenant_id, item_session_id, event_name, data)
                    elif event_name == "complete" and item_session_id:
                        _persist_relay_only_event(worker_db, request.tenant_id, item_session_id, event_name, data)
                        worker_terminal["seen"] = True
                    elif event_name in {"stream_cancelled", "stream_interrupted", "error", "error_occurred"}:
                        worker_terminal["seen"] = True
                    if item["event"] == "user_message_received":
                        event_source_session_id = str(item["data"].get("sessionId") or request.session_id or "")
                        set_source_session(event_source_session_id)
                        span_turn_id["value"] = str(
                            data.get("turn_id")
                            or data.get("user_message_id")
                            or data.get("message_id")
                            or ""
                        )
                        _schedule_session_title_summary(
                            request.tenant_id,
                            request.user_id,
                            event_source_session_id,
                            request.agent_id,
                            language_context=request.language_context,
                        )
                        continue
                    if item["event"] == "complete":
                        event_source_session_id = str(item["data"].get("sessionId") or request.session_id or "")
                        _schedule_session_title_summary(
                            request.tenant_id,
                            request.user_id,
                            event_source_session_id,
                            request.agent_id,
                            language_context=request.language_context,
                        )
                        if team_tl_team_id is not None:
                            # 团队 TL 会话:complete 后做派任务后处理(与 tl_chat 端点同语义);
                            # 后处理失败不影响本轮回复
                            try:
                                tl_team = worker_db.get(Team, team_tl_team_id)
                                tl_session = worker_db.get(
                                    ChatSession, event_source_session_id or request.session_id or ""
                                )
                                tl_user = worker_db.get(User, request.user_id) if request.user_id else None
                                if tl_team is not None and tl_session is not None and tl_user is not None:
                                    process_tl_reply(
                                        worker_db,
                                        team=tl_team,
                                        session=tl_session,
                                        user=tl_user,
                                        user_message=original_message,
                                        reply=str(data.get("reply") or ""),
                                        client_turn_id=request.client_turn_id,
                                    )
                            except Exception:
                                logger.exception("team TL reply post-processing failed")
                        if event_source_session_id:
                            summary_payload = _session_title_summary_payload(worker_db, request.tenant_id, event_source_session_id)
                            if summary_payload:
                                _persist_relay_only_event(
                                    worker_db,
                                    request.tenant_id,
                                    event_source_session_id,
                                    SESSION_TITLE_SUMMARY_EVENT,
                                    summary_payload,
                                )
                        if request.interaction_mode != "scheduled_task" or not request.agent_id:
                            continue
                        draft = detect_scheduled_task_draft(
                            worker_db,
                            request.tenant_id,
                            request.agent_id,
                            request.user_id,
                            request.message,
                            event_source_session_id or None,
                            request.client_timezone,
                            language_context=request.language_context,
                        )
                        if draft and draft.should_create:
                            _persist_scheduled_task_draft(
                                worker_db,
                                request.tenant_id,
                                event_source_session_id,
                                draft,
                                language_context=request.language_context,
                            )
                            _persist_relay_only_event(
                                worker_db,
                                request.tenant_id,
                                event_source_session_id,
                                "scheduled_task_draft",
                                {
                                    **draft.model_dump(mode="json"),
                                    **_language_context_payload(request),
                                },
                            )
        except Exception:
            logger.exception("chat stream worker failed")
            session_id = source_session_id["value"] or request.session_id or ""
            if session_id:
                with Session(engine) as error_db:
                    chat_session = error_db.get(ChatSession, session_id)
                    if chat_session:
                        _persist_chat_turn_interrupted(
                            error_db,
                            request.tenant_id,
                            chat_session,
                            request.client_turn_id or "",
                            "INTERNAL_ERROR",
                            language_context=request.language_context,
                        )
                        error_db.commit()
                        worker_terminal["seen"] = True
                        set_source_session(session_id)
        except BaseException as exc:
            logger.exception("chat stream worker stopped with base exception")
            session_id = source_session_id["value"] or request.session_id or ""
            if session_id:
                with Session(engine) as error_db:
                    chat_session = error_db.get(ChatSession, session_id)
                    if chat_session:
                        _persist_chat_turn_interrupted(
                            error_db,
                            request.tenant_id,
                            chat_session,
                            request.client_turn_id or "",
                            "INTERNAL_ERROR",
                            language_context=request.language_context,
                        )
                        error_db.commit()
                        worker_terminal["seen"] = True
                        set_source_session(session_id)
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
        finally:
            if span_sink_token is not None:
                reset_span_sink(span_sink_token)
            session_id = source_session_id["value"] or request.session_id or ""
            if session_id and not worker_terminal["seen"]:
                with Session(engine) as final_db:
                    chat_session = final_db.get(ChatSession, session_id)
                    if chat_session:
                        changed = _persist_chat_turn_interrupted(
                            final_db,
                            request.tenant_id,
                            chat_session,
                            request.client_turn_id or "",
                            "stream worker ended before terminal event",
                            language_context=request.language_context,
                        )
                        if changed:
                            final_db.commit()
                            set_source_session(session_id)
            worker_done.set()

    threading.Thread(target=run_stream_worker, daemon=True).start()

    def stream_events() -> Iterator[str]:
        nonlocal initial_cursor
        relay_ready.wait(15)
        deadline = time.monotonic() + STREAM_RELAY_IDLE_TIMEOUT_SECONDS
        last_heartbeat_at = time.monotonic()
        terminal_sent = False
        internal_relay_turn_ids: set[str] = set()
        while True:
            session_id = source_session_id["value"]
            emitted = False
            if session_id:
                with Session(engine) as relay_db:
                    rows = _events_after_cursor(relay_db, request.tenant_id, session_id, initial_cursor)
                for row in rows:
                    payload = row.payload_json or {}
                    row_turn_ids = {
                        str(payload.get(key) or "").strip()
                        for key in ("turn_id", "user_message_id", "message_id", "client_turn_id")
                        if str(payload.get(key) or "").strip()
                    }
                    if payload.get("message_visibility") == "internal":
                        internal_relay_turn_ids.update(row_turn_ids)
                    event_name, data = _relay_event_payload(row)
                    initial_cursor = (row.created_at, row.id)
                    emitted = True
                    if row_turn_ids & internal_relay_turn_ids:
                        continue
                    yield _sse(event_name, data, row.id)
                    if event_name in STREAM_RELAY_TERMINAL_EVENTS:
                        terminal_sent = True
                if emitted:
                    deadline = time.monotonic() + STREAM_RELAY_IDLE_TIMEOUT_SECONDS
                    last_heartbeat_at = time.monotonic()
            if terminal_sent and worker_done.is_set() and not emitted:
                return
            if worker_done.is_set() and not emitted:
                return
            if time.monotonic() > deadline:
                if session_id:
                    with Session(engine) as timeout_db:
                        chat_session = timeout_db.get(ChatSession, session_id)
                        if chat_session:
                            _persist_chat_turn_interrupted(
                                timeout_db,
                                request.tenant_id,
                                chat_session,
                                request.client_turn_id or "",
                                "stream relay timed out waiting for terminal event",
                                language_context=request.language_context,
                            )
                            timeout_db.commit()
                    continue
                return
            now = time.monotonic()
            if now - last_heartbeat_at >= STREAM_RELAY_HEARTBEAT_SECONDS:
                last_heartbeat_at = now
                yield _sse(
                    "heartbeat",
                    {
                        "phase": "relay",
                        "sessionId": session_id or request.session_id or "",
                    },
                )
            time.sleep(STREAM_RELAY_POLL_SECONDS)

    return StreamingResponse(stream_events(), media_type="text/event-stream")


@router.post("/sessions/{session_id}/cancel")
def cancel_chat_turn_endpoint(
    session_id: str,
    request: ChatTurnCancelRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, bool]:
    _ensure_request_tenant(request.tenant_id, current_user)
    chat_session = _ensure_chat_session_available(db, request.tenant_id, current_user.id, session_id)
    persisted = _persist_chat_turn_cancelled(
        db,
        request.tenant_id,
        chat_session,
        request.turn_id,
        current_user.id,
    )
    db.commit()
    # Publish the process-local fast path only after the durable cancellation
    # event commits. A failed commit must not change the outcome of a retry in
    # this process compared with a fresh worker.
    if persisted:
        cancel_chat_turn(session_id, request.turn_id)
    return {"ok": True}


def _persist_chat_turn_cancelled(
    db: Session,
    tenant_id: str,
    chat_session: ChatSession,
    requested_turn_id: str,
    cancelled_by_user_id: str | None = None,
    *,
    language_context: LanguageContext | None = None,
) -> bool:
    """Persist a cancellation trace and fallback reply with the immutable turn locale snapshot."""
    requested_turn_id = requested_turn_id.strip()
    if not requested_turn_id:
        return False

    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == chat_session.id)
        .order_by(AgentEvent.created_at)
    ).all()
    language_context = language_context or _language_context_for_turn(
        db,
        tenant_id,
        chat_session.id,
        requested_turn_id,
        events=events,
    )
    message_id = ""
    client_turn_id = ""
    for event in reversed(events):
        if event.event_type != "user_message_received":
            continue
        payload = event.payload_json or {}
        candidate_message_id = str(payload.get("message_id") or payload.get("user_message_id") or "").strip()
        candidate_client_turn_id = str(payload.get("client_turn_id") or "").strip()
        if requested_turn_id in {candidate_message_id, candidate_client_turn_id}:
            message_id = candidate_message_id
            client_turn_id = candidate_client_turn_id
            break
    if not message_id:
        message_id = requested_turn_id
        client_turn_id = requested_turn_id

    turn_ids = {message_id}
    if client_turn_id:
        turn_ids.add(client_turn_id)
    for event in events:
        if event.event_type not in {"assistant_message_created", "stream_cancelled"}:
            continue
        payload = event.payload_json or {}
        event_turn_ids = {
            str(payload.get("turn_id") or "").strip(),
            str(payload.get("user_message_id") or "").strip(),
            str(payload.get("message_id") or "").strip(),
            str(payload.get("client_turn_id") or "").strip(),
        }
        matches_message = bool(message_id and message_id in event_turn_ids)
        matches_client_turn = bool(client_turn_id and client_turn_id in event_turn_ids)
        if not matches_message and not matches_client_turn:
            continue
        if event.event_type == "stream_cancelled":
            _cancel_harness_turn_receipt(
                db,
                tenant_id,
                chat_session.id,
                message_id,
                client_turn_id,
            )
            return _ensure_cancelled_assistant_message(
                db,
                tenant_id,
                chat_session,
                message_id,
                client_turn_id,
                event.created_at + timedelta(microseconds=1),
                language_context=language_context,
            )
        return False

    now = utc_now()
    cancelled_reply = localized_cancelled_reply(language_context)
    receipt_cancelled = _cancel_harness_turn_receipt(
        db,
        tenant_id,
        chat_session.id,
        message_id,
        client_turn_id,
    )
    if receipt_cancelled is False:
        # Normal completion already owns the terminal receipt. Do not append a
        # contradictory cancellation event/message after that linearization.
        return False
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=chat_session.id,
            event_type="stream_cancelled",
            payload_json={
                "turn_id": message_id,
                "user_message_id": message_id,
                "client_turn_id": client_turn_id or None,
                "phase": "cancelled",
                "text": cancelled_reply,
                "cancelled_by_user_id": cancelled_by_user_id,
                **(
                    {"language_context": language_context.model_dump(mode="json")}
                    if language_context is not None
                    else {}
                ),
            },
            created_at=now,
        )
    )
    _ensure_cancelled_assistant_message(
        db,
        tenant_id,
        chat_session,
        message_id,
        client_turn_id,
        now + timedelta(microseconds=1),
        language_context=language_context,
    )
    chat_session.status = "active"
    chat_session.updated_at = now
    db.add(chat_session)
    return True


def _cancel_harness_turn_receipt(
    db: Session,
    tenant_id: str,
    session_id: str,
    user_message_id: str,
    client_turn_id: str,
) -> bool | None:
    """Fence the worker in the same transaction as the cancellation event."""

    identities = {value for value in (user_message_id, client_turn_id) if value}
    if not identities:
        return None
    matching = db.exec(
        select(HarnessTurnRecord).where(
            HarnessTurnRecord.tenant_id == tenant_id,
            HarnessTurnRecord.session_id == session_id,
            (
                HarnessTurnRecord.client_turn_id.in_(identities)
                | HarnessTurnRecord.user_message_id.in_(identities)
            ),
        )
    ).first()
    if matching is None:
        return None
    if matching.status == "cancelled":
        return True
    if matching.status != "started":
        return False
    now = utc_now()
    result = db.exec(
        update(HarnessTurnRecord)
        .where(
            HarnessTurnRecord.tenant_id == tenant_id,
            HarnessTurnRecord.session_id == session_id,
            HarnessTurnRecord.status == "started",
            (
                HarnessTurnRecord.client_turn_id.in_(identities)
                | HarnessTurnRecord.user_message_id.in_(identities)
            ),
        )
        .values(
            status="cancelled",
            error_json={
                "code": "CANCELLED",
                "message": "用户取消了当前 Harness 执行。",
            },
            finished_at=now,
            updated_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    return getattr(result, "rowcount", 0) == 1


def _language_context_for_turn(
    db: Session,
    tenant_id: str,
    session_id: str,
    requested_turn_id: str,
    *,
    events: list[AgentEvent] | None = None,
) -> LanguageContext | None:
    """Recover only an explicitly persisted locale snapshot, never infer one from message text."""
    requested_turn_id = requested_turn_id.strip()
    if not requested_turn_id:
        return None
    event_rows = events
    if event_rows is None:
        event_rows = db.exec(
            select(AgentEvent)
            .where(
                AgentEvent.tenant_id == tenant_id,
                AgentEvent.session_id == session_id,
            )
            .order_by(AgentEvent.created_at.desc())
        ).all()
    for event in event_rows:
        payload = event.payload_json or {}
        event_turn_ids = {
            str(payload.get(key) or "").strip()
            for key in ("turn_id", "user_message_id", "message_id", "client_turn_id")
            if str(payload.get(key) or "").strip()
        }
        if requested_turn_id and requested_turn_id not in event_turn_ids:
            continue
        raw_context = payload.get("language_context")
        if isinstance(raw_context, dict):
            try:
                return LanguageContext.model_validate(raw_context)
            except (TypeError, ValueError):
                continue
    record = db.exec(
        select(HarnessTurnRecord).where(
            HarnessTurnRecord.tenant_id == tenant_id,
            HarnessTurnRecord.session_id == session_id,
            or_(
                HarnessTurnRecord.client_turn_id == requested_turn_id,
                HarnessTurnRecord.user_message_id == requested_turn_id,
            ),
        )
    ).first()
    raw_context = record.language_context_json if record is not None else None
    if not isinstance(raw_context, dict):
        return None
    try:
        return LanguageContext.model_validate(raw_context)
    except (TypeError, ValueError):
        pass

    # A legacy/partially committed stream may have the snapshot on its message metadata
    # before the matching event or receipt is visible; inspect only the exact turn IDs.
    message_rows = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
        .order_by(Message.created_at.desc())
    ).all()
    for message in message_rows:
        metadata = message.metadata_json or {}
        metadata_turn_ids = {
            str(metadata.get(key) or "").strip()
            for key in ("turn_id", "user_message_id", "client_turn_id")
            if str(metadata.get(key) or "").strip()
        }
        if message.id != requested_turn_id and requested_turn_id not in metadata_turn_ids:
            continue
        raw_context = metadata.get("language_context")
        if isinstance(raw_context, dict):
            try:
                return LanguageContext.model_validate(raw_context)
            except (TypeError, ValueError):
                continue
    return None


def _safe_interruption_code(reason: object) -> str:
    """Reduce a worker interruption marker to a registered public code only."""
    candidate = reason.strip() if isinstance(reason, str) else ""
    if candidate == "LLM_ERROR":
        return "MODEL_UPSTREAM_ERROR"
    entry = ERROR_REGISTRY.get(candidate)
    if entry is None:
        return "INTERNAL_ERROR"
    return entry.code


def _ensure_cancelled_assistant_message(
    db: Session,
    tenant_id: str,
    chat_session: ChatSession,
    user_message_id: str,
    client_turn_id: str,
    created_at,
    *,
    language_context: LanguageContext | None = None,
) -> bool:
    """Create one cancellation assistant message while retaining its turn locale snapshot."""
    user_message = db.get(Message, user_message_id)
    if not user_message or user_message.tenant_id != tenant_id or user_message.session_id != chat_session.id:
        return False
    if user_message.role != "user":
        return False

    turn_ids = {user_message_id}
    if client_turn_id:
        turn_ids.add(client_turn_id)
    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == chat_session.id, Message.role == "assistant")
        .order_by(Message.created_at)
    ).all()
    for message_row in messages:
        metadata = message_row.metadata_json or {}
        row_turn_ids = {
            str(metadata.get("turn_id") or "").strip(),
            str(metadata.get("user_message_id") or "").strip(),
            str(metadata.get("client_turn_id") or "").strip(),
        }
        if turn_ids & row_turn_ids:
            return False

    cancelled_reply = localized_cancelled_reply(language_context)
    assistant_message = Message(
        tenant_id=tenant_id,
        session_id=chat_session.id,
        role="assistant",
        content=cancelled_reply,
        metadata_json={
            "turn_id": user_message_id,
            "user_message_id": user_message_id,
            "client_turn_id": client_turn_id or None,
            "status": "cancelled",
            **(
                {"language_context": language_context.model_dump(mode="json")}
                if language_context is not None
                else {}
            ),
        },
        created_at=created_at,
    )
    db.add(assistant_message)
    stage_channel_delivery(db, chat_session, assistant_message)
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=chat_session.id,
            event_type="assistant_message_created",
            payload_json={
                "message_id": assistant_message.id,
                "assistant_message_id": assistant_message.id,
                "user_message_id": user_message_id,
                "turn_id": user_message_id,
                "client_turn_id": client_turn_id or None,
                "reply": cancelled_reply,
                "status": "cancelled",
                **(
                    {"language_context": language_context.model_dump(mode="json")}
                    if language_context is not None
                    else {}
                ),
            },
            created_at=created_at,
        )
    )
    summary_prefix = localized_compat_text(
        language_context,
        zh_cn="最近回复：",
        en_us="Latest reply: ",
    )
    chat_session.summary = f"{summary_prefix}{cancelled_reply}"
    chat_session.updated_at = created_at
    db.add(chat_session)
    return True


def _persist_chat_turn_interrupted(
    db: Session,
    tenant_id: str,
    chat_session: ChatSession,
    requested_turn_id: str,
    reason: str,
    error_details: dict[str, object] | None = None,
    *,
    language_context: LanguageContext | None = None,
) -> bool:
    """Persist interruption trace and fallback reply with the immutable turn locale snapshot."""
    del error_details
    message_id, client_turn_id = _resolve_turn_ids_from_events(db, tenant_id, chat_session.id, requested_turn_id)
    if not message_id:
        message_id = requested_turn_id.strip()
    if not message_id:
        return False

    language_context = language_context or _language_context_for_turn(
        db,
        tenant_id,
        chat_session.id,
        requested_turn_id,
    )

    if _turn_has_terminal_event(db, tenant_id, chat_session.id, message_id, client_turn_id):
        return False

    now = utc_now()
    safe_code = _safe_interruption_code(reason)
    payload = {
        "turn_id": message_id,
        "user_message_id": message_id,
        "client_turn_id": client_turn_id or None,
        "phase": "interrupted",
        "code": safe_code,
        "message": safe_code,
        "text": localized_interrupted_reply(language_context),
        "retryable": True,
    }
    if language_context is not None:
        payload["language_context"] = language_context.model_dump(mode="json")
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=chat_session.id,
            event_type="stream_interrupted",
            payload_json=payload,
            created_at=now,
        )
    )
    _ensure_interrupted_assistant_message(
        db,
        tenant_id,
        chat_session,
        message_id,
        client_turn_id,
        now + timedelta(microseconds=1),
        language_context=language_context,
    )
    chat_session.status = "active"
    chat_session.updated_at = now
    db.add(chat_session)
    return True


def _resolve_turn_ids_from_events(
    db: Session,
    tenant_id: str,
    session_id: str,
    requested_turn_id: str,
) -> tuple[str, str]:
    requested_turn_id = requested_turn_id.strip()
    if not requested_turn_id:
        return "", ""
    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == session_id)
        .order_by(AgentEvent.created_at)
    ).all()
    for event in reversed(events):
        if event.event_type != "user_message_received":
            continue
        payload = event.payload_json or {}
        candidate_message_id = str(payload.get("message_id") or payload.get("user_message_id") or "").strip()
        candidate_client_turn_id = str(payload.get("client_turn_id") or "").strip()
        if requested_turn_id in {candidate_message_id, candidate_client_turn_id}:
            return candidate_message_id, candidate_client_turn_id
    return requested_turn_id, requested_turn_id


def _turn_has_terminal_event(
    db: Session,
    tenant_id: str,
    session_id: str,
    message_id: str,
    client_turn_id: str = "",
) -> bool:
    turn_ids = {message_id}
    if client_turn_id:
        turn_ids.add(client_turn_id)
    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == session_id)
        .order_by(AgentEvent.created_at)
    ).all()
    for event in events:
        if event.event_type not in {
            "assistant_message_created",
            "complete",
            "error_occurred",
            "stream_cancelled",
            "stream_interrupted",
        }:
            continue
        payload = event.payload_json or {}
        event_turn_ids = {
            str(payload.get("turn_id") or "").strip(),
            str(payload.get("user_message_id") or "").strip(),
            str(payload.get("message_id") or "").strip(),
            str(payload.get("client_turn_id") or "").strip(),
        }
        if turn_ids & event_turn_ids:
            return True
    return False


def _ensure_interrupted_assistant_message(
    db: Session,
    tenant_id: str,
    chat_session: ChatSession,
    user_message_id: str,
    client_turn_id: str,
    created_at,
    *,
    language_context: LanguageContext | None = None,
) -> bool:
    """Create one interrupted assistant message while retaining its turn locale snapshot."""
    user_message = db.get(Message, user_message_id)
    if not user_message or user_message.tenant_id != tenant_id or user_message.session_id != chat_session.id:
        return False
    if user_message.role != "user":
        return False

    turn_ids = {user_message_id}
    if client_turn_id:
        turn_ids.add(client_turn_id)
    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == chat_session.id, Message.role == "assistant")
        .order_by(Message.created_at)
    ).all()
    for message_row in messages:
        metadata = message_row.metadata_json or {}
        row_turn_ids = {
            str(metadata.get("turn_id") or "").strip(),
            str(metadata.get("user_message_id") or "").strip(),
            str(metadata.get("client_turn_id") or "").strip(),
        }
        if turn_ids & row_turn_ids:
            return False

    interrupted_reply = localized_interrupted_reply(language_context)
    assistant_message = Message(
        tenant_id=tenant_id,
        session_id=chat_session.id,
        role="assistant",
        content=interrupted_reply,
        metadata_json={
            "turn_id": user_message_id,
            "user_message_id": user_message_id,
            "client_turn_id": client_turn_id or None,
            "status": "interrupted",
            **(
                {"language_context": language_context.model_dump(mode="json")}
                if language_context is not None
                else {}
            ),
        },
        created_at=created_at,
    )
    db.add(assistant_message)
    stage_channel_delivery(db, chat_session, assistant_message)
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=chat_session.id,
            event_type="assistant_message_created",
            payload_json={
                "message_id": assistant_message.id,
                "assistant_message_id": assistant_message.id,
                "user_message_id": user_message_id,
                "turn_id": user_message_id,
                "client_turn_id": client_turn_id or None,
                "reply": interrupted_reply,
                "status": "interrupted",
                **(
                    {"language_context": language_context.model_dump(mode="json")}
                    if language_context is not None
                    else {}
                ),
            },
            created_at=created_at,
        )
    )
    summary_prefix = localized_compat_text(
        language_context,
        zh_cn="最近回复：",
        en_us="Latest reply: ",
    )
    chat_session.summary = f"{summary_prefix}{interrupted_reply}"
    chat_session.updated_at = created_at
    db.add(chat_session)
    return True


def _persist_relay_only_event(
    db: Session,
    tenant_id: str,
    session_id: str,
    event_type: str,
    payload: dict[str, object],
) -> None:
    db.add(
        AgentEvent(
            tenant_id=tenant_id,
            session_id=session_id,
            event_type=event_type,
            payload_json=payload,
        )
    )
    db.commit()


def _relay_event_payload(row: AgentEvent) -> tuple[str, dict[str, object]]:
    """Build one streaming replay envelope while fail-closing any legacy raw error payloads."""
    payload = _sanitized_session_event_payload(row.event_type, row.payload_json or {})
    event_name = STREAM_RELAY_EVENT_ALIASES.get(row.event_type, row.event_type)
    data: dict[str, object] = {
        "kind": event_name,
        "sessionId": row.session_id,
        "timestamp": row.created_at.isoformat(),
        "provider": "skill",
        **payload,
    }
    return event_name, data


def _project_error_candidate(
    candidate: object,
    *,
    source: str,
    default_code: str,
    retryable: bool,
) -> dict[str, JsonValue]:
    """Project a raw or partially structured error candidate to a safe public descriptor."""
    code = default_code
    params: dict[str, JsonValue] = {}
    request_id: str | None = None
    trace_id: str | None = None
    internal_message: str | None = None
    if isinstance(candidate, BaseException):
        internal_message = str(candidate)[:500]
    elif isinstance(candidate, dict):
        candidate_code = candidate.get("code")
        candidate_params = candidate.get("params")
        if isinstance(candidate_code, str) and candidate_code.isupper():
            code = _LEGACY_PUBLIC_ERROR_ALIASES.get(candidate_code, candidate_code)
        if isinstance(candidate_params, dict):
            params = {
                str(key): value
                for key, value in candidate_params.items()
                if isinstance(key, str)
            }
        if isinstance(candidate.get("retryable"), bool):
            retryable = candidate["retryable"]
        request_value = candidate.get("request_id")
        trace_value = candidate.get("trace_id")
        request_id = request_value if isinstance(request_value, str) and request_value else None
        trace_id = trace_value if isinstance(trace_value, str) and trace_value else None
        message_value = candidate.get("message") or candidate.get("detail")
        internal_message = (
            str(message_value)[:500]
            if isinstance(message_value, str) and message_value
            else str(candidate)[:500]
        )
    elif candidate is not None:
        internal_message = str(candidate)[:500]
    entry = ERROR_REGISTRY.get(code)
    if entry is None:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        params = {}
    occurrence = ErrorOccurrence(
        descriptor=ErrorDescriptor(
            code=entry.code,
            params=params,
            retryable=retryable,
            request_id=request_id,
            trace_id=trace_id,
        ),
        internal=InternalErrorContext(
            source=source,
            raw_message=internal_message,
        ),
    )
    return project_public_error(occurrence, ERROR_REGISTRY)


def _language_context_from_payload(payload: dict[str, object]) -> LanguageContext | None:
    """Read a valid immutable locale snapshot from an event without inferring from prose."""
    value = payload.get("language_context")
    if not isinstance(value, dict):
        return None
    try:
        return LanguageContext.model_validate(value)
    except (TypeError, ValueError):
        return None


_FAILURE_RAW_PAYLOAD_FIELDS = frozenset(
    {
        "content",
        "data",
        "diagnostic",
        "detail",
        "error_details",
        "error_json",
        "error_traceback",
        "error_type",
        "failure_reason",
        "last_error",
        "message",
        "output",
        "rationale",
        "reason",
        "reply",
        "reply_fragment",
        "review",
        "result",
        "stderr",
        "stderr_preview",
        "stdout",
        "stdout_preview",
        "structured_result",
        "text",
        "traceback",
    }
)


def _scrub_failure_payload(
    value: object,
    *,
    source: str,
    default_code: str,
    retryable: bool,
) -> object:
    """Recursively remove failure prose while retaining only canonical nested error descriptors."""
    if isinstance(value, dict):
        scrubbed: dict[str, object] = {}
        for key, child in value.items():
            if not isinstance(key, str) or key in _FAILURE_RAW_PAYLOAD_FIELDS:
                continue
            if key == "error":
                scrubbed[key] = _project_error_candidate(
                    child,
                    source=source,
                    default_code=default_code,
                    retryable=retryable,
                )
            else:
                scrubbed[key] = _scrub_failure_payload(
                    child,
                    source=source,
                    default_code=default_code,
                    retryable=retryable,
                )
        return scrubbed
    if isinstance(value, list):
        return [
            _scrub_failure_payload(
                item,
                source=source,
                default_code=default_code,
                retryable=retryable,
            )
            for item in value
        ]
    return value


def _sanitized_session_event_payload(
    event_type: str,
    payload: dict[str, object],
) -> dict[str, object]:
    """Fail closed raw error fields on authenticated session detail, list, and replay paths."""
    safe_payload = dict(payload)
    phase = str(safe_payload.get("phase") or "").strip()
    error_value = safe_payload.get("error")
    if event_type == "human_handoff_resume_failed":
        descriptor = _project_error_candidate(
            error_value,
            source="chat.handoff_resume",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
        safe_payload = _scrub_failure_payload(
            safe_payload,
            source="chat.handoff_resume",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
        if not isinstance(safe_payload, dict):
            safe_payload = {}
        safe_payload["error"] = descriptor
    elif event_type == "auto_route_decision":
        if error_value not in (None, ""):
            descriptor = _project_error_candidate(
                error_value,
                source="channel.auto_route",
                default_code="INTERNAL_ERROR",
                retryable=False,
            )
            safe_payload = _scrub_failure_payload(
                safe_payload,
                source="channel.auto_route",
                default_code="INTERNAL_ERROR",
                retryable=False,
            )
            if not isinstance(safe_payload, dict):
                safe_payload = {}
            safe_payload["error"] = descriptor
    if event_type in {"error_occurred", "stream_interrupted"} or (
        event_type == "stream_status" and phase == "error"
    ):
        descriptor = _project_error_candidate(
            safe_payload,
            source=f"chat.{event_type}",
            default_code="INTERNAL_ERROR",
            retryable=event_type == "stream_interrupted",
        )
        safe_payload = _scrub_failure_payload(
            safe_payload,
            source=f"chat.{event_type}",
            default_code="INTERNAL_ERROR",
            retryable=event_type == "stream_interrupted",
        )
        if not isinstance(safe_payload, dict):
            safe_payload = {}
        safe_payload.update(
            {
                "code": descriptor["code"],
                "message": descriptor["code"],
                "params": descriptor["params"],
                "retryable": descriptor["retryable"],
                "error": descriptor,
            }
        )
        for key in (
            "reason",
            "detail",
            "error_details",
            "error_type",
            "error_traceback",
            "traceback",
            "stderr_preview",
        ):
            safe_payload.pop(key, None)
        if event_type == "stream_interrupted":
            safe_payload["text"] = localized_interrupted_reply(
                _language_context_from_payload(safe_payload)
            )
    if event_type == "general_skill_trace" and _general_skill_trace_failed(phase):
        safe_payload = _scrub_failure_payload(
            safe_payload,
            source="chat.general_skill_trace",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
        if not isinstance(safe_payload, dict):
            safe_payload = {}
        safe_message = localized_compat_text(
            _language_context_from_payload(safe_payload),
            zh_cn="执行失败",
            en_us="Execution failed",
        )
        safe_payload["message"] = safe_message
        safe_payload["rationale"] = safe_message
        safe_payload["text"] = safe_message
        safe_payload["error"] = _project_error_candidate(
            payload.get("error") or payload,
            source="chat.general_skill_trace",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
    if event_type in {"tool_result", "tool_call_finished"}:
        success = safe_payload.get("success")
        is_error = bool(safe_payload.get("isError")) if success is None else not bool(success)
        if is_error:
            descriptor = _project_error_candidate(
                safe_payload.get("error")
                or safe_payload.get("content")
                or safe_payload,
                source=f"chat.{event_type}",
                default_code="TOOL_UPSTREAM_ERROR",
                retryable=True,
            )
            scrubbed_payload = _scrub_failure_payload(
                safe_payload,
                source=f"chat.{event_type}",
                default_code="TOOL_UPSTREAM_ERROR",
                retryable=True,
            )
            if isinstance(scrubbed_payload, dict):
                safe_payload = scrubbed_payload
            safe_payload["error"] = descriptor
            if event_type == "tool_result":
                safe_payload["content"] = {"error": descriptor}
            else:
                safe_payload.pop("content", None)
    data = safe_payload.get("data")
    if isinstance(data, dict) and "error" in safe_payload:
        next_data = dict(data)
        next_data["error"] = safe_payload["error"]
        safe_payload["data"] = next_data
    return safe_payload


def _sanitized_span_payload(
    event_type: str,
    payload: dict[str, object],
) -> dict[str, object]:
    """Fail closed legacy span errors while preserving normal timing and language metadata."""
    safe_payload = dict(payload)
    if event_type.endswith("_failed"):
        descriptor = _project_error_candidate(
            safe_payload.get("error") or safe_payload,
            source="observability.span",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
        scrubbed_payload = _scrub_failure_payload(
            safe_payload,
            source="observability.span",
            default_code="INTERNAL_ERROR",
            retryable=False,
        )
        if isinstance(scrubbed_payload, dict):
            safe_payload = scrubbed_payload
        safe_payload["error"] = descriptor
        safe_payload.pop("error_type", None)
    return safe_payload


def _events_after_cursor(
    db: Session,
    tenant_id: str,
    session_id: str,
    cursor: tuple[object, str] | None,
) -> list[AgentEvent]:
    statement = select(AgentEvent).where(
        AgentEvent.tenant_id == tenant_id,
        AgentEvent.session_id == session_id,
        AgentEvent.event_type.notin_(SPAN_EVENT_TYPES),
    )
    if cursor:
        last_created_at, last_id = cursor
        statement = statement.where(
            or_(
                AgentEvent.created_at > last_created_at,
                (AgentEvent.created_at == last_created_at) & (AgentEvent.id > last_id),
            )
        )
    return db.exec(statement.order_by(AgentEvent.created_at, AgentEvent.id).limit(200)).all()


def _latest_event_cursor(db: Session, tenant_id: str, session_id: str) -> tuple[object, str] | None:
    row = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == session_id)
        .order_by(AgentEvent.created_at.desc(), AgentEvent.id.desc())
        .limit(1)
    ).first()
    if not row:
        return None
    return row.created_at, row.id


def _sse(event: object, data: object, event_id: str | None = None) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    id_line = f"id: {event_id}\n" if event_id else ""
    return f"{id_line}event: {event}\ndata: {payload}\n\n"


@router.post("/sessions", response_model=ChatSessionRead)
def create_chat_session(
    request: ChatSessionCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ChatSessionRead:
    """Create a session with the user's reply-language preference as its initial authority."""
    _ensure_request_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_chat_agent_available(db, request.tenant_id, request.agent_id, current_user)
    title = _normalize_title(request.title)
    row = ChatSession(
        id=new_id("session"),
        tenant_id=request.tenant_id,
        user_id=current_user.id,
        agent_id=request.agent_id,
        title=title,
        agent_reply_locale=current_user.agent_reply_locale,
        agent_reply_locale_source=(
            "user_preference" if current_user.agent_reply_locale else None
        ),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return session_read(row)


@router.get("/sessions", response_model=list[ChatSessionRead])
def list_chat_sessions(
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ChatSessionRead]:
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    rows = list(
        db.exec(
            select(ChatSession)
            .where(
                ChatSession.tenant_id == tenant_id,
                or_(
                    ChatSession.channel.is_(None),
                    ChatSession.channel != "skill_test",
                ),
                or_(
                    and_(
                        ChatSession.user_id == current_user.id,
                        ChatSession.team_id.is_(None),
                    ),
                    and_(
                        ChatSession.team_id.is_not(None),
                        team_tl_session_filter(),
                    ),
                ),
            )
            .order_by(ChatSession.updated_at.desc())
        )
        .all()
    )
    if not is_admin_user(current_user):
        team_ids = {row.team_id for row in rows if row.team_id}
        owned_team_ids = (
            {
                team.id
                for team in db.exec(
                    select(Team).where(
                        Team.id.in_(team_ids),
                        Team.owner_user_id == current_user.id,
                    )
                ).all()
            }
            if team_ids
            else set()
        )
        rows = [
            row
            for row in rows
            if not row.team_id or row.user_id == current_user.id or row.team_id in owned_team_ids
        ]
    hidden_session_ids = pilotdeck_origin_session_ids(
        db,
        tenant_id,
        (row.id for row in rows),
    )
    rows = [row for row in rows if row.id not in hidden_session_ids]
    _cleanup_stale_completed_sessions(db, tenant_id, rows)
    scheduled_session_ids = {
        session_id
        for session_id in db.exec(
            select(ScheduledTaskRun.session_id).where(
                ScheduledTaskRun.tenant_id == tenant_id,
                ScheduledTaskRun.user_id == current_user.id,
                ScheduledTaskRun.session_id.is_not(None),
            )
        ).all()
        if session_id
    }
    team_ids = {row.team_id for row in rows if row.team_id}
    team_names = {
        team.id: team.name
        for team in db.exec(select(Team).where(Team.id.in_(team_ids))).all()
    } if team_ids else {}
    return [
        session_read(
            row,
            is_scheduled=row.id in scheduled_session_ids,
            team_name=team_names.get(row.team_id) if row.team_id else None,
        )
        for row in rows
    ]


@router.get("/sessions/{session_id}", response_model=ChatSessionRead)
def get_chat_session(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ChatSessionRead:
    """Read one conversation without adding team sessions to the global list."""
    _ensure_request_tenant(tenant_id, current_user)
    row = _get_readable_chat_session(db, tenant_id, current_user, session_id)
    team = db.get(Team, row.team_id) if row.team_id else None
    return session_read(row, team_name=team.name if team else None)


@router.put("/sessions/{session_id}", response_model=ChatSessionRead)
def rename_chat_session(
    session_id: str,
    request: ChatSessionUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ChatSessionRead:
    _ensure_request_tenant(request.tenant_id, current_user)
    row = _get_user_chat_session(db, request.tenant_id, current_user.id, session_id)
    row.title = _normalize_title(request.title)
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    is_scheduled = db.exec(
        select(ScheduledTaskRun.id).where(
            ScheduledTaskRun.tenant_id == request.tenant_id,
            ScheduledTaskRun.user_id == current_user.id,
            ScheduledTaskRun.session_id == row.id,
        )
    ).first() is not None
    team = db.get(Team, row.team_id) if row.team_id else None
    return session_read(row, is_scheduled=is_scheduled, team_name=team.name if team else None)


@router.delete("/sessions/{session_id}")
def delete_chat_session(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    """Delete one user's chat session and then remove its captured Harness workspace roots."""

    _ensure_request_tenant(tenant_id, current_user)
    row = _get_user_chat_session(db, tenant_id, current_user.id, session_id)
    harness_cleanup = purge_chat_session_records(db, row)
    db.commit()
    remove_chat_session_workspace(
        tenant_id=tenant_id,
        session_id=session_id,
        db=db,
        workspace_roots=harness_cleanup.workspace_roots,
    )
    return {"status": "deleted"}


@router.get("/sessions/{session_id}/messages", response_model=list[MessageRead])
def list_chat_messages(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[MessageRead]:
    _ensure_request_tenant(tenant_id, current_user)
    chat_session = _get_readable_chat_session(db, tenant_id, current_user, session_id)
    _cleanup_stale_completed_sessions(db, tenant_id, [chat_session])
    rows = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
        .order_by(Message.created_at)
    ).all()
    events = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.session_id == session_id,
            AgentEvent.event_type.in_(["user_message_received", "assistant_message_created"]),  # type: ignore[attr-defined]
        )
        .order_by(AgentEvent.created_at)
    ).all()
    turn_ids_by_message = _message_turn_ids_from_events(events)
    rows = visible_message_rows(rows)
    feedback_by_message = _feedback_by_message(db, tenant_id, current_user.id, [row.id for row in rows])
    return [
        message_read(
            row,
            feedback_by_message.get(row.id),
            turn_ids_by_message.get(row.id),
            db,
            content_override=visible_message_content(row),
        )
        for row in rows
    ]


@router.get("/sessions/{session_id}/artifacts/{task_frame_id}")
def download_harness_artifact(
    session_id: str,
    task_frame_id: str,
    tenant_id: str = Query(...),
    path: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> StreamingResponse:
    """Download a file explicitly published by a Harness TaskFrame."""

    _ensure_request_tenant(tenant_id, current_user)
    _get_readable_chat_session(db, tenant_id, current_user, session_id)
    frame = db.exec(
        select(HarnessTaskFrameRecord).where(
            HarnessTaskFrameRecord.tenant_id == tenant_id,
            HarnessTaskFrameRecord.session_id == session_id,
            HarnessTaskFrameRecord.task_id == task_frame_id,
        )
    ).first()
    if frame is None:
        raise _chat_error("CHAT_ARTIFACT_NOT_FOUND", 404)
    artifact = _published_workspace_artifact(
        db,
        tenant_id=tenant_id,
        session_id=session_id,
        task_frame_id=task_frame_id,
        requested_path=path,
    )
    if artifact is None:
        raise _chat_error("CHAT_ARTIFACT_NOT_FOUND", 404)

    opened = None
    try:
        opened, _workspace_root = open_harness_task_artifact(
            tenant_id=tenant_id,
            session_id=session_id,
            task_frame_id=task_frame_id,
            path=path,
            db=db,
        )
        digest = opened.sha256()
        expected_digest = str(artifact.get("sha256") or "").strip().lower()
        expected_size = artifact.get("size")
        if (
            (expected_digest and expected_digest != digest.lower())
            or (isinstance(expected_size, int) and expected_size != opened.size)
        ):
            opened.close()
            raise _chat_error("CHAT_ARTIFACT_CHANGED", 409)
    except HarnessWorkspaceArtifactConflictError as exc:
        if opened is not None:
            opened.close()
        raise _chat_error("CHAT_ARTIFACT_LOCATION_CONFLICT", 409, cause=exc) from None
    except (HarnessArtifactAccessError, OSError) as exc:
        if opened is not None:
            opened.close()
        raise _chat_error("CHAT_ARTIFACT_NOT_FOUND", 404, cause=exc) from None

    filename = _safe_artifact_download_name(
        str(artifact.get("display_name") or opened.filename)
    )
    fallback_filename = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("._")
    fallback_filename = (fallback_filename or "artifact")[:120]
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return StreamingResponse(
        opened.iter_bytes(),
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": (
                f'attachment; filename="{fallback_filename}"; '
                f"filename*=UTF-8''{quote(filename, safe='')}"
            ),
            "Content-Length": str(opened.size),
            "ETag": f'"sha256:{digest}"',
            "X-Content-Type-Options": "nosniff",
        },
        background=BackgroundTask(opened.close),
    )


@router.get("/sessions/{session_id}/events")
def list_chat_session_events(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[dict]:
    _ensure_request_tenant(tenant_id, current_user)
    _get_readable_chat_session(db, tenant_id, current_user, session_id)
    messages = db.exec(
        select(Message).where(
            Message.tenant_id == tenant_id,
            Message.session_id == session_id,
        )
    ).all()
    internal_turn_ids = internal_message_turn_ids(messages)
    rows = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.session_id == session_id,
        )
        .order_by(AgentEvent.created_at)
        .limit(500)
    ).all()
    if internal_turn_ids:
        rows = [
            row
            for row in rows
            if str(
                (row.payload_json or {}).get("turn_id")
                or (row.payload_json or {}).get("user_message_id")
                or (row.payload_json or {}).get("message_id")
                or ""
            ).strip()
            not in internal_turn_ids
        ]
    return [_normalized_session_event_payload(row) for row in rows]


@router.get("/handoffs", response_model=list[HumanHandoffRead])
def list_human_handoffs(
    tenant_id: str = Query(...),
    status: str = Query("pending"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[HumanHandoffRead]:
    _ensure_request_tenant(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    conditions = [HumanHandoffRequest.tenant_id == tenant_id]
    if status != "all":
        conditions.append(HumanHandoffRequest.status == status)
    if not is_admin_user(current_user):
        if status == "pending":
            conditions.append(
                or_(
                    HumanHandoffRequest.assignee_user_id == current_user.id,
                    HumanHandoffRequest.assignee_user_id.is_(None),
                )
            )
        else:
            conditions.append(
                or_(
                    HumanHandoffRequest.assignee_user_id == current_user.id,
                    HumanHandoffRequest.requester_user_id == current_user.id,
                )
            )
    candidate_session_ids = db.exec(
        select(HumanHandoffRequest.session_id).where(*conditions)
    ).all()
    hidden_session_ids = pilotdeck_origin_session_ids(db, tenant_id, candidate_session_ids)
    stmt = select(HumanHandoffRequest).where(*conditions)
    if hidden_session_ids:
        stmt = stmt.where(HumanHandoffRequest.session_id.notin_(hidden_session_ids))
    rows = db.exec(stmt.order_by(HumanHandoffRequest.updated_at.desc()).limit(200)).all()
    return [human_handoff_read(row) for row in rows]


@router.post("/handoffs/{handoff_id}/reply", response_model=HumanHandoffRead)
def reply_human_handoff(
    handoff_id: str,
    request: HumanHandoffReplyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> HumanHandoffRead:
    _ensure_request_tenant(request.tenant_id, current_user)
    row = db.get(HumanHandoffRequest, handoff_id)
    if not row or row.tenant_id != request.tenant_id:
        raise _chat_error("CHAT_HANDOFF_NOT_FOUND", 404)
    if not is_admin_user(current_user) and row.assignee_user_id not in {None, current_user.id}:
        raise _chat_error("CHAT_HANDOFF_ACCESS_FORBIDDEN", 403)
    reply = request.reply.strip()
    if not reply:
        raise _chat_error("CHAT_HANDOFF_REPLY_REQUIRED", 400)
    if row.status != "pending":
        raise _chat_error("CHAT_HANDOFF_NOT_PENDING", 409)
    chat_session = db.get(ChatSession, row.session_id)
    if not chat_session or chat_session.tenant_id != request.tenant_id:
        raise _chat_error("CHAT_HANDOFF_SESSION_UNAVAILABLE", 409)

    _apply_handoff_reply(
        db, row, reply, answered_by_user_id=current_user.id, source="web"
    )
    return human_handoff_read(row)


@router.post("/messages/{message_id}/feedback")
def upsert_message_feedback(
    message_id: str,
    request: MessageFeedbackRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Persist feedback and enqueue analysis with the linked turn locale snapshot."""
    _ensure_request_tenant(request.tenant_id, current_user)
    message_row = _get_feedback_target_message(db, request.tenant_id, current_user.id, message_id)
    existing = db.exec(
        select(MessageFeedback).where(
            MessageFeedback.tenant_id == request.tenant_id,
            MessageFeedback.message_id == message_id,
            MessageFeedback.user_id == current_user.id,
        )
    ).first()
    now = utc_now()
    if existing:
        existing.rating = request.rating
        existing.analysis_status = "pending"
        existing.analysis_bucket = None
        existing.analysis_reason = None
        existing.analysis_summary = None
        existing.analysis_confidence = None
        existing.analysis_json = {}
        existing.analyzed_at = None
        existing.updated_at = now
        row = existing
    else:
        row = MessageFeedback(
            tenant_id=request.tenant_id,
            session_id=message_row.session_id,
            message_id=message_row.id,
            user_id=current_user.id,
            rating=request.rating,
            analysis_status="pending",
            analysis_json={},
            created_at=now,
            updated_at=now,
        )
    db.add(row)
    _upsert_skill_feedback_for_message(db, request.tenant_id, current_user.id, message_row, request.rating, now)
    language_context = resolve_feedback_language_context(
        db,
        tenant_id=request.tenant_id,
        session_id=message_row.session_id,
        message_id=message_row.id,
    )
    db.add(
        AgentEvent(
            tenant_id=request.tenant_id,
            session_id=message_row.session_id,
            event_type="message_feedback_changed",
            payload_json={
                "message_id": message_row.id,
                "rating": request.rating,
                "user_id": current_user.id,
                "language_context": language_context.model_dump(mode="json"),
            },
        )
    )
    db.commit()
    db.refresh(row)
    enqueue_feedback_analysis(
        row.tenant_id,
        row.id,
        row.session_id,
        language_context=language_context,
    )
    return {
        "id": row.id,
        "tenant_id": row.tenant_id,
        "session_id": row.session_id,
        "message_id": row.message_id,
        "rating": row.rating,
        "analysis_status": row.analysis_status,
        "updated_at": row.updated_at.isoformat(),
    }


@router.delete("/messages/{message_id}/feedback")
def delete_message_feedback(
    message_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    _ensure_request_tenant(tenant_id, current_user)
    message_row = _get_feedback_target_message(db, tenant_id, current_user.id, message_id)
    existing = db.exec(
        select(MessageFeedback).where(
            MessageFeedback.tenant_id == tenant_id,
            MessageFeedback.message_id == message_id,
            MessageFeedback.user_id == current_user.id,
        )
    ).first()
    if existing:
        db.delete(existing)
        _delete_skill_feedback_for_message(db, tenant_id, current_user.id, message_row)
        db.add(
            AgentEvent(
                tenant_id=tenant_id,
                session_id=message_row.session_id,
                event_type="message_feedback_changed",
                payload_json={"message_id": message_row.id, "rating": None, "user_id": current_user.id},
            )
        )
        db.commit()
    return {"status": "deleted"}


@router.get("/sessions/{session_id}/trace")
def list_chat_session_trace(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[dict]:
    _ensure_request_tenant(tenant_id, current_user)
    _get_readable_chat_session(db, tenant_id, current_user, session_id)
    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == session_id)
        .order_by(Message.created_at)
    ).all()
    internal_turn_ids = internal_message_turn_ids(messages)
    messages = visible_message_rows(messages)
    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == session_id)
        .order_by(AgentEvent.created_at)
    ).all()
    if internal_turn_ids:
        events = [
            event
            for event in events
            if str(
                (event.payload_json or {}).get("turn_id")
                or (event.payload_json or {}).get("user_message_id")
                or (event.payload_json or {}).get("message_id")
                or ""
            ).strip()
            not in internal_turn_ids
        ]
    skills = db.exec(select(Skill).where(Skill.tenant_id == tenant_id)).all()
    skill_names = {skill.skill_id: skill.name for skill in skills}
    return _build_turn_traces(messages, events, skill_names)


@router.get("/sessions/{session_id}/spans")
def list_chat_session_spans(
    session_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """Return persisted span events with canonical public errors and no raw exception text."""
    _ensure_request_tenant(tenant_id, current_user)
    _get_readable_chat_session(db, tenant_id, current_user, session_id)
    rows = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.session_id == session_id,
            AgentEvent.event_type.in_(SPAN_EVENT_TYPES),
        )
        .order_by(AgentEvent.created_at, AgentEvent.id)
    ).all()
    return [
        {
            "event_id": row.id,
            "event_type": row.event_type,
            "created_at": row.created_at.isoformat(),
            **_sanitized_span_payload(row.event_type, row.payload_json or {}),
        }
        for row in rows
    ]


def _get_user_chat_session(db: Session, tenant_id: str, user_id: str, session_id: str) -> ChatSession:
    ensure_tenant(db, tenant_id)
    row = db.get(ChatSession, session_id)
    if not row or row.tenant_id != tenant_id or row.user_id != user_id:
        raise _chat_error("CHAT_SESSION_NOT_FOUND", 404)
    return row


def _get_readable_chat_session(db: Session, tenant_id: str, current_user: User, session_id: str) -> ChatSession:
    ensure_tenant(db, tenant_id)
    row = db.get(ChatSession, session_id)
    if not row or row.tenant_id != tenant_id:
        raise _chat_error("CHAT_SESSION_NOT_FOUND", 404)
    if row.user_id == current_user.id:
        return row
    if row.team_id:
        team = db.get(Team, row.team_id)
        if team and team.tenant_id == tenant_id and (
            current_user.role == "admin" or team.owner_user_id == current_user.id
        ):
            return row
    if _user_can_read_handoff_session(db, tenant_id, current_user, session_id):
        return row
    raise _chat_error("CHAT_SESSION_NOT_FOUND", 404)


def _published_workspace_artifact(
    db: Session,
    *,
    tenant_id: str,
    session_id: str,
    task_frame_id: str,
    requested_path: str,
) -> dict[str, object] | None:
    try:
        normalized_requested_path = normalize_harness_artifact_path(requested_path)
    except HarnessArtifactAccessError:
        return None
    rows = db.exec(
        select(Message).where(
            Message.tenant_id == tenant_id,
            Message.session_id == session_id,
            Message.role == "assistant",
        )
    ).all()
    for row in rows:
        artifacts = (row.metadata_json or {}).get("harness_artifacts")
        if not isinstance(artifacts, list):
            continue
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            if artifact.get("type") != "workspace_file":
                continue
            if str(artifact.get("task_frame_id") or "") != task_frame_id:
                continue
            stored_path = artifact.get("path")
            if not isinstance(stored_path, str):
                continue
            try:
                normalized_stored_path = normalize_harness_artifact_path(stored_path)
            except HarnessArtifactAccessError:
                continue
            if normalized_stored_path == normalized_requested_path:
                return dict(artifact)
    return None


def _safe_artifact_download_name(filename: str) -> str:
    cleaned = "".join(
        character
        for character in filename
        if character not in {"\r", "\n", "\x00"}
        and (character.isprintable() or character == "\t")
    ).strip()
    return cleaned[:180] or "artifact"


def _user_can_read_handoff_session(db: Session, tenant_id: str, current_user: User, session_id: str) -> bool:
    statement = select(HumanHandoffRequest).where(
        HumanHandoffRequest.tenant_id == tenant_id,
        HumanHandoffRequest.session_id == session_id,
    )
    if not is_admin_user(current_user):
        statement = statement.where(
            or_(
                HumanHandoffRequest.assignee_user_id == current_user.id,
                HumanHandoffRequest.assignee_user_id.is_(None),
                HumanHandoffRequest.requester_user_id == current_user.id,
            )
        )
    return db.exec(statement).first() is not None


def _ensure_chat_agent_available(
    db: Session,
    tenant_id: str,
    agent_id: str | None,
    current_user: User,
) -> AgentProfile:
    if not agent_id:
        raise _chat_error("CHAT_AGENT_REQUIRED", 400)
    ensure_tenant(db, tenant_id)
    row = db.get(AgentProfile, agent_id)
    if not row or row.tenant_id != tenant_id or row.status != "active" or row.is_overall:
        raise _chat_error("CHAT_AGENT_UNAVAILABLE", 404)
    if not _chat_agent_visible_to_user(row, current_user):
        raise _chat_error("CHAT_AGENT_ACCESS_FORBIDDEN", 403)
    return row


def _bind_request_to_session_agent(
    db: Session,
    request: ChatTurnRequest,
    chat_session: ChatSession,
    current_user: User,
) -> ChatTurnRequest:
    """Bind the agent without allowing a request to mutate an existing session reply locale."""
    if chat_session.agent_reply_locale and request.agent_reply_locale:
        session_locale = normalize_locale(chat_session.agent_reply_locale)
        requested_locale = normalize_locale(request.agent_reply_locale)
        if session_locale is not None and requested_locale is not session_locale:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "AGENT_REPLY_LOCALE_CONFLICT",
                    "params": {
                        "requested": requested_locale.value if requested_locale else None,
                        "session": session_locale.value,
                    },
                },
            )
    if chat_session.agent_id:
        if request.agent_id and request.agent_id != chat_session.agent_id:
            raise _chat_error("CHAT_SESSION_AGENT_CONFLICT", 409)
        return request.model_copy(update={"agent_id": chat_session.agent_id})

    agent = _ensure_chat_agent_available(db, request.tenant_id, request.agent_id, current_user)
    chat_session.agent_id = agent.id
    chat_session.updated_at = utc_now()
    db.add(chat_session)
    db.commit()
    return request.model_copy(update={"agent_id": agent.id})


def _ensure_chat_session_available(db: Session, tenant_id: str, user_id: str, session_id: str) -> ChatSession:
    ensure_tenant(db, tenant_id)
    row = db.get(ChatSession, session_id)
    if not row or row.tenant_id != tenant_id:
        raise _chat_error("CHAT_SESSION_NOT_FOUND", 404)
    # 团队会话(team_id 非空)对本租户成员开放发言(如 TL 工作台聊天室);
    # 普通会话仍仅创建者可见
    if row.user_id != user_id and not row.team_id:
        raise _chat_error("CHAT_SESSION_NOT_FOUND", 404)
    return row


def _ensure_team_session_human_writable(chat_session: ChatSession) -> None:
    """团队内部会话(任务执行/竞标/验收)仅可查看,不允许人工 /turn、/stream 写入。

    判据与 _team_tl_session_team 一致:只有机器类型为 TL 的团队会话才对人类开放发言,
    其余团队会话由唤醒机制自主驱动,人工写入会污染任务历史并绕过 Agent 权限校验。
    """
    if chat_session.team_id and not is_team_tl_session(chat_session):
        raise _chat_error("CHAT_TEAM_SESSION_READ_ONLY", 403)


def _team_tl_session_team(db: Session, chat_session: ChatSession) -> Team | None:
    """识别团队 TL 会话:session 挂 team_id 且绑定 agent 是该团队现任 TL。

    非 TL 的团队会话(任务执行/竞标等)不对人直接聊,返回 None(不注入、不后处理)。
    """
    if not chat_session.team_id or not chat_session.agent_id:
        return None
    # 团队会话全量绑定 team_id 后,任务验收/竞标打分等会话同样挂在 TL 名下;
    # 只有稳定机器类型为 TL 的会话才按人对 TL 聊天处理。
    if not is_team_tl_session(chat_session):
        return None
    team = db.get(Team, chat_session.team_id)
    if team is None or team.tenant_id != chat_session.tenant_id or team.status != "active":
        return None
    leader = get_team_leader(db, team.id)
    if leader is None or leader.agent_id != chat_session.agent_id:
        return None
    return team


def _get_feedback_target_message(db: Session, tenant_id: str, user_id: str, message_id: str) -> Message:
    ensure_tenant(db, tenant_id)
    row = db.get(Message, message_id)
    if not row or row.tenant_id != tenant_id or row.role != "assistant":
        raise _chat_error("CHAT_MESSAGE_NOT_FOUND", 404)
    chat_session = db.get(ChatSession, row.session_id)
    if not chat_session or chat_session.tenant_id != tenant_id or chat_session.user_id != user_id:
        raise _chat_error("CHAT_MESSAGE_NOT_FOUND", 404)
    return row


def _feedback_by_message(
    db: Session,
    tenant_id: str,
    user_id: str,
    message_ids: list[str],
) -> dict[str, str]:
    if not message_ids:
        return {}
    rows = db.exec(
        select(MessageFeedback).where(
            MessageFeedback.tenant_id == tenant_id,
            MessageFeedback.user_id == user_id,
            MessageFeedback.message_id.in_(message_ids),  # type: ignore[attr-defined]
        )
    ).all()
    return {row.message_id: row.rating for row in rows}


def _cleanup_stale_completed_sessions(
    db: Session,
    tenant_id: str,
    rows: list[ChatSession],
) -> None:
    candidates = [row for row in rows if row.active_skill_id]
    if not candidates:
        return
    skills = list(
        db.exec(
            select(Skill).where(Skill.tenant_id == tenant_id, Skill.status == "published")
        ).all()
    )
    if not skills:
        return
    loop = AgentLoop(db)
    changed = False
    for row in candidates:
        before = (
            row.active_skill_id,
            row.active_step_id,
            json.dumps(row.slots_json or {}, sort_keys=True, ensure_ascii=False),
        )
        loop._finish_stale_completed_skill(tenant_id, row, skills)
        after = (
            row.active_skill_id,
            row.active_step_id,
            json.dumps(row.slots_json or {}, sort_keys=True, ensure_ascii=False),
        )
        changed = changed or before != after
    if changed:
        db.commit()
        for row in candidates:
            db.refresh(row)


def _upsert_skill_feedback_for_message(
    db: Session,
    tenant_id: str,
    user_id: str,
    message_row: Message,
    rating: str,
    now,
) -> None:
    skill_context = _active_skill_context_for_assistant_message(db, tenant_id, message_row)
    if not skill_context:
        return
    skill_id = skill_context["skill_id"]
    skill_version = skill_context.get("skill_version")
    step_id = skill_context.get("node_id") or skill_context.get("step_id")
    existing = db.exec(
        select(SkillFeedback).where(
            SkillFeedback.tenant_id == tenant_id,
            SkillFeedback.message_id == message_row.id,
            SkillFeedback.user_id == user_id,
        )
    ).first()
    if existing:
        existing.skill_id = skill_id
        existing.skill_version = skill_version
        existing.step_id = step_id
        existing.rating = rating
        existing.updated_at = now
        db.add(existing)
        return
    db.add(
        SkillFeedback(
            tenant_id=tenant_id,
            skill_id=skill_id,
            skill_version=skill_version,
            step_id=step_id,
            session_id=message_row.session_id,
            message_id=message_row.id,
            user_id=user_id,
            rating=rating,
            created_at=now,
            updated_at=now,
        )
    )


def _delete_skill_feedback_for_message(
    db: Session,
    tenant_id: str,
    user_id: str,
    message_row: Message,
) -> None:
    existing = db.exec(
        select(SkillFeedback).where(
            SkillFeedback.tenant_id == tenant_id,
            SkillFeedback.message_id == message_row.id,
            SkillFeedback.user_id == user_id,
        )
    ).first()
    if existing:
        db.delete(existing)


def _active_skill_for_assistant_message(db: Session, tenant_id: str, message_row: Message) -> str | None:
    context = _active_skill_context_for_assistant_message(db, tenant_id, message_row)
    return context["skill_id"] if context else None


def _active_skill_context_for_assistant_message(
    db: Session, tenant_id: str, message_row: Message
) -> dict[str, str | None] | None:
    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == tenant_id, Message.session_id == message_row.session_id)
        .order_by(Message.created_at)
    ).all()
    target_index = next((index for index, item in enumerate(messages) if item.id == message_row.id), -1)
    if target_index < 0:
        return None
    user_message = next(
        (item for item in reversed(messages[:target_index]) if item.role == "user"),
        None,
    )
    if not user_message:
        return None

    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == tenant_id, AgentEvent.session_id == message_row.session_id)
        .order_by(AgentEvent.created_at)
    ).all()
    collecting = False
    last_context: dict[str, str | None] | None = None
    skill_hint: str | None = None
    for event in events:
        payload = event.payload_json or {}
        if event.event_type == "user_message_received":
            event_message_id = str(payload.get("message_id") or payload.get("user_message_id") or "").strip()
            collecting = bool(event_message_id and event_message_id == user_message.id)
            last_context = None if collecting else last_context
            skill_hint = None if collecting else skill_hint
            continue
        if not collecting:
            continue
        if event.event_type == "router_decision_created":
            target_skill_id = str(payload.get("target_skill_id") or "").strip()
            if target_skill_id:
                skill_hint = target_skill_id
        event_context = _skill_context_from_event(event, skill_hint=skill_hint)
        if event_context:
            last_context = event_context
            if event_context.get("skill_id"):
                skill_hint = event_context["skill_id"]
        if event.event_type == "assistant_message_created":
            assistant_message_id = str(
                payload.get("message_id") or payload.get("assistant_message_id") or ""
            ).strip()
            if assistant_message_id == message_row.id:
                return _fill_skill_context_version(db, tenant_id, last_context)
            continue
    return _fill_skill_context_version(db, tenant_id, last_context)


def _skill_id_from_event(event: AgentEvent) -> str | None:
    context = _skill_context_from_event(event)
    return context["skill_id"] if context else None


def _skill_context_from_event(event: AgentEvent, skill_hint: str | None = None) -> dict[str, str | None] | None:
    payload = event.payload_json or {}
    if event.event_type in {"skill_started", "skill_resumed", "skill_step_changed"}:
        skill_id = str(payload.get("to_skill_id") or payload.get("from_skill_id") or skill_hint or "") or None
        if not skill_id:
            return None
        skill_version = str(payload.get("to_skill_version") or payload.get("from_skill_version") or "") or None
        node_id = str(
            payload.get("to_node_id")
            or payload.get("from_node_id")
            or payload.get("to_step_id")
            or payload.get("from_step_id")
            or ""
        ) or None
        return {"skill_id": skill_id, "skill_version": skill_version, "node_id": node_id}
    if event.event_type == "skill_completed":
        skill_id = str(payload.get("skill_id") or "") or None
        if not skill_id:
            return None
        return {
            "skill_id": skill_id,
            "skill_version": str(payload.get("skill_version") or "") or None,
            "node_id": str(payload.get("node_id") or payload.get("step_id") or "") or None,
        }
    if event.event_type == "reflection_decision_created":
        skill_id = str(payload.get("target_skill_id") or "") or None
        if not skill_id:
            return None
        return {
            "skill_id": skill_id,
            "skill_version": str(payload.get("target_skill_version") or "") or None,
            "node_id": str(payload.get("target_node_id") or payload.get("target_step_id") or "") or None,
        }
    return None


def _fill_skill_context_version(
    db: Session, tenant_id: str, context: dict[str, str | None] | None
) -> dict[str, str | None] | None:
    if not context or context.get("skill_version"):
        return context
    skill_id = context.get("skill_id")
    if not skill_id:
        return context
    skill = db.exec(select(Skill).where(Skill.tenant_id == tenant_id, Skill.skill_id == skill_id)).first()
    if skill:
        return {**context, "skill_version": skill.version}
    return context


_TRACE_EVENT_CODES = {
    "stream_status": "public.run.status",
    "stream_cancelled": "public.run.cancelled",
    "stream_interrupted": "public.run.failed",
    "task_frame_started": "run.task.frame.started",
    "task_frame_finished": "run.task.frame.finished",
    "task_frame_completed": "run.task.frame.completed",
    "task_frame_dependency_waiting": "run.task.frame.waiting",
    "task_frame_dependencies_released": "run.task.frame.released",
    "harness_action_created": "run.action.started",
    "harness_mcp_app_view": "run.capability.completed",
    "harness_tool_completed": "run.capability.completed",
    "harness_step_timeout": "run.sop.step.timeout",
    "harness_execution_recovered": "harness.execution.recovered",
    "general_skill_selected": "run.skill.trace",
    "general_skill_intent_checked": "public.run.intent",
    "general_skill_trace": "run.skill.trace",
    "general_skill_run_finished": "run.skill.completed",
    "skill_state": "run.sop.state",
    "router_decision_created": "public.run.intent",
    "step_result": "run.sop.step",
    "skill_started": "run.sop.state",
    "skill_resumed": "run.sop.state",
    "skill_step_changed": "run.sop.state",
    "skill_completed": "run.skill.completed",
    "tool_call_started": "run.action.started",
    "tool_result": "run.tool.completed",
    "tool_call_finished": "run.tool.completed",
    "knowledge_query_started": "public.run.citation",
    "knowledge_query_finished": "public.run.citation",
    "knowledge_result": "public.run.citation",
    "agent_loop_continued": "run.loop.continued",
    "agent_loop_completed": "run.loop.completed",
    "reflection_decision_created": "run.sop.state",
    "reflection_decision": "run.sop.state",
    "reflection_skipped": "run.sop.state",
    "reflection_retry_started": "run.sop.state",
    "error_occurred": "public.run.failed",
}


def _trace_payload_text(value: object) -> str:
    """Serialize raw trace output without adding a product-facing label or translation."""
    if value is None or value == "":
        return ""
    if isinstance(value, str):
        try:
            return json.dumps(json.loads(value), ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def _trace_payload_language(value: str) -> str:
    """Identify raw output format for clients without converting its language or content."""
    if not value.strip():
        return "text"
    try:
        json.loads(value)
        return "json"
    except (TypeError, ValueError):
        return "text"


def _trace_event_data(payload: dict[str, object]) -> dict[str, object]:
    """Keep raw event values while dropping deprecated backend-rendered text fields."""
    return {
        key: value
        for key, value in payload.items()
        if key not in {"detail", "outputTitle", "status_text", "text"}
    }


def _trace_event_descriptor(
    event_type: str,
    payload: dict[str, object],
    event_id: str,
) -> tuple[str | None, dict[str, object]]:
    """Return a registered trace code and exact primitive params for one event type."""
    event_code = _TRACE_EVENT_CODES.get(event_type)
    if event_type == "stream_status" and str(payload.get("phase") or "").strip() == "error":
        event_code = "public.run.failed"
    if event_code in {"public.run.cancelled", "run.action.started"}:
        job_id = str(payload.get("job_id") or payload.get("task_frame_id") or event_id).strip()
        return event_code, {"job_id": job_id or "chat"}
    if event_code == "public.run.intent":
        decision = str(payload.get("decision") or payload.get("user_intent") or "unknown").strip()
        return event_code, {"decision": decision or "unknown"}
    if event_code == "public.run.failed":
        error_code = _LEGACY_PUBLIC_ERROR_ALIASES.get(
            str(payload.get("code") or payload.get("error_type") or "").strip(),
            str(payload.get("code") or payload.get("error_type") or "INTERNAL_ERROR").strip(),
        ) or "INTERNAL_ERROR"
        job_id = str(payload.get("job_id") or payload.get("task_frame_id") or event_id).strip()
        return event_code, {
            "job_id": job_id or "chat",
            "error_code": error_code,
            "retryable": bool(payload.get("retryable")),
        }
    if event_code == "harness.execution.recovered":
        raw_params = payload.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        error_code = str(params.get("error_code") or "INTERNAL_ERROR").strip()
        return event_code, {"error_code": error_code or "INTERNAL_ERROR"}
    return event_code, {}


def _structured_trace_line(
    *,
    line_id: str,
    kind: str,
    state: str,
    event_type: str,
    event_data: dict[str, object],
    event_id: str,
    event_code: str | None = None,
    params: dict[str, object] | None = None,
    output: str | None = None,
    output_language: str | None = None,
    code: str | None = None,
    language: str | None = None,
    mcp_app: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build a locale-independent trace projection with an empty legacy text field."""
    resolved_code, resolved_params = _trace_event_descriptor(event_type, event_data, event_id)
    line: dict[str, object] = {
        "id": line_id,
        "kind": kind,
        "text": "",
        "event_type": event_type,
        "event_data": _trace_event_data(event_data),
        "state": state,
    }
    if event_code or resolved_code:
        line["event_code"] = event_code or resolved_code
        line["params"] = params if params is not None else resolved_params
    if output:
        line["output"] = output
        line["outputLanguage"] = output_language or _trace_payload_language(output)
        line["collapsible"] = True
    if code:
        line["code"] = code
    if language:
        line["language"] = language
    if mcp_app is not None:
        line["mcpApp"] = mcp_app
    return line


def _general_skill_trace_failed(phase: str) -> bool:
    """Identify failed general-skill phases without projecting their diagnostic prose."""
    return "failed" in phase or phase == "code_timeout" or phase.endswith("_error")


def _general_skill_trace_output(payload: dict[str, object], phase: str) -> dict[str, str]:
    """Expose successful or technical general-skill output without localized output labels."""
    if phase in {"stdout_chunk", "stderr_chunk"}:
        output = _trace_payload_text(payload.get("stdout_preview") or payload.get("stderr_preview") or payload.get("text"))
        return {
            "output": output,
            "outputLanguage": _trace_payload_language(output),
        } if output else {}
    if phase in {"code_finished", "code_timeout"}:
        result: dict[str, object] = {}
        for key in ("return_code", "structured_result"):
            if key in payload:
                result[key] = payload.get(key)
        for key in ("stdout_preview", "stderr_preview"):
            if str(payload.get(key) or "").strip():
                result[key.removesuffix("_preview")] = payload.get(key)
        output = _trace_payload_text(
            result or payload.get("stdout_preview") or payload.get("stderr_preview")
        )
        return {
            "output": output,
            "outputLanguage": _trace_payload_language(output),
        } if output else {}
    if phase.startswith("reflection_"):
        result = {
            key: payload.get(key)
            for key in ("structured_result", "review", "stdout_preview", "stderr_preview")
            if key in payload
        }
        output = _trace_payload_text(result)
        return {
            "output": output,
            "outputLanguage": _trace_payload_language(output),
        } if result and output else {}
    return {}


def _resolve_step_label(
    step_id: str,
    step_names: dict[str, dict[str, str]] | None,
    skill_id: str | None = None,
) -> str:
    """Resolve an explicit stored step label, otherwise retain the raw step identifier."""
    normalized_step_id = str(step_id or "").strip()
    if not normalized_step_id or step_names is None:
        return normalized_step_id
    scoped = step_names.get(skill_id or "") or {}
    if normalized_step_id in scoped:
        return scoped[normalized_step_id]
    for steps in step_names.values():
        if normalized_step_id in steps:
            return steps[normalized_step_id]
    return normalized_step_id


def _harness_event_trace_line(
    event: AgentEvent,
    skill_hint: str | None = None,
    step_names: dict[str, dict[str, str]] | None = None,
    tool_names: dict[str, str] | None = None,
    payload_override: dict[str, object] | None = None,
) -> dict | None:
    """Return one locale-independent Harness trace projection with raw diagnostics."""
    raw_payload = event.payload_json or {}
    payload = payload_override if payload_override is not None else _sanitized_session_event_payload(
        event.event_type, raw_payload
    )
    event_type = event.event_type
    event_id = str(event.id or "")
    frame_id = str(payload.get("task_frame_id") or event_id).strip()
    iteration = str(payload.get("iteration") or "").strip()

    if event_type == "task_frame_started":
        kind = "skill" if str(payload.get("kind") or "").strip() == "sop" else "decision"
        return _structured_trace_line(
            line_id=f"harness_frame_{frame_id}",
            kind=kind,
            state="running",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {
        "task_frame_finished",
        "task_frame_completed",
        "task_frame_dependency_waiting",
        "task_frame_dependencies_released",
    }:
        status = str(payload.get("status") or "completed").strip()
        failed = status in {"failed", "blocked", "cancelled"}
        if event_type == "task_frame_dependency_waiting":
            state = "running"
        elif event_type in {"task_frame_completed", "task_frame_dependencies_released"}:
            state = "completed"
        else:
            state = "failed" if failed else "running" if status == "awaiting_user" else "completed"
        kind = "skill" if str(payload.get("kind") or "").strip() == "sop" else "decision"
        return _structured_trace_line(
            line_id=f"harness_frame_{frame_id}",
            kind=kind,
            state=state,
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "harness_action_created":
        action = str(payload.get("action") or "").strip()
        if action == "tool":
            return _structured_trace_line(
                line_id=f"harness_action_{frame_id}_{iteration or event_id}",
                kind="tool",
                state="running",
                event_type=event_type,
                event_data=payload,
                event_id=event_id,
            )
        if action == "finish":
            return _structured_trace_line(
                line_id=f"harness_finish_{frame_id}_{iteration or event_id}",
                kind="decision",
                state="completed",
                event_type=event_type,
                event_data=payload,
                event_id=event_id,
            )
        return None
    if event_type == "harness_mcp_app_view":
        mcp_app = payload.get("mcp_app") if isinstance(payload.get("mcp_app"), dict) else None
        if mcp_app is None:
            return None
        return _structured_trace_line(
            line_id=f"harness_mcp_app_{frame_id}_{event_id}",
            kind="tool",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
            mcp_app=mcp_app,
        )
    if event_type == "harness_tool_completed":
        success = bool(payload.get("success"))
        result_payload = payload.get("result")
        output = _trace_payload_text(result_payload) if success else ""
        mcp_app = (
            result_payload.get("mcp_app")
            if isinstance(result_payload, dict)
            and isinstance(result_payload.get("mcp_app"), dict)
            else None
        )
        return _structured_trace_line(
            line_id=f"harness_action_{frame_id}_{iteration or event_id}",
            kind="tool",
            state="completed" if success else "failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
            output=output or None,
            mcp_app=mcp_app,
        )
    if event_type == "harness_step_timeout":
        return _structured_trace_line(
            line_id=f"harness_timeout_{frame_id}",
            kind="skill",
            state="failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    return None


def _ensure_request_tenant(tenant_id: str, current_user: User) -> None:
    if tenant_id != current_user.tenant_id:
        raise _chat_error("TENANT_MISMATCH", 403)


def _chat_agent_visible_to_user(row: AgentProfile, user: User) -> bool:
    if is_admin_user(user):
        return True
    metadata = row.metadata_json or {}
    return agent_owned_by_user(row, user) or metadata.get("published_to_gallery") is True


def _normalize_title(value: str | None) -> str | None:
    if value is None:
        return None
    title = value.strip()
    if not title:
        raise _chat_error("CHAT_SESSION_TITLE_REQUIRED", 400)
    return title[:80]


def _message_turn_ids_from_events(events: list[AgentEvent]) -> dict[str, str]:
    turn_ids: dict[str, str] = {}
    for event in events:
        payload = event.payload_json or {}
        if event.event_type == "user_message_received":
            message_id = str(payload.get("message_id") or payload.get("user_message_id") or "").strip()
            if message_id:
                turn_ids[message_id] = message_id
            continue
        if event.event_type == "assistant_message_created":
            assistant_message_id = str(
                payload.get("message_id") or payload.get("assistant_message_id") or ""
            ).strip()
            explicit_turn_id = str(payload.get("turn_id") or payload.get("user_message_id") or "").strip()
            if assistant_message_id and explicit_turn_id:
                turn_ids[assistant_message_id] = explicit_turn_id
    return turn_ids


def _build_turn_traces(
    messages: list[Message],
    events: list[AgentEvent],
    skill_names: dict[str, str],
) -> list[dict]:
    if not events:
        return []

    user_messages_by_id = {message.id: message for message in messages if message.role == "user"}
    traces: list[dict] = []
    traces_by_turn_id: dict[str, dict] = {}
    skill_hints_by_turn_id: dict[str, str | None] = {}
    active_turn_id: str | None = None

    for event in events:
        payload = event.payload_json or {}
        if event.event_type == "user_message_received":
            text = str(payload.get("message") or "")
            message_id = str(payload.get("message_id") or payload.get("user_message_id") or "").strip()
            user_message = user_messages_by_id.get(message_id) if message_id else None
            turn_id = message_id or event.id
            active_turn_id = turn_id
            current = {
                "turn_id": turn_id,
                "user_message_id": message_id or None,
                "_user_message_content": user_message.content if user_message else text,
                "started_at": event.created_at.isoformat(),
                "completed_at": None,
                "lines": [],
            }
            traces.append(current)
            traces_by_turn_id[turn_id] = current
            skill_hints_by_turn_id[turn_id] = None
            continue

        target_turn_id = _event_trace_turn_id(event, active_turn_id)
        if not target_turn_id:
            continue
        current = traces_by_turn_id.get(target_turn_id)
        if not current:
            continue
        if event.event_type == "router_decision_created":
            target_skill_id = str(payload.get("target_skill_id") or "").strip()
            if target_skill_id:
                skill_hints_by_turn_id[target_turn_id] = target_skill_id

        skill_hint = skill_hints_by_turn_id.get(target_turn_id)
        trace_was_completed = bool(current.get("completed_at"))
        lines = _event_trace_lines(event, skill_names, skill_hint)
        for line in lines:
            if trace_was_completed and line.get("state") == "running":
                line = {**line, "state": "completed"}
            _upsert_trace_line(current["lines"], line)
        event_context = _skill_context_from_event(event, skill_hint=skill_hint)
        if event_context and event_context.get("skill_id"):
            skill_hints_by_turn_id[target_turn_id] = event_context["skill_id"]
        if event.event_type == "assistant_message_created":
            if not current.get("completed_at"):
                current["completed_at"] = event.created_at.isoformat()
            _complete_trace_lines(current["lines"])
            if active_turn_id == target_turn_id:
                active_turn_id = None
        elif event.event_type in {"stream_cancelled", "stream_interrupted", "error_occurred"}:
            if not current.get("completed_at"):
                current["completed_at"] = event.created_at.isoformat()
            _finish_trace_if_needed(current, event.created_at)
            if active_turn_id == target_turn_id:
                active_turn_id = None

    fallback_time = events[-1].created_at if events else None
    open_turn_id = active_turn_id
    for current in traces:
        if open_turn_id and current.get("turn_id") == open_turn_id and not current.get("completed_at"):
            continue
        _finish_trace_if_needed(current, fallback_time)

    for trace in traces:
        trace.pop("_user_message_content", None)
    return _with_scheduled_draft_message_traces(traces, messages)


def _event_trace_turn_id(event: AgentEvent, _active_turn_id: str | None) -> str | None:
    payload = event.payload_json or {}
    if event.event_type == "user_message_received":
        return str(payload.get("message_id") or payload.get("user_message_id") or "").strip() or event.id
    explicit_turn_id = str(payload.get("turn_id") or payload.get("user_message_id") or "").strip()
    if explicit_turn_id:
        return explicit_turn_id
    return None


def _with_scheduled_draft_message_traces(traces: list[dict], messages: list[Message]) -> list[dict]:
    traced_turn_ids = {str(trace.get("turn_id") or "") for trace in traces}
    next_traces = list(traces)
    previous_user: Message | None = None
    for message in messages:
        if message.role == "user":
            previous_user = message
            continue
        if message.role != "assistant" or not previous_user:
            continue
        metadata = message.metadata_json or {}
        draft = metadata.get("scheduled_task_draft") if isinstance(metadata, dict) else None
        if not isinstance(draft, dict) or previous_user.id in traced_turn_ids:
            continue
        next_traces.append(
            {
                "turn_id": previous_user.id,
                "user_message_id": previous_user.id,
                "started_at": previous_user.created_at.isoformat(),
                "completed_at": message.created_at.isoformat(),
                "lines": _scheduled_task_trace_lines(draft),
            }
        )
        traced_turn_ids.add(previous_user.id)
    next_traces.sort(key=lambda item: str(item.get("started_at") or ""))
    return next_traces


def _event_trace_lines(
    event: AgentEvent,
    skill_names: dict[str, str],
    skill_hint: str | None = None,
    step_names: dict[str, dict[str, str]] | None = None,
    tool_names: dict[str, str] | None = None,
) -> list[dict]:
    """Return trace lines with canonical descriptors and a compatibility empty text field."""
    line = _event_trace_line(event, skill_names, skill_hint, step_names, tool_names)
    if not line:
        return []
    lines = line if isinstance(line, list) else [line]
    for item in lines:
        item.setdefault("icon", _event_trace_icon(event, item))
    return lines


def _event_trace_icon(event: AgentEvent, line: dict) -> str:
    event_type = event.event_type
    payload = event.payload_json or {}
    phase = str(payload.get("phase") or "").strip()
    if event_type in {"router_decision_created", "general_skill_intent_checked"}:
        return "judge"
    if event_type == "stream_status" and phase in {"routing", "scheduled_task_intent"}:
        return "judge"
    if event_type == "general_skill_trace":
        if phase in {
            "plan_created",
            "attempt_started",
            "running_code",
            "stdout_chunk",
            "stderr_chunk",
            "code_finished",
            "code_timeout",
            "plan_failed",
        }:
            return "generated"
        if phase.startswith("reflection_") or phase == "repair_planning":
            return "loading"
        return "advance"
    if event_type in {
        "agent_loop_continued",
        "agent_loop_completed",
        "reflection_decision_created",
        "reflection_decision",
        "reflection_skipped",
        "reflection_retry_started",
        "stream_cancelled",
        "stream_interrupted",
        "error_occurred",
    }:
        return "loading"
    kind = str(line.get("kind") or "")
    if kind == "tool":
        return "tool"
    if kind == "code":
        return "generated"
    if kind == "thinking":
        return "loading"
    return "advance"


def _structured_event_trace_line(
    event: AgentEvent,
    payload: dict[str, object],
    skill_names: dict[str, str],
    skill_hint: str | None = None,
    step_names: dict[str, dict[str, str]] | None = None,
) -> dict | list[dict] | None:
    """Build a structured trace line while leaving user and diagnostic values raw."""
    event_type = event.event_type
    event_id = str(event.id or "")

    if event_type == "stream_status":
        phase = str(payload.get("phase") or "").strip()
        if phase in {"scheduled_task_intent", "scheduled_task_parse", "scheduled_task_draft"}:
            index = {
                "scheduled_task_intent": 0,
                "scheduled_task_parse": 1,
                "scheduled_task_draft": 2,
            }[phase]
            return {
                **_scheduled_task_trace_lines(
                    payload,
                    state="running",
                    event_type=event_type,
                )[index]
            }
        if phase == "responding" or not phase or phase == "received":
            return None
        if phase == "routing":
            line_id = "decision_router"
        elif phase == "error":
            code = str(payload.get("code") or payload.get("error_type") or "status").strip()
            line_id = f"error_{code}"
        elif phase == "stepping":
            repair_reason = str(payload.get("repair_reason") or "main").strip()
            iteration = str(payload.get("iteration") or "").strip()
            suffix = f"_{iteration}" if iteration else ""
            line_id = f"decision_stepping_{repair_reason}{suffix}"
        elif phase == "reflecting":
            line_id = "reflection"
        elif phase in KNOWLEDGE_TRACE_PHASES:
            line_id = _knowledge_trace_line_id(payload)
        elif phase == "tool" and payload.get("tool_name"):
            tool_call_id = str(payload.get("tool_call_id") or payload.get("tool_name")).strip()
            line_id = f"tool_{tool_call_id}"
        else:
            line_id = f"decision_status_{phase}"
        kind = "knowledge" if phase in KNOWLEDGE_TRACE_PHASES else "tool" if phase == "tool" else "decision"
        state = "failed" if phase == "error" else "running"
        return _structured_trace_line(
            line_id=line_id,
            kind=kind,
            state=state,
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )

    if event_type == "stream_cancelled":
        return _structured_trace_line(
            line_id="generation_stopped",
            kind="decision",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "stream_interrupted":
        return _structured_trace_line(
            line_id="generation_interrupted",
            kind="thinking",
            state="failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {"general_skill_selected", "general_skill_intent_checked"}:
        kind = "skill" if event_type == "general_skill_selected" else "decision"
        return _structured_trace_line(
            line_id=f"general_skill_{'selected' if kind == 'skill' else 'intent'}_{event_id}",
            kind=kind,
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "general_skill_trace":
        phase = str(payload.get("phase") or "").strip()
        if phase == "replying":
            return None
        output = _general_skill_trace_output(payload, phase)
        code = str(payload.get("code") or "").strip()
        runtime = str(payload.get("runtime") or "").strip().lower()
        code_phases = {
            "plan_created",
            "attempt_started",
            "running_code",
            "stdout_chunk",
            "stderr_chunk",
            "code_finished",
            "code_timeout",
            "plan_failed",
        }
        return _structured_trace_line(
            line_id=f"general_skill_trace_{event_id}",
            kind="code" if code or phase in code_phases else "decision",
            state="failed" if _general_skill_trace_failed(phase) else "completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
            output=output.get("output"),
            output_language=output.get("outputLanguage"),
            code=code or None,
            language=("bash" if code and runtime == "bash" else "python" if code else None),
        )
    if event_type == "general_skill_run_finished":
        return _structured_trace_line(
            line_id=f"general_skill_finished_{event_id}",
            kind="skill",
            state="completed" if bool(payload.get("success")) else "failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "skill_state":
        lines: list[dict] = []
        for index, entry in enumerate(payload.get("currentSkills") or []):
            if not isinstance(entry, dict):
                continue
            skill_id = str(entry.get("skillId") or "").strip()
            if not skill_id:
                continue
            state = str(entry.get("state") or "active").strip()
            state_key = str(entry.get("stepId") or index)
            lines.append(
                _structured_trace_line(
                    line_id=f"skill_state_{skill_id}_{state}_{state_key}",
                    kind="skill",
                    state="completed" if state == "suspended" else "running",
                    event_type=event_type,
                    event_data={**payload, "current_skill": entry},
                    event_id=event_id,
                )
            )
        return lines or None
    if event_type == "scheduled_task_draft_created":
        return _scheduled_task_trace_lines(payload, event_type=event_type)
    if event_type == "router_decision_created":
        return _structured_trace_line(
            line_id="decision_router",
            kind="decision",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "step_result":
        tool_call = payload.get("tool_call") if isinstance(payload.get("tool_call"), dict) else {}
        knowledge_query = payload.get("knowledge_query") if isinstance(payload.get("knowledge_query"), dict) else {}
        if tool_call.get("name"):
            line_id = f"decision_step_tool_{tool_call['name']}"
            state = "running"
        elif knowledge_query.get("query"):
            line_id = "decision_step_knowledge"
            state = "running"
        else:
            line_id = "decision_step_result"
            state = "completed"
        return _structured_trace_line(
            line_id=line_id,
            kind="decision",
            state=state,
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {"skill_started", "skill_resumed", "skill_step_changed"}:
        to_skill_id = str(payload.get("to_skill_id") or "")
        from_skill_id = str(payload.get("from_skill_id") or "")
        if (
            event_type == "skill_step_changed"
            and from_skill_id == to_skill_id
            and str(payload.get("from_step_id") or "") == str(payload.get("to_step_id") or "")
        ):
            return None
        skill_id = to_skill_id or from_skill_id or (skill_hint or "")
        if not skill_id:
            return None
        step_id = str(payload.get("to_step_id") or payload.get("from_step_id") or "").strip()
        return _structured_trace_line(
            line_id=f"skill_state_{skill_id}_active_{step_id or '0'}",
            kind="skill",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "skill_completed":
        skill_id = str(payload.get("skill_id") or "").strip()
        return _structured_trace_line(
            line_id=f"skill_{event_id}",
            kind="skill",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "tool_call_started":
        name = str(payload.get("name") or "").strip()
        if not name:
            return None
        return _structured_trace_line(
            line_id=f"tool_{payload.get('tool_call_id') or name or event_id!s}",
            kind="tool",
            state="running",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "knowledge_query_started":
        return _structured_trace_line(
            line_id=_knowledge_trace_line_id(payload),
            kind="knowledge",
            state="running",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {"knowledge_query_finished", "knowledge_result"}:
        return _structured_trace_line(
            line_id=_knowledge_trace_line_id(payload),
            kind="knowledge",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "tool_result":
        content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
        raw_name = str(
            payload.get("rawToolName")
            or payload.get("toolId")
            or content.get("tool_name")
            or ""
        ).strip()
        success = payload.get("success")
        is_error = bool(payload.get("isError")) if success is None else not bool(success)
        output = _trace_payload_text(content)
        return _structured_trace_line(
            line_id=f"tool_{payload.get('toolCallId') or raw_name or event_id!s}",
            kind="tool",
            state="failed" if is_error else "completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
            output=output or None,
        )
    if event_type == "tool_call_finished":
        name = str(payload.get("tool_name") or "").strip()
        tool_call_id = str(payload.get("tool_call_id") or name or event_id)
        return _structured_trace_line(
            line_id=f"tool_{tool_call_id}",
            kind="tool",
            state="completed" if bool(payload.get("success")) else "failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {"agent_loop_continued", "agent_loop_completed"}:
        iteration = str(payload.get("iteration") or event_id)
        return _structured_trace_line(
            line_id=f"decision_stepping_tool_continuation_{iteration}",
            kind="decision",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type in {
        "reflection_decision_created",
        "reflection_decision",
        "reflection_skipped",
        "reflection_retry_started",
    }:
        return _structured_trace_line(
            line_id="reflection",
            kind="decision",
            state="completed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "error_occurred":
        code = str(payload.get("code") or payload.get("error_type") or event_id).strip()
        return _structured_trace_line(
            line_id=f"error_{code}",
            kind="decision",
            state="failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    if event_type == "harness_execution_recovered":
        return _structured_trace_line(
            line_id=f"harness_recovery_{event_id}",
            kind="decision",
            state="failed",
            event_type=event_type,
            event_data=payload,
            event_id=event_id,
        )
    return None


def _event_trace_line(
    event: AgentEvent,
    skill_names: dict[str, str],
    skill_hint: str | None = None,
    step_names: dict[str, dict[str, str]] | None = None,
    tool_names: dict[str, str] | None = None,
) -> dict | list[dict] | None:
    """Return a structured, locale-independent trace line for a persisted event."""
    payload = _sanitized_session_event_payload(event.event_type, event.payload_json or {})
    if event.event_type in {
        "task_frame_started",
        "task_frame_finished",
        "task_frame_completed",
        "task_frame_dependency_waiting",
        "task_frame_dependencies_released",
        "harness_action_created",
        "harness_mcp_app_view",
        "harness_tool_completed",
        "harness_step_timeout",
    }:
        return _harness_event_trace_line(
            event,
            skill_hint=skill_hint,
            step_names=step_names,
            tool_names=tool_names,
            payload_override=payload,
        )
    return _structured_event_trace_line(
        event,
        payload,
        skill_names,
        skill_hint=skill_hint,
        step_names=step_names,
    )


def _knowledge_trace_line_id(payload: dict) -> str:
    raw_query = payload.get("query")
    if isinstance(raw_query, dict):
        raw_query = raw_query.get("query")
    query = " ".join(str(raw_query or "").split())
    return f"knowledge_lookup_{query}" if query else "knowledge_lookup"


def _upsert_trace_line(lines: list[dict], line: dict) -> None:
    for index, item in enumerate(lines):
        if item.get("id") == line.get("id"):
            lines[index] = line
            return
    lines.append(line)


def _complete_trace_lines(lines: list[dict]) -> None:
    """Mark trace lines terminal without synthesizing localized product copy."""
    for line in lines:
        if line.get("state") == "running":
            line["state"] = "completed"


def _finish_trace_if_needed(trace: dict, fallback_time) -> None:
    if not trace.get("completed_at") and fallback_time:
        trace["completed_at"] = fallback_time.isoformat()
    _complete_trace_lines(trace["lines"])

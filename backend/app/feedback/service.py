from __future__ import annotations

import logging
import time
from collections import Counter
from typing import Any, Final, TypedDict

from sqlmodel import Session, select

from app.db.models import (
    AgentEvent,
    ChatSession,
    Message,
    MessageFeedback,
    ModelConfig,
    User,
    utc_now,
)
from app.llm import LLMClient, LLMError
from app.llm.model_config_resolver import resolve_model_config_for_runtime
from app.observability.spans import llm_operation

# Product labels remain available only for the explicitly deprecated import
# compatibility surface.  Canonical feedback projections below never read this
# map; the enterprise client localizes stable bucket identifiers itself.
FEEDBACK_BUCKET_LABELS: dict[str, str] = {
    "model_issue": "模型问题",
    "skill_issue": "技能问题",
    "skill_instruction_issue": "技能指令问题",
    "sop_trigger_issue": "SOP 触发问题",
    "sop_slot_issue": "SOP 信息收集问题",
    "sop_transition_issue": "SOP 流转问题",
    "sop_capability_issue": "SOP 能力绑定问题",
    "knowledge_gap": "知识缺口",
    "tool_or_system_issue": "工具/系统问题",
    "tool_or_runtime_issue": "工具/运行时问题",
    "user_random_or_unclear": "用户随意或上下文不足",
    "positive_or_resolved": "正向反馈",
    "needs_model_analysis": "待模型分析",
    "unknown": "未知",
}

FEEDBACK_BUCKET_IDS: Final[frozenset[str]] = frozenset(FEEDBACK_BUCKET_LABELS)
FEEDBACK_ANALYSIS_STATUS_IDS: Final[frozenset[str]] = frozenset(
    {"pending", "analyzed", "failed", "needs_model", "unknown"}
)
ALLOWED_BUCKETS = set(FEEDBACK_BUCKET_IDS)
FEEDBACK_ANALYSIS_MAX_ATTEMPTS = 3
FEEDBACK_ANALYSIS_RETRY_DELAY_SECONDS = 0.6

_LOGGER = logging.getLogger(__name__)


class FeedbackSummaryDescriptor(TypedDict):
    """Typed aggregate descriptor consumed by the localized feedback UI."""

    bucket: str
    params: dict[str, int]
    detail: str | None

FEEDBACK_ANALYSIS_PROMPT = """
你是客服 Agent 质量分析器。请根据用户反馈、消息上下文和执行轨迹，判断反馈原因。

你只输出 JSON，字段：
{
  "bucket": "model_issue | skill_instruction_issue | sop_trigger_issue | sop_slot_issue | sop_transition_issue | sop_capability_issue | knowledge_gap | tool_or_runtime_issue | user_random_or_unclear | positive_or_resolved | unknown",
  "confidence": 0.0,
  "reason": "一句话原因，不超过 80 字",
  "summary": "给运营看的简短总结，不超过 120 字",
  "evidence": ["最多 3 条依据"],
  "suggested_action": "建议动作，不超过 80 字"
}

分类标准：
- model_issue：模型理解、推理、回复组织、语气或事实引用有问题。
- skill_instruction_issue：通用技能的 SKILL.md 指令、示例或边界不清晰。
- sop_trigger_issue：本应触发的 SOP 未触发，或错误触发了 SOP。
- sop_slot_issue：槽位收集、确认、缺失信息追问或已有信息复用错误。
- sop_transition_issue：SOP 当前节点、合法后继、分支条件或结束条件错误。
- sop_capability_issue：SOP 节点绑定的技能、知识库或工具不正确或不可用。
- knowledge_gap：缺少正式知识、检索未命中或引用证据不足。
- tool_or_runtime_issue：工具未配置、调用失败、系统异常、超时或返回值错误。
- skill_issue、tool_or_system_issue：仅用于兼容历史数据；新分析优先使用上面的细分类。
- user_random_or_unclear：用户点踩缺少可解释问题，或上下文不足以判断。
- positive_or_resolved：点赞或正向确认。
- unknown：仍无法判断。

不要把执行轨迹逐字复述为原因；要判断根因。
""".strip()


class FeedbackAnalysisService:
    def __init__(self, db: Session):
        self.db = db

    def analyze_feedback(self, feedback_id: str) -> MessageFeedback | None:
        """Analyze one feedback row and persist only canonical identifiers plus raw model content."""
        feedback = self.db.get(MessageFeedback, feedback_id)
        if not feedback:
            return None
        model_config = self._default_model_config(feedback.tenant_id)
        if not model_config:
            return self._mark_needs_model(feedback)

        payload = self._analysis_payload(feedback)
        last_error: LLMError | None = None
        for attempt in range(1, FEEDBACK_ANALYSIS_MAX_ATTEMPTS + 1):
            try:
                with llm_operation("feedback.analyze", attempt=attempt):
                    raw = LLMClient(model_config).generate_json(FEEDBACK_ANALYSIS_PROMPT, payload)
                analysis = _normalize_analysis(raw, feedback.rating)
                self._apply_analysis(feedback, analysis, "analyzed")
                self.db.add(feedback)
                self.db.commit()
                self.db.refresh(feedback)
                return feedback
            except LLMError as exc:
                last_error = exc
                if attempt < FEEDBACK_ANALYSIS_MAX_ATTEMPTS:
                    time.sleep(FEEDBACK_ANALYSIS_RETRY_DELAY_SECONDS * attempt)

        if last_error is None:
            last_error = LLMError("Unknown model analysis failure")
        self._mark_failed(feedback, last_error, FEEDBACK_ANALYSIS_MAX_ATTEMPTS)
        self.db.add(feedback)
        self.db.commit()
        self.db.refresh(feedback)
        return feedback

    def _default_model_config(self, tenant_id: str) -> ModelConfig | None:
        """Resolve the enabled default model for a tenant, if one is configured."""
        row = self.db.exec(
            select(ModelConfig).where(
                ModelConfig.tenant_id == tenant_id,
                ModelConfig.is_default == True,
                ModelConfig.enabled == True,
            )
        ).first()
        if row is None:
            return None
        return resolve_model_config_for_runtime(self.db, tenant_id, row.id)

    def _mark_needs_model(self, feedback: MessageFeedback) -> MessageFeedback:
        """Persist a stable no-model state without writing a locale-specific fallback sentence."""
        analysis = {
            "bucket": "needs_model_analysis",
            "confidence": 0.0,
            "reason": "",
            "summary": "",
            "evidence": [],
            "suggested_action": "",
        }
        self._apply_analysis(feedback, analysis, "needs_model")
        self.db.add(feedback)
        self.db.commit()
        self.db.refresh(feedback)
        return feedback

    def _mark_failed(self, feedback: MessageFeedback, exc: LLMError, attempts: int) -> None:
        """Persist a retryable stable failure while retaining the exception only in private logs."""
        _LOGGER.error(
            "feedback analysis failed",
            extra={"error_type": type(exc).__name__, "attempts": attempts},
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        self._apply_analysis(
            feedback,
            {
                "bucket": "unknown",
                "confidence": None,
                "reason": "",
                "summary": "",
                "evidence": [],
                "suggested_action": "",
                "error_type": "llm_error",
                "retryable": True,
                "attempts": attempts,
            },
            "failed",
        )

    def _apply_analysis(self, feedback: MessageFeedback, analysis: dict[str, Any], status: str) -> None:
        """Persist canonical status/bucket identifiers while retaining normalized model fields."""
        feedback.analysis_status = _canonical_feedback_status(status, default="unknown")
        feedback.analysis_bucket = _canonical_feedback_bucket(analysis.get("bucket"))
        feedback.analysis_reason = str(analysis.get("reason") or "")[:300]
        feedback.analysis_summary = str(analysis.get("summary") or "")[:500]
        confidence = analysis.get("confidence")
        feedback.analysis_confidence = None if confidence is None else _float_in_range(confidence, 0.0, 1.0)
        feedback.analysis_json = analysis
        feedback.analyzed_at = utc_now()
        feedback.updated_at = utc_now()

    def _analysis_payload(self, feedback: MessageFeedback) -> dict[str, Any]:
        """Build the model input from feedback context without localizing or rewriting source content."""
        message = self.db.get(Message, feedback.message_id)
        chat_session = self.db.get(ChatSession, feedback.session_id)
        user = self.db.get(User, feedback.user_id)
        messages = list(
            self.db.exec(
                select(Message)
                .where(Message.tenant_id == feedback.tenant_id, Message.session_id == feedback.session_id)
                .order_by(Message.created_at)
            ).all()
        )
        target_index = next((index for index, item in enumerate(messages) if item.id == feedback.message_id), -1)
        if target_index >= 0:
            context_messages = messages[max(0, target_index - 6) : target_index + 2]
        else:
            context_messages = messages[-8:]
        events = list(
            self.db.exec(
                select(AgentEvent)
                .where(AgentEvent.tenant_id == feedback.tenant_id, AgentEvent.session_id == feedback.session_id)
                .order_by(AgentEvent.created_at.desc())
                .limit(30)
            ).all()
        )
        return {
            "feedback": {
                "rating": feedback.rating,
                "message_id": feedback.message_id,
                "updated_at": feedback.updated_at.isoformat(),
            },
            "session": {
                "session_id": chat_session.id if chat_session else feedback.session_id,
                "title": chat_session.title if chat_session else None,
                "active_skill_id": chat_session.active_skill_id if chat_session else None,
                "active_step_id": chat_session.active_step_id if chat_session else None,
                "summary": chat_session.summary if chat_session else None,
                "slots": chat_session.slots_json if chat_session else {},
            },
            "user": {
                "user_id": feedback.user_id,
                "username": user.username if user else None,
                "display_name": user.display_name if user else None,
            },
            "target_message": {
                "role": message.role if message else None,
                "content": message.content if message else "",
            },
            "nearby_messages": [
                {
                    "id": item.id,
                    "role": item.role,
                    "content": item.content,
                    "created_at": item.created_at.isoformat(),
                }
                for item in context_messages
            ],
            "recent_agent_events": [
                {
                    "event_type": event.event_type,
                    "payload": event.payload_json,
                    "created_at": event.created_at.isoformat(),
                }
                for event in reversed(events)
            ],
        }


def feedback_analysis_read(row: MessageFeedback) -> dict[str, Any]:
    """Project one feedback row using stable IDs, typed params, and raw model-owned fields."""
    bucket = _canonical_feedback_bucket(row.analysis_bucket)
    status = _effective_analysis_status(row)
    confidence = None if status == "failed" else row.analysis_confidence
    metadata = _safe_analysis_metadata(row.analysis_json)
    evidence = _raw_evidence(metadata)
    return {
        "status": status,
        "status_params": _analysis_status_params(status, metadata),
        "bucket": bucket,
        "bucket_params": {},
        "reason": row.analysis_reason,
        "summary": row.analysis_summary,
        "evidence": evidence,
        "confidence": confidence,
        "metadata": metadata,
        "analyzed_at": row.analyzed_at.isoformat() if row.analyzed_at else None,
    }


def _effective_analysis_status(row: MessageFeedback) -> str:
    """Return a stable persisted status, deriving failed from legacy error metadata."""
    status = _canonical_feedback_status(row.analysis_status)
    if status != "analyzed":
        return status
    metadata = row.analysis_json if isinstance(row.analysis_json, dict) else {}
    if metadata.get("error_type") or metadata.get("retryable"):
        return "failed"
    return status


def feedback_summary(rows: list[MessageFeedback]) -> dict[str, Any]:
    """Build a locale-neutral feedback summary with typed count parameters and raw model text."""
    total = len(rows)
    down_rows = [row for row in rows if row.rating == "down"]
    up_rows = [row for row in rows if row.rating == "up"]
    bucket_counts = Counter(_canonical_feedback_bucket(row.analysis_bucket) for row in down_rows)
    status_counts = Counter(_effective_analysis_status(row) or "pending" for row in rows)
    top_summaries = [
        {
            "message_id": row.message_id,
            "bucket": _canonical_feedback_bucket(row.analysis_bucket),
            "bucket_params": {},
            "status": _effective_analysis_status(row),
            "status_params": _analysis_status_params(
                _effective_analysis_status(row),
                row.analysis_json if isinstance(row.analysis_json, dict) else {},
            ),
            "summary": row.analysis_summary,
            "reason": row.analysis_reason,
            "evidence": _raw_evidence(row.analysis_json),
            "confidence": row.analysis_confidence,
        }
        for row in sorted(down_rows, key=lambda item: item.updated_at, reverse=True)
        if row.analysis_summary or row.analysis_reason
    ][:5]
    return {
        "total_feedback": total,
        "down_count": len(down_rows),
        "up_count": len(up_rows),
        "bucket_counts": [
            {
                "bucket": bucket,
                "count": count,
                "params": {"count": int(count)},
            }
            for bucket, count in bucket_counts.most_common()
        ],
        "status_counts": dict(status_counts),
        "summary": _compact_overall_summary(bucket_counts, top_summaries),
        "top_summaries": top_summaries,
    }


def _normalize_analysis(raw: dict[str, Any], rating: str) -> dict[str, Any]:
    """Normalize model JSON to bounded stable IDs while retaining raw summary and evidence values."""
    if not isinstance(raw, dict):
        raw = {}
    bucket = str(raw.get("bucket") or "").strip()
    if rating == "up" and bucket in {"", "unknown", "user_random_or_unclear"}:
        bucket = "positive_or_resolved"
    bucket = _canonical_feedback_bucket(bucket)
    evidence = raw.get("evidence")
    if not isinstance(evidence, list):
        evidence = []
    return {
        "bucket": bucket,
        "confidence": _float_in_range(raw.get("confidence"), 0.0, 1.0),
        "reason": str(raw.get("reason") or "")[:300],
        "summary": str(raw.get("summary") or raw.get("reason") or "")[:500],
        "evidence": evidence[:3],
        "suggested_action": str(raw.get("suggested_action") or "")[:300],
    }


def _compact_overall_summary(
    bucket_counts: Counter[str], top_summaries: list[dict[str, Any]]
) -> FeedbackSummaryDescriptor | None:
    """Return a locale-neutral aggregate descriptor instead of composing product prose server-side."""
    if not bucket_counts:
        return None
    leader, count = bucket_counts.most_common(1)[0]
    detail = next((item.get("summary") or item.get("reason") for item in top_summaries if item.get("bucket") == leader), "")
    return {"bucket": leader, "params": {"count": int(count)}, "detail": detail or None}


def _canonical_feedback_bucket(value: object) -> str:
    """Map persisted or model bucket input to the stable public identifier set."""
    return value if isinstance(value, str) and value in FEEDBACK_BUCKET_IDS else "unknown"


def _canonical_feedback_status(value: object, *, default: str = "pending") -> str:
    """Map persisted status input to a stable identifier, failing closed for malformed values."""
    if value is None or value == "":
        return default
    return value if isinstance(value, str) and value in FEEDBACK_ANALYSIS_STATUS_IDS else "unknown"


def _analysis_status_params(status: str, metadata: dict[str, Any]) -> dict[str, int]:
    """Return only typed, non-sensitive status parameters for localized UI messages."""
    attempts = metadata.get("attempts") if status == "failed" else None
    if isinstance(attempts, int) and not isinstance(attempts, bool) and attempts > 0:
        return {"attempts": attempts}
    return {}


def _raw_evidence(metadata: object) -> list[Any]:
    """Copy model-owned evidence without translating or coercing its raw values."""
    if not isinstance(metadata, dict):
        return []
    evidence = metadata.get("evidence")
    return list(evidence) if isinstance(evidence, list) else []


def _safe_analysis_metadata(value: object) -> dict[str, Any]:
    """Drop deprecated localized label fields while preserving model-owned metadata and evidence."""
    if not isinstance(value, dict):
        return {}
    return {
        str(key): item
        for key, item in value.items()
        if str(key) not in {"bucket_label", "status_label", "label"}
    }


def _float_in_range(value: Any, minimum: float, maximum: float) -> float:
    """Clamp model confidence to a finite numeric range without changing other raw fields."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = minimum
    return max(minimum, min(maximum, parsed))

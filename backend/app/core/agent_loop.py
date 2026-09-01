from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from datetime import timedelta
from time import sleep
from typing import Any, Literal

from sqlmodel import Session, select

from app.agents.branching import (
    model_for_agent,
    visible_published_skills,
    visible_skill,
)
from app.channels.service_outbox import stage_channel_delivery
from app.core.agent_identity_prompt import AgentIdentityPrompt
from app.core.cancellation import clear_chat_turn_cancelled
from app.core.conversation_context import (
    ConversationContextSettings,
    build_conversation_context,
)
from app.core.conversation_projection import ConversationProjection
from app.core.graph_rules import GraphRules
from app.core.harness_agent import HarnessExecutionCancelled
from app.core.harness_session_lock import HarnessSessionBusy
from app.core.harness_turn_store import (
    HarnessTurnConflict,
    _prepare_turn_language_context,
)
from app.core.harness_v2_engine import (
    HarnessV2Engine,
    _with_recoverable_first_session,
    get_or_create_harness_session,
)
from app.core.human_handoff_service import HumanHandoffService
from app.core.response_generator import (
    ResponseGenerator,
    format_runtime_failure_reply,
    model_failure_suggestion,
    public_error_code,
)
from app.core.skill_runtime import SkillRuntime
from app.core.slash_commands import SlashCommandError
from app.core.turn_finalizer import TurnFinalizer
from app.db.models import (
    AgentProfile,
    ChannelBinding,
    ChannelDelivery,
    ChatSession,
    HarnessTurnRecord,
    HumanHandoffRequest,
    Message,
    ModelConfig,
    PersonaConfig,
    Skill,
    UIConfig,
    User,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    ReplyLocaleConflict,
    resolve_compatible_language_context,
    resolve_language_context,
)
from app.i18n.raw_source import RawSourceKind, RawSourceMarker
from app.knowledge.citations import (
    compact_knowledge_citation_labels,
    restore_truncated_atomic_references,
)
from app.llm import LLMClient, LLMError
from app.llm.model_config_resolver import (
    resolve_model_config_for_runtime,
)
from app.llm.prompts.language import (
    language_prompt_contract,
    localized_cancelled_reply,
    localized_compat_text,
)
from app.llm.stage_protocol import stage_payload, unified_system_prompt
from app.memory.jobs import enqueue_memory_capture
from app.memory.service import MemoryService
from app.observability import EventLog
from app.observability.product_events import record_product_event
from app.observability.spans import llm_operation
from app.session.helpers import public_session
from app.session.message_visibility import visible_message_content, visible_message_rows
from app.session.origin import PILOTDECK_GROUP_CHAT_CHANNEL
from app.session.session_schema import (
    ChatTurnRequest,
    ChatTurnResponse,
    RouterDecision,
    StepAgentResult,
)
from app.tools.tool_schema import ToolResult

logger = logging.getLogger(__name__)

_STREAM_FALLBACK_GRACE_SECONDS = 120

STREAM_CHUNK_INTERVAL_SECONDS = 0.045
MAX_TOOL_ACTIONS_PER_TURN = 32
MAX_TOOL_ACTIONS_PER_TURN_LIMIT = 100
GRAPH_PENDING_STEPS_SLOT = "_graph_pending_steps"
ExecutionFinalizeState = Literal["continued", "completed", "handoff"]


def _legacy_event_recorder(events: Any) -> Callable[..., Any]:
    """Return the named compatibility writer, with a narrow old-sink fallback.

    Production :class:`EventLog` instances expose ``record_legacy_event``.  A small
    number of integration tests and embedding callers still provide the historical
    ``record``-only sink, so retain that exact compatibility shape without making it
    the normal producer API.
    """
    adapter = getattr(events, "record_legacy_event", None)
    if callable(adapter):
        return adapter
    fallback = getattr(events, "record", None)
    if callable(fallback):
        return fallback
    raise TypeError("event sink does not implement the legacy event contract")


def _knowledge_scope_ids(
    scope: dict[str, Any],
    plural_key: str,
    singular_key: str,
) -> list[str]:
    values = scope.get(plural_key)
    if not isinstance(values, list):
        singular = scope.get(singular_key)
        values = [singular] if singular else []
    return list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))


def _find_handoff_node_id_in_skill(
    skill: Skill, active_step_id: str | None = None
) -> str | None:
    """查找 SOP 中从当前节点可达的 handoff 节点。

    使用 GraphRules.find_handoff_node_id 做基于 edges 的 BFS,
    优先返回从 active_step_id 可达的 handoff 节点,而非数组顺序的第一个。
    """
    content = skill.content_json or {}
    return GraphRules.find_handoff_node_id(content, active_step_id)


def _agent_identity_prompt(agent: AgentProfile) -> str:
    return AgentIdentityPrompt.render(
        agent,
        single_line=_single_line_text,
        metadata_formatter=_metadata_prompt_text,
    )


def _metadata_prompt_text(value: object) -> str:
    if isinstance(value, str):
        return _single_line_text(value)
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        items = [_single_line_text(item) for item in value]
        return "、".join(item for item in items if item)
    return ""


def _single_line_text(value: object) -> str:
    return AgentIdentityPrompt.single_line(value)


class AgentLoopPreconditionError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class AgentLoop:
    def __init__(
        self,
        db: Session,
        *,
        event_sink: Callable[[str, dict[str, Any]], None] | None = None,
        stream_sink: Any | None = None,
    ) -> None:
        """Initialize the turn runtime with optional progress and answer streaming."""
        self.db = db
        self.events = EventLog(db, event_sink=event_sink)
        self.stream_sink = stream_sink
        self.stream_delivery_succeeded = False
        self.stream_delivery_pending = False
        self.stream_delivery_id: str | None = None
        self.runtime = SkillRuntime()
        self.response_generator = ResponseGenerator()
        self.memory = MemoryService(db)
        self._language_context: LanguageContext | None = None

    def _abort_stream_sink(self) -> None:
        """Retire an unfinished channel stream without exposing provider failures."""
        self.stream_delivery_pending = False
        if self.stream_sink is None:
            return
        abort = getattr(self.stream_sink, "abort", None)
        if not callable(abort):
            return
        try:
            abort()
        except Exception:
            logger.exception("stream sink abort failed")

    def _prepare_stream_delivery(self, reply: str, streamed_reply: str) -> None:
        """Freeze the persisted answer in the sink without publishing a terminal frame."""
        self.stream_delivery_succeeded = False
        self.stream_delivery_pending = False
        if self.stream_sink is None:
            return
        try:
            replace_answer = getattr(self.stream_sink, "replace_answer", None)
            if callable(replace_answer):
                replace_answer(reply)
                self.stream_delivery_pending = True
            elif streamed_reply == reply:
                self.stream_delivery_pending = True
        except Exception:
            logger.exception("stream sink answer preparation failed")
        if not self.stream_delivery_pending:
            abort = getattr(self.stream_sink, "abort", None)
            if callable(abort):
                try:
                    abort()
                except Exception:
                    logger.exception("stream sink abort failed")

    def _complete_stream_delivery(self) -> None:
        """Publish the terminal frame only after the answer and fallback commit durably."""
        if self.stream_sink is None:
            return
        succeeded = False
        if self.stream_delivery_pending:
            try:
                succeeded = bool(self.stream_sink.finish())
            except Exception:
                logger.exception("stream sink finalization failed")
            if not succeeded:
                abort = getattr(self.stream_sink, "abort", None)
                if callable(abort):
                    try:
                        abort()
                    except Exception:
                        logger.exception("stream sink abort failed")
        self.stream_delivery_succeeded = succeeded
        self.stream_delivery_pending = False
        try:
            self._settle_stream_delivery(succeeded=succeeded)
        except Exception:
            logger.exception("stream fallback settlement failed")
            self.db.rollback()
            try:
                self._settle_stream_delivery(succeeded=succeeded)
            except Exception:
                logger.exception("stream fallback settlement retry failed")
                self.db.rollback()

    def _settle_stream_delivery(self, *, succeeded: bool) -> None:
        """Retire or release the durable fallback after the stream terminal attempt."""
        delivery_id = self.stream_delivery_id
        if not delivery_id:
            return
        delivery = self.db.get(ChannelDelivery, delivery_id)
        if delivery is None or delivery.status != "pending":
            self.stream_delivery_id = None
            return
        delivery.updated_at = utc_now()
        if succeeded:
            delivery.status = "delivered"
            delivery.next_attempt_at = None
            delivery.last_error = None
            delivery.delivered_at = delivery.updated_at
        else:
            delivery.next_attempt_at = delivery.updated_at
            delivery.last_error = "stream_delivery_failed"
            delivery.delivered_at = None
        self.db.add(delivery)
        self.db.commit()
        self.stream_delivery_id = None

    def _record_legacy_event(
        self,
        tenant_id: str,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        raw_fields: set[str] | frozenset[str] | None = None,
    ) -> Any:
        """Route producer events through the named compatibility adapter.

        The fallback is limited to record-only test/embedding sinks; production
        ``EventLog`` instances always take ``record_legacy_event`` and therefore
        retain its allowlist, validation, and usage telemetry.
        """
        recorder = _legacy_event_recorder(self.events)
        if raw_fields is None:
            return recorder(tenant_id, session_id, event_type, payload)
        return recorder(
            tenant_id,
            session_id,
            event_type,
            payload,
            raw_fields=raw_fields,
        )

    def _prepare_request_language_context(self, request: ChatTurnRequest) -> LanguageContext:
        """Resolve one request's UI/reply locales before Harness creates or claims execution state."""
        # Workflow: a caller-provided internal snapshot is already immutable; otherwise resolve
        # against the recovered session and user preferences before the engine starts streaming.
        session_request = _with_recoverable_first_session(request)
        session = (
            self.db.get(ChatSession, session_request.session_id)
            if session_request.session_id
            else None
        )
        if session is not None:
            existing = None
            client_turn_id = str(request.client_turn_id or "").strip()
            if client_turn_id:
                existing = self.db.exec(
                    select(HarnessTurnRecord).where(
                        HarnessTurnRecord.tenant_id == session.tenant_id,
                        HarnessTurnRecord.session_id == session.id,
                        HarnessTurnRecord.client_turn_id == client_turn_id,
                    )
                ).first()
            context = _prepare_turn_language_context(
                self.db,
                session,
                request,
                existing=existing,
            )
        elif request.language_context is not None:
            context = request.language_context
        else:
            user = self.db.get(User, request.user_id) if request.user_id else None
            try:
                context = resolve_language_context(
                    LanguageContextInputs(
                        explicit_ui_locale=request.ui_locale,
                        explicit_agent_reply_locale=request.agent_reply_locale,
                        user_ui_locale=user.ui_locale if user else None,
                        user_agent_reply_locale=user.agent_reply_locale if user else None,
                    )
                )
            except ReplyLocaleConflict as exc:
                raise HarnessTurnConflict(
                    "同一个 client_turn_id 不能用于不同的 Harness 请求或语言快照。",
                    code=exc.code,
                    params=exc.params,
                ) from exc
            request.language_context = context
            request.ui_locale = context.ui_locale
            request.agent_reply_locale = context.agent_reply_locale
        self._language_context = context
        self.events.bind_turn("", language_context=context)
        return context

    def _response_with_language_context(self, response: ChatTurnResponse) -> ChatTurnResponse:
        """Add the active immutable locale snapshot to a response without changing its reply."""
        if not isinstance(response, ChatTurnResponse):
            return response
        context = self._language_context or response.language_context
        if context is None:
            return response
        updates: dict[str, object] = {}
        if response.ui_locale is None:
            updates["ui_locale"] = context.ui_locale
        if response.agent_reply_locale is None:
            updates["agent_reply_locale"] = context.agent_reply_locale
        if response.language_context is None:
            updates["language_context"] = context
        if not updates:
            return response
        return response.model_copy(
            update=updates
        )

    def _turn_payload(self, payload: dict[str, Any], user_message_id: str | None) -> dict[str, Any]:
        """Attach turn correlation and the immutable language snapshot to stream payloads."""
        data = dict(payload)
        if user_message_id:
            data.setdefault("user_message_id", user_message_id)
            data.setdefault("turn_id", user_message_id)
        if self._language_context is not None:
            data.setdefault(
                "language_context", self._language_context.model_dump(mode="json")
            )
        return data

    def _public_runtime_error_detail(self, code: str) -> str:
        """Return one safe runtime detail for public replies without exposing raw exceptions."""
        del code
        return localized_compat_text(
            self._language_context,
            zh_cn="本次操作未完成。",
            en_us="The operation could not be completed.",
        )

    def _public_turn_rejection_detail(self, code: str) -> str:
        """Return one safe rejection detail for public busy, replay, and locale-conflict replies."""
        if code == "INTERNAL_ERROR":
            return localized_compat_text(
                self._language_context,
                zh_cn="本次请求未完成。",
                en_us="This request could not be completed.",
            )
        if code == "AGENT_REPLY_LOCALE_CONFLICT":
            return localized_compat_text(
                self._language_context,
                zh_cn="该会话已绑定回复语言，当前请求不能改写该语言快照。",
                en_us="This session already has a bound reply locale and cannot be changed by this request.",
            )
        return localized_compat_text(
            self._language_context,
            zh_cn="该请求当前不能完成。",
            en_us="This request could not be completed.",
        )

    def _public_turn_rejection_suggestion(self, code: str) -> str:
        """Return the safe operator guidance for one rejected Harness turn."""
        if code == "AGENT_REPLY_LOCALE_CONFLICT":
            return localized_compat_text(
                self._language_context,
                zh_cn="请保持会话已绑定的回复语言，或新建会话后重试。",
                en_us="Keep the session's bound reply locale, or start a new session and retry.",
            )
        return localized_compat_text(
            self._language_context,
            zh_cn="请稍后重试，或为新请求使用新的 client_turn_id。",
            en_us="Please retry later, or use a new client_turn_id for a new request.",
        )

    def _public_turn_rejection_payload(
        self,
        code: str,
        safe_params: dict[str, object] | None,
        client_turn_id: str | None,
    ) -> dict[str, object]:
        """Project a rejected Harness turn as stable code plus safe params without raw causes."""
        payload: dict[str, object] = {
            "code": code,
            "message": code,
            "client_turn_id": client_turn_id,
        }
        if isinstance(safe_params, dict) and safe_params:
            payload["params"] = dict(safe_params)
        return payload

    def handle_turn(self, request: ChatTurnRequest) -> ChatTurnResponse:
        """Execute one turn after binding its locale snapshot and preserve compatible error paths."""
        engine = HarnessV2Engine(self)
        chat_session: ChatSession | None = None
        user_message_id: str | None = None
        step_result = StepAgentResult(action="reply")
        runtime_error_code: str | None = None
        try:
            self._prepare_request_language_context(request)
            return self._response_with_language_context(engine.run(request))
        except (HarnessTurnConflict, HarnessSessionBusy) as exc:
            chat_session = engine.session
            self._abort_stream_sink()
            self.db.rollback()
            chat_session = chat_session or self._get_or_create_session(request)
            raw_error_code = (
                "HARNESS_SESSION_BUSY"
                if isinstance(exc, HarnessSessionBusy)
                else getattr(exc, "code", "HARNESS_TURN_CONFLICT")
            )
            error_code = public_error_code(raw_error_code)
            safe_params = getattr(exc, "params", None)
            self._record_legacy_event(
                request.tenant_id,
                chat_session.id,
                "turn_rejected",
                self._public_turn_rejection_payload(
                    error_code,
                    safe_params if isinstance(safe_params, dict) else None,
                    request.client_turn_id,
                ),
            )
            self.db.commit()
            return self._response_with_language_context(ChatTurnResponse(
                reply=format_runtime_failure_reply(
                    localized_compat_text(
                        self._language_context,
                        zh_cn="Harness 并发或重复请求已阻止",
                        en_us="The Harness request was rejected",
                    ),
                    self._public_turn_rejection_detail(error_code),
                    error_code,
                    self._public_turn_rejection_suggestion(error_code),
                    self._language_context,
                ),
                session_id=chat_session.id,
                runtime_error_code=error_code,
                step_result=step_result,
                session_state=public_session(chat_session),
            ))
        except HarnessExecutionCancelled:
            chat_session = engine.session
            user_message_id = engine.user_message_id
            self._abort_stream_sink()
            engine.mark_cancelled()
            chat_session = chat_session or self._get_or_create_session(request)
            if user_message_id:
                self._persist_cancelled_assistant_message(
                    request.tenant_id,
                    chat_session,
                    user_message_id,
                    request.client_turn_id,
                )
            self.db.commit()
            for turn_id in (user_message_id, request.client_turn_id):
                if turn_id:
                    clear_chat_turn_cancelled(chat_session.id, turn_id)
            return self._response_with_language_context(ChatTurnResponse(
                reply=localized_cancelled_reply(self._language_context),
                session_id=chat_session.id,
                step_result=step_result,
                session_state=public_session(chat_session),
            ))
        except (AgentLoopPreconditionError, SlashCommandError) as exc:
            chat_session = engine.session
            safe_code = public_error_code(exc.code)
            engine.mark_interrupted(safe_code, safe_code)
            chat_session = chat_session or self._get_or_create_session(request)
            return self._finish_with_error(chat_session, safe_code, safe_code)
        except LLMError as exc:
            chat_session = engine.session
            user_message_id = engine.user_message_id
            self._abort_stream_sink()
            runtime_error_code = public_error_code(
                getattr(exc, "code", None),
                fallback="MODEL_UPSTREAM_ERROR",
            )
            logger.exception(
                "agent loop model failure",
                extra={"tenant_id": request.tenant_id, "client_turn_id": request.client_turn_id},
            )
            engine.mark_interrupted(runtime_error_code, runtime_error_code)
            chat_session = chat_session or self._get_or_create_session(request)
            self._record_legacy_event(
                request.tenant_id,
                chat_session.id,
                "error_occurred",
                {"code": runtime_error_code, "message": runtime_error_code},
            )
            reply = format_runtime_failure_reply(
                "模型调用失败",
                self._public_runtime_error_detail(runtime_error_code),
                runtime_error_code,
                model_failure_suggestion(self._language_context),
                self._language_context,
            )
        except Exception:
            chat_session = engine.session
            user_message_id = engine.user_message_id
            self._abort_stream_sink()
            runtime_error_code = "INTERNAL_ERROR"
            logger.exception(
                "agent loop runtime failure",
                extra={"tenant_id": request.tenant_id, "client_turn_id": request.client_turn_id},
            )
            engine.mark_interrupted(runtime_error_code, runtime_error_code)
            chat_session = chat_session or self._get_or_create_session(request)
            self._record_legacy_event(
                request.tenant_id,
                chat_session.id,
                "error_occurred",
                {"code": runtime_error_code, "message": runtime_error_code},
            )
            reply = format_runtime_failure_reply(
                localized_compat_text(
                    self._language_context,
                    zh_cn="Harness v2 执行出错",
                    en_us="The Harness run failed",
                ),
                self._public_runtime_error_detail(runtime_error_code),
                runtime_error_code,
                localized_compat_text(
                    self._language_context,
                    zh_cn="请稍后重试，或联系管理员查看执行记录。",
                    en_us="Please retry later or ask an administrator to inspect the run record.",
                ),
                self._language_context,
            )
        finally:
            terminal_record = getattr(engine, "turn_record", None)
            terminal_session = getattr(engine, "session", None)
            if (
                terminal_record is not None
                and terminal_session is not None
                and terminal_record.status in {"completed", "failed", "cancelled"}
            ):
                for turn_id in (engine.user_message_id, request.client_turn_id):
                    if turn_id:
                        clear_chat_turn_cancelled(terminal_session.id, turn_id)
            engine.close()

        reply = self._finalize_turn(
            chat_session,
            request.tenant_id,
            reply,
            step_result,
            request.message,
            user_message_id=user_message_id,
            assistant_metadata_override=(
                {"message_visibility": request.message_visibility}
                if request.message_visibility != "visible"
                else None
            ),
        )
        self.db.commit()
        self.db.refresh(chat_session)
        return self._response_with_language_context(ChatTurnResponse(
            reply=reply,
            session_id=chat_session.id,
            runtime_error_code=runtime_error_code,
            step_result=step_result,
            session_state=public_session(chat_session),
        ))

    def handle_turn_stream(self, request: ChatTurnRequest) -> Iterator[dict[str, object]]:
        yield from self._handle_turn_stream_v2(request)

    def _handle_turn_stream_v2(self, request: ChatTurnRequest) -> Iterator[dict[str, object]]:
        """Resolve the turn language before emitting any initial stream event."""
        self._prepare_request_language_context(request)
        session_request = _with_recoverable_first_session(request)
        existing_session = (
            self.db.get(ChatSession, session_request.session_id)
            if session_request.session_id
            else None
        )
        chat_session = get_or_create_harness_session(
            self,
            session_request,
        )
        created_session = existing_session is None
        scoped_request = request.model_copy(update={"session_id": chat_session.id})
        initial_turn_id = str(request.client_turn_id or "").strip() or None
        if created_session:
            yield self._stream_event(
                "session_created",
                chat_session,
                {
                    "sessionId": chat_session.id,
                    "turn_id": initial_turn_id,
                    "client_turn_id": request.client_turn_id,
                    "execution_engine": "harness_v2",
                },
            )
        yield self._stream_event(
            "user_message_received",
            chat_session,
            self._turn_payload(
                {
                    "sessionId": chat_session.id,
                    "client_turn_id": request.client_turn_id,
                    "execution_engine": "harness_v2",
                },
                initial_turn_id,
            ),
        )
        yield self._stream_status(
            chat_session,
            "planning",
            {"execution_engine": "harness_v2"},
            user_message_id=initial_turn_id,
        )
        response = self.handle_turn(scoped_request)
        chat_session = self.db.get(ChatSession, response.session_id)
        if chat_session is None:
            return
        user_message = None
        client_turn_id = str(request.client_turn_id or "").strip()
        if client_turn_id:
            receipt = self.db.exec(
                select(HarnessTurnRecord).where(
                    HarnessTurnRecord.tenant_id == request.tenant_id,
                    HarnessTurnRecord.session_id == response.session_id,
                    HarnessTurnRecord.client_turn_id == client_turn_id,
                )
            ).first()
            if receipt is not None and receipt.user_message_id:
                candidate = self.db.get(Message, receipt.user_message_id)
                if (
                    candidate is not None
                    and candidate.tenant_id == request.tenant_id
                    and candidate.session_id == response.session_id
                    and candidate.role == "user"
                ):
                    user_message = candidate
        if user_message is None and not client_turn_id:
            user_message = self.db.exec(
                select(Message)
                .where(
                    Message.tenant_id == request.tenant_id,
                    Message.session_id == response.session_id,
                    Message.role == "user",
                )
                .order_by(Message.created_at.desc())
            ).first()
        user_message_id = user_message.id if user_message else None
        cancelled_reply = localized_cancelled_reply(self._language_context)
        if response.reply == cancelled_reply:
            yield self._stream_event(
                "stream_cancelled",
                chat_session,
                self._turn_payload(
                    {
                        "phase": "cancelled",
                        "text": cancelled_reply,
                        "client_turn_id": request.client_turn_id,
                        "execution_engine": "harness_v2",
                    },
                    user_message_id or initial_turn_id,
                ),
            )
            return
        resolved_turn_id = user_message_id or initial_turn_id
        if response.runtime_error_code:
            yield self._stream_event(
                "error",
                chat_session,
                self._turn_payload(
                    {
                        "code": response.runtime_error_code,
                        "message": response.runtime_error_code,
                        "client_turn_id": request.client_turn_id,
                        "execution_engine": "harness_v2",
                    },
                    resolved_turn_id,
                ),
            )
            return
        for chunk in self.response_generator.chunk_text(response.reply):
            event = self._stream_event(
                "stream_delta",
                chat_session,
                self._turn_payload(
                    {
                        "content": chunk,
                        "execution_engine": "harness_v2",
                    },
                    resolved_turn_id,
                ),
            )
            self.db.commit()
            yield event
        end_event = self._stream_event(
            "stream_end",
            chat_session,
            self._turn_payload({"execution_engine": "harness_v2"}, resolved_turn_id),
        )
        self.db.commit()
        yield end_event
        yield self._stream_event(
            "complete",
            chat_session,
            self._turn_payload(
                {
                    **response.model_dump(mode="json"),
                    "execution_engine": "harness_v2",
                },
                resolved_turn_id,
            ),
        )

    def _stream_status(
        self,
        chat_session: ChatSession,
        phase: str,
        extra: dict[str, object] | None = None,
        user_message_id: str | None = None,
    ) -> dict[str, object]:
        """Emit locale-independent status metadata for frontend-owned product chrome."""
        payload: dict[str, object] = {"phase": phase, **(extra or {})}
        if user_message_id:
            payload = self._turn_payload(payload, user_message_id)
            if phase != "received":
                self._record_legacy_event(
                    chat_session.tenant_id, chat_session.id, "stream_status", payload
                )
                self.db.commit()
        return self._stream_event(
            "status",
            chat_session,
            payload,
        )

    def _stream_event(
        self,
        kind: str,
        chat_session: ChatSession,
        payload: dict[str, object],
    ) -> dict[str, object]:
        """Persist and relay a stream event with its immutable language snapshot."""
        payload = dict(payload)
        if self._language_context is not None:
            payload.setdefault(
                "language_context", self._language_context.model_dump(mode="json")
            )
        persisted_stream_events = {
            "agent_loop_completed",
            "agent_loop_continued",
            "general_skill_run_finished",
            "general_skill_trace",
            "knowledge_result",
            "reflection_decision",
            "skill_state",
            "step_result",
            "stream_delta",
            "stream_replace",
            "stream_end",
            "tool_result",
        }
        if kind in persisted_stream_events and (
            payload.get("turn_id") or payload.get("user_message_id")
        ):
            self._record_legacy_event(chat_session.tenant_id, chat_session.id, kind, payload)
            self.db.commit()
        data = {
            "kind": kind,
            "sessionId": chat_session.id,
            "timestamp": utc_now().isoformat(),
            "provider": "skill",
            **payload,
        }
        return {"event": kind, "data": data}

    def _pace_stream(self) -> None:
        sleep(STREAM_CHUNK_INTERVAL_SECONDS)

    def _current_step_allows_human_handoff(
        self, skill: Skill | None, active_step_id: str | None
    ) -> bool:
        if not skill:
            return False
        current_step = self._current_skill_step(skill, active_step_id)
        return bool(current_step and self._step_declares_human_handoff(current_step))

    def _maybe_route_to_handoff_node(
        self, chat_session: ChatSession, active_skill: Skill | None
    ) -> bool:
        """当 step_result.handoff=True 但当前 step 不声明 handoff 时,
        查找 SOP 中的 handoff 节点并路由到它。这使得后续的
        _create_human_handoff_request 能从 handoff 节点读取 assignee_user_id。

        返回 True 表示已路由到 handoff 节点。
        """
        if not active_skill or not chat_session.active_skill_id:
            return False
        current_step = self._current_skill_step(
            active_skill, chat_session.active_step_id
        )
        if current_step and self._step_declares_human_handoff(current_step):
            return False
        handoff_step_id = _find_handoff_node_id_in_skill(
            active_skill, chat_session.active_step_id
        )
        if not handoff_step_id:
            return False
        self._change_active_step(
            chat_session.tenant_id,
            chat_session,
            handoff_step_id,
            reason="handoff_node_routed_by_step_result",
        )
        return True

    def _step_declares_human_handoff(self, step: dict[str, Any]) -> bool:
        node_type = str(step.get("type") or "").strip()
        return node_type == "handoff" or "handoff_human" in self._step_actions(step)

    def _human_handoff_assignee_user_id(
        self, tenant_id: str, agent_id: str | None, fallback_user_id: str | None
    ) -> str | None:
        return HumanHandoffService(self.db, getattr(self, "events", None)).assignee_user_id(
            tenant_id,
            agent_id,
            fallback_user_id,
            tenant_admin_resolver=self._human_handoff_tenant_admin_user_id,
        )

    def _human_handoff_tenant_admin_user_id(self, tenant_id: str) -> str | None:
        return HumanHandoffService(self.db, getattr(self, "events", None)).tenant_admin_user_id(
            tenant_id
        )

    def _human_handoff_context_summary(self, chat_session: ChatSession) -> str:
        return HumanHandoffService(self.db, getattr(self, "events", None)).context_summary(
            chat_session
        )

    def _human_handoff_pending_question(
        self, current_step: dict[str, Any] | None, step_result: StepAgentResult
    ) -> str:
        return HumanHandoffService.pending_question(current_step, step_result)

    def _step_actions(self, step: dict[str, Any]) -> list[str]:
        return GraphRules.step_actions(step)

    def _finish_stale_completed_skill(
        self, tenant_id: str, chat_session: ChatSession, skills: list[Skill]
    ) -> None:
        if chat_session.skill_stack_json or chat_session.resume_after_answer_json:
            chat_session.skill_stack_json = []
            chat_session.resume_after_answer_json = None
            chat_session.updated_at = utc_now()
        active_skill = next(
            (skill for skill in skills if skill.skill_id == chat_session.active_skill_id), None
        )
        if active_skill and self._is_terminal_skill_state(active_skill, chat_session):
            self._complete_active_skill(
                tenant_id, chat_session, active_skill, "stale_terminal_state"
            )

    def _should_complete_skill(
        self,
        skill: Skill | None,
        chat_session: ChatSession,
        step_result: StepAgentResult,
        tool_result: ToolResult | None,
    ) -> bool:
        if not skill or not step_result.is_step_completed:
            return False
        if tool_result and not tool_result.success:
            return False
        # Graph topology is authoritative for SOP completion. A non-terminal
        # node may allow an interim reply and all global slots may already be
        # filled, but an outgoing edge still means the workflow has work left.
        # Check this before the reply/tool completion shortcuts so transitioning
        # into an intermediate node cannot finish the entire SOP.
        if self._graph_flow_has_unfinished_work(skill, chat_session, step_result):
            return False
        if (
            tool_result
            and tool_result.success
            and self._current_step_can_finish_after_tool(skill, chat_session)
        ):
            return True
        if self._graph_pending_steps(chat_session):
            return False
        if self._is_answer_ready_skill_state(skill, chat_session):
            return True
        if self._is_terminal_skill_state(skill, chat_session):
            return True
        if not step_result.next_step_id and not step_result.tool_call:
            return True
        return self._is_terminal_skill_state(skill, chat_session)

    def _is_terminal_skill_state(self, skill: Skill, chat_session: ChatSession) -> bool:
        return self._is_terminal_skill_position(
            skill, chat_session.active_step_id, chat_session.slots_json or {}
        )

    def _is_answer_ready_skill_state(self, skill: Skill, chat_session: ChatSession) -> bool:
        step = self._current_skill_step(skill, chat_session.active_step_id)
        if not step:
            return False
        actions = self._step_actions(step)
        if not self._actions_allow_final_reply(actions):
            return False
        required = [str(field) for field in (skill.content_json or {}).get("required_info", [])]
        return all(
            self._skill_slot_satisfied(chat_session.slots_json or {}, field) for field in required
        )

    def _graph_flow_has_unfinished_work(
        self,
        skill: Skill | None,
        chat_session: ChatSession,
        step_result: StepAgentResult | None = None,
    ) -> bool:
        if not skill or chat_session.active_skill_id != skill.skill_id:
            return False
        if self._graph_pending_steps(chat_session):
            return True
        if (
            step_result
            and step_result.next_step_id
            and str(step_result.next_step_id) == str(chat_session.active_step_id)
        ):
            return True
        if not chat_session.active_step_id:
            return False
        return bool(self._graph_outgoing_edges(skill).get(chat_session.active_step_id))

    def _is_terminal_skill_position(
        self, skill: Skill, active_step_id: str | None, slots: dict[str, Any]
    ) -> bool:
        if not active_step_id:
            return False
        content = skill.content_json or {}
        terminal_node_ids = {str(node_id) for node_id in content.get("terminal_node_ids", [])}
        if active_step_id not in terminal_node_ids:
            return False
        return GraphRules.terminal_position_from_step(
            content,
            active_step_id,
            slots,
            self._current_skill_step(skill, active_step_id),
            self._skill_slot_satisfied,
            self._step_actions,
        )

    def _current_step_can_finish_after_tool(self, skill: Skill, chat_session: ChatSession) -> bool:
        step = self._current_skill_step(skill, chat_session.active_step_id)
        if not step:
            return False
        actions = self._step_actions(step)
        if not self._actions_allow_final_reply(actions):
            return False
        expected = [str(field) for field in step.get("expected_user_info", [])]
        return all(
            self._skill_slot_satisfied(chat_session.slots_json or {}, field) for field in expected
        )

    def _actions_allow_final_reply(self, actions: list[str]) -> bool:
        return GraphRules.actions_allow_final_reply(actions)

    def _complete_active_skill(
        self, tenant_id: str, chat_session: ChatSession, skill: Skill, reason: str
    ) -> None:
        before_skill = chat_session.active_skill_id
        before_step = chat_session.active_step_id
        self.runtime.complete_current_skill(chat_session)
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "skill_completed",
            {
                "skill_id": before_skill or skill.skill_id,
                "step_id": before_step,
                "reason": reason,
                "resumed_skill_id": chat_session.active_skill_id,
                "resumed_step_id": chat_session.active_step_id,
            },
        )

    def _finalize_execution_after_reply(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        active_skill: Skill | None,
        router_decision: RouterDecision,
        step_result: StepAgentResult,
        tool_result: ToolResult | None,
    ) -> ExecutionFinalizeState:
        return TurnFinalizer.finalize(
            tenant_id,
            chat_session,
            active_skill,
            router_decision,
            step_result,
            tool_result,
            current_step_allows_handoff=self._current_step_allows_human_handoff,
            route_to_handoff_node=self._maybe_route_to_handoff_node,
            create_handoff=self._create_human_handoff_request,
            record_event=_legacy_event_recorder(self.events),
            should_complete=self._should_complete_skill,
            complete_skill=self._complete_active_skill,
        )

    def _create_human_handoff_request(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        active_skill: Skill | None,
        step_result: StepAgentResult,
    ) -> HumanHandoffRequest:
        # SOP 节点指定的处理人:从当前 step 的 assignee_user_id 字段读取
        # (handoff 类型节点或 allowed_actions 含 handoff_human 的节点可配置)。
        # assignee_notify_channel 指定投递渠道:None=默认;"web"=仅网页端;绑定渠道=按渠道转接。
        step_assignee_user_id: str | None = None
        step_notify_channel: str | None = None
        current_step = (
            self._current_skill_step(active_skill, chat_session.active_step_id)
            if active_skill
            else None
        )
        if isinstance(current_step, dict):
            step_assignee_user_id = (
                str(current_step.get("assignee_user_id") or "").strip() or None
            )
            step_notify_channel = (
                str(current_step.get("assignee_notify_channel") or "").strip() or None
            )
        # 当前渠道默认处理人:从会话所属 binding 的 config_json 读取。
        binding_default_assignee_user_id, binding_default_notify_channel = (
            self._binding_default_handoff_assignee(tenant_id, chat_session)
        )
        handoff = HumanHandoffService(self.db, self.events).create(
            tenant_id,
            chat_session,
            step_result,
            current_step_resolver=lambda: current_step,
            assignee_resolver=self._human_handoff_assignee_user_id,
            context_summary=self._human_handoff_context_summary,
            pending_question=self._human_handoff_pending_question,
            step_assignee_user_id=step_assignee_user_id,
            binding_default_assignee_user_id=binding_default_assignee_user_id,
            step_notify_channel=step_notify_channel,
            binding_default_notify_channel=binding_default_notify_channel,
            language_context=getattr(self, "_language_context", None),
        )
        # 给 assignee 发渠道私聊通知。失败仅记日志,不影响 handoff 主流程
        # (网页收件箱仍可兜底)。
        self._maybe_notify_handoff_assignee(tenant_id, chat_session, handoff)
        return handoff

    def _binding_default_handoff_assignee(
        self,
        tenant_id: str,
        chat_session: ChatSession,
    ) -> tuple[str | None, str | None]:
        """会话所属渠道绑定配置的默认人工处理人及其通知渠道。

        从 ChatSession.channel_binding_id 反查 binding(而非 agent 挂载列表取首个),
        读取 config_json.default_handoff_assignee_user_id 与
        default_handoff_assignee_channel。无 binding 或未配置返回 (None, None)。
        """
        if not chat_session.channel_binding_id:
            return None, None
        binding = self.db.get(ChannelBinding, chat_session.channel_binding_id)
        if not binding or binding.tenant_id != tenant_id:
            return None, None
        config = binding.config_json if isinstance(binding.config_json, dict) else {}
        value = str(config.get("default_handoff_assignee_user_id") or "").strip()
        if not value:
            return None, None
        channel = str(config.get("default_handoff_assignee_channel") or "").strip()
        return value, (channel or None)

    def _maybe_notify_handoff_assignee(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        handoff: HumanHandoffRequest,
    ) -> None:
        """按通知渠道偏好解析投递 binding,给 assignee 登记渠道私聊通知。

        绑定解析规则:
        - 偏好为具体渠道(如 feishu)时:优先会话所属 binding(渠道匹配且 active);
          会话无 binding 或渠道不匹配时,在租户内找该渠道的任一 active 员工绑定。
        - 偏好为 None(默认)时:用会话所属 binding(渠道支持私聊通知即可达)。
        - 偏好为 "web" 时:仅网页收件箱,直接返回。

        无可用 binding(含日志说明)或 assignee 在该 binding scope 无非群聊身份时,
        由 notify_handoff_assignee 内部跳过,网页收件箱兜底。
        """
        from app.channels.service_outbox import (
            HANDOFF_NOTIFY_CHANNELS,
            notify_handoff_assignee,
            resolve_handoff_notify_binding,
        )

        metadata = handoff.metadata_json if isinstance(handoff.metadata_json, dict) else {}
        notify_channel = str(metadata.get("assignee_notify_channel") or "").strip()
        if notify_channel == "web":
            return
        binding: ChannelBinding | None = None
        if notify_channel:
            # 指定渠道:优先会话所属 binding,渠道不匹配时回退租户内该渠道任一 binding。
            if chat_session.channel_binding_id:
                session_binding = self.db.get(ChannelBinding, chat_session.channel_binding_id)
                if (
                    session_binding
                    and session_binding.tenant_id == tenant_id
                    and session_binding.channel == notify_channel
                    and session_binding.status == "active"
                ):
                    binding = session_binding
            binding = binding or resolve_handoff_notify_binding(self.db, tenant_id, notify_channel)
            if binding is None:
                logger.warning(
                    "handoff 通知跳过:租户无可用的 %s 绑定 handoff=%s", notify_channel, handoff.id
                )
                return
        else:
            # 默认投递:用会话所属 binding,渠道支持私聊通知即可达。
            if not chat_session.channel_binding_id:
                return
            session_binding = self.db.get(ChannelBinding, chat_session.channel_binding_id)
            if (
                not session_binding
                or session_binding.tenant_id != tenant_id
                or session_binding.status != "active"
            ):
                return
            if session_binding.channel not in HANDOFF_NOTIFY_CHANNELS:
                return
            binding = session_binding
        notify_handoff_assignee(
            self.db,
            binding,
            handoff,
            handoff.pending_question or "",
            handoff.context_summary or "",
        )

    def _apply_step_result(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        step_result: StepAgentResult,
        active_skill: Skill | None = None,
    ) -> None:
        source_skill_id = chat_session.active_skill_id
        source_step_id = chat_session.active_step_id
        if step_result.slot_updates:
            chat_session.slots_json = {
                **(chat_session.slots_json or {}),
                **step_result.slot_updates,
            }
            self._record_legacy_event(
                tenant_id,
                chat_session.id,
                "slot_updated",
                {"slot_updates": step_result.slot_updates, "slots": chat_session.slots_json},
            )

        active_skill_matches = bool(
            active_skill and active_skill.skill_id == chat_session.active_skill_id
        )
        invalid_next_step = False
        if active_skill_matches and step_result.next_step_id:
            next_step_id = str(step_result.next_step_id).strip()
            if not self._skill_has_step(active_skill, next_step_id):
                self._record_legacy_event(
                    tenant_id,
                    chat_session.id,
                    "step_agent_result_repaired",
                    {
                        "mode": "invalid_next_step_ignored",
                        "active_skill_id": chat_session.active_skill_id,
                        "active_step_id": chat_session.active_step_id,
                        "invalid_next_step_id": step_result.next_step_id,
                    },
                )
                step_result.next_step_id = None
                step_result.is_step_completed = False
                invalid_next_step = True

        self._sync_awaiting_input_from_step_result(
            chat_session,
            step_result,
            active_skill,
            source_skill_id=source_skill_id,
            source_step_id=source_step_id,
        )

        if not chat_session.active_skill_id:
            return
        if invalid_next_step:
            return
        if active_skill_matches and step_result.next_step_id:
            next_step_id = str(step_result.next_step_id).strip()
            source_step_id = chat_session.active_step_id
            pending_steps = self._graph_pending_steps(chat_session)
            if pending_steps:
                if next_step_id in pending_steps:
                    pending_steps = [item for item in pending_steps if item != next_step_id]
                    self._store_graph_pending_steps(tenant_id, chat_session, pending_steps)
                    self._change_active_step(
                        tenant_id,
                        chat_session,
                        next_step_id,
                        reason="graph_merge_step",
                    )
                    return

                if next_step_id not in pending_steps:
                    pending_steps.append(next_step_id)
                    self._store_graph_pending_steps(tenant_id, chat_session, pending_steps)
                if self._activate_next_pending_graph_step(
                    tenant_id,
                    chat_session,
                    active_skill,
                    reason="graph_sibling_step",
                ):
                    step_result.next_step_id = chat_session.active_step_id
                return

            self._queue_graph_sibling_steps(
                tenant_id,
                chat_session,
                active_skill,
                source_step_id,
                next_step_id,
            )

        if step_result.next_step_id:
            self._change_active_step(tenant_id, chat_session, str(step_result.next_step_id).strip())
            return

        if active_skill_matches and step_result.is_step_completed and self._activate_next_pending_graph_step(
            tenant_id,
            chat_session,
            active_skill,
            reason="graph_pending_step",
        ):
            step_result.next_step_id = chat_session.active_step_id

    def _sync_awaiting_input_from_step_result(
        self,
        chat_session: ChatSession,
        step_result: StepAgentResult,
        active_skill: Skill | None,
        *,
        source_skill_id: str | None,
        source_step_id: str | None,
    ) -> None:
        if not active_skill or active_skill.skill_id != source_skill_id or not source_step_id:
            return

        step = self._current_skill_step(active_skill, source_step_id)
        if not step:
            return
        missing_fields = [
            str(field)
            for field in step.get("expected_user_info", [])
            if not self._skill_slot_satisfied(chat_session.slots_json or {}, str(field))
        ]
        is_waiting_reply = step_result.action in {"ask_user", "clarify"}
        if is_waiting_reply and missing_fields:
            previous = (
                chat_session.awaiting_input_json
                if isinstance(chat_session.awaiting_input_json, dict)
                else {}
            )
            awaiting_input = {
                "skill_id": source_skill_id,
                "step_id": source_step_id,
                "expected_fields": missing_fields,
                "question_summary": str(step_result.reply or "").strip() or None,
            }
            if previous.get("task_id"):
                awaiting_input["task_id"] = previous["task_id"]
            chat_session.awaiting_input_json = awaiting_input
            chat_session.last_agent_question = awaiting_input["question_summary"]
            return

        should_clear = bool(
            step_result.next_step_id
            or step_result.tool_call
            or step_result.is_step_completed
            or not missing_fields
        )
        awaiting = chat_session.awaiting_input_json
        if not should_clear or not isinstance(awaiting, dict):
            return
        if awaiting.get("skill_id") not in {None, source_skill_id}:
            return
        if awaiting.get("step_id") not in {None, source_step_id}:
            return
        task_id = awaiting.get("task_id")
        chat_session.awaiting_input_json = {"task_id": task_id} if task_id else None
        chat_session.last_agent_question = None

    def _change_active_step(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        next_step_id: str,
        *,
        reason: str | None = None,
    ) -> None:
        previous_step = chat_session.active_step_id
        chat_session.active_step_id = next_step_id
        if previous_step == next_step_id:
            return
        payload: dict[str, Any] = {
            "from_skill_id": chat_session.active_skill_id,
            "to_skill_id": chat_session.active_skill_id,
            "from_step_id": previous_step,
            "to_step_id": next_step_id,
        }
        if reason:
            payload["reason"] = reason
        self._record_legacy_event(tenant_id, chat_session.id, "skill_step_changed", payload)

    def _graph_pending_steps(self, chat_session: ChatSession) -> list[str]:
        value = (chat_session.slots_json or {}).get(GRAPH_PENDING_STEPS_SLOT)
        return GraphRules.normalize_pending_steps(value)

    def _store_graph_pending_steps(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        pending_steps: list[str],
    ) -> None:
        slots = dict(chat_session.slots_json or {})
        normalized = GraphRules.normalize_pending_steps(pending_steps)
        if normalized:
            slots[GRAPH_PENDING_STEPS_SLOT] = normalized
        else:
            slots.pop(GRAPH_PENDING_STEPS_SLOT, None)
        chat_session.slots_json = slots
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "graph_pending_steps_updated",
            {"pending_step_ids": normalized},
        )

    def _queue_graph_sibling_steps(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        active_skill: Skill,
        source_step_id: str | None,
        selected_step_id: str,
    ) -> None:
        if not source_step_id:
            return
        outgoing = self._graph_outgoing_edges(active_skill).get(source_step_id) or []
        sibling_steps = GraphRules.sibling_steps_from_edges(
            outgoing,
            selected_step_id,
            self._edge_condition,
        )
        if not sibling_steps:
            return
        pending_steps = self._graph_pending_steps(chat_session)
        for step_id in sibling_steps:
            if step_id not in pending_steps:
                pending_steps.append(step_id)
        self._store_graph_pending_steps(tenant_id, chat_session, pending_steps)

    def _edge_condition(self, edge: dict[str, Any]) -> str:
        return GraphRules.edge_condition(edge)

    def _activate_next_pending_graph_step(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        active_skill: Skill,
        *,
        reason: str,
    ) -> bool:
        pending_steps = self._graph_pending_steps(chat_session)
        while pending_steps:
            next_step_id = pending_steps.pop(0)
            if not self._skill_has_step(active_skill, next_step_id):
                continue
            self._store_graph_pending_steps(tenant_id, chat_session, pending_steps)
            self._change_active_step(tenant_id, chat_session, next_step_id, reason=reason)
            return True
        self._store_graph_pending_steps(tenant_id, chat_session, [])
        return False

    def _skill_has_step(self, skill: Skill, step_id: str | None) -> bool:
        return GraphRules.has_step(skill.content_json or {}, step_id)

    def _first_step_id(self, skill: Skill) -> str | None:
        content = skill.content_json or {}
        start_node_id = str(content.get("start_node_id") or "").strip()
        if start_node_id and self._skill_has_step(skill, start_node_id):
            return start_node_id
        steps = self._skill_steps(skill)
        first_step = steps[0] if steps and isinstance(steps[0], dict) else None
        return first_step.get("step_id") if first_step else None

    def _skill_steps(self, skill: Skill) -> list[dict[str, Any]]:
        return GraphRules.steps_from_nodes(self._ordered_skill_nodes(skill))

    def _skill_nodes(self, skill: Skill) -> list[dict[str, Any]]:
        return GraphRules.nodes(skill.content_json or {})

    def _ordered_skill_nodes(self, skill: Skill) -> list[dict[str, Any]]:
        content = skill.content_json or {}
        return GraphRules.ordered_nodes(
            content,
            nodes=self._skill_nodes(skill),
            outgoing=self._graph_outgoing_edges(skill),
        )

    def _graph_outgoing_edges(self, skill: Skill) -> dict[str, list[dict[str, Any]]]:
        return GraphRules.outgoing_edges(skill.content_json or {})

    def _default_next_step(self, skill: Skill, active_step_id: str | None) -> dict[str, Any] | None:
        if not active_step_id:
            return None
        return GraphRules.default_next_step_from_parts(
            self._skill_nodes(skill),
            self._graph_outgoing_edges(skill).get(active_step_id, []),
        )

    def _get_or_create_session(self, request: ChatTurnRequest) -> ChatSession:
        """Load or create a session and seed its reply locale from the active turn snapshot."""
        session_id = request.session_id or new_id("session")
        chat_session = self.db.get(ChatSession, session_id)
        if not chat_session:
            chat_session = ChatSession(
                id=session_id,
                tenant_id=request.tenant_id,
                user_id=request.user_id,
                agent_id=request.agent_id,
                channel=(
                    request.channel
                    if request.channel in {PILOTDECK_GROUP_CHAT_CHANNEL, "skill_test"}
                    else None
                ),
                agent_reply_locale=(
                    self._language_context.agent_reply_locale.value
                    if self._language_context is not None
                    else None
                ),
                agent_reply_locale_source=(
                    self._language_context.agent_reply_locale_source.value
                    if self._language_context is not None
                    else None
                ),
            )
            self.db.add(chat_session)
            self.db.flush()
        elif not chat_session.agent_id and request.agent_id:
            chat_session.agent_id = request.agent_id
        if chat_session.agent_reply_locale is None and self._language_context is not None:
            chat_session.agent_reply_locale = self._language_context.agent_reply_locale.value
            chat_session.agent_reply_locale_source = (
                self._language_context.agent_reply_locale_source.value
            )
        return chat_session

    def _current_skill_step(
        self, skill: Skill, active_step_id: str | None
    ) -> dict[str, Any] | None:
        if not active_step_id:
            return None
        return GraphRules.current_step_from_steps(self._skill_steps(skill), active_step_id)

    def _skill_slot_satisfied(self, slots: dict[str, Any], field: str) -> bool:
        return GraphRules.slot_satisfied(slots, field)

    def _get_request_model(
        self,
        request: ChatTurnRequest,
        agent_id: str | None = None,
        role: str = "default",
    ) -> ModelConfig | None:
        if request.model_config_id:
            row = self.db.get(ModelConfig, request.model_config_id)
            if not row or row.tenant_id != request.tenant_id:
                raise AgentLoopPreconditionError("invalid_model_config", "选中的模型配置不存在。")
            if not row.enabled:
                raise AgentLoopPreconditionError("disabled_model_config", "选中的模型配置已停用。")
            return resolve_model_config_for_runtime(self.db, request.tenant_id, row.id)
        return self._get_default_model(request.tenant_id, agent_id, role)

    def _get_default_model(
        self, tenant_id: str, agent_id: str | None = None, role: str = "default"
    ) -> ModelConfig | None:
        return model_for_agent(self.db, tenant_id, agent_id, role)

    def _get_persona_prompt(self, tenant_id: str, agent_id: str | None = None) -> str | None:
        agent = self._get_agent_profile(tenant_id, agent_id)
        if agent and not agent.is_overall:
            return _agent_identity_prompt(agent)
        if agent and agent.is_overall and agent.persona_prompt:
            return agent.persona_prompt
        row = self.db.get(PersonaConfig, tenant_id)
        return row.system_prompt if row else None

    def _get_agent_loop_max_actions(
        self, tenant_id: str, agent_id: str | None = None
    ) -> int:
        if not hasattr(self.db, "get"):
            return MAX_TOOL_ACTIONS_PER_TURN
        agent = self.db.get(AgentProfile, agent_id) if agent_id else None
        if agent is not None and (
            agent.tenant_id != tenant_id or agent.status != "active"
        ):
            agent = None
        if agent is not None:
            value = agent.harness_max_actions
            return max(1, min(int(value), MAX_TOOL_ACTIONS_PER_TURN_LIMIT))
        row = self.db.get(UIConfig, tenant_id)
        value = row.agent_loop_max_actions if row else MAX_TOOL_ACTIONS_PER_TURN
        return max(1, min(int(value), MAX_TOOL_ACTIONS_PER_TURN_LIMIT))

    def _get_conversation_context_settings(
        self,
        tenant_id: str,
    ) -> ConversationContextSettings:
        if not hasattr(self.db, "get"):
            return ConversationContextSettings()
        row = self.db.get(UIConfig, tenant_id)
        if row is None:
            return ConversationContextSettings()
        return ConversationContextSettings(
            token_budget=getattr(row, "context_token_budget", 32_000),
            compaction_trigger_ratio=getattr(
                row,
                "context_compaction_trigger_ratio",
                0.70,
            ),
            recent_round_limit=getattr(row, "context_recent_round_limit", 6),
            long_summary_token_budget=getattr(
                row,
                "context_long_summary_token_budget",
                4_000,
            ),
            medium_summary_token_budget=getattr(
                row,
                "context_medium_summary_token_budget",
                4_000,
            ),
            allowed_roles=frozenset(
                getattr(row, "context_allowed_roles", None)
                or {"user", "assistant"}
            ),
            long_summary_prefix=getattr(
                row,
                "context_long_summary_prefix",
                "历史的信息可以被总结为：",
            ),
            medium_summary_prefix=getattr(
                row,
                "context_medium_summary_prefix",
                "近期的历史信息总结为：",
            ),
        ).normalized()

    def _list_published_skills(self, tenant_id: str, agent_id: str | None = None) -> list[Skill]:
        return visible_published_skills(self.db, tenant_id, agent_id)

    def _get_agent_profile(self, tenant_id: str, agent_id: str | None) -> AgentProfile | None:
        if not agent_id:
            return None
        row = self.db.get(AgentProfile, agent_id)
        if not row or row.tenant_id != tenant_id or row.status != "active":
            return None
        return row

    def _get_active_skill(
        self, tenant_id: str, skill_id: str | None, agent_id: str | None = None
    ) -> Skill | None:
        if not skill_id:
            return None
        return visible_skill(self.db, tenant_id, skill_id, agent_id)

    def _drop_unavailable_skill_state(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        skills: list[Skill],
    ) -> bool:
        skills_by_id = {skill.skill_id: skill for skill in skills}
        available_skill_ids = set(skills_by_id)
        changed = False
        removed_skill_ids: set[str] = set()
        repaired_steps: list[dict[str, str | None]] = []

        if chat_session.skill_stack_json or chat_session.resume_after_answer_json:
            chat_session.skill_stack_json = []
            chat_session.resume_after_answer_json = None
            changed = True

        def frame_skill_id(frame: object) -> str:
            if not isinstance(frame, dict):
                return ""
            return str(frame.get("target_skill_id") or frame.get("skill_id") or "").strip()

        def keep_frame(frame: object) -> bool:
            skill_id = frame_skill_id(frame)
            if not skill_id:
                return True
            if skill_id in available_skill_ids:
                return True
            removed_skill_ids.add(skill_id)
            return False

        active_skill_id = str(chat_session.active_skill_id or "").strip()
        if active_skill_id and active_skill_id not in available_skill_ids:
            removed_skill_ids.add(active_skill_id)
            chat_session.active_skill_id = None
            chat_session.active_step_id = None
            chat_session.slots_json = {}
            chat_session.awaiting_input_json = None
            chat_session.resume_after_answer_json = None
            changed = True
        elif active_skill_id:
            active_skill = skills_by_id[active_skill_id]
            active_step_id = str(chat_session.active_step_id or "").strip()
            restored_step_id = self._first_step_id(active_skill)
            if (
                restored_step_id
                and active_step_id != restored_step_id
                and not self._skill_has_step(active_skill, active_step_id)
            ):
                chat_session.active_step_id = restored_step_id
                awaiting = (
                    chat_session.awaiting_input_json
                    if isinstance(chat_session.awaiting_input_json, dict)
                    else {}
                )
                task_id = awaiting.get("task_id")
                chat_session.awaiting_input_json = {"task_id": task_id} if task_id else None
                chat_session.last_agent_question = None
                repaired_steps.append(
                    {
                        "skill_id": active_skill_id,
                        "from_step_id": active_step_id,
                        "to_step_id": restored_step_id,
                    }
                )
                changed = True

        for attr in ("pending_tasks_json",):
            value = getattr(chat_session, attr) or []
            if not isinstance(value, list):
                continue
            kept = [frame for frame in value if keep_frame(frame)]
            if len(kept) != len(value):
                setattr(chat_session, attr, kept)
                changed = True

        awaiting = chat_session.awaiting_input_json
        if isinstance(awaiting, dict):
            awaiting_skill_id = str(awaiting.get("skill_id") or "").strip()
            if awaiting_skill_id and awaiting_skill_id not in available_skill_ids:
                removed_skill_ids.add(awaiting_skill_id)
                chat_session.awaiting_input_json = None
                changed = True

        if changed:
            chat_session.updated_at = utc_now()
            if hasattr(self, "events"):
                self._record_legacy_event(
                    tenant_id,
                    chat_session.id,
                    "skill_state_pruned",
                    {
                        "removed_skill_ids": sorted(removed_skill_ids),
                        "repaired_steps": repaired_steps,
                    },
                )
        return changed

    def _conversation_context(
        self,
        chat_session: ChatSession,
        model_config: ModelConfig | None = None,
    ) -> dict[str, object]:
        if not hasattr(self, "db") or not hasattr(self.db, "exec"):
            return build_conversation_context([])
        rows = list(
            self.db.exec(
                select(Message)
                .where(
                    Message.tenant_id == chat_session.tenant_id,
                    Message.session_id == chat_session.id,
                )
                .order_by(Message.created_at.asc())
            ).all()
        )
        visible_rows = visible_message_rows(rows)
        context = build_conversation_context(
            [
                ConversationProjection.message_context_entry(
                    row,
                    content=visible_message_content(row),
                )
                for row in visible_rows
            ],
            settings=self._get_conversation_context_settings(chat_session.tenant_id),
            context_state=chat_session.context_state_json,
            summary_builder=self._context_summary_builder(model_config) if model_config else None,
        )
        next_state = context.get("context_state")
        if isinstance(next_state, dict) and next_state != (chat_session.context_state_json or {}):
            chat_session.context_state_json = next_state
            self.db.add(chat_session)
        return context

    def _context_summary_builder(self, model_config: ModelConfig) -> Callable[[str, str, int], str]:
        """Build a context compactor that uses the active immutable reply-locale snapshot."""

        def summarize(label: str, source: str, token_budget: int) -> str:
            """Summarize raw conversation history into locale-bound prose for future turns."""
            del label
            language_contract = language_prompt_contract(
                getattr(self, "_language_context", None),
                [
                    RawSourceMarker(
                        json_pointer="/history_to_compress",
                        kind=RawSourceKind.HISTORY,
                    )
                ],
            )
            payload = stage_payload(
                phase="Context Compression",
                user_message="Compress conversation history",
                conversation_context={},
                memory_context=None,
                instructions=(
                    "Compress the provided conversation history into a concise factual summary "
                    "for future turns. Preserve source-owned history facts when quoting; retain "
                    "identity, preferences, confirmed facts, unfinished tasks, key constraints, "
                    "and tool or knowledge conclusions. Remove greetings, repetition, internal "
                    "IDs, timestamps, and reasoning. Do not invent information."
                ),
                stage_data={"history_to_compress": source},
                output_contract=(
                    f"Return only one plain-text summary of approximately {token_budget} tokens "
                    "or fewer."
                ),
            )
            payload.update(language_contract)
            with llm_operation("context.compact"):
                return (
                    LLMClient(model_config).generate_text(unified_system_prompt(), payload).strip()
                )

        return summarize

    def _message_context_entry(self, row: Message) -> dict[str, Any]:
        return ConversationProjection.message_context_entry(row)

    def _assistant_message_metadata(
        self,
        step_result: StepAgentResult | None,
        chat_session: ChatSession,
        source_message: str | None = None,
    ) -> dict[str, Any]:
        """Project assistant metadata with the active immutable locale snapshot."""
        return ConversationProjection.assistant_message_metadata(
            step_result,
            citation_deduper=self._dedupe_knowledge_citations,
            language_context=self._language_context,
        )

    def _dedupe_knowledge_citations(self, citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return ConversationProjection.dedupe_knowledge_citations(citations)

    def _append_message(
        self,
        tenant_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> Message:
        message = Message(
            tenant_id=tenant_id,
            session_id=session_id,
            role=role,
            content=content,
            metadata_json=metadata or {},
        )
        self.db.add(message)
        return message

    def _persist_cancelled_assistant_message(
        self,
        tenant_id: str,
        chat_session: ChatSession,
        user_message_id: str,
        client_turn_id: str | None = None,
    ) -> Message | None:
        """Persist one cancellation reply while retaining the turn's language snapshot."""
        if not user_message_id:
            return None
        user_message = self.db.get(Message, user_message_id)
        if (
            not user_message
            or user_message.tenant_id != tenant_id
            or user_message.session_id != chat_session.id
            or user_message.role != "user"
        ):
            return None

        normalized_client_turn_id = (client_turn_id or "").strip()
        turn_ids = {user_message_id}
        if normalized_client_turn_id:
            turn_ids.add(normalized_client_turn_id)
        existing_messages = self.db.exec(
            select(Message)
            .where(
                Message.tenant_id == tenant_id,
                Message.session_id == chat_session.id,
                Message.role == "assistant",
            )
            .order_by(Message.created_at)
        ).all()
        for row in existing_messages:
            metadata = row.metadata_json or {}
            row_turn_ids = {
                str(metadata.get("turn_id") or "").strip(),
                str(metadata.get("user_message_id") or "").strip(),
                str(metadata.get("client_turn_id") or "").strip(),
            }
            if turn_ids & row_turn_ids:
                return None

        chat_session.updated_at = utc_now()
        chat_session.status = "active"
        cancelled_reply = localized_cancelled_reply(self._language_context)
        summary_prefix = localized_compat_text(
            self._language_context,
            zh_cn="最近回复：",
            en_us="Latest reply: ",
        )
        chat_session.summary = f"{summary_prefix}{cancelled_reply}"
        user_visibility = str(
            (user_message.metadata_json or {}).get("message_visibility") or "visible"
        )
        cancelled_metadata = {
            "turn_id": user_message_id,
            "user_message_id": user_message_id,
            "client_turn_id": normalized_client_turn_id or None,
            "status": "cancelled",
        }
        if user_visibility != "visible":
            cancelled_metadata["message_visibility"] = user_visibility
        if self._language_context is not None:
            cancelled_metadata["language_context"] = self._language_context.model_dump(mode="json")
        assistant_message = self._append_message(
            tenant_id,
            chat_session.id,
            "assistant",
            cancelled_reply,
            metadata=cancelled_metadata,
        )
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "assistant_message_created",
            {
                "message_id": assistant_message.id,
                "assistant_message_id": assistant_message.id,
                "user_message_id": user_message_id,
                "turn_id": user_message_id,
                "client_turn_id": normalized_client_turn_id or None,
                "reply": cancelled_reply,
                "status": "cancelled",
                **(
                    {"language_context": self._language_context.model_dump(mode="json")}
                    if self._language_context is not None
                    else {}
                ),
            },
        )
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "session_state_changed",
            public_session(chat_session).model_dump(),
        )
        return assistant_message

    def _user_message_metadata(self, request: ChatTurnRequest) -> dict[str, Any]:
        return ConversationProjection.user_message_metadata(request)

    def _enqueue_memory_capture(
        self,
        request: ChatTurnRequest,
        chat_session: ChatSession,
        step_result: StepAgentResult,
        tool_result: ToolResult | None,
        model_config: ModelConfig,
    ) -> list[dict[str, object]]:
        try:
            job = enqueue_memory_capture(
                request,
                chat_session.id,
                step_result,
                tool_result,
                model_config.id,
            )
        except Exception:
            logger.exception(
                "memory capture enqueue failed",
                extra={"tenant_id": request.tenant_id, "session_id": chat_session.id},
            )
            language_context = self._language_context or resolve_compatible_language_context(
                snapshot=request.language_context,
                legacy_ui_locale=(request.ui_locale.value if request.ui_locale else None),
                legacy_agent_reply_locale=(
                    request.agent_reply_locale.value if request.agent_reply_locale else None
                ),
            )
            try:
                record_product_event(
                    self.events,
                    event_code="memory.capture.failed",
                    tenant_id=request.tenant_id,
                    aggregate_type="chat_session",
                    aggregate_id=chat_session.id,
                    params={
                        "reason_code": "MEMORY_CAPTURE_ENQUEUE_FAILED",
                        "missing_session": False,
                        "missing_model_config": False,
                    },
                    language_context=language_context,
                    client_turn_id=request.client_turn_id,
                )
            except Exception:
                logger.exception(
                    "memory capture failure event recording failed",
                    extra={"tenant_id": request.tenant_id, "session_id": chat_session.id},
                )
            return []
        self._record_legacy_event(
            request.tenant_id,
            chat_session.id,
            "async_job_enqueued",
            {"job_id": job.id, "job_name": job.name, "feature": "memory"},
        )
        self.db.commit()
        return [{"job_id": job.id, "job_name": job.name}]

    def _finish_with_error(
        self, chat_session: ChatSession, code: str, message: str
    ) -> ChatTurnResponse:
        """Finalize a configuration error while preserving the active language snapshot."""
        self._abort_stream_sink()
        reply = format_runtime_failure_reply(
            localized_compat_text(
                self._language_context,
                zh_cn="系统配置错误",
                en_us="System configuration error",
            ),
            message,
            code,
            localized_compat_text(
                self._language_context,
                zh_cn="请在管理端补齐配置后重试。",
                en_us="Complete the required configuration in the admin console and retry.",
            ),
            self._language_context,
        )
        self._record_legacy_event(
            chat_session.tenant_id,
            chat_session.id,
            "error_occurred",
            {"code": code, "message": code},
        )
        reply = self._finalize_turn(chat_session, chat_session.tenant_id, reply)
        self.db.commit()
        self.db.refresh(chat_session)
        return self._response_with_language_context(ChatTurnResponse(
            reply=reply,
            session_id=chat_session.id,
            runtime_error_code=code,
            session_state=public_session(chat_session),
        ))

    def _finalize_turn(
        self,
        chat_session: ChatSession,
        tenant_id: str,
        reply: str,
        step_result: StepAgentResult | None = None,
        source_message: str | None = None,
        user_message_id: str | None = None,
        assistant_metadata_override: dict[str, Any] | None = None,
    ) -> str:
        """Persist the assistant reply, delivery stage, trace event, and language snapshot."""
        chat_session.updated_at = utc_now()
        if chat_session.status != "handoff":
            chat_session.status = "active"
        metadata = self._assistant_message_metadata(step_result, chat_session, source_message)
        if assistant_metadata_override:
            metadata = {**metadata, **dict(assistant_metadata_override)}
        reply = restore_truncated_atomic_references(reply, metadata.get("knowledge_citations"))
        reply = self._normalize_reply_citation_labels(reply, metadata.get("knowledge_citations"))
        reply = self._strip_trailing_citation_summary(reply)
        reply, compacted_citations = compact_knowledge_citation_labels(
            reply,
            metadata.get("knowledge_citations"),
        )
        metadata = dict(metadata)
        if compacted_citations:
            metadata["knowledge_citations"] = compacted_citations
        else:
            metadata.pop("knowledge_citations", None)
            metadata.pop("knowledge_query", None)
        if not chat_session.title and source_message:
            fallback_title = self._fallback_session_title_from_message(source_message)
            if fallback_title:
                chat_session.title = fallback_title
        summary_prefix = localized_compat_text(
            self._language_context,
            zh_cn="最近回复：",
            en_us="Latest reply: ",
        )
        chat_session.summary = f"{summary_prefix}{reply[:120]}"
        assistant_metadata = dict(metadata or {})
        if user_message_id:
            assistant_metadata.setdefault("user_message_id", user_message_id)
            assistant_metadata.setdefault("turn_id", user_message_id)
        assistant_message = self._append_message(
            tenant_id,
            chat_session.id,
            "assistant",
            reply,
            metadata=assistant_metadata,
        )
        if not self.stream_delivery_succeeded:
            not_before = (
                utc_now() + timedelta(seconds=_STREAM_FALLBACK_GRACE_SECONDS)
                if self.stream_delivery_pending
                else None
            )
            delivery = stage_channel_delivery(
                self.db,
                chat_session,
                assistant_message,
                not_before=not_before,
            )
            if (
                self.stream_delivery_pending
                and delivery is not None
                and delivery.status == "pending"
            ):
                self.stream_delivery_id = delivery.id
        event_payload: dict[str, Any] = {
            "message_id": assistant_message.id,
            "assistant_message_id": assistant_message.id,
            "reply": reply,
        }
        if user_message_id:
            event_payload["user_message_id"] = user_message_id
            event_payload["turn_id"] = user_message_id
        if assistant_metadata.get("knowledge_citations"):
            event_payload["knowledge_citations"] = assistant_metadata["knowledge_citations"]
        if assistant_metadata.get("message_visibility"):
            event_payload["message_visibility"] = assistant_metadata["message_visibility"]
        if assistant_metadata.get("language_context"):
            event_payload["language_context"] = assistant_metadata["language_context"]
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "assistant_message_created",
            event_payload,
        )
        self._record_legacy_event(
            tenant_id,
            chat_session.id,
            "session_state_changed",
            public_session(chat_session).model_dump(),
        )
        return reply

    def _mark_session_running(self, chat_session: ChatSession) -> None:
        if chat_session.status == "handoff":
            return
        chat_session.status = "running"
        chat_session.updated_at = utc_now()
        self.db.add(chat_session)

    @staticmethod
    def _fallback_session_title_from_message(message: str) -> str:
        return ConversationProjection.fallback_session_title(message)

    def _normalize_reply_citation_labels(self, reply: str, citations: object) -> str:
        return ConversationProjection.normalize_reply_citation_labels(reply, citations)

    def _strip_trailing_citation_summary(self, reply: str) -> str:
        return ConversationProjection.strip_trailing_citation_summary(reply)

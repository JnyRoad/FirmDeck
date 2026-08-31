from datetime import datetime, timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.core.cancellation as cancellation_module
from app.api.chat import (
    _TRACE_EVENT_CODES,
    _build_turn_traces,
    _event_trace_lines,
    _events_after_cursor,
    _harness_event_trace_line,
    _message_turn_ids_from_events,
    _normalized_session_event_payload,
    _persist_chat_turn_cancelled,
    _persist_chat_turn_interrupted,
    _relay_event_payload,
    _resolve_step_label,
    _scheduled_task_draft_reply,
    _trace_event_descriptor,
    list_chat_session_spans,
    message_read,
)
from app.channels.feishu_trace import _SinkEvent
from app.contracts.event_registry import EVENT_REGISTRY
from app.contracts.events import EventVisibility, SystemEvent
from app.core.cancellation import is_chat_turn_cancelled
from app.db.models import (
    AgentEvent,
    ChatSession,
    HarnessTurnRecord,
    KnowledgeConcept,
    Message,
    Tenant,
    User,
)
from app.i18n.language_context import LanguageContext, LocaleResolutionSource, SupportedLocale
from app.observability.event_log import EventLog


def test_task_frame_finished_keeps_switched_sop_name_while_awaiting_user() -> None:
    line = _harness_event_trace_line(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="task_frame_finished",
            payload_json={
                "task_frame_id": "task_purchase",
                "kind": "sop",
                "skill_id": "skill_purchase_001",
                "skill_name": "购买商品流程",
                "step_id": "collect_user_name",
                "status": "awaiting_user",
                "action_count": 1,
            },
        )
    )

    assert line["id"] == "harness_frame_task_purchase"
    assert line["kind"] == "skill"
    assert line["text"] == ""
    assert line["event_type"] == "task_frame_finished"
    assert line["event_code"] == "run.task.frame.finished"
    assert line["params"] == {}
    assert line["event_data"]["skill_name"] == "购买商品流程"
    assert line["state"] == "running"
    assert "detail" not in line


def test_event_log_binds_all_execution_events_to_current_turn() -> None:
    with _test_db() as db:
        events = EventLog(db)
        events.bind_turn("msg_user", "client_turn")

        event = events.record(
            "tenant_demo",
            "session_test",
            "step_agent_result_created",
            {"reply": "请补充退款原因"},
        )

        assert event.payload_json == {
            "reply": "请补充退款原因",
            "turn_id": "msg_user",
            "user_message_id": "msg_user",
            "client_turn_id": "client_turn",
        }


def test_event_log_binds_language_context_to_execution_events() -> None:
    """Persist the immutable UI/reply locale snapshot on every bound stream event."""
    with _test_db() as db:
        events = EventLog(db)
        context = LanguageContext(
            ui_locale=SupportedLocale.EN_US,
            agent_reply_locale=SupportedLocale.ZH_CN,
            ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
            agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
        )
        events.bind_turn("msg_user", "client_turn", language_context=context)

        event = events.record(
            "tenant_demo",
            "session_test",
            "stream_status",
            {"phase": "planning", "text": "正在规划本轮任务"},
        )

        assert event.payload_json["language_context"] == context.model_dump(mode="json")
        assert event.payload_json["turn_id"] == "msg_user"


def test_harness_recovery_event_projects_its_canonical_code_and_params() -> None:
    """Keep recovery visible after replay without restoring the legacy localized reply."""
    event = AgentEvent(
        tenant_id="tenant_demo",
        session_id="session_recovery",
        event_type="harness_execution_recovered",
        payload_json={
            "schema_version": 2,
            "event_code": "harness.execution.recovered",
            "params": {"error_code": "INTERNAL_ERROR"},
        },
    )

    lines = _event_trace_lines(event, {})

    assert len(lines) == 1
    assert lines[0]["event_code"] == "harness.execution.recovered"
    assert lines[0]["params"] == {"error_code": "INTERNAL_ERROR"}
    assert lines[0]["text"] == ""


def test_session_spans_endpoint_returns_internal_spans_without_relaying_them() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        user = User(
            id="user_demo",
            tenant_id="tenant_demo",
            username="demo",
            password_hash="hashed",
        )
        db.add(user)
        db.add(
            ChatSession(
                id="session_test",
                tenant_id="tenant_demo",
                user_id=user.id,
            )
        )
        db.add(
            AgentEvent(
                id="evt_span",
                tenant_id="tenant_demo",
                session_id="session_test",
                event_type="llm_call_finished",
                payload_json={
                    "span_id": "span_demo",
                    "operation": "router.scene",
                    "duration_ms": 123.4,
                },
            )
        )
        db.add(
            AgentEvent(
                id="evt_business",
                tenant_id="tenant_demo",
                session_id="session_test",
                event_type="router_decision_created",
                payload_json={"decision": "answer_only"},
            )
        )
        db.commit()

        spans = list_chat_session_spans(
            "session_test",
            tenant_id="tenant_demo",
            current_user=user,
            db=db,
        )
        relayed = _events_after_cursor(db, "tenant_demo", "session_test", None)

    assert len(spans) == 1
    assert spans[0]["operation"] == "router.scene"
    assert spans[0]["duration_ms"] == 123.4
    assert [event.event_type for event in relayed] == ["router_decision_created"]


def test_session_spans_endpoint_sanitizes_failed_span_error_payload() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
    ).model_dump(mode="json")
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        user = User(
            id="user_demo",
            tenant_id="tenant_demo",
            username="demo",
            password_hash="hashed",
        )
        db.add(user)
        db.add(
            ChatSession(
                id="session_test",
                tenant_id="tenant_demo",
                user_id=user.id,
            )
        )
        db.add(
            AgentEvent(
                id="evt_span_failed",
                tenant_id="tenant_demo",
                session_id="session_test",
                event_type="llm_call_failed",
                payload_json={
                    "span_id": "span_failed",
                    "operation": "router.scene",
                    "duration_ms": 12.5,
                    "error": "secret token=/private/router.sock",
                    "error_type": "RuntimeError",
                    "language_context": context,
                },
            )
        )
        db.commit()

        spans = list_chat_session_spans(
            "session_test",
            tenant_id="tenant_demo",
            current_user=user,
            db=db,
        )

    assert len(spans) == 1
    assert spans[0]["operation"] == "router.scene"
    assert spans[0]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert spans[0]["language_context"] == context
    assert "secret token" not in str(spans[0])
    assert "error_type" not in spans[0]


def test_relay_event_payload_sanitizes_legacy_auto_route_error() -> None:
    context = LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    ).model_dump(mode="json")
    row = AgentEvent(
        id="evt_route_failed",
        tenant_id="tenant_demo",
        session_id="session_test",
        event_type="auto_route_decision",
        payload_json={
            "current_agent_id": "agent_xz",
            "agent_id": "agent_xz",
            "switched": False,
            "confidence": 0.0,
            "threshold": 0.75,
            "reason": "",
            "error": "Expecting value: secret classifier body",
            "language_context": context,
        },
    )

    normalized = _normalized_session_event_payload(row)
    event_name, relayed = _relay_event_payload(row)

    assert event_name == "auto_route_decision"
    assert normalized["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert relayed["error"] == normalized["error"]
    assert normalized["language_context"] == context
    assert relayed["language_context"] == context
    assert "secret classifier body" not in str(normalized)
    assert "Expecting value" not in str(relayed)


def test_turn_trace_uses_router_skill_hint_when_events_have_turn_id() -> None:
    started_at = datetime(2026, 6, 5, 6, 35, 4)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="帮我下单a2，实际发货a3",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "帮我下单a2，实际发货a3"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="router_decision_created",
            payload_json={
                "decision": "continue_active",
                "target_skill_id": "skill_purchase_001",
                "target_step_id": "confirm_purchase",
                "user_intent": "下单",
                "reason": "继续购买流程",
                "user_message_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="skill_step_changed",
            payload_json={
                "from_step_id": "confirm_purchase",
                "to_step_id": "end",
                "user_message_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="assistant_message_created",
            payload_json={"user_message_id": "msg_user", "reply": "已完成"},
            created_at=started_at + timedelta(seconds=3),
        ),
    ]

    traces = _build_turn_traces(messages, events, {"skill_purchase_001": "购买商品流程"})

    skill_lines = [line for line in traces[0]["lines"] if line["kind"] == "skill"]
    assert skill_lines
    assert skill_lines[0]["text"] == ""
    assert skill_lines[0]["event_type"] == "skill_step_changed"
    assert skill_lines[0]["event_code"] == "run.sop.state"
    assert skill_lines[0]["event_data"]["to_step_id"] == "end"
    assert "detail" not in skill_lines[0]
    router_line = next(line for line in traces[0]["lines"] if line["id"] == "decision_router")
    assert router_line["icon"] == "judge"
    assert skill_lines[0]["icon"] == "advance"


def test_turn_trace_recovers_persisted_skill_state_for_current_turn() -> None:
    started_at = datetime(2026, 7, 14, 9, 57, 4)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="先查询天气，再购买 a1",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "先查询天气，再购买 a1"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="skill_state",
            payload_json={
                "activeSkillId": "skill_purchase_001",
                "activeStepId": "collect_user_name",
                "currentSkills": [
                    {
                        "skillId": "skill_purchase_001",
                        "name": "购买商品流程",
                        "stepId": "collect_user_name",
                        "state": "active",
                    },
                    {
                        "skillId": "skill_weather_001",
                        "name": "天气查询流程",
                        "stepId": "collect_city",
                        "state": "pending",
                    },
                ],
                "runtimeDecision": "start_new_task",
                "user_message_id": "msg_user",
                "turn_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
    ]

    traces = _build_turn_traces(messages, events, {"skill_purchase_001": "购买商品流程"})

    skill_lines = [line for line in traces[0]["lines"] if line["kind"] == "skill"]
    assert skill_lines[0]["id"] == "skill_state_skill_purchase_001_active_collect_user_name"
    assert skill_lines[0]["text"] == ""
    assert skill_lines[0]["event_type"] == "skill_state"
    assert skill_lines[0]["event_code"] == "run.sop.state"
    assert skill_lines[0]["event_data"]["current_skill"]["name"] == "购买商品流程"
    assert "detail" not in skill_lines[0]
    assert skill_lines[1]["id"] == "skill_state_skill_weather_001_pending_collect_city"
    assert skill_lines[1]["text"] == ""
    assert skill_lines[1]["event_code"] == "run.sop.state"


def test_turn_trace_merges_skill_started_with_matching_state_snapshot() -> None:
    started_at = datetime(2026, 7, 15, 13, 44, 11)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="帮我查询本月报销额度",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "帮我查询本月报销额度"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="skill_started",
            payload_json={
                "decision": "start_new_task",
                "to_skill_id": "skill_expense_quota_query",
                "to_step_id": "node_collect_info",
                "turn_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="skill_state",
            payload_json={
                "runtimeDecision": "start_new_task",
                "currentSkills": [
                    {
                        "skillId": "skill_expense_quota_query",
                        "name": "报销额度查询",
                        "stepId": "node_collect_info",
                        "state": "active",
                    }
                ],
                "turn_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=2),
        ),
    ]

    traces = _build_turn_traces(
        messages,
        events,
        {"skill_expense_quota_query": "报销额度查询"},
    )

    skill_lines = [line for line in traces[0]["lines"] if line["kind"] == "skill"]
    assert len(skill_lines) == 1
    assert skill_lines[0]["id"] == "skill_state_skill_expense_quota_query_active_node_collect_info"
    assert skill_lines[0]["kind"] == "skill"
    assert skill_lines[0]["text"] == ""
    assert skill_lines[0]["event_type"] == "skill_state"
    assert skill_lines[0]["event_code"] == "run.sop.state"
    assert skill_lines[0]["params"] == {}
    assert skill_lines[0]["state"] == "running"
    assert skill_lines[0]["icon"] == "advance"
    assert "detail" not in skill_lines[0]


def test_turn_trace_uses_live_stream_ids_for_persisted_status_events() -> None:
    started_at = datetime(2026, 7, 15, 14, 10, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="查询报销额度",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "查询报销额度"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="stream_status",
            payload_json={"phase": "stepping", "text": "正在思考", "turn_id": "msg_user"},
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="stream_status",
            payload_json={"phase": "reflecting", "text": "正在反思", "turn_id": "msg_user"},
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="stream_status",
            payload_json={"phase": "knowledge", "text": "查询业务资料", "turn_id": "msg_user"},
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="stream_status",
            payload_json={
                "phase": "tool",
                "text": "正在调用工具",
                "tool_name": "expense.quota_query",
                "tool_call_id": "call_1",
                "turn_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=4),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert [line["id"] for line in traces[0]["lines"]] == [
        "decision_stepping_main",
        "reflection",
        "knowledge_lookup",
        "tool_call_1",
    ]


def test_turn_trace_merges_knowledge_lifecycle_events_for_same_query() -> None:
    started_at = datetime(2026, 7, 15, 14, 33, 9)
    query = "招待客户的餐费是否计入差旅费报销范围"
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content=query,
            created_at=started_at,
        )
    ]
    common_payload = {"query": {"query": query}, "turn_id": "msg_user"}
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": query},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="knowledge_query_started",
            payload_json=common_payload,
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="knowledge_query_finished",
            payload_json={**common_payload, "selected_concepts": [{"id": "concept_1"}]},
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="knowledge_result",
            payload_json={**common_payload, "selected_concepts": [{"id": "concept_1"}]},
            created_at=started_at + timedelta(seconds=3),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    knowledge_lines = [line for line in traces[0]["lines"] if line["kind"] == "knowledge"]
    assert len(knowledge_lines) == 1
    assert knowledge_lines[0]["id"] == f"knowledge_lookup_{query}"
    assert knowledge_lines[0]["kind"] == "knowledge"
    assert knowledge_lines[0]["text"] == ""
    assert knowledge_lines[0]["event_type"] == "knowledge_result"
    assert knowledge_lines[0]["event_code"] == "public.run.citation"
    assert knowledge_lines[0]["params"] == {}
    assert knowledge_lines[0]["event_data"]["selected_concepts"] == [{"id": "concept_1"}]
    assert knowledge_lines[0]["state"] == "completed"
    assert knowledge_lines[0]["icon"] == "advance"
    assert "detail" not in knowledge_lines[0]


def test_turn_trace_merges_created_and_relayed_reflection_decisions() -> None:
    started_at = datetime(2026, 7, 15, 14, 37, 5)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="继续处理",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "继续处理"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="reflection_decision_created",
            payload_json={"needs_retry": False, "turn_id": "msg_user"},
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="reflection_decision",
            payload_json={"needs_retry": False, "turn_id": "msg_user"},
            created_at=started_at + timedelta(seconds=2),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    reflection_lines = [line for line in traces[0]["lines"] if line["id"] == "reflection"]
    assert len(reflection_lines) == 1
    assert reflection_lines[0]["text"] == ""
    assert reflection_lines[0]["event_type"] == "reflection_decision"
    assert reflection_lines[0]["event_code"] == "run.sop.state"
    assert reflection_lines[0]["params"] == {}
    assert "detail" not in reflection_lines[0]


def test_turn_trace_ignores_noop_skill_step_change() -> None:
    started_at = datetime(2026, 7, 15, 12, 40, 14)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="user",
            content="我的工号是2472063",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "我的工号是2472063"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="skill_step_changed",
            payload_json={
                "decision": "continue_active",
                "from_skill_id": "expense_travel_reimbursement",
                "to_skill_id": "expense_travel_reimbursement",
                "from_step_id": "collect_reimbursement_info",
                "to_step_id": "collect_reimbursement_info",
                "turn_id": "msg_user",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
    ]

    traces = _build_turn_traces(
        messages,
        events,
        {"expense_travel_reimbursement": "差旅报销申请"},
    )

    assert not any(line["kind"] == "skill" for line in traces[0]["lines"])


def test_message_read_hydrates_knowledge_citation_content_from_concept() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    content = "完整 Content 正文。\n\n第二段继续保留。"
    with Session(engine) as db:
        db.add(
            KnowledgeConcept(
                tenant_id="tenant_demo",
                knowledge_base_id="kb_demo",
                knowledge_base_version_id="kbv_demo",
                document_id="kdoc_demo",
                concept_id="sources/demo/sections/sec-4",
                concept_type="Source Section",
                title="段落组 1",
                description="不完整 summary",
                content_md=f"---\ntitle: 段落组 1\n---\n{content}",
            )
        )
        db.commit()
        row = Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_test",
            role="assistant",
            content="回答 [1]",
            metadata_json={
                "knowledge_citations": [
                    {
                        "id": "kref_1",
                        "label": "[1]",
                        "kind": "concept",
                        "title": "段落组 1",
                        "concept_id": "sources/demo/sections/sec-4",
                        "summary": "不完整 summary",
                        "excerpt": "不完整 summary",
                    }
                ]
            },
        )

        read = message_read(row, db=db)

    citation = read.metadata["knowledge_citations"][0]
    assert citation["content"] == content
    assert citation["excerpt"] == content
    assert citation["summary"] == "不完整 summary"


def test_message_read_compacts_historical_knowledge_citation_labels() -> None:
    row = Message(
        id="msg_assistant_historical_citations",
        tenant_id="tenant_demo",
        session_id="session_test",
        role="assistant",
        content="先参考排查手册。[1] 区域故障则提交报修。[4]",
        metadata_json={
            "knowledge_citations": [
                {"id": "kref_1", "label": "[1]", "title": "排查手册"},
                {"id": "kref_4", "label": "[4]", "title": "网络故障"},
            ]
        },
    )

    read = message_read(row)

    assert read.content == "先参考排查手册。[1] 区域故障则提交报修。[2]"
    assert [item["label"] for item in read.metadata["knowledge_citations"]] == ["[1]", "[2]"]


def test_turn_trace_does_not_reconstruct_events_from_message_metadata() -> None:
    started_at = datetime(2026, 6, 20, 10, 0, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_citation",
            role="user",
            content="引用规则是什么？",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_citation",
            role="assistant",
            content="回答需要展示知识引用。[1]",
            metadata_json={
                "knowledge_citations": [
                    {
                        "title": "知识引用测试说明 / 引用规则",
                        "source_title": "citation-demo.md",
                    }
                ]
            },
            created_at=started_at + timedelta(seconds=1),
        ),
    ]

    traces = _build_turn_traces(messages, [], {})

    assert traces == []


def test_turn_trace_keeps_running_routing_status_for_refresh() -> None:
    started_at = datetime(2026, 7, 4, 9, 0, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_running",
            role="user",
            content="你好",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_running",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "你好"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_running",
            event_type="stream_status",
            payload_json={"turn_id": "msg_user", "user_message_id": "msg_user", "phase": "routing", "text": "正在判断用户意图"},
            created_at=started_at + timedelta(milliseconds=100),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert traces[0]["completed_at"] is None
    assert any(
        line["id"] == "decision_router"
        and line["text"] == ""
        and line["event_type"] == "stream_status"
        and line["event_code"] == "public.run.status"
        and line["params"] == {}
        and line["state"] == "running"
        and line["icon"] == "judge"
        for line in traces[0]["lines"]
    )


def test_turn_trace_marks_model_and_intermediate_errors_failed() -> None:
    """Project raw legacy failures to stable trace codes without provider prose."""
    started_at = datetime(2026, 7, 9, 12, 0, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_error",
            role="user",
            content="总结一下",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_error",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "总结一下"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_error",
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "error",
                "code": "LLM_ERROR",
                "message": "upstream timeout",
                "text": "模型调用失败",
            },
            created_at=started_at + timedelta(milliseconds=100),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_error",
            event_type="general_skill_trace",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "plan_failed",
                "message": "模型生成 runner 失败",
                "error": "invalid json",
            },
            created_at=started_at + timedelta(milliseconds=200),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_error",
            event_type="error_occurred",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "code": "LLM_ERROR",
                "message": "upstream timeout",
            },
            created_at=started_at + timedelta(milliseconds=300),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})
    lines = traces[0]["lines"]

    assert traces[0]["completed_at"] == events[-1].created_at.isoformat()
    skill_error = next(line for line in lines if line["event_type"] == "general_skill_trace")
    assert skill_error["event_code"] == "run.skill.trace"
    assert skill_error["state"] == "failed"
    assert skill_error["text"] == ""
    terminal_error = next(line for line in lines if line["event_type"] == "error_occurred")
    assert terminal_error["event_code"] == "public.run.failed"
    assert terminal_error["params"]["error_code"] == "MODEL_UPSTREAM_ERROR"
    assert terminal_error["state"] == "failed"
    assert terminal_error["text"] == ""
    assert all("detail" not in line for line in lines)
    assert "upstream timeout" not in str(lines)
    assert "invalid json" not in str(lines)


def test_failed_trace_and_tool_events_drop_nested_provider_diagnostics() -> None:
    """Keep nested failure payloads safe on the same replay and SSE projection path."""
    raw_secret = "provider secret=do-not-publish traceback=/private/runtime.sock"
    skill_event = AgentEvent(
        tenant_id="tenant_demo",
        session_id="session_error",
        event_type="general_skill_trace",
        payload_json={
            "phase": "reflection_failed",
            "message": raw_secret,
            "review": {"reason": raw_secret},
            "structured_result": {"error": raw_secret},
            "data": {"traceback": raw_secret},
        },
    )
    tool_event = AgentEvent(
        tenant_id="tenant_demo",
        session_id="session_error",
        event_type="tool_call_finished",
        payload_json={
            "success": False,
            "content": {"message": raw_secret},
            "result": {"stderr": raw_secret},
            "data": {"traceback": raw_secret},
        },
    )

    skill_name, skill_payload = _relay_event_payload(skill_event)
    tool_name, tool_payload = _relay_event_payload(tool_event)

    assert skill_name == "general_skill_trace"
    assert tool_name == "tool_call_finished"
    assert raw_secret not in str(skill_payload)
    assert raw_secret not in str(tool_payload)
    assert skill_payload["error"]["code"] == "INTERNAL_ERROR"
    assert tool_payload["error"]["code"] == "TOOL_UPSTREAM_ERROR"


def test_turn_trace_cancel_event_closes_running_status_for_refresh() -> None:
    started_at = datetime(2026, 7, 4, 9, 5, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_cancelled",
            role="user",
            content="暂停测试",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_cancelled",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "暂停测试"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_cancelled",
            event_type="stream_status",
            payload_json={"turn_id": "msg_user", "user_message_id": "msg_user", "phase": "routing", "text": "正在判断用户意图"},
            created_at=started_at + timedelta(milliseconds=100),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_cancelled",
            event_type="stream_cancelled",
            payload_json={"turn_id": "msg_user", "user_message_id": "msg_user"},
            created_at=started_at + timedelta(milliseconds=300),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert traces[0]["completed_at"] == (started_at + timedelta(milliseconds=300)).isoformat()
    assert all(line["state"] != "running" for line in traces[0]["lines"])
    assert any(
        line["id"] == "generation_stopped"
        and line["text"] == ""
        and line["event_code"] == "public.run.cancelled"
        and line["params"]["job_id"]
        and line["state"] == "completed"
        for line in traces[0]["lines"]
    )


def test_scheduled_task_draft_trace_restores_config_stages_for_refresh() -> None:
    started_at = datetime(2026, 7, 7, 16, 50, 0)
    draft = {
        "should_create": True,
        "tenant_id": "tenant_demo",
        "agent_id": "agent_demo",
        "title": "提醒我喝咖啡",
        "prompt": "提醒我喝咖啡",
        "schedule_type": "daily",
        "schedule": {"time": "16:50"},
        "timezone": "Asia/Shanghai",
        "confidence": 0.95,
        "source_session_id": "session_schedule",
    }
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_schedule",
            role="user",
            content="16:50提醒我喝咖啡",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_schedule",
            role="assistant",
            content="我已按你选择的定时项目整理成自动任务草案。",
            metadata_json={"turn_id": "msg_user", "user_message_id": "msg_user", "scheduled_task_draft": draft},
            created_at=started_at + timedelta(milliseconds=500),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_schedule",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "16:50提醒我喝咖啡"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_schedule",
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "scheduled_task_intent",
                "text": "识别定时任务需求",
            },
            created_at=started_at + timedelta(milliseconds=100),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_schedule",
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "scheduled_task_parse",
                "text": "解析执行计划",
            },
            created_at=started_at + timedelta(milliseconds=200),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_schedule",
            event_type="scheduled_task_draft_created",
            payload_json={**draft, "turn_id": "msg_user", "user_message_id": "msg_user"},
            created_at=started_at + timedelta(milliseconds=300),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_schedule",
            event_type="assistant_message_created",
            payload_json={"message_id": "msg_assistant", "turn_id": "msg_user", "user_message_id": "msg_user"},
            created_at=started_at + timedelta(milliseconds=500),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert traces[0]["completed_at"] == (started_at + timedelta(milliseconds=500)).isoformat()
    assert [line["id"] for line in traces[0]["lines"]] == [
        "scheduled_task_intent",
        "scheduled_task_parse",
        "scheduled_task_draft",
    ]
    assert all(line["state"] == "completed" for line in traces[0]["lines"])
    assert [line["event_code"] for line in traces[0]["lines"]] == [
        "chat.scheduled.intent",
        "chat.scheduled.plan",
        "chat.scheduled.draft",
    ]
    assert all(line["params"] == {} for line in traces[0]["lines"])
    assert all(line["text"] == "" and "detail" not in line for line in traces[0]["lines"])
    assert all(line["event_type"] == "stream_status" or line["event_type"] == "scheduled_task_draft_created" for line in traces[0]["lines"])
    assert traces[0]["lines"][1]["event_data"] == {
        "title": "提醒我喝咖啡",
        "schedule_type": "daily",
        "schedule": {"time": "16:50"},
    }


def test_scheduled_task_draft_reply_uses_agent_reply_locale() -> None:
    zh_context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    en_context = zh_context.model_copy(
        update={"agent_reply_locale": SupportedLocale.EN_US}
    )

    assert _scheduled_task_draft_reply(zh_context) == (
        "定时任务草案已准备好。确认下方卡片后才会创建并启用。"
    )
    assert _scheduled_task_draft_reply(en_context) == (
        "The scheduled task draft is ready. Confirm the card below to create and enable it."
    )


def test_cancel_endpoint_persists_terminal_trace_for_client_turn_id() -> None:
    db = _test_db()
    started_at = datetime(2026, 7, 4, 9, 5, 0)
    session_row = ChatSession(id="session_cancel_endpoint", tenant_id="tenant_demo", user_id="user_demo")
    db.add(session_row)
    db.add(
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id=session_row.id,
            role="user",
            content="暂停测试",
            created_at=started_at,
        )
    )
    db.add(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            event_type="user_message_received",
            payload_json={
                "message_id": "msg_user",
                "client_turn_id": "turn_local_1",
                "message": "暂停测试",
            },
            created_at=started_at,
        )
    )
    db.add(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "routing",
                "text": "正在判断用户意图",
            },
            created_at=started_at + timedelta(milliseconds=100),
        )
    )
    db.commit()

    assert _persist_chat_turn_cancelled(db, "tenant_demo", session_row, "turn_local_1", "user_demo")
    db.commit()
    assert not _persist_chat_turn_cancelled(db, "tenant_demo", session_row, "turn_local_1", "user_demo")

    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == "tenant_demo", AgentEvent.session_id == session_row.id)
        .order_by(AgentEvent.created_at)
    ).all()
    cancel_events = [event for event in events if event.event_type == "stream_cancelled"]
    assert len(cancel_events) == 1
    assert cancel_events[0].payload_json["turn_id"] == "msg_user"
    assert cancel_events[0].payload_json["user_message_id"] == "msg_user"
    assert cancel_events[0].payload_json["client_turn_id"] == "turn_local_1"

    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == "tenant_demo", Message.session_id == session_row.id)
        .order_by(Message.created_at)
    ).all()
    assistant_messages = [message for message in messages if message.role == "assistant"]
    assert len(assistant_messages) == 1
    assert assistant_messages[0].content == "已停止生成"
    assert assistant_messages[0].metadata_json["turn_id"] == "msg_user"
    assert assistant_messages[0].metadata_json["user_message_id"] == "msg_user"
    assert assistant_messages[0].metadata_json["client_turn_id"] == "turn_local_1"
    traces = _build_turn_traces(messages, events, {})
    assert traces[0]["completed_at"] == cancel_events[0].created_at.isoformat()
    assert all(line["state"] != "running" for line in traces[0]["lines"])
    assert any(
        line["id"] == "generation_stopped"
        and line["text"] == ""
        and line["event_code"] == "public.run.cancelled"
        and line["params"]["job_id"]
        and line["state"] == "completed"
        for line in traces[0]["lines"]
    )


def test_cancel_endpoint_persists_cancel_even_before_user_event_is_visible() -> None:
    db = _test_db()
    session_row = ChatSession(id="session_cancel_before_event", tenant_id="tenant_demo", user_id="user_demo")
    db.add(session_row)
    db.commit()

    assert _persist_chat_turn_cancelled(db, "tenant_demo", session_row, "turn_local_pending", "user_demo")
    db.commit()
    assert not _persist_chat_turn_cancelled(db, "tenant_demo", session_row, "turn_local_pending", "user_demo")

    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == "tenant_demo", AgentEvent.session_id == session_row.id)
        .order_by(AgentEvent.created_at)
    ).all()
    cancel_events = [event for event in events if event.event_type == "stream_cancelled"]
    assert len(cancel_events) == 1
    assert cancel_events[0].payload_json["turn_id"] == "turn_local_pending"
    assert cancel_events[0].payload_json["user_message_id"] == "turn_local_pending"
    assert cancel_events[0].payload_json["client_turn_id"] == "turn_local_pending"
    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == "tenant_demo", Message.session_id == session_row.id)
        .order_by(Message.created_at)
    ).all()
    assert [message.role for message in messages] == []
    assert is_chat_turn_cancelled(
        session_row.id,
        "turn_local_pending",
        db=db,
    )


def test_reused_message_id_does_not_cancel_a_new_client_turn() -> None:
    db = _test_db()
    session_row = ChatSession(id="session_reused_id", tenant_id="tenant_demo", user_id="user_demo")
    db.add(session_row)
    now = datetime(2026, 8, 17, 9, 0, 0)
    db.add(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            event_type="stream_cancelled",
            payload_json={
                "turn_id": "message_reused",
                "user_message_id": "message_reused",
                "client_turn_id": "old_client_turn",
            },
            created_at=now,
        )
    )
    db.add(
        HarnessTurnRecord(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            client_turn_id="message_reused",
            request_digest="sha256:new-request",
            status="started",
            lease_owner="worker-new",
            lease_expires_at=now + timedelta(minutes=5),
            user_message_id="new_user_message",
        )
    )
    db.commit()

    assert not is_chat_turn_cancelled(
        session_row.id,
        "message_reused",
        db=db,
        identity_kind="client",
    )
    assert is_chat_turn_cancelled(
        session_row.id,
        "message_reused",
        db=db,
        identity_kind="message",
    )


def test_process_local_cancel_markers_are_bounded(monkeypatch) -> None:
    monkeypatch.setattr(cancellation_module, "_MAX_CANCEL_MARKERS", 2)
    session_id = "session_marker_bound"
    try:
        cancellation_module.cancel_chat_turn(session_id, "turn_1")
        cancellation_module.cancel_chat_turn(session_id, "turn_2")
        cancellation_module.cancel_chat_turn(session_id, "turn_3")

        assert not cancellation_module.is_chat_turn_cancelled(session_id, "turn_1")
        assert cancellation_module.is_chat_turn_cancelled(session_id, "turn_2")
        assert cancellation_module.is_chat_turn_cancelled(session_id, "turn_3")
    finally:
        for turn_id in ("turn_1", "turn_2", "turn_3"):
            cancellation_module.clear_chat_turn_cancelled(session_id, turn_id)


def test_stream_interrupted_persists_terminal_trace_and_message() -> None:
    """Persist only a stable interruption code while keeping traceback details private."""
    db = _test_db()
    started_at = datetime(2026, 7, 4, 9, 7, 0)
    session_row = ChatSession(id="session_interrupted", tenant_id="tenant_demo", user_id="user_demo")
    db.add(session_row)
    db.add(
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id=session_row.id,
            role="user",
            content="你是谁",
            created_at=started_at,
        )
    )
    db.add(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            event_type="user_message_received",
            payload_json={
                "message_id": "msg_user",
                "client_turn_id": "turn_interrupted",
                "message": "你是谁",
            },
            created_at=started_at,
        )
    )
    db.add(
        AgentEvent(
            tenant_id="tenant_demo",
            session_id=session_row.id,
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "responding",
                "text": "正在生成回复",
            },
            created_at=started_at + timedelta(milliseconds=100),
        )
    )
    db.commit()

    raw_reason = "provider token=do-not-publish traceback=/private/runtime.sock"
    assert _persist_chat_turn_interrupted(
        db,
        "tenant_demo",
        session_row,
        "turn_interrupted",
        raw_reason,
        error_details={
            "error_type": "RuntimeError",
            "error_traceback": "Traceback: provider token=do-not-publish",
        },
    )
    db.commit()
    assert not _persist_chat_turn_interrupted(db, "tenant_demo", session_row, "turn_interrupted", "GeneratorExit")

    events = db.exec(
        select(AgentEvent)
        .where(AgentEvent.tenant_id == "tenant_demo", AgentEvent.session_id == session_row.id)
        .order_by(AgentEvent.created_at)
    ).all()
    interrupted_events = [event for event in events if event.event_type == "stream_interrupted"]
    assert len(interrupted_events) == 1
    assert interrupted_events[0].payload_json["turn_id"] == "msg_user"
    assert interrupted_events[0].payload_json["client_turn_id"] == "turn_interrupted"
    assert interrupted_events[0].payload_json["code"] == "INTERNAL_ERROR"
    assert interrupted_events[0].payload_json["message"] == "INTERNAL_ERROR"
    assert "reason" not in interrupted_events[0].payload_json
    assert "error_details" not in interrupted_events[0].payload_json
    assert "do-not-publish" not in str(interrupted_events[0].payload_json)

    messages = db.exec(
        select(Message)
        .where(Message.tenant_id == "tenant_demo", Message.session_id == session_row.id)
        .order_by(Message.created_at)
    ).all()
    assistant_messages = [message for message in messages if message.role == "assistant"]
    assert len(assistant_messages) == 1
    assert assistant_messages[0].metadata_json["status"] == "interrupted"
    assert assistant_messages[0].content == "本次响应中断，请重试发送。"

    traces = _build_turn_traces(messages, events, {})
    assert traces[0]["completed_at"] == interrupted_events[0].created_at.isoformat()
    assert all(line["state"] != "running" for line in traces[0]["lines"])
    assert any(
        line["id"] == "generation_interrupted"
        and line["text"] == ""
        and line["event_code"] == "public.run.failed"
        and line["params"]["error_code"] == "INTERNAL_ERROR"
        and line["state"] == "failed"
        for line in traces[0]["lines"]
    )


def test_stream_interrupted_preserves_language_context_snapshot() -> None:
    """Carry the turn locale snapshot into interruption events and fallback messages."""
    db = _test_db()
    session = ChatSession(id="session_interrupted_locale", tenant_id="tenant_demo")
    user_message = Message(
        id="msg_interrupted_locale",
        tenant_id="tenant_demo",
        session_id=session.id,
        role="user",
        content="hello",
    )
    context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
    )
    db.add(session)
    db.add(user_message)
    db.flush()

    assert _persist_chat_turn_interrupted(
        db,
        "tenant_demo",
        session,
        user_message.id,
        "worker stopped",
        language_context=context,
    )

    interrupted = db.exec(
        select(AgentEvent).where(
            AgentEvent.session_id == session.id,
            AgentEvent.event_type == "stream_interrupted",
        )
    ).one()
    assistant = db.exec(
        select(Message).where(
            Message.session_id == session.id,
            Message.role == "assistant",
        )
    ).one()
    expected = context.model_dump(mode="json")
    assert interrupted.payload_json["language_context"] == expected
    assert assistant.metadata_json["language_context"] == expected
    assert assistant.content == "本次响应中断，请重试发送。"


def test_stream_cancelled_preserves_language_context_snapshot() -> None:
    """Carry the immutable locale snapshot through cancellation fallback persistence."""
    db = _test_db()
    session = ChatSession(id="session_cancelled_locale", tenant_id="tenant_demo")
    user_message = Message(
        id="msg_cancelled_locale",
        tenant_id="tenant_demo",
        session_id=session.id,
        role="user",
        content="hello",
    )
    context = LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    db.add(session)
    db.add(user_message)
    db.flush()

    assert _persist_chat_turn_cancelled(
        db,
        "tenant_demo",
        session,
        user_message.id,
        language_context=context,
    )

    cancelled = db.exec(
        select(AgentEvent).where(
            AgentEvent.session_id == session.id,
            AgentEvent.event_type == "stream_cancelled",
        )
    ).one()
    assistant = db.exec(
        select(Message).where(
            Message.session_id == session.id,
            Message.role == "assistant",
        )
    ).one()
    expected = context.model_dump(mode="json")
    assert cancelled.payload_json["language_context"] == expected
    assert assistant.metadata_json["language_context"] == expected
    assert assistant.content == "Generation stopped."


def test_relay_event_payload_maps_persisted_router_and_status_events() -> None:
    status_event = AgentEvent(
        id="evt_status",
        tenant_id="tenant_demo",
        session_id="session_relay",
        event_type="stream_status",
        payload_json={"turn_id": "msg_user", "phase": "routing", "text": "正在判断用户意图"},
        created_at=datetime(2026, 7, 4, 9, 9, 0),
    )
    router_event = AgentEvent(
        id="evt_router",
        tenant_id="tenant_demo",
        session_id="session_relay",
        event_type="router_decision_created",
        payload_json={"turn_id": "msg_user", "decision": "answer_only"},
        created_at=datetime(2026, 7, 4, 9, 9, 1),
    )

    status_name, status_payload = _relay_event_payload(status_event)
    router_name, router_payload = _relay_event_payload(router_event)

    assert status_name == "status"
    assert status_payload["sessionId"] == "session_relay"
    assert status_payload["phase"] == "routing"
    assert router_name == "router_decision"
    assert router_payload["decision"] == "answer_only"


def test_turn_trace_without_terminal_event_stays_open_for_refresh_recovery() -> None:
    started_at = datetime(2026, 7, 4, 9, 6, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_refresh",
            role="user",
            content="你是谁",
            created_at=started_at,
        )
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_refresh",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "你是谁"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_refresh",
            event_type="stream_status",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "phase": "routing",
                "text": "正在判断用户意图",
            },
            created_at=started_at + timedelta(milliseconds=100),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert traces[0]["completed_at"] is None
    assert any(line["id"] == "decision_router" and line["state"] == "running" for line in traces[0]["lines"])
    assert all(line["id"] != "generation_stopped" for line in traces[0]["lines"])


def test_turn_trace_ignores_trace_events_without_turn_id() -> None:
    started_at = datetime(2026, 7, 4, 9, 8, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            role="user",
            content="北京今天天气如何",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            role="assistant",
            content="北京今天晴朗。",
            created_at=started_at + timedelta(seconds=50),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "北京今天天气如何"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="router_decision_created",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "decision": "answer_only",
                "user_intent": "查询天气",
                "reason": "实时信息查询",
            },
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="general_skill_selected",
            payload_json={
                "skill_slug": "maomao-weather",
                "skill_name": "weather",
                "reason": "匹配天气查询能力",
            },
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="tool_result",
            payload_json={
                "toolName": "weather",
                "rawToolName": "maomao-weather",
                "success": True,
                "content": {"tool_name": "maomao-weather", "success": True, "data": {"found": True}},
            },
            created_at=started_at + timedelta(seconds=4),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="general_skill_trace",
            payload_json={
                "skill_slug": "maomao-weather",
                "phase": "planning",
                "message": "正在根据 SKILL.md 生成 runner",
            },
            created_at=started_at + timedelta(seconds=4),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="general_skill_trace",
            payload_json={
                "skill_slug": "maomao-weather",
                "phase": "reflection_reviewed",
                "message": "已完成运行结果校验",
                "review": {"reason": "结果可用"},
            },
            created_at=started_at + timedelta(seconds=5),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="general_skill_run_finished",
            payload_json={"skill_slug": "maomao-weather", "success": True},
            created_at=started_at + timedelta(seconds=6),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_general_skill",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant",
                "user_message_id": "msg_user",
                "reply": "北京今天晴朗。",
            },
            created_at=started_at + timedelta(seconds=50),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    texts = [line["text"] for line in traces[0]["lines"]]
    assert traces[0]["turn_id"] == "msg_user"
    assert "选择通用技能 weather" not in texts
    assert "调用工具 weather" not in texts
    assert "正在根据 SKILL.md 生成 runner" not in texts
    assert "已完成运行结果校验" not in texts
    assert "通用技能运行完成" not in texts


def test_turn_trace_restores_stream_tool_and_skill_events_with_turn_id() -> None:
    started_at = datetime(2026, 7, 4, 9, 9, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            role="user",
            content="北京今天天气如何",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            role="assistant",
            content="北京今天晴朗。",
            metadata_json={"turn_id": "msg_user", "user_message_id": "msg_user"},
            created_at=started_at + timedelta(seconds=50),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "北京今天天气如何"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            event_type="general_skill_trace",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "skill_slug": "maomao-weather",
                "phase": "planning",
                "message": "正在根据 SKILL.md 生成 runner",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            event_type="tool_result",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "toolName": "weather",
                "rawToolName": "maomao-weather",
                "success": True,
                "content": {"tool_name": "maomao-weather", "success": True, "data": {"found": True}},
            },
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            event_type="agent_loop_completed",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "iteration": 1,
            },
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_stream_trace",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant",
                "user_message_id": "msg_user",
                "reply": "北京今天晴朗。",
            },
            created_at=started_at + timedelta(seconds=50),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert all(line["text"] == "" for line in traces[0]["lines"])
    skill_line = next(line for line in traces[0]["lines"] if line["event_type"] == "general_skill_trace")
    assert skill_line["event_code"] == "run.skill.trace"
    assert skill_line["event_data"]["message"] == "正在根据 SKILL.md 生成 runner"
    tool_line = next(line for line in traces[0]["lines"] if line["event_type"] == "tool_result")
    assert tool_line["event_code"] == "run.tool.completed"
    assert "maomao-weather" in tool_line["output"]
    loop_line = next(line for line in traces[0]["lines"] if line["event_type"] == "agent_loop_completed")
    assert loop_line["event_code"] == "run.loop.completed"


def test_turn_trace_uses_message_id_for_repeated_user_text() -> None:
    started_at = datetime(2026, 7, 3, 10, 0, 0)
    messages = [
        Message(
            id="msg_user_first",
            tenant_id="tenant_demo",
            session_id="session_repeat",
            role="user",
            content="你好",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant_first",
            tenant_id="tenant_demo",
            session_id="session_repeat",
            role="assistant",
            content="你好！",
            created_at=started_at + timedelta(seconds=2),
        ),
        Message(
            id="msg_user_second",
            tenant_id="tenant_demo",
            session_id="session_repeat",
            role="user",
            content="你好",
            created_at=started_at + timedelta(seconds=10),
        ),
        Message(
            id="msg_assistant_second",
            tenant_id="tenant_demo",
            session_id="session_repeat",
            role="assistant",
            content="请问有什么可以帮您？",
            created_at=started_at + timedelta(seconds=12),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_first", "message": "你好"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="assistant_message_created",
            payload_json={"user_message_id": "msg_user_first", "reply": "你好！"},
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_second", "message": "你好"},
            created_at=started_at + timedelta(seconds=10),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="router_decision_created",
            payload_json={
                "user_message_id": "msg_user_second",
                "decision": "answer_only",
                "user_intent": "问候",
                "reason": "第二轮问候",
            },
            created_at=started_at + timedelta(seconds=11),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="assistant_message_created",
            payload_json={"user_message_id": "msg_user_second", "reply": "请问有什么可以帮您？"},
            created_at=started_at + timedelta(seconds=12),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert [trace["turn_id"] for trace in traces] == ["msg_user_first", "msg_user_second"]
    assert traces[1]["user_message_id"] == "msg_user_second"
    router_line = next(line for line in traces[1]["lines"] if line["id"] == "decision_router")
    assert router_line["text"] == ""
    assert router_line["event_type"] == "router_decision_created"
    assert router_line["event_code"] == "public.run.intent"
    assert router_line["params"] == {"decision": "answer_only"}
    assert router_line["event_data"]["reason"] == "第二轮问候"


def test_turn_trace_keeps_late_trace_events_after_assistant_event() -> None:
    started_at = datetime(2026, 7, 6, 10, 0, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            role="user",
            content="你好",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            role="assistant",
            content="你好！",
            metadata_json={"turn_id": "msg_user", "user_message_id": "msg_user"},
            created_at=started_at + timedelta(seconds=2),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "你好"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            event_type="stream_status",
            payload_json={"user_message_id": "msg_user", "turn_id": "msg_user", "phase": "routing", "text": "正在判断用户意图"},
            created_at=started_at + timedelta(milliseconds=200),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            event_type="assistant_message_created",
            payload_json={"message_id": "msg_assistant", "user_message_id": "msg_user", "reply": "你好！"},
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            event_type="router_decision_created",
            payload_json={
                "user_message_id": "msg_user",
                "turn_id": "msg_user",
                "decision": "answer_only",
                "user_intent": "问候",
                "reason": "晚到的意图明细也要保留",
            },
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_late_trace",
            event_type="step_result",
            payload_json={
                "user_message_id": "msg_user",
                "turn_id": "msg_user",
                "reply": "直接回复问候",
            },
            created_at=started_at + timedelta(seconds=4),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert len(traces) == 1
    assert traces[0]["completed_at"] == (started_at + timedelta(seconds=2)).isoformat()
    router_line = next(line for line in traces[0]["lines"] if line["id"] == "decision_router")
    assert router_line["text"] == ""
    assert router_line["event_code"] == "public.run.intent"
    assert router_line["event_data"]["reason"] == "晚到的意图明细也要保留"
    step_line = next(line for line in traces[0]["lines"] if line["id"] == "decision_step_result")
    assert step_line["text"] == ""
    assert step_line["event_code"] == "run.sop.step"
    assert step_line["event_data"]["reply"] == "直接回复问候"
    assert all(line["state"] != "running" for line in traces[0]["lines"])


def test_turn_trace_does_not_merge_interleaved_repeated_turns() -> None:
    started_at = datetime(2026, 7, 3, 10, 30, 0)
    messages = [
        Message(
            id="msg_user_first",
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            role="user",
            content="你好",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant_first",
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            role="assistant",
            content="我是第一个回答。",
            created_at=started_at + timedelta(seconds=12),
        ),
        Message(
            id="msg_user_second",
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            role="user",
            content="你好",
            created_at=started_at + timedelta(seconds=2),
        ),
        Message(
            id="msg_assistant_second",
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            role="assistant",
            content="我是第二个回答。",
            created_at=started_at + timedelta(seconds=14),
        ),
    ]
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_first", "message": "你好"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="router_decision_created",
            payload_json={
                "user_message_id": "msg_user_first",
                "decision": "answer_only",
                "user_intent": "问候",
                "reason": "第一轮问候",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_second", "message": "你好"},
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="router_decision_created",
            payload_json={
                "user_message_id": "msg_user_second",
                "decision": "answer_only",
                "user_intent": "问候",
                "reason": "第二轮问候",
            },
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant_first",
                "user_message_id": "msg_user_first",
                "reply": "我是第一个回答。",
            },
            created_at=started_at + timedelta(seconds=12),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_interleaved",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant_second",
                "user_message_id": "msg_user_second",
                "reply": "我是第二个回答。",
            },
            created_at=started_at + timedelta(seconds=14),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert [trace["turn_id"] for trace in traces] == ["msg_user_first", "msg_user_second"]
    assert traces[0]["completed_at"] == (started_at + timedelta(seconds=12)).isoformat()
    assert traces[1]["completed_at"] == (started_at + timedelta(seconds=14)).isoformat()
    first_router = next(line for line in traces[0]["lines"] if line["id"] == "decision_router")
    second_router = next(line for line in traces[1]["lines"] if line["id"] == "decision_router")
    assert first_router["event_data"]["reason"] == "第一轮问候"
    assert second_router["event_data"]["reason"] == "第二轮问候"
    assert first_router["text"] == second_router["text"] == ""


def test_turn_trace_without_message_id_does_not_bind_user_messages() -> None:
    started_at = datetime(2026, 7, 3, 11, 0, 0)
    messages = [
        Message(
            id="msg_user_first",
            tenant_id="tenant_demo",
            session_id="session_sequence",
            role="user",
            content="第一句",
            created_at=started_at,
        ),
        Message(
            id="msg_user_second",
            tenant_id="tenant_demo",
            session_id="session_sequence",
            role="user",
            content="第二句",
            created_at=started_at + timedelta(seconds=10),
        ),
    ]
    events = [
        AgentEvent(
            id="evt_user_first",
            tenant_id="tenant_demo",
            session_id="session_sequence",
            event_type="user_message_received",
            payload_json={"message": "第二句"},
            created_at=started_at,
        ),
        AgentEvent(
            id="evt_assistant_first",
            tenant_id="tenant_demo",
            session_id="session_sequence",
            event_type="assistant_message_created",
            payload_json={"reply": "收到"},
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            id="evt_user_second",
            tenant_id="tenant_demo",
            session_id="session_sequence",
            event_type="user_message_received",
            payload_json={"message": "第二句"},
            created_at=started_at + timedelta(seconds=10),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert [trace["turn_id"] for trace in traces] == ["evt_user_first", "evt_user_second"]
    assert [trace["user_message_id"] for trace in traces] == [None, None]


def test_message_turn_ids_from_events_use_ids_not_message_text() -> None:
    started_at = datetime(2026, 7, 3, 12, 0, 0)
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_first", "message": "你好"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant_first",
                "user_message_id": "msg_user_first",
                "reply": "你好！",
            },
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user_second", "message": "你好"},
            created_at=started_at + timedelta(seconds=10),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="assistant_message_created",
            payload_json={
                "message_id": "msg_assistant_second",
                "turn_id": "msg_user_second",
                "reply": "请问有什么可以帮您？",
            },
            created_at=started_at + timedelta(seconds=11),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="user_message_received",
            payload_json={"message": "你好"},
            created_at=started_at + timedelta(seconds=20),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_repeat",
            event_type="assistant_message_created",
            payload_json={"message_id": "msg_assistant_without_user_id", "reply": "旧事件不应猜测归属"},
            created_at=started_at + timedelta(seconds=21),
        ),
    ]

    assert _message_turn_ids_from_events(events) == {
        "msg_user_first": "msg_user_first",
        "msg_assistant_first": "msg_user_first",
        "msg_user_second": "msg_user_second",
        "msg_assistant_second": "msg_user_second",
    }


def test_message_read_uses_metadata_turn_id_when_event_mapping_is_missing() -> None:
    row = Message(
        id="msg_assistant",
        tenant_id="tenant_demo",
        session_id="session_repeat",
        role="assistant",
        content="你好",
        metadata_json={"turn_id": "msg_user"},
        created_at=datetime(2026, 7, 4, 12, 0, 0),
    )

    assert message_read(row).turn_id == "msg_user"


def test_turn_trace_restores_harness_task_and_general_skill_execution() -> None:
    started_at = datetime(2026, 8, 1, 9, 0, 0)
    messages = [
        Message(
            id="msg_user",
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            role="user",
            content="北京天气如何",
            created_at=started_at,
        ),
        Message(
            id="msg_assistant",
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            role="assistant",
            content="北京多云，29 度。",
            created_at=started_at + timedelta(seconds=9),
        ),
    ]
    base_payload = {
        "turn_id": "msg_user",
        "user_message_id": "msg_user",
        "task_frame_id": "task-weather",
        "harness_run_id": "run-weather",
        "execution_engine": "harness_v2",
    }
    events = [
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="user_message_received",
            payload_json={"message_id": "msg_user", "message": "北京天气如何"},
            created_at=started_at,
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="task_frame_started",
            payload_json={**base_payload, "kind": "conversation"},
            created_at=started_at + timedelta(seconds=1),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="harness_action_created",
            payload_json={
                **base_payload,
                "iteration": 1,
                "action": "tool",
                "tool_name": "general_skill.weather",
            },
            created_at=started_at + timedelta(seconds=2),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="general_skill_trace",
            payload_json={
                **base_payload,
                "phase": "plan_created",
                "message": "已生成 Bash runner",
                "runtime": "bash",
                "code": "python3 scripts/weather.py",
            },
            created_at=started_at + timedelta(seconds=3),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="general_skill_trace",
            payload_json={
                **base_payload,
                "phase": "code_finished",
                "message": "Bash runner 执行完成",
                "runtime": "bash",
                "return_code": 0,
                "structured_result": {"temperature": 29},
            },
            created_at=started_at + timedelta(seconds=4),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="general_skill_run_finished",
            payload_json={
                **base_payload,
                "skill_slug": "weather",
                "operation": "execute",
                "success": True,
            },
            created_at=started_at + timedelta(seconds=5),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="harness_tool_completed",
            payload_json={
                **base_payload,
                "iteration": 1,
                "tool_name": "general_skill.weather",
                "success": True,
                "error": None,
                "result": {
                    "tool_name": "general_skill.weather",
                    "success": True,
                    "data": {"structured_result": {"temperature": 29}},
                },
            },
            created_at=started_at + timedelta(seconds=6),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="harness_action_created",
            payload_json={
                **base_payload,
                "iteration": 2,
                "action": "finish",
            },
            created_at=started_at + timedelta(seconds=7),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="task_frame_finished",
            payload_json={
                **base_payload,
                "status": "completed",
                "action_count": 2,
            },
            created_at=started_at + timedelta(seconds=8),
        ),
        AgentEvent(
            tenant_id="tenant_demo",
            session_id="session_harness_trace",
            event_type="assistant_message_created",
            payload_json={
                "turn_id": "msg_user",
                "user_message_id": "msg_user",
                "message_id": "msg_assistant",
                "reply": "北京多云，29 度。",
            },
            created_at=started_at + timedelta(seconds=9),
        ),
    ]

    traces = _build_turn_traces(messages, events, {})

    assert len(traces) == 1
    lines = traces[0]["lines"]
    assert any(
        line["id"] == "harness_frame_task-weather"
        and line["text"] == ""
        and line["event_type"] == "task_frame_finished"
        and line["event_code"] == "run.task.frame.finished"
        and line["state"] == "completed"
        for line in lines
    )
    tool_line = next(
        line
        for line in lines
        if line["id"] == "harness_action_task-weather_1"
    )
    assert tool_line["text"] == ""
    assert tool_line["event_type"] == "harness_tool_completed"
    assert tool_line["event_code"] == "run.capability.completed"
    assert tool_line["params"] == {}
    assert '"temperature": 29' in tool_line["output"]
    plan_line = next(line for line in lines if line.get("code"))
    assert plan_line["language"] == "bash"
    assert plan_line["code"] == "python3 scripts/weather.py"
    assert any(
        line["event_type"] == "general_skill_trace"
        and line["text"] == ""
        and line["code"] == "python3 scripts/weather.py"
        for line in lines
    )
    assert any(
        line["event_type"] == "general_skill_run_finished"
        and line["text"] == ""
        for line in lines
    )
    assert any(
        line["event_type"] == "harness_action_created"
        and line["text"] == ""
        for line in lines
    )


def test_event_trace_lines_exposes_structured_fields_for_channel_card() -> None:
    step_names = {
        "skill_refund": {
            "collect_order_info": "收集订单信息",
            "reply_final_result": "反馈最终结果",
        }
    }
    skill_names = {
        "skill_refund": "售后退款流程",
        "skill_exchange": "售后换货流程",
    }

    started = _event_trace_lines(
        _SinkEvent(
            "task_frame_started",
            {"task_frame_id": "f1", "kind": "sop", "step_id": "reply_final_result"},
        ),
        skill_names,
        "skill_refund",
        step_names,
    )
    assert started[0]["text"] == ""
    assert started[0]["event_type"] == "task_frame_started"
    assert started[0]["event_code"] == "run.task.frame.started"
    assert started[0]["params"] == {}
    assert started[0]["event_data"]["step_id"] == "reply_final_result"
    assert "detail" not in started[0]

    finished = _event_trace_lines(
        _SinkEvent(
            "task_frame_finished",
            {"task_frame_id": "f1", "status": "handoff", "action_count": 3},
        ),
        skill_names,
        "skill_refund",
        step_names,
    )
    assert finished[0]["text"] == ""
    assert finished[0]["event_type"] == "task_frame_finished"
    assert finished[0]["event_code"] == "run.task.frame.finished"
    assert finished[0]["params"] == {}
    assert finished[0]["event_data"]["status"] == "handoff"
    assert finished[0]["event_data"]["action_count"] == 3
    assert "detail" not in finished[0]
    assert finished[0]["state"] == "completed"

    state = _event_trace_lines(
        _SinkEvent(
            "skill_state",
            {
                "runtimeDecision": "continue_active",
                "currentSkills": [
                    {
                        "skillId": "skill_refund",
                        "name": "售后退款流程",
                        "stepId": "collect_order_info",
                        "state": "active",
                    }
                ],
            },
        ),
        skill_names,
        "skill_refund",
        step_names,
    )
    assert state[0]["text"] == ""
    assert state[0]["event_type"] == "skill_state"
    assert state[0]["event_code"] == "run.sop.state"
    assert state[0]["event_data"]["current_skill"]["name"] == "售后退款流程"
    assert "detail" not in state[0]

    result = _event_trace_lines(
        _SinkEvent("step_result", {"next_step_id": "reply_final_result"}),
        skill_names,
        "skill_refund",
        step_names,
    )
    assert result[0]["text"] == ""
    assert result[0]["event_code"] == "run.sop.step"
    assert result[0]["event_data"]["next_step_id"] == "reply_final_result"
    assert "detail" not in result[0]

    skill_started = _event_trace_lines(
        _SinkEvent(
            "skill_started",
            {
                "from_skill_id": "skill_exchange",
                "to_skill_id": "skill_refund",
                "to_step_id": "collect_order_info",
            },
        ),
        skill_names,
        None,
        step_names,
    )
    assert skill_started[0]["text"] == ""
    assert skill_started[0]["event_type"] == "skill_started"
    assert skill_started[0]["event_code"] == "run.sop.state"
    assert skill_started[0]["event_data"]["to_skill_id"] == "skill_refund"
    assert "detail" not in skill_started[0]

    reflection = _event_trace_lines(
        _SinkEvent(
            "reflection_decision",
            {"needs_retry": False, "target_step_id": "reply_final_result"},
        ),
        skill_names,
        "skill_refund",
        step_names,
    )
    assert reflection[0]["text"] == ""
    assert reflection[0]["event_code"] == "run.sop.state"
    assert reflection[0]["event_data"]["target_step_id"] == "reply_final_result"
    assert "detail" not in reflection[0]

    tool_action = _event_trace_lines(
        _SinkEvent(
            "harness_action_created",
            {"task_frame_id": "f1", "iteration": 1, "action": "tool", "tool_name": "hr.balance_query"},
        ),
        skill_names,
        "skill_refund",
        step_names,
        {"hr.balance_query": "假期考勤查询"},
    )
    assert tool_action[0]["text"] == ""
    assert tool_action[0]["event_code"] == "run.action.started"
    assert tool_action[0]["params"] == {"job_id": "f1"}
    assert tool_action[0]["event_data"]["tool_name"] == "hr.balance_query"

    tool_completed = _event_trace_lines(
        _SinkEvent(
            "harness_tool_completed",
            {"task_frame_id": "f1", "iteration": 1, "tool_name": "hr.balance_query", "success": True},
        ),
        skill_names,
        "skill_refund",
        step_names,
        {"hr.balance_query": "假期考勤查询"},
    )
    assert tool_completed[0]["text"] == ""
    assert tool_completed[0]["event_code"] == "run.capability.completed"
    assert tool_completed[0]["event_data"]["tool_name"] == "hr.balance_query"

    reserved_tool = _event_trace_lines(
        _SinkEvent(
            "harness_tool_completed",
            {"task_frame_id": "f1", "iteration": 2, "tool_name": "capability_describe", "success": True},
        ),
        skill_names,
        "skill_refund",
        step_names,
        {"hr.balance_query": "假期考勤查询"},
    )
    assert reserved_tool[0]["text"] == ""
    assert reserved_tool[0]["event_code"] == "run.capability.completed"
    assert reserved_tool[0]["event_data"]["tool_name"] == "capability_describe"

    skill_completed = _event_trace_lines(
        _SinkEvent(
            "skill_completed",
            {"skill_id": "skill_refund", "reason": "step_completed"},
        ),
        skill_names,
        "skill_refund",
        step_names,
        {"hr.balance_query": "假期考勤查询"},
    )
    assert skill_completed[0]["text"] == ""
    assert skill_completed[0]["event_code"] == "run.skill.completed"
    assert skill_completed[0]["event_data"]["reason"] == "step_completed"
    assert "detail" not in skill_completed[0]


def test_event_trace_lines_keeps_raw_tool_names_without_tool_names() -> None:
    tool_completed = _event_trace_lines(
        _SinkEvent(
            "harness_tool_completed",
            {"task_frame_id": "f1", "iteration": 1, "tool_name": "hr.balance_query", "success": True},
        ),
        {},
    )
    assert tool_completed[0]["text"] == ""
    assert tool_completed[0]["event_code"] == "run.capability.completed"
    assert tool_completed[0]["event_data"]["tool_name"] == "hr.balance_query"

    skill_completed = _event_trace_lines(
        _SinkEvent(
            "skill_completed",
            {"skill_id": "skill_refund", "reason": "step_completed"},
        ),
        {},
    )
    assert skill_completed[0]["text"] == ""
    assert skill_completed[0]["event_code"] == "run.skill.completed"
    assert skill_completed[0]["event_data"]["reason"] == "step_completed"
    assert "detail" not in skill_completed[0]


def test_event_trace_lines_keeps_technical_detail_without_step_names() -> None:
    started = _event_trace_lines(
        _SinkEvent(
            "task_frame_started",
            {"task_frame_id": "f1", "kind": "sop", "step_id": "collect_order_info"},
        ),
        {},
    )
    assert started[0]["text"] == ""
    assert started[0]["event_code"] == "run.task.frame.started"
    assert started[0]["event_data"]["step_id"] == "collect_order_info"
    assert "detail" not in started[0]

    finished = _event_trace_lines(
        _SinkEvent("task_frame_finished", {"task_frame_id": "f1", "status": "handoff"}),
        {},
    )
    assert finished[0]["text"] == ""
    assert finished[0]["event_code"] == "run.task.frame.finished"
    assert finished[0]["event_data"]["status"] == "handoff"
    assert "detail" not in finished[0]


def test_resolve_step_label_uses_names_then_fallbacks() -> None:
    step_names = {
        "skill_refund": {"collect_order_info": "收集订单信息"},
        "skill_exchange": {"collect_order_info": "收集换货订单信息"},
    }
    assert _resolve_step_label("collect_order_info", step_names, "skill_refund") == "收集订单信息"
    assert _resolve_step_label("collect_order_info", step_names, "skill_exchange") == "收集换货订单信息"
    assert _resolve_step_label("collect_order_info", step_names) == "收集订单信息"
    assert _resolve_step_label("collect_order_info", {}) == "collect_order_info"
    assert _resolve_step_label("handoff_to_repair_specialist", {}) == "handoff_to_repair_specialist"
    assert _resolve_step_label("reply_final_result", {}) == "reply_final_result"
    assert _resolve_step_label("end", {}) == "end"
    assert _resolve_step_label("some_random_id", {}) == "some_random_id"
    assert _resolve_step_label("collect_order_info", None) == "collect_order_info"


def test_harness_trace_line_uses_canonical_descriptor_and_raw_event_data() -> None:
    """Persist only canonical headline metadata while retaining raw task-frame values."""
    line = _harness_event_trace_line(
        AgentEvent(
            id="event-frame-started",
            tenant_id="tenant_demo",
            session_id="session_test",
            event_type="task_frame_started",
            payload_json={
                "task_frame_id": "frame-1",
                "kind": "sop",
                "skill_name": "流程原名",
                "step_id": "collect_order_info",
            },
        )
    )

    assert line is not None
    assert line["event_code"] == "run.task.frame.started"
    assert line["params"] == {}
    assert line["event_type"] == "task_frame_started"
    assert line["event_data"]["skill_name"] == "流程原名"
    assert line["text"] == ""
    assert "detail" not in line
    assert "outputTitle" not in line


def test_trace_event_code_map_matches_registry_and_exact_params() -> None:
    """Ensure every chat trace descriptor is present in the generated event contract shape."""
    language_context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    payload = {
        "phase": "routing",
        "job_id": "job-1",
        "task_frame_id": "frame-1",
        "decision": "answer_only",
        "code": "LLM_ERROR",
        "success": True,
    }

    for event_type, expected_code in _TRACE_EVENT_CODES.items():
        event_code, params = _trace_event_descriptor(event_type, payload, "event-1")
        assert event_code == expected_code
        entry = EVENT_REGISTRY.require(expected_code)
        assert set(params) == set(entry.params_schema)
        EVENT_REGISTRY.validate(
            SystemEvent(
                event_code=event_code,
                params=params,
                tenant_id="tenant-demo",
                aggregate_type="chat_turn",
                aggregate_id="turn-1",
                visibility=EventVisibility.PUBLIC,
                language_context=language_context,
            )
        )

    failed_code, failed_params = _trace_event_descriptor(
        "stream_status",
        {**payload, "phase": "error"},
        "event-1",
    )
    assert failed_code == "public.run.failed"
    assert failed_params == {
        "job_id": "job-1",
        "error_code": "MODEL_UPSTREAM_ERROR",
        "retryable": False,
    }


def test_tool_trace_line_keeps_success_raw_output_without_backend_labels() -> None:
    """Keep provider/tool success content available in raw fields without rendering product prose."""
    line = _event_trace_lines(
        _SinkEvent(
            "harness_tool_completed",
            {
                "task_frame_id": "frame-1",
                "iteration": 1,
                "tool_name": "vendor.lookup",
                "success": True,
                "result": {"provider_message": "原始供应商回文"},
            },
        ),
        {},
    )[0]

    assert line["event_code"] == "run.capability.completed"
    assert line["params"] == {}
    assert line["event_data"]["result"]["provider_message"] == "原始供应商回文"
    assert "原始供应商回文" in line["output"]
    assert line["text"] == ""
    assert "detail" not in line
    assert "outputTitle" not in line


def test_scheduled_trace_line_exposes_event_type_with_canonical_fields() -> None:
    """Make scheduled replay lines consistent with structured trace consumers."""
    lines = _event_trace_lines(
        _SinkEvent(
            "stream_status",
            {
                "phase": "scheduled_task_intent",
                "code": "chat.scheduled.intent",
                "params": {},
                "title": "原始任务标题",
                "schedule_type": "daily",
                "schedule": {"time": "16:50"},
            },
        ),
        {},
    )

    assert lines[0]["event_type"] == "stream_status"
    assert lines[0]["event_code"] == "chat.scheduled.intent"
    assert lines[0]["params"] == {}
    assert lines[0]["event_data"]["title"] == "原始任务标题"
    assert lines[0]["text"] == ""
    assert "detail" not in lines[0]


def _test_db() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)

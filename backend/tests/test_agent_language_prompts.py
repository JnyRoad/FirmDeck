from __future__ import annotations

import pytest

from app.core import agent_loop as agent_loop_module
from app.core import reflection_agent as reflection_agent_module
from app.core import response_generator as response_generator_module
from app.core import step_agent as step_agent_module
from app.core import turn_planner as turn_planner_module
from app.core.agent_loop import AgentLoop
from app.core.conversation_context import ConversationContextSettings
from app.core.reflection_agent import ReflectionAgent
from app.core.response_generator import ResponseGenerator
from app.core.step_agent import StepAgent
from app.core.turn_planner import TurnPlanner
from app.db.models import ChatSession, Message
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.i18n.raw_source import RawSourceKind, RawSourceMarker
from app.llm.prompts.language import (
    language_prompt_contract,
    resolve_prompt_language_context,
)
from app.session.session_schema import RouterDecision, StepAgentResult
from app.tools.tool_schema import ToolResult


def _english_reply_context() -> LanguageContext:
    """Create one mixed UI/reply snapshot used to detect accidental UI-locale coupling."""
    return LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.USER_PREFERENCE,
    )


@pytest.mark.parametrize(
    ("ui_locale", "reply_locale"),
    [
        (SupportedLocale.ZH_CN, SupportedLocale.ZH_CN),
        (SupportedLocale.ZH_CN, SupportedLocale.EN_US),
        (SupportedLocale.EN_US, SupportedLocale.ZH_CN),
        (SupportedLocale.EN_US, SupportedLocale.EN_US),
    ],
)
def test_language_prompt_contract_uses_reply_locale_independently(
    ui_locale: SupportedLocale,
    reply_locale: SupportedLocale,
) -> None:
    """Bind generated prose to reply locale without deriving it from the UI locale."""
    context = LanguageContext(
        ui_locale=ui_locale,
        agent_reply_locale=reply_locale,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )

    contract = language_prompt_contract(context, [])

    assert contract["language_context"] == context.model_dump(mode="json")
    assert contract["language_directive"]["new_prose_locale"] == reply_locale.value
    assert contract["language_directive"]["source_content_policy"] == "preserve_verbatim"
    directive = contract["language_directive"]["instruction"].lower()
    assert "translate all" not in directive
    assert "翻译全部" not in directive


def test_language_prompt_contract_serializes_exact_raw_source_markers() -> None:
    """Preserve exact raw JSON pointers without widening them to parent payloads."""
    context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.USER_PREFERENCE,
    )
    markers = [
        RawSourceMarker(json_pointer="/user_message", kind=RawSourceKind.USER_INPUT),
        RawSourceMarker(
            json_pointer="/tool_result/data/provider_body",
            kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
        ),
        RawSourceMarker(json_pointer="/artifacts/0/path", kind=RawSourceKind.PATH),
    ]

    contract = language_prompt_contract(context, markers)

    assert contract["raw_source_markers"] == [
        {
            "json_pointer": "/user_message",
            "kind": "user_input",
            "policy": "preserve_verbatim",
        },
        {
            "json_pointer": "/tool_result/data/provider_body",
            "kind": "tool_provider_output",
            "policy": "preserve_verbatim",
        },
        {
            "json_pointer": "/artifacts/0/path",
            "kind": "path",
            "policy": "preserve_verbatim",
        },
    ]


def test_missing_prompt_context_uses_explicit_legacy_zh_cn_snapshot() -> None:
    """Keep compatibility deterministic by resolving missing context to audited zh-CN."""
    context = resolve_prompt_language_context(None)

    assert context.ui_locale is SupportedLocale.ZH_CN
    assert context.agent_reply_locale is SupportedLocale.ZH_CN
    assert context.ui_locale_source is LocaleResolutionSource.LEGACY_DEFAULT
    assert context.agent_reply_locale_source is LocaleResolutionSource.LEGACY_DEFAULT


def test_turn_planner_marks_user_history_and_uses_reply_locale(monkeypatch) -> None:
    """Keep Planner-generated task prose locale-bound while preserving user and history input."""
    captured: dict[str, object] = {}

    class FakeLLMClient:
        """Capture one Planner payload and return a valid conversation plan."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model initialization for the Planner contract test."""

        def generate_json(
            self,
            _system_prompt: str,
            payload: dict[str, object],
        ) -> dict[str, object]:
            """Record the model boundary and return one English task frame."""
            captured.update(payload)
            return {
                "decision": "answer_only",
                "user_intent": "Keep RAW-用户 unchanged",
                "task_frames": [
                    {
                        "kind": "conversation",
                        "decision": "answer_only",
                        "user_intent": "Keep RAW-用户 unchanged",
                        "requirements": ["Answer the request"],
                    }
                ],
            }

    monkeypatch.setattr(turn_planner_module, "LLMClient", FakeLLMClient)

    TurnPlanner().plan(
        "RAW-用户",
        ChatSession(id="session-language", tenant_id="tenant-language"),
        [],
        None,  # type: ignore[arg-type]
        conversation_context={"messages": [{"content": "HISTORY-原文"}]},
        language_context=_english_reply_context(),
    )

    assert captured["language_directive"]["new_prose_locale"] == "en-US"
    markers = captured["raw_source_markers"]
    assert {item["json_pointer"] for item in markers} >= {
        "/user_message",
        "/conversation_context",
        "/_agent_stage/memory",
    }
    assert captured["user_message"] == "RAW-用户"


def test_step_reflection_and_response_stages_share_language_snapshot(monkeypatch) -> None:
    """Carry one immutable snapshot through legacy Step, Reflection, and Response model stages."""
    captured: dict[str, dict[str, object]] = {}

    class FakeJsonClient:
        """Capture JSON stages and return the smallest valid result for each phase."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model initialization while retaining stage behavior."""

        def generate_json(
            self,
            _system_prompt: str,
            payload: dict[str, object],
        ) -> dict[str, object]:
            """Dispatch a valid response by the real stage phase."""
            phase = payload["_agent_stage"]["phase"]
            captured[str(phase)] = payload
            if phase == "Reflection":
                return {"action": "pass", "needs_retry": False}
            return {"action": "reply", "reply": "New English prose"}

    class FakeTextClient:
        """Capture the final text stage and return newly generated English prose."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model initialization for response synthesis."""

        def generate_text(
            self,
            _system_prompt: str,
            payload: dict[str, object],
        ) -> str:
            """Record the response payload and return a valid final reply."""
            captured["Response Generator"] = payload
            return "New English prose preserving RAW-知识"

    context = _english_reply_context()
    session = ChatSession(id="session-language", tenant_id="tenant-language")
    decision = RouterDecision(decision="continue_active")
    monkeypatch.setattr(step_agent_module, "LLMClient", FakeJsonClient)
    step_result = StepAgent().run(
        "RAW-用户",
        session,
        None,
        [],
        None,  # type: ignore[arg-type]
        router_decision=decision,
        conversation_context={"messages": [{"content": "HISTORY-原文"}]},
        current_knowledge=[{"content": "RAW-知识"}],
        language_context=context,
    )

    monkeypatch.setattr(reflection_agent_module, "LLMClient", FakeJsonClient)
    ReflectionAgent().review(
        "RAW-用户",
        session,
        None,
        decision,
        StepAgentResult(action="reply", reply="New English prose", is_step_completed=True),
        ToolResult(tool_name="provider.raw", success=True, data={"body": "RAW-供应商"}),
        [],
        [],
        None,  # type: ignore[arg-type]
        conversation_context={"messages": [{"content": "HISTORY-原文"}]},
        language_context=context,
    )

    monkeypatch.setattr(response_generator_module, "LLMClient", FakeTextClient)
    reply = ResponseGenerator().generate(
        "RAW-用户",
        session,
        None,
        decision,
        step_result,
        ToolResult(tool_name="provider.raw", success=True, data={"body": "RAW-供应商"}),
        None,  # type: ignore[arg-type]
        conversation_context={"messages": [{"content": "HISTORY-原文"}]},
        language_context=context,
    )

    assert reply == "New English prose preserving RAW-知识"
    for phase in ("Step Agent", "Reflection", "Response Generator"):
        payload = captured[phase]
        assert payload["language_context"] == context.model_dump(mode="json")
        assert payload["language_directive"]["new_prose_locale"] == "en-US"
        assert payload["user_message"] == "RAW-用户"


@pytest.mark.parametrize("reply_locale", [SupportedLocale.EN_US, SupportedLocale.ZH_CN])
def test_agent_loop_context_summary_uses_reply_locale_and_preserves_raw_history(
    monkeypatch,
    reply_locale: SupportedLocale,
) -> None:
    """长会话摘要遵循 reply locale，并把历史内容作为精确 raw source 传递。"""
    captured: dict[str, object] = {}

    class FakeLLMClient:
        """Capture context-compression payloads without contacting a model provider."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model setup while retaining the summary call boundary."""

        def generate_text(self, _system_prompt: str, payload: dict[str, object]) -> str:
            """Record the structured compression request and return generated English prose."""
            captured.update(payload)
            return "English history summary"

    monkeypatch.setattr(agent_loop_module, "LLMClient", FakeLLMClient)
    context = LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=reply_locale,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    loop = object.__new__(AgentLoop)
    loop._language_context = context
    source = "user: RAW-历史输入\nassistant: RAW-员工回复"

    summary = loop._context_summary_builder(object())(
        "长期历史信息",
        source,
        120,
    )

    assert summary == "English history summary"
    assert captured["language_context"] == context.model_dump(mode="json")
    assert captured["language_directive"]["new_prose_locale"] == reply_locale.value
    assert captured["raw_source_markers"] == [
        {
            "json_pointer": "/history_to_compress",
            "kind": "history",
            "policy": "preserve_verbatim",
        }
    ]
    assert captured["history_to_compress"] == source
    assert captured["user_message"] == "Compress conversation history"
    assert "中文事实摘要" not in str(captured)


def test_agent_loop_conversation_context_invokes_locale_bound_summary_builder(
    monkeypatch,
) -> None:
    """长会话压缩通过实际会话上下文入口调用 locale-bound summary builder。"""
    captured: list[dict[str, object]] = []

    class FakeLLMClient:
        """Capture each long/medium compaction request without contacting a provider."""

        def __init__(self, _model_config: object) -> None:
            """Avoid external model initialization for the context integration test."""

        def generate_text(self, _system_prompt: str, payload: dict[str, object]) -> str:
            """Record the structured history payload and return locale-bound summary prose."""
            captured.append(payload)
            return "English history summary"

    class FakeResult:
        """Expose the SQLModel result methods used by the context projection."""

        def __init__(self, rows: list[Message]) -> None:
            """Retain the exact visible message rows supplied by the test fixture."""
            self.rows = rows

        def all(self) -> list[Message]:
            """Return all fixture rows in their source order."""
            return self.rows

    class FakeDatabase:
        """Provide only the database operations needed by AgentLoop context projection."""

        def __init__(self, rows: list[Message]) -> None:
            """Store rows and ignore the SQL statement because query shape is not under test."""
            self.result = FakeResult(rows)

        def exec(self, _statement: object) -> FakeResult:
            """Return the fixed message result for the conversation context query."""
            return self.result

        def add(self, _row: object) -> None:
            """Accept the in-memory context-state update without persisting test data."""

    monkeypatch.setattr(agent_loop_module, "LLMClient", FakeLLMClient)
    context = _english_reply_context()
    rows = [
        Message(
            id=f"message_{index}",
            tenant_id="tenant-language",
            session_id="session-language",
            role="user" if index % 2 == 0 else "assistant",
            content=f"RAW-history-{index} " + ("x" * 120),
        )
        for index in range(20)
    ]
    loop = object.__new__(AgentLoop)
    loop.db = FakeDatabase(rows)
    loop._language_context = context
    loop._get_conversation_context_settings = lambda _tenant_id: ConversationContextSettings(
        token_budget=500,
        compaction_trigger_ratio=0.20,
        recent_round_limit=2,
        long_summary_token_budget=128,
        medium_summary_token_budget=128,
    )
    session = ChatSession(
        id="session-language",
        tenant_id="tenant-language",
        user_id="user-language",
    )

    projected = loop._conversation_context(session, object())

    assert projected["metadata"]["compacted_now"] is True
    assert len(captured) == 1
    assert all(item["language_context"] == context.model_dump(mode="json") for item in captured)
    assert all(item["language_directive"]["new_prose_locale"] == "en-US" for item in captured)
    assert all(item["history_to_compress"].startswith("user: RAW-history-0") for item in captured)

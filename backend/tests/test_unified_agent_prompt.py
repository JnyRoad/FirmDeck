from app.core.reflection_agent import ReflectionAgent
from app.core.response_generator import ResponseGenerator
from app.core.router import Router
from app.core.step_agent import StepAgent
from app.db.models import ChatSession
from app.llm import LLMClient
from app.session.session_schema import StepAgentResult
from app.tools.tool_schema import ToolCall


def test_four_agent_stages_use_identical_system_and_stage_local_user_content(
    monkeypatch,
) -> None:
    systems: dict[str, str] = {}
    payloads: dict[str, dict] = {}

    def fake_init(self, model_config):  # noqa: ANN001
        return None

    def fake_generate_json(self, system_prompt, payload):  # noqa: ANN001
        phase = payload["_agent_stage"]["phase"]
        systems[phase] = system_prompt
        payloads[phase] = payload
        if phase == "Router":
            return {"decision": "answer_only", "confidence": 0.9}
        if phase == "Step Agent":
            return {"reply": "正在处理", "is_step_completed": False}
        if phase == "Reflection":
            return {"action": "pass", "needs_retry": False}
        raise AssertionError(f"unexpected phase: {phase}")

    def fake_generate_text(self, system_prompt, payload):  # noqa: ANN001
        phase = payload["_agent_stage"]["phase"]
        systems[phase] = system_prompt
        payloads[phase] = payload
        return "最终回复"

    monkeypatch.setattr(LLMClient, "__init__", fake_init)
    monkeypatch.setattr(LLMClient, "generate_json", fake_generate_json)
    monkeypatch.setattr(LLMClient, "generate_text", fake_generate_text)

    session = ChatSession(id="session_test", tenant_id="tenant_demo")
    context = {
        "messages": [{"role": "user", "content": "当前问题"}],
        "metadata": {"current_turn_time": "2026-07-13T20:45:00+08:00"},
    }
    memory = [{"content": "用户偏好简洁回答", "id": "internal_memory_id"}]
    router_decision = Router().decide(
        "当前问题",
        session,
        [],
        model_config=None,  # type: ignore[arg-type]
        conversation_context=context,
        memory_context=memory,
    )
    step_result = StepAgent().run(
        "当前问题",
        session,
        None,
        [],
        model_config=None,  # type: ignore[arg-type]
        router_decision=router_decision,
        conversation_context=context,
        memory_context=memory,
    )
    ReflectionAgent().review(
        "当前问题",
        session,
        None,
        router_decision,
        StepAgentResult(tool_call=ToolCall(name="demo", arguments={})),
        None,
        [],
        [],
        model_config=None,  # type: ignore[arg-type]
        conversation_context=context,
        memory_context=memory,
    )
    ResponseGenerator().generate(
        "当前问题",
        session,
        None,
        router_decision,
        step_result,
        None,
        model_config=None,  # type: ignore[arg-type]
        memory_context=memory,
        conversation_context=context,
    )

    assert set(systems) == {"Router", "Step Agent", "Reflection", "Response Generator"}
    assert len(set(systems.values())) == 1
    assert "统一执行引擎" in next(iter(systems.values()))
    for phase, payload in payloads.items():
        assert payload["_agent_stage"]["memory"] == "- 用户偏好简洁回答"
        assert payload["_agent_stage"]["turn_time"] == "2026-07-13T20:45:00+08:00"
        assert payload["user_message"] == "当前问题"
        assert "internal_memory_id" not in str(payload)
        assert payload["_agent_stage"]["instructions"]
        assert payload["_agent_stage"]["output_contract"]

from __future__ import annotations

from app import paths
from app.core.context_projection import (
    compact_awaiting_input,
    compact_conversation_context,
    compact_knowledge_context,
    compact_pending_tasks,
    compact_router_decision,
    compact_step_skill_context,
)
from app.db.models import ChatSession, ModelConfig, Skill, Tool
from app.llm import LLMClient, LLMError
from app.llm.stage_protocol import (
    STEP_AGENT_OUTPUT_SCHEMA,
    stage_payload,
    unified_system_prompt,
)
from app.observability.spans import llm_operation
from app.session.session_schema import RouterDecision, StepAgentResult


PROMPT_PATH = paths.resource_dir() / "app" / "llm" / "prompts" / "step_agent_prompt.md"
INTERNAL_SCHEDULER_SLOT_KEYS = {"_graph_pending_steps"}


class StepAgent:
    def run(
        self,
        message: str,
        session: ChatSession,
        skill: Skill | None,
        tools: list[Tool],
        model_config: ModelConfig,
        router_decision: RouterDecision | None = None,
        repair_context: dict[str, object] | None = None,
        recent_messages: list[dict[str, str]] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        conversation_context: dict[str, object] | None = None,
        current_knowledge: list[dict[str, object]] | None = None,
    ) -> StepAgentResult:
        compact_knowledge = compact_knowledge_context(current_knowledge)
        compact_repair = _compact_repair_context(repair_context)
        stage_data = {
            "active_skill": compact_step_skill_context(
                skill.content_json,
                session.active_step_id,
                skill_id=skill.skill_id,
                name=skill.name,
                description=skill.description,
            )
            if skill
            else None,
            "retrieved_knowledge": compact_knowledge,
            "router_decision": compact_router_decision(
                router_decision.model_dump(mode="json") if router_decision else None
            ),
            "slots": _step_agent_slots(session.slots_json),
            "awaiting_input": compact_awaiting_input(session.awaiting_input_json),
            "pending_tasks": compact_pending_tasks(session.pending_tasks_json),
            "repair_context": compact_repair,
            "available_tools": [
                {
                    "name": tool.name,
                    "display_name": tool.display_name,
                    "description": tool.description,
                    "bucket": getattr(tool, "bucket", None) or "未分桶",
                    "input_schema": tool.input_schema,
                    "allowed_skills": tool.allowed_skills_json,
                }
                for tool in tools
                if tool.enabled
            ],
        }
        payload = stage_payload(
            phase="Step Agent",
            user_message=message,
            conversation_context=compact_conversation_context(conversation_context),
            memory_context=memory_context,
            instructions=PROMPT_PATH.read_text(encoding="utf-8"),
            stage_data=stage_data,
            output_contract=STEP_AGENT_OUTPUT_SCHEMA,
        )
        try:
            operation = "step_agent.repair" if repair_context else "step_agent.run"
            repair_reason = str((repair_context or {}).get("reason") or "") or None
            with llm_operation(operation, repair_reason=repair_reason):
                raw = LLMClient(model_config).generate_json(
                    unified_system_prompt(), payload
                )
            return StepAgentResult.model_validate(raw)
        except Exception as exc:
            if isinstance(exc, LLMError):
                raise
            raise LLMError(f"Step agent returned invalid JSON schema: {exc}") from exc


def _step_agent_slots(slots: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(slots, dict):
        return {}
    return {
        key: value
        for key, value in slots.items()
        if str(key) not in INTERNAL_SCHEDULER_SLOT_KEYS
    }


def _compact_repair_context(
    repair_context: dict[str, object] | None,
) -> dict[str, object] | None:
    if not isinstance(repair_context, dict):
        return None
    projected = dict(repair_context)
    if projected.get("reason") == "knowledge_continuation":
        projected.pop("knowledge_results", None)
        projected["knowledge_results_available_in"] = "retrieved_knowledge"
    return projected

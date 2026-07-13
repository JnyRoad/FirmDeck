from __future__ import annotations

from typing import Any

from app import paths
from app.core.context_projection import (
    compact_awaiting_input,
    compact_conversation_context,
    compact_pending_tasks,
)
from app.db.models import ChatSession, ModelConfig, Skill
from app.llm import LLMClient, LLMError
from app.llm.stage_protocol import (
    ROUTER_OUTPUT_SCHEMA,
    TASK_SCHEDULER_OUTPUT_SCHEMA,
    stage_payload,
    unified_system_prompt,
)
from app.observability.spans import llm_operation
from app.session.session_schema import RouterDecision, TaskScheduleDecision
from app.session.slot_policy import strip_router_generated_message_slots


PROMPT_PATH = paths.resource_dir() / "app" / "llm" / "prompts" / "router_prompt.md"
TASK_SCHEDULER_PROMPT_PATH = paths.resource_dir() / "app" / "llm" / "prompts" / "task_scheduler_prompt.md"


class Router:
    def decide(
        self,
        message: str,
        session: ChatSession,
        available_skills: list[Skill],
        model_config: ModelConfig,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
    ) -> RouterDecision:
        payload = stage_payload(
            phase="Router",
            user_message=message,
            conversation_context=compact_conversation_context(conversation_context),
            memory_context=memory_context,
            instructions=PROMPT_PATH.read_text(encoding="utf-8"),
            stage_data={
                "current_session": _router_session_payload(session),
                "available_skills": _available_skill_payloads(available_skills),
            },
            output_contract=ROUTER_OUTPUT_SCHEMA,
        )
        try:
            with llm_operation("router.scene"):
                raw = LLMClient(model_config).generate_json(
                    unified_system_prompt(), payload
                )
            decision = RouterDecision.model_validate(raw)
        except Exception as exc:
            if isinstance(exc, LLMError):
                raise
            raise LLMError(f"Router returned invalid JSON schema: {exc}") from exc
        return self._normalize_decision(decision, session, available_skills)

    def schedule_tasks_after_completion(
        self,
        message: str,
        session: ChatSession,
        available_skills: list[Skill],
        model_config: ModelConfig,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        completed_reply: str | None = None,
    ) -> TaskScheduleDecision:
        candidate_frames = self._candidate_task_frames(session)
        payload = stage_payload(
            phase="Router / Task Scheduler",
            user_message=message,
            conversation_context=compact_conversation_context(conversation_context),
            memory_context=memory_context,
            instructions=TASK_SCHEDULER_PROMPT_PATH.read_text(encoding="utf-8"),
            stage_data={
            "completed_reply": completed_reply or "",
            "current_session": _router_session_payload(session),
            "candidate_task_frames": candidate_frames,
            "available_skills": _available_skill_payloads(available_skills),
            },
            output_contract=TASK_SCHEDULER_OUTPUT_SCHEMA,
        )
        try:
            with llm_operation("router.task_scheduler"):
                raw = LLMClient(model_config).generate_json(
                    unified_system_prompt(),
                    payload,
                )
            schedule = TaskScheduleDecision.model_validate(raw)
        except Exception as exc:
            if isinstance(exc, LLMError):
                raise
            raise LLMError(f"Task scheduler returned invalid JSON schema: {exc}") from exc
        return self._normalize_schedule(schedule, candidate_frames)

    def _normalize_decision(
        self, decision: RouterDecision, session: ChatSession, available_skills: list[Skill]
    ) -> RouterDecision:
        self._strip_generated_message_slots(decision)
        skills = {skill.skill_id: skill for skill in available_skills}
        if decision.target_skill_id and decision.target_skill_id not in skills:
            decision.target_skill_id = None
            decision.target_step_id = None
        if decision.awaiting_input and decision.awaiting_input.skill_id not in {None, *skills.keys()}:
            decision.awaiting_input = None
        if decision.decision == "start_new_task":
            if not decision.target_skill_id or decision.target_skill_id not in skills:
                decision.decision = "clarify"
                decision.target_skill_id = None
                decision.target_step_id = None
                decision.clarification_question = "请问您想办理哪类业务？"
                return decision
        if decision.decision == "switch_to_pending":
            pending_ids = {
                str(task.get("task_id"))
                for task in (session.pending_tasks_json or [])
                if isinstance(task, dict) and task.get("task_id")
            }
            if not decision.selected_task_id or decision.selected_task_id not in pending_ids:
                decision.decision = "clarify"
                decision.clarification_question = "请问您想继续哪一项待处理任务？"
                return decision
        if not decision.target_skill_id and session.active_skill_id:
            decision.target_skill_id = session.active_skill_id
        if decision.target_skill_id and not decision.target_step_id:
            target_skill = skills.get(decision.target_skill_id)
            if target_skill:
                decision.target_step_id = _first_node_id(target_skill)
        normalized_tasks = self._normalize_tasks(decision.pending_tasks, skills)
        decision.pending_tasks = normalized_tasks
        decision.created_tasks = self._normalize_tasks(decision.created_tasks, skills)
        return decision

    def _strip_generated_message_slots(self, decision: RouterDecision) -> None:
        decision.slot_hints = strip_router_generated_message_slots(decision.slot_hints)
        for task in [*decision.pending_tasks, *decision.created_tasks]:
            task.slot_hints = strip_router_generated_message_slots(task.slot_hints)
        for update in decision.task_updates:
            update.slot_hints = strip_router_generated_message_slots(update.slot_hints)

    def _normalize_tasks(self, tasks, skills: dict[str, Skill]):
        normalized_tasks = []
        for task in tasks:
            if not task.target_skill_id or task.target_skill_id not in skills:
                continue
            if not task.target_step_id:
                target_skill = skills.get(task.target_skill_id)
                if target_skill:
                    task.target_step_id = _first_node_id(target_skill)
            normalized_tasks.append(task)
        return normalized_tasks

    def _normalize_schedule(
        self, schedule: TaskScheduleDecision, candidate_frames: list[dict[str, Any]]
    ) -> TaskScheduleDecision:
        valid_ids = {
            str(frame.get("task_id"))
            for frame in candidate_frames
            if isinstance(frame, dict) and frame.get("task_id")
        }
        selected_ids: list[str] = []
        for task_id in schedule.selected_task_ids:
            if task_id in valid_ids and task_id not in selected_ids:
                selected_ids.append(task_id)
        schedule.selected_task_ids = selected_ids
        if not selected_ids:
            schedule.action = "stop"
        return schedule

    def _candidate_task_frames(self, session: ChatSession) -> list[dict[str, Any]]:
        frames = compact_pending_tasks(session.pending_tasks_json)
        for frame in frames:
            frame["source"] = "pending"
            frame["slots"] = strip_router_generated_message_slots(
                frame.get("slots") if isinstance(frame.get("slots"), dict) else {}
            )
        return [frame for frame in frames if frame.get("task_id")]


def _first_node_id(skill: Skill) -> str | None:
    content = skill.content_json or {}
    start_node_id = content.get("start_node_id")
    if isinstance(start_node_id, str) and start_node_id.strip():
        return start_node_id
    nodes = content.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict) and node.get("node_id"):
                return str(node["node_id"])
    return None


def _available_skill_payloads(available_skills: list[Skill]) -> list[dict[str, Any]]:
    return [_skill_payload(skill) for skill in available_skills]


def _skill_payload(skill: Skill) -> dict[str, Any]:
    content = skill.content_json or {}
    return _without_empty(
        {
            "skill_id": skill.skill_id,
            "name": skill.name,
            "description": skill.description,
            "trigger_intents": content.get("trigger_intents", []),
        }
    )


def _router_session_payload(session: ChatSession) -> dict[str, Any]:
    return _without_empty(
        {
            "active_skill_id": session.active_skill_id,
            "active_step_id": session.active_step_id,
            "slots": session.slots_json or {},
            "pending_tasks": compact_pending_tasks(session.pending_tasks_json),
            "awaiting_input": compact_awaiting_input(session.awaiting_input_json),
            "status": session.status,
        }
    )


def _without_empty(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item
        for key, item in value.items()
        if item is not None and item != "" and item != [] and item != {}
    }

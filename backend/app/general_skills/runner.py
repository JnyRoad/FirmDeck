from __future__ import annotations

import inspect
import json
import logging
import os
import queue
import selectors
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from tempfile import mkdtemp
from typing import Any

from app import paths
from app.db.models import GeneralSkill, ModelConfig
from app.general_skills.runtime_env import (
    GeneralSkillRuntimeError,
    ensure_runtime_python,
    runtime_environment,
)
from app.general_skills.schema import (
    GeneralSkillExecutionPlan,
    GeneralSkillExecutionReview,
    GeneralSkillReply,
    GeneralSkillRunResponse,
    GeneralSkillSelection,
)
from app.harness.artifacts import HarnessArtifactAccessError, normalize_harness_artifact_path
from app.harness.command import run_sandboxed_process
from app.harness.errors import HarnessExecutionError
from app.i18n.language_context import LanguageContext
from app.i18n.raw_source import RawSourceKind, RawSourceMarker
from app.llm import LLMClient, LLMError
from app.llm.model_config_resolver import snapshot_model_config
from app.llm.prompts.language import (
    language_prompt_contract,
    localized_compat_text,
    resolve_prompt_language_context,
)
from app.llm.stage_protocol import stage_payload, unified_system_prompt
from app.observability.spans import llm_operation

PROMPT_DIR = paths.resource_dir() / "app" / "llm" / "prompts"
SELECTOR_PROMPT = PROMPT_DIR / "general_skill_selector_prompt.md"
RUNNER_PROMPT = PROMPT_DIR / "general_skill_runner_prompt.md"
REPAIR_PROMPT = PROMPT_DIR / "general_skill_repair_prompt.md"
REVIEW_PROMPT = PROMPT_DIR / "general_skill_review_prompt.md"
REPLY_PROMPT = PROMPT_DIR / "general_skill_reply_prompt.md"
READ_PROMPT = PROMPT_DIR / "general_skill_read_prompt.md"
RUN_TIMEOUT_SECONDS = 12
MAX_OUTPUT_CHARS = 20000
GENERAL_SKILL_MAX_ATTEMPTS = 10
MAX_DECLARED_ARTIFACTS = 20
TraceSink = Callable[[dict[str, Any]], None]
CancellationCheck = Callable[[], bool]
GENERAL_SKILL_SELECTION_OUTPUT = {
    "use_general_skill": "boolean",
    "selected_slug": "string?",
    "operation": "read | execute",
    "use_knowledge": "boolean",
    "knowledge_query": "string?",
    "confidence": "number",
    "reason": "string?",
}
GENERAL_SKILL_READ_OUTPUT = {
    "reply": "string",
    "summary": "string?",
    "inputs": ["string"],
    "side_effects": ["string"],
}
GENERAL_SKILL_PLAN_OUTPUT = {
    "code": "string",
    "runtime": "bash | python",
    "rationale": "string?",
    "expected_output": "string?",
}
GENERAL_SKILL_REVIEW_OUTPUT = {
    "result_sufficient": "boolean",
    "needs_retry": "boolean",
    "terminal": "boolean",
    "reason": "string",
    "repair_hint": "string?",
}
GENERAL_SKILL_REPLY_OUTPUT = {"reply": "string"}
logger = logging.getLogger(__name__)

GENERAL_SKILL_TRACE_EVENT_CODE = "run.skill.trace"
"""Stable public event code used by both legacy and structured Skill traces."""

_GENERAL_SKILL_TRACE_CODE_PREFIX = "general_skill.trace"
_GENERAL_SKILL_TRACE_PARAM_FIELDS: dict[str, frozenset[str]] = {
    "skill_loaded": frozenset({"skill_slug", "skill_name"}),
    "read_started": frozenset(),
    "read_failed": frozenset(),
    "read_created": frozenset(),
    "reply_created": frozenset(),
    "plan_failed": frozenset({"attempt"}),
    "attempt_started": frozenset({"attempt"}),
    "reflection_stopped": frozenset({"attempt"}),
    "reflection_passed": frozenset({"attempt"}),
    "reflection_retrying": frozenset({"attempt"}),
    "repair_failed": frozenset({"attempt"}),
    "reply_failed": frozenset(),
    "planning": frozenset(),
    "plan_created": frozenset({"attempt", "runtime"}),
    "repair_planning": frozenset({"attempt"}),
    "running_code": frozenset({"attempt", "runtime", "run_id"}),
    "runtime_environment_failed": frozenset({"attempt", "runtime"}),
    "stdout_chunk": frozenset({"attempt"}),
    "stderr_chunk": frozenset({"attempt"}),
    "code_timeout": frozenset({"attempt", "runtime"}),
    "code_finished": frozenset({"attempt", "runtime", "return_code"}),
    "replying": frozenset(),
    "reflection_reviewing": frozenset({"attempt"}),
    "reflection_reviewed": frozenset({"attempt"}),
    "instructions_loaded": frozenset(
        {"skill_slug", "skill_name", "operation", "requested_operation"}
    ),
    "unknown": frozenset(),
}
_GENERAL_SKILL_TRACE_PARAM_KINDS = {
    "skill_slug": "string",
    "skill_name": "string",
    "operation": "string",
    "requested_operation": "string",
    "runtime": "string",
    "run_id": "string",
    "attempt": "integer",
    "return_code": "integer",
}
_GENERAL_SKILL_TRACE_RAW_FIELDS = frozenset(
    {
        "raw_code",
        "raw_error",
        "raw_error_code",
        "raw_stdout",
        "raw_stderr",
        "raw_structured_result",
        "raw_review",
        "raw_rationale",
        "raw_expected_output",
    }
)


def _is_trace_param_value(field_name: str, value: object) -> bool:
    """Return whether one trace param has the exact primitive type assigned to its field."""
    expected_kind = _GENERAL_SKILL_TRACE_PARAM_KINDS.get(field_name)
    if expected_kind == "string":
        return isinstance(value, str)
    if expected_kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return False


def canonical_general_skill_trace_payload(item: Mapping[str, Any]) -> dict[str, Any]:
    """Project one Skill trace item to stable descriptors and explicitly marked raw fields.

    The outer ``run.skill.trace`` event is registered separately.  Its registry entry
    intentionally has an empty parameter schema; the phase-specific ``params`` below
    are validated by this local allowlist and are not claimed as registry validation.
    """
    source = dict(item) if isinstance(item, Mapping) else {}
    raw_phase = str(source.pop("phase", "unknown") or "unknown").strip()
    phase = raw_phase if raw_phase in _GENERAL_SKILL_TRACE_PARAM_FIELDS else "unknown"
    expected_code = f"{_GENERAL_SKILL_TRACE_CODE_PREFIX}.{phase}"
    supplied_params = source.pop("params", {})
    params_source = dict(supplied_params) if isinstance(supplied_params, Mapping) else {}
    if "skill_slug" not in params_source and "slug" in source:
        params_source["skill_slug"] = source["slug"]
    for field_name in _GENERAL_SKILL_TRACE_PARAM_FIELDS.get(phase, frozenset()):
        if field_name in source and field_name not in params_source:
            params_source[field_name] = source[field_name]
    allowed_params = _GENERAL_SKILL_TRACE_PARAM_FIELDS.get(phase, frozenset())
    params = {
        field_name: params_source[field_name]
        for field_name in sorted(allowed_params)
        if field_name in params_source
        and _is_trace_param_value(field_name, params_source[field_name])
    }
    payload: dict[str, Any] = {
        "phase": phase,
        "code": expected_code,
        "event_code": GENERAL_SKILL_TRACE_EVENT_CODE,
        "params": params,
    }
    for field_name in sorted(_GENERAL_SKILL_TRACE_RAW_FIELDS):
        if field_name in source:
            payload[field_name] = source[field_name]
    raw_aliases = {
        "code": "raw_code",
        "error": "raw_error",
        "error_code": "raw_error_code",
        "stdout_preview": "raw_stdout",
        "stderr_preview": "raw_stderr",
        "structured_result": "raw_structured_result",
        "review": "raw_review",
        "rationale": "raw_rationale",
        "expected_output": "raw_expected_output",
    }
    for source_name, target_name in raw_aliases.items():
        if (
            target_name not in payload
            and source_name in source
            and (source_name != "code" or source[source_name] != expected_code)
        ):
            payload[target_name] = source[source_name]
    if phase == "stdout_chunk" and "raw_stdout" not in payload and "text" in source:
        payload["raw_stdout"] = source["text"]
    if phase == "stderr_chunk" and "raw_stderr" not in payload and "text" in source:
        payload["raw_stderr"] = source["text"]
    return payload


def build_general_skill_trace_payload(
    phase: str,
    *,
    params: Mapping[str, Any] | None = None,
    **raw_fields: Any,
) -> dict[str, Any]:
    """Build a canonical Skill trace descriptor without allowing product prose fields."""
    return canonical_general_skill_trace_payload(
        {"phase": phase, "params": dict(params or {}), **raw_fields}
    )


def _general_skill_language_contract(
    language_context: LanguageContext | None,
    *extra_markers: RawSourceMarker,
) -> dict[str, object]:
    """Build the common Skill query/history/source contract plus stage-specific raw markers."""
    return language_prompt_contract(
        language_context,
        [
            RawSourceMarker(
                json_pointer="/user_message",
                kind=RawSourceKind.USER_INPUT,
            ),
            RawSourceMarker(
                json_pointer="/conversation_context",
                kind=RawSourceKind.HISTORY,
            ),
            RawSourceMarker(
                json_pointer="/skill",
                kind=RawSourceKind.BUSINESS_RECORD,
            ),
            *extra_markers,
        ],
    )


class GeneralSkillExecutionCancelled(RuntimeError):
    pass


class GeneralSkillSelector:
    def decide(
        self,
        query: str,
        general_skills: list[GeneralSkill],
        model_config: ModelConfig,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> GeneralSkillSelection:
        """Select a skill operation while preserving query/history and constraining generated fields."""
        payload = stage_payload(
            phase="Router / General Skill Selector",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=SELECTOR_PROMPT.read_text(encoding="utf-8"),
            stage_data={
                **language_prompt_contract(
                    language_context,
                    [
                        RawSourceMarker(
                            json_pointer="/user_message",
                            kind=RawSourceKind.USER_INPUT,
                        ),
                        RawSourceMarker(
                            json_pointer="/conversation_context",
                            kind=RawSourceKind.HISTORY,
                        ),
                        RawSourceMarker(
                            json_pointer="/general_skills",
                            kind=RawSourceKind.BUSINESS_RECORD,
                        ),
                    ],
                ),
                "general_skills": [
                    {
                        "slug": skill.slug,
                        "name": skill.name,
                        "description": skill.description,
                        "homepage": skill.homepage,
                        "status": skill.status,
                    }
                    for skill in general_skills
                    if skill.status == "published"
                ],
            },
            output_contract=GENERAL_SKILL_SELECTION_OUTPUT,
        )
        with llm_operation("general_skill.select"):
            raw = LLMClient(model_config).generate_json(
                unified_system_prompt(), payload
            )
        decision = GeneralSkillSelection.model_validate(raw)
        slugs = {skill.slug for skill in general_skills if skill.status == "published"}
        if decision.use_general_skill and decision.selected_slug in slugs:
            return decision
        return decision.model_copy(update={"use_general_skill": False, "selected_slug": None})


class GeneralSkillReader:
    """Explain a skill package without generating or executing runner code."""

    def read(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> GeneralSkillRunResponse:
        """Generate a read-only Skill explanation in reply locale without rewriting Skill sources."""
        language_context = resolve_prompt_language_context(language_context)
        trace: list[dict[str, Any]] = [
            build_general_skill_trace_payload(
                "skill_loaded",
                params={"skill_slug": skill.slug, "skill_name": skill.name},
            ),
            build_general_skill_trace_payload("read_started"),
        ]
        payload = stage_payload(
            phase="Step Agent / General Skill Read",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=READ_PROMPT.read_text(encoding="utf-8"),
            stage_data={
                **language_prompt_contract(
                    language_context,
                    [
                        RawSourceMarker(
                            json_pointer="/user_message",
                            kind=RawSourceKind.USER_INPUT,
                        ),
                        RawSourceMarker(
                            json_pointer="/conversation_context",
                            kind=RawSourceKind.HISTORY,
                        ),
                        RawSourceMarker(
                            json_pointer="/skill",
                            kind=RawSourceKind.BUSINESS_RECORD,
                        ),
                    ],
                ),
                "skill": {
                    "slug": skill.slug,
                    "name": skill.name,
                    "description": skill.description,
                    "homepage": skill.homepage,
                    "markdown": skill.skill_markdown,
                    "package": _skill_package_payload(skill),
                }
            },
            output_contract=GENERAL_SKILL_READ_OUTPUT,
        )
        try:
            with llm_operation("general_skill.read"):
                raw = LLMClient(model_config).generate_json(unified_system_prompt(), payload)
            reply = str(raw.get("reply") or "").strip()
            if not reply:
                raise LLMError("General skill read reply is empty")
        except LLMError:
            logger.exception("general skill read failed")
            trace.append(
                build_general_skill_trace_payload(
                    "read_failed",
                    raw_error_code="GENERAL_SKILL_READ_FAILED",
                )
            )
            return GeneralSkillRunResponse(
                skill_slug=skill.slug,
                operation="read",
                execution_trace=trace,
                stderr="",
                structured_result={
                    "success": False,
                    "operation": "read",
                    "error": "skill_read_failed",
                    "error_code": "GENERAL_SKILL_READ_FAILED",
                },
                reply=localized_compat_text(
                    language_context,
                    zh_cn="抱歉，当前无法完成这个 Skill 的只读说明。",
                    en_us="Sorry, this Skill cannot be described right now.",
                ),
                language_context=language_context,
            )
        structured = {
            "success": True,
            "operation": "read",
            "summary": str(raw.get("summary") or "").strip(),
            "inputs": raw.get("inputs") if isinstance(raw.get("inputs"), list) else [],
            "side_effects": raw.get("side_effects")
            if isinstance(raw.get("side_effects"), list)
            else [],
        }
        trace.extend(
            [
                build_general_skill_trace_payload("read_created"),
                build_general_skill_trace_payload("reply_created"),
            ]
        )
        return GeneralSkillRunResponse(
            skill_slug=skill.slug,
            operation="read",
            execution_trace=trace,
            structured_result=structured,
            reply=reply,
            language_context=language_context,
        )


class GeneralSkillRunner:
    def run(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        user_id: str = "",
        max_attempts: int = GENERAL_SKILL_MAX_ATTEMPTS,
        event_sink: TraceSink | None = None,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        workspace_root: Path | None = None,
        is_cancelled: CancellationCheck | None = None,
        sandbox_network_mode: str = "all",
        sandbox_allowed_domains: tuple[str, ...] = (),
        sandbox_enabled: bool = True,
        language_context: LanguageContext | None = None,
    ) -> GeneralSkillRunResponse:
        """Plan, execute, review, and answer under one immutable reply-locale snapshot."""
        # Workflow: generate a bounded executable plan before any sandbox side effect occurs.
        language_context = resolve_prompt_language_context(language_context)
        trace: list[dict[str, Any]] = []
        max_attempts = max(1, min(max_attempts, GENERAL_SKILL_MAX_ATTEMPTS))
        _raise_if_cancelled(is_cancelled)
        _emit(
            trace,
            build_general_skill_trace_payload(
                "skill_loaded",
                params={"skill_slug": skill.slug, "skill_name": skill.name},
            ),
            event_sink,
        )
        try:
            plan, planning_attempts = self._generate_plan_with_reflection(
                skill,
                query,
                model_config,
                trace,
                event_sink,
                max_attempts,
                conversation_context,
                memory_context,
                language_context,
            )
            _raise_if_cancelled(is_cancelled)
        except LLMError:
            logger.exception("general skill runner plan failed")
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "plan_failed",
                    raw_error_code="GENERAL_SKILL_PLAN_FAILED",
                ),
                event_sink,
            )
            return GeneralSkillRunResponse(
                skill_slug=skill.slug,
                execution_trace=trace,
                generated_code="",
                stdout="",
                stderr="",
                structured_result={
                    "success": False,
                    "error": "runner_plan_failed",
                    "error_code": "GENERAL_SKILL_PLAN_FAILED",
                },
                reply=localized_compat_text(
                    language_context,
                    zh_cn="抱歉，当前通用技能执行代码生成失败，暂时无法完成这次运行。",
                    en_us="Sorry, the Skill runner plan could not be generated for this run.",
                ),
                language_context=language_context,
            )

        attempts: list[dict[str, Any]] = planning_attempts
        stdout = ""
        stderr = ""
        structured_result: dict[str, Any] = {}
        for attempt in range(1, max_attempts + 1):
            # Workflow: execute and review each attempt before deciding whether repair is safe.
            _raise_if_cancelled(is_cancelled)
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "attempt_started",
                    params={"attempt": attempt},
                ),
                event_sink,
            )
            supported = inspect.signature(self._execute_plan).parameters
            optional_controls = {
                "workspace_root": workspace_root,
                "is_cancelled": is_cancelled,
                "sandbox_network_mode": sandbox_network_mode,
                "sandbox_allowed_domains": sandbox_allowed_domains,
                "sandbox_enabled": sandbox_enabled,
            }
            execute_kwargs = {
                key: value for key, value in optional_controls.items() if key in supported
            }
            stdout, stderr, structured_result = self._execute_plan(
                skill, query, plan, user_id, trace, event_sink, attempt, **execute_kwargs
            )
            _normalize_failure_diagnostics(structured_result)
            _raise_if_cancelled(is_cancelled)
            review = self._review_execution_result(
                skill,
                query,
                model_config,
                plan,
                stdout,
                stderr,
                structured_result,
                trace,
                event_sink,
                attempt,
                conversation_context,
                memory_context,
                language_context,
            )
            if (
                structured_result.get("retryable") is False
                or structured_result.get("infrastructure_failure") is True
            ):
                review["needs_retry"] = False
                review["terminal"] = True
            _raise_if_cancelled(is_cancelled)
            attempts.append(
                {
                    "attempt": attempt,
                    "code": _truncate(plan.code),
                    "stdout": _truncate(stdout),
                    "stderr": _truncate(stderr),
                    "structured_result": structured_result,
                    "execution_review": review,
                }
            )
            needs_retry = bool(review.get("needs_retry"))
            if not needs_retry:
                if structured_result.get("success") is False or review.get("result_sufficient") is False:
                    _emit(
                        trace,
                        build_general_skill_trace_payload(
                            "reflection_stopped",
                            params={"attempt": attempt},
                            raw_structured_result=structured_result,
                            raw_review=review,
                        ),
                        event_sink,
                    )
                else:
                    _emit(
                        trace,
                        build_general_skill_trace_payload(
                            "reflection_passed",
                            params={"attempt": attempt},
                        ),
                        event_sink,
                    )
                break
            if attempt >= max_attempts:
                _emit(
                    trace,
                    build_general_skill_trace_payload(
                        "reflection_stopped",
                        params={"attempt": attempt},
                    ),
                    event_sink,
                )
                break
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "reflection_retrying",
                    params={"attempt": attempt},
                    raw_stdout=stdout[:600],
                    raw_stderr=stderr[:600],
                    raw_structured_result=structured_result,
                    raw_review=review,
                ),
                event_sink,
            )
            try:
                plan = self._repair_plan(
                    skill,
                    query,
                    model_config,
                    trace,
                    attempts,
                    event_sink,
                    attempt + 1,
                    conversation_context,
                    memory_context,
                    language_context,
                )
                _raise_if_cancelled(is_cancelled)
            except LLMError as exc:
                _emit(
                    trace,
                    build_general_skill_trace_payload(
                        "repair_failed",
                        params={"attempt": attempt},
                        raw_error=str(exc),
                    ),
                    event_sink,
                )
                break

        try:
            _raise_if_cancelled(is_cancelled)
            reply = self._generate_reply(
                skill,
                query,
                model_config,
                trace,
                stdout,
                stderr,
                structured_result,
                event_sink,
                conversation_context,
                memory_context,
                language_context,
            )
            _raise_if_cancelled(is_cancelled)
        except LLMError as exc:
            _emit(
                trace,
                build_general_skill_trace_payload("reply_failed", raw_error=str(exc)),
                event_sink,
            )
            reply = _fallback_reply(structured_result, language_context)
        return GeneralSkillRunResponse(
            skill_slug=skill.slug,
            execution_trace=trace,
            generated_code=plan.code,
            stdout=stdout,
            stderr=stderr,
            structured_result=structured_result,
            artifacts=(
                list(structured_result.get("artifacts") or [])
                if isinstance(structured_result.get("artifacts"), list)
                else []
            ),
            reply=reply,
            language_context=language_context,
        )

    def _generate_plan(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        trace: list[dict[str, Any]],
        event_sink: TraceSink | None = None,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> GeneralSkillExecutionPlan:
        """Generate one sandbox runner plan without rewriting the Skill package or user query."""
        _emit(trace, build_general_skill_trace_payload("planning"), event_sink)
        stage_data = {
            **_general_skill_language_contract(language_context),
            "skill": {
                "slug": skill.slug,
                "name": skill.name,
                "description": skill.description,
                "homepage": skill.homepage,
                "markdown": skill.skill_markdown,
                "package": _skill_package_payload(skill),
            },
            "runtime": {
                "languages": ["bash", "python"],
                "stdin_json": {
                    "query": query,
                    "skill_slug": skill.slug,
                    "skill_name": skill.name,
                    "skill_workspace": "<runtime absolute path to the restored skill folder>",
                    "output_dir": "<runtime absolute path for final downloadable files>",
                    "skill_files": [file["path"] for file in _skill_files(skill)],
                },
                "timeout_seconds": _run_timeout_seconds(skill),
            },
        }
        payload = stage_payload(
            phase="Step Agent / General Skill Plan",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=RUNNER_PROMPT.read_text(encoding="utf-8"),
            stage_data=stage_data,
            output_contract=GENERAL_SKILL_PLAN_OUTPUT,
        )
        with llm_operation("general_skill.plan"):
            raw = LLMClient(snapshot_model_config(model_config)).generate_json(
                unified_system_prompt(),
                payload,
            )
        plan = GeneralSkillExecutionPlan.model_validate(raw)
        plan.runtime = _plan_runtime(plan)
        if not plan.code.strip():
            raise LLMError("General skill runner code is empty")
        _emit(
            trace,
            build_general_skill_trace_payload(
                "plan_created",
                params={"runtime": plan.runtime},
                raw_rationale=plan.rationale,
                raw_code=plan.code,
                raw_expected_output=plan.expected_output,
            ),
            event_sink,
        )
        return plan

    def _generate_plan_with_reflection(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        trace: list[dict[str, Any]],
        event_sink: TraceSink | None,
        max_attempts: int,
        conversation_context: dict[str, object] | None,
        memory_context: list[dict[str, object]] | None,
        language_context: LanguageContext | None,
    ) -> tuple[GeneralSkillExecutionPlan, list[dict[str, Any]]]:
        """Retry plan generation while reusing the same language snapshot and source inputs."""
        planning_failures: list[dict[str, Any]] = []
        last_error: LLMError | None = None
        for plan_attempt in range(1, max_attempts + 1):
            try:
                if plan_attempt == 1:
                    return (
                        self._generate_plan(
                            skill,
                            query,
                            model_config,
                            trace,
                            event_sink,
                            conversation_context,
                            memory_context,
                            language_context,
                        ),
                        planning_failures,
                    )
                return (
                    self._repair_plan(
                        skill,
                        query,
                        model_config,
                        trace,
                        planning_failures,
                        event_sink,
                        plan_attempt,
                        conversation_context,
                        memory_context,
                        language_context,
                    ),
                    planning_failures,
                )
            except LLMError as exc:
                last_error = exc
                failure = {
                    "attempt": f"planning-{plan_attempt}",
                    "code": "",
                    "stdout": "",
                    "stderr": "",
                    "structured_result": {
                        "success": False,
                        "error": "plan_generation_failed",
                        "error_code": "GENERAL_SKILL_PLAN_FAILED",
                        "retryable": True,
                    },
                    "execution_review": {
                        "result_sufficient": False,
                        "needs_retry": plan_attempt < max_attempts,
                        "terminal": False,
                        "reason": "模型未能生成可执行 runner 计划，需要重新输出合法 JSON、runtime 和完整代码。",
                        "repair_hint": "保留原始 skill 与 query，重新输出包含 runtime、code、rationale、expected_output 的合法 JSON。",
                    },
                }
                planning_failures.append(failure)
                _emit(
                    trace,
                    build_general_skill_trace_payload(
                        "plan_failed",
                        params={"attempt": plan_attempt},
                        raw_error_code="GENERAL_SKILL_PLAN_FAILED",
                    ),
                    event_sink,
                )
                if plan_attempt >= max_attempts:
                    break
                _emit(
                    trace,
                    build_general_skill_trace_payload(
                        "reflection_retrying",
                        params={"attempt": plan_attempt},
                        raw_structured_result=failure["structured_result"],
                        raw_review=failure["execution_review"],
                    ),
                    event_sink,
                )
        raise LLMError(str(last_error) if last_error else "General skill runner plan generation failed")

    def _repair_plan(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        trace: list[dict[str, Any]],
        attempts: list[dict[str, Any]],
        event_sink: TraceSink | None,
        next_attempt: int,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> GeneralSkillExecutionPlan:
        """Repair a failed runner plan while preserving prior raw diagnostics verbatim."""
        _emit(
            trace,
            build_general_skill_trace_payload(
                "repair_planning",
                params={"attempt": next_attempt},
            ),
            event_sink,
        )
        stage_data = {
            **_general_skill_language_contract(
                language_context,
                RawSourceMarker(
                    json_pointer="/previous_attempts",
                    kind=RawSourceKind.DIAGNOSTIC,
                ),
            ),
            "skill": {
                "slug": skill.slug,
                "name": skill.name,
                "description": skill.description,
                "homepage": skill.homepage,
                "markdown": skill.skill_markdown,
                "package": _skill_package_payload(skill),
            },
            "runtime": {
                "languages": ["bash", "python"],
                "stdin_json": {
                    "query": query,
                    "skill_slug": skill.slug,
                    "skill_name": skill.name,
                    "skill_workspace": "<runtime absolute path to the restored skill folder>",
                    "output_dir": "<runtime absolute path for final downloadable files>",
                    "skill_files": [file["path"] for file in _skill_files(skill)],
                },
                "timeout_seconds": _run_timeout_seconds(skill),
            },
            "previous_attempts": attempts[-3:],
        }
        payload = stage_payload(
            phase="Step Agent / General Skill Repair",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=REPAIR_PROMPT.read_text(encoding="utf-8"),
            stage_data=stage_data,
            output_contract=GENERAL_SKILL_PLAN_OUTPUT,
        )
        with llm_operation("general_skill.repair", attempt=next_attempt):
            raw = LLMClient(snapshot_model_config(model_config)).generate_json(
                unified_system_prompt(),
                payload,
            )
        plan = GeneralSkillExecutionPlan.model_validate(raw)
        plan.runtime = _plan_runtime(plan)
        if not plan.code.strip():
            raise LLMError("General skill repaired runner code is empty")
        _emit(
            trace,
            build_general_skill_trace_payload(
                "plan_created",
                params={"attempt": next_attempt, "runtime": plan.runtime},
                raw_rationale=plan.rationale,
                raw_code=plan.code,
                raw_expected_output=plan.expected_output,
            ),
            event_sink,
        )
        return plan

    def _execute_plan(
        self,
        skill: GeneralSkill,
        query: str,
        plan: GeneralSkillExecutionPlan,
        user_id: str,
        trace: list[dict[str, Any]],
        event_sink: TraceSink | None = None,
        attempt: int = 1,
        workspace_root: Path | None = None,
        is_cancelled: CancellationCheck | None = None,
        sandbox_network_mode: str | None = None,
        sandbox_allowed_domains: tuple[str, ...] | None = None,
        sandbox_enabled: bool = True,
    ) -> tuple[str, str, dict[str, Any]]:
        sandbox_network_mode = sandbox_network_mode or "all"
        sandbox_allowed_domains = sandbox_allowed_domains or ()
        _raise_if_cancelled(is_cancelled)
        if workspace_root is not None:
            workspace_root.mkdir(parents=True, exist_ok=True)
        run_dir = Path(
            mkdtemp(
                prefix="general_skill_",
                dir=str(workspace_root) if workspace_root is not None else None,
            )
        )
        skill_dir = run_dir / "skill"
        _materialize_skill_package(skill, skill_dir)
        artifact_dir = run_dir / "artifacts"
        artifact_dir.mkdir()
        runtime = _plan_runtime(plan)
        runner_path = run_dir / ("runner.sh" if runtime == "bash" else "runner.py")
        runner_path.write_text(plan.code, encoding="utf-8")
        stdin_payload = {
            "query": query,
            "skill_slug": skill.slug,
            "skill_name": skill.name,
            "user_id": user_id,
            "skill_workspace": str(skill_dir),
            "artifact_dir": str(artifact_dir),
            "skill_files": [file["path"] for file in _skill_files(skill)],
        }
        _emit(
            trace,
            build_general_skill_trace_payload(
                "running_code",
                params={
                    "attempt": attempt,
                    "runtime": runtime,
                    "run_id": run_dir.name,
                },
            ),
            event_sink,
        )
        try:
            runtime_python = ensure_runtime_python()
            env = runtime_environment(os.environ.copy(), python_path=runtime_python)
        except GeneralSkillRuntimeError as exc:
            structured = {
                "success": False,
                "error": "runtime_environment_error",
                "message": str(exc),
                "retryable": False,
            }
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "runtime_environment_failed",
                    params={"attempt": attempt, "runtime": runtime},
                    raw_structured_result=structured,
                ),
                event_sink,
            )
            return "", str(exc), structured
        env.update(
            {
                "ARGUMENTS": query,
                "QUERY": query,
                "SKILL_WORKSPACE": str(skill_dir),
                "ARTIFACT_DIR": str(artifact_dir),
                "SKILL_SLUG": skill.slug,
                "SKILL_NAME": skill.name,
                "USER_ID": user_id,
                "SKILL_FILES_JSON": json.dumps([file["path"] for file in _skill_files(skill)], ensure_ascii=False),
            }
        )
        if runtime == "bash" and not _bash_supported():
            structured = {
                "success": False,
                "error": "bash_runtime_unsupported",
                "message": "当前运行环境不支持 bash 技能（Windows 或打包版），请改用 Python 技能。",
                "retryable": False,
            }
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "runtime_environment_failed",
                    params={"attempt": attempt, "runtime": runtime},
                    raw_structured_result=structured,
                ),
                event_sink,
            )
            return "", structured["message"], structured
        command = ["/bin/bash", str(runner_path)] if runtime == "bash" else [str(runtime_python), str(runner_path)]
        cwd = str(skill_dir if runtime == "bash" else run_dir)
        if is_cancelled and is_cancelled():
            raise GeneralSkillExecutionCancelled("General skill execution cancelled.")
        try:
            result = run_sandboxed_process(
                # The runner and materialized package share one workspace.
                workspace=run_dir,
                argv=command,
                stdin_json=stdin_payload,
                stdin_path_keys=("skill_workspace", "artifact_dir"),
                cwd=Path(cwd),
                timeout_seconds=_run_timeout_seconds(skill),
                output_limit=MAX_OUTPUT_CHARS * 4,
                env=env,
                env_path_keys=("SKILL_WORKSPACE", "ARTIFACT_DIR"),
                network_mode=sandbox_network_mode,
                allowed_domains=sandbox_allowed_domains,
                sandbox_enabled=sandbox_enabled,
                is_cancelled=is_cancelled,
            )
        except HarnessExecutionError as exc:
            if exc.error.code == "SANDBOX_EXECUTION_CANCELLED":
                raise GeneralSkillExecutionCancelled(str(exc)) from exc
            raise
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        timed_out = result.timed_out
        if stdout:
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "stdout_chunk",
                    params={"attempt": attempt},
                    raw_stdout=stdout,
                ),
                event_sink,
            )
        if stderr:
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "stderr_chunk",
                    params={"attempt": attempt},
                    raw_stderr=stderr,
                ),
                event_sink,
            )

        if timed_out:
            stdout = _truncate(stdout)
            stderr = _truncate(stderr)
            structured = {"success": False, "error": "runner_timeout", "message": "通用技能运行超时"}
            _emit(
                trace,
                build_general_skill_trace_payload(
                    "code_timeout",
                    params={"attempt": attempt, "runtime": runtime},
                    raw_stdout=stdout[:600],
                    raw_stderr=stderr[:600],
                    raw_structured_result=structured,
                ),
                event_sink,
            )
            return stdout, stderr, structured

        return_code = result.returncode
        stdout = _truncate(stdout)
        stderr = _truncate(stderr)
        structured = _parse_stdout_json(stdout)
        _normalize_declared_artifacts(
            structured,
            artifact_root=artifact_dir,
            workspace_root=workspace_root,
        )
        if workspace_root is not None:
            # 供 invoker 在产物未声明时自动扫描补登(工作区相对路径);
            # 强制覆盖:模型在输出 JSON 里自报的 artifact_dir 不可信,不得劫持扫描目录
            structured["artifact_dir"] = artifact_dir.relative_to(workspace_root).as_posix()
        if return_code != 0:
            structured.setdefault("success", False)
            structured.setdefault("error", f"runner exited with code {return_code}")
        _emit(
            trace,
            build_general_skill_trace_payload(
                "code_finished",
                params={
                    "attempt": attempt,
                    "runtime": runtime,
                    "return_code": return_code,
                },
                raw_stdout=stdout[:600],
                raw_stderr=stderr[:600],
                raw_structured_result=structured,
            ),
            event_sink,
        )
        return stdout, stderr, structured

    def _generate_reply(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        trace: list[dict[str, Any]],
        stdout: str,
        stderr: str,
        structured_result: dict[str, Any],
        event_sink: TraceSink | None = None,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> str:
        """Generate final Skill prose in reply locale while retaining execution output verbatim."""
        _emit(trace, build_general_skill_trace_payload("replying"), event_sink)
        stage_data = {
            **_general_skill_language_contract(
                language_context,
                RawSourceMarker(
                    json_pointer="/execution_trace",
                    kind=RawSourceKind.DIAGNOSTIC,
                ),
                RawSourceMarker(
                    json_pointer="/stdout",
                    kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
                ),
                RawSourceMarker(
                    json_pointer="/stderr",
                    kind=RawSourceKind.DIAGNOSTIC,
                ),
                RawSourceMarker(
                    json_pointer="/structured_result",
                    kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
                ),
            ),
            "skill": {
                "slug": skill.slug,
                "name": skill.name,
                "description": skill.description,
            },
            "execution_trace": trace,
            "stdout": stdout,
            "stderr": stderr,
            "structured_result": structured_result,
        }
        payload = stage_payload(
            phase="Response Generator / General Skill Reply",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=REPLY_PROMPT.read_text(encoding="utf-8"),
            stage_data=stage_data,
            output_contract=GENERAL_SKILL_REPLY_OUTPUT,
        )
        try:
            with llm_operation("general_skill.reply"):
                raw = LLMClient(model_config).generate_json(
                    unified_system_prompt(), payload
                )
            reply = GeneralSkillReply.model_validate(raw).reply.strip()
        except LLMError:
            raise
        except Exception as exc:
            raise LLMError(f"General skill reply returned invalid JSON schema: {exc}") from exc
        if not reply:
            raise LLMError("General skill reply is empty")
        _emit(trace, build_general_skill_trace_payload("reply_created"), event_sink)
        return reply

    def _review_execution_result(
        self,
        skill: GeneralSkill,
        query: str,
        model_config: ModelConfig,
        plan: GeneralSkillExecutionPlan,
        stdout: str,
        stderr: str,
        structured_result: dict[str, Any],
        trace: list[dict[str, Any]],
        event_sink: TraceSink | None,
        attempt: int,
        conversation_context: dict[str, object] | None = None,
        memory_context: list[dict[str, object]] | None = None,
        language_context: LanguageContext | None = None,
    ) -> dict[str, Any]:
        """Review raw execution evidence under the same immutable language snapshot."""
        _emit(
            trace,
            build_general_skill_trace_payload(
                "reflection_reviewing",
                params={"attempt": attempt},
            ),
            event_sink,
        )
        stage_data = {
            **_general_skill_language_contract(
                language_context,
                RawSourceMarker(
                    json_pointer="/runner",
                    kind=RawSourceKind.DIAGNOSTIC,
                ),
                RawSourceMarker(
                    json_pointer="/stdout",
                    kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
                ),
                RawSourceMarker(
                    json_pointer="/stderr",
                    kind=RawSourceKind.DIAGNOSTIC,
                ),
                RawSourceMarker(
                    json_pointer="/structured_result",
                    kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
                ),
            ),
            "skill": {
                "slug": skill.slug,
                "name": skill.name,
                "description": skill.description,
                "homepage": skill.homepage,
                "markdown": _truncate(skill.skill_markdown, 6000),
                "package": _skill_package_payload(skill, preview_limit=6000),
            },
            "runner": {
                "rationale": plan.rationale,
                "expected_output": plan.expected_output,
                "code_preview": _truncate(plan.code, 6000),
            },
            "attempt": attempt,
            "stdout": _truncate(stdout),
            "stderr": _truncate(stderr),
            "structured_result": structured_result,
        }
        payload = stage_payload(
            phase="Reflection / General Skill Review",
            user_message=query,
            conversation_context=conversation_context,
            memory_context=memory_context,
            instructions=REVIEW_PROMPT.read_text(encoding="utf-8"),
            stage_data=stage_data,
            output_contract=GENERAL_SKILL_REVIEW_OUTPUT,
        )
        try:
            with llm_operation("general_skill.review", attempt=attempt):
                raw = LLMClient(model_config).generate_json(
                    unified_system_prompt(), payload
                )
            review = GeneralSkillExecutionReview.model_validate(raw).model_dump(mode="json")
        except Exception as exc:
            fallback_needs_retry = _execution_needs_retry(stdout, stderr, structured_result)
            review = {
                "result_sufficient": not fallback_needs_retry,
                "needs_retry": fallback_needs_retry,
                "terminal": False,
                "reason": f"模型校验失败，使用运行信号兜底判断：{exc}",
                "repair_hint": "补充运行诊断或调整 runner 输出结构",
            }
        if review.get("terminal") is True:
            review["needs_retry"] = False
        _emit(
            trace,
            build_general_skill_trace_payload(
                "reflection_reviewed",
                params={"attempt": attempt},
                raw_review=review,
            ),
            event_sink,
        )
        return review


def _truncate(value: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n...<truncated>"


def _plan_runtime(plan: GeneralSkillExecutionPlan) -> str:
    runtime = str(getattr(plan, "runtime", "") or "python").strip().lower()
    if runtime in {"bash", "shell", "sh"}:
        return "bash"
    return "python"


def _runtime_label(runtime: str) -> str:
    return "Bash" if runtime == "bash" else "Python"


def _skill_files(skill: GeneralSkill) -> list[dict[str, Any]]:
    raw_files = getattr(skill, "skill_files_json", None)
    files = (
        raw_files
        if isinstance(raw_files, Sequence) and not isinstance(raw_files, (str, bytes))
        else []
    )
    normalized: list[dict[str, Any]] = []
    for raw_file in files:
        if not isinstance(raw_file, Mapping):
            continue
        path = _safe_package_path(str(raw_file.get("path") or ""))
        content = str(raw_file.get("content") or "")
        if not path:
            continue
        normalized.append(
            {
                "path": path,
                "content": content,
                "size": int(raw_file.get("size") or len(content.encode("utf-8"))),
                "mime_type": raw_file.get("mime_type"),
            }
        )
    if normalized:
        return normalized
    markdown = str(getattr(skill, "skill_markdown", "") or "")
    return [{"path": "SKILL.md", "content": markdown, "size": len(markdown.encode("utf-8")), "mime_type": "text/markdown"}]


def _skill_package_payload(skill: GeneralSkill, preview_limit: int = 12000) -> dict[str, Any]:
    files = _skill_files(skill)
    previews: list[dict[str, Any]] = []
    remaining = preview_limit
    for file in files:
        content = str(file.get("content") or "")
        preview = content[: max(0, min(len(content), remaining))]
        remaining -= len(preview)
        previews.append(
            {
                "path": file["path"],
                "size": file.get("size"),
                "mime_type": file.get("mime_type"),
                "content_preview": preview,
                "truncated": len(preview) < len(content),
            }
        )
    return {
        "entrypoint": "SKILL.md",
        "file_count": len(files),
        "files": previews,
    }


def _materialize_skill_package(skill: GeneralSkill, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    metadata = getattr(skill, "metadata_json", None)
    directory_values = metadata.get("skill_directories", []) if isinstance(metadata, Mapping) else []
    if isinstance(directory_values, Sequence) and not isinstance(directory_values, (str, bytes)):
        for value in directory_values:
            relative_path = _safe_package_path(str(value or ""))
            if relative_path:
                (target_dir / relative_path).mkdir(parents=True, exist_ok=True)
    for file in _skill_files(skill):
        relative_path = _safe_package_path(str(file["path"]))
        output_path = target_dir / relative_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(str(file.get("content") or ""), encoding="utf-8")


def _safe_package_path(path: str) -> str:
    cleaned = path.replace("\\", "/").strip().strip("/")
    parts = [part for part in cleaned.split("/") if part and part != "."]
    if not parts or any(part == ".." for part in parts):
        return ""
    return "/".join(parts)


def _safe_artifact_text(value: Any, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = "".join(
        character
        for character in str(value).strip()
        if ord(character) >= 32 and ord(character) != 127
    )
    return cleaned[:max_length] or None


def _parse_stdout_json(stdout: str) -> dict[str, Any]:
    stripped = stdout.strip()
    if not stripped:
        return {"success": False, "message": "runner produced no stdout"}
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return value
        return {"success": True, "data": value}
    except json.JSONDecodeError:
        return {"success": True, "text": stripped}


def _normalize_declared_artifacts(
    structured: dict[str, Any],
    *,
    artifact_root: Path,
    workspace_root: Path | None,
) -> None:
    declarations = structured.get("artifacts")
    if declarations is None:
        return
    declaration_errors: list[dict[str, str]] = []
    if not isinstance(declarations, list) or workspace_root is None:
        structured["artifacts"] = []
        structured["artifact_errors"] = [
            {
                "path": "",
                "code": "artifact_declaration_invalid",
                "message": "artifacts 必须是当前运行目录下的相对路径列表。",
            }
        ]
        return
    normalized: list[dict[str, Any]] = []
    for declaration in declarations[:MAX_DECLARED_ARTIFACTS]:
        raw_path = declaration.get("path") if isinstance(declaration, Mapping) else declaration
        try:
            relative = normalize_harness_artifact_path(str(raw_path or ""))
            task_relative = (artifact_root / relative).relative_to(workspace_root).as_posix()
            item: dict[str, Any] = {"path": task_relative}
            if isinstance(declaration, Mapping):
                display_name = _safe_artifact_text(declaration.get("display_name"), 180)
                description = _safe_artifact_text(declaration.get("description"), 500)
                if display_name:
                    item["display_name"] = display_name
                if description:
                    item["description"] = description
            normalized.append(item)
        except (HarnessArtifactAccessError, ValueError):
            declaration_errors.append(
                {
                    "path": str(raw_path or ""),
                    "code": "artifact_declaration_invalid",
                    "message": "产物路径必须位于当前运行目录，且只能使用相对路径。",
                }
            )
    if len(declarations) > MAX_DECLARED_ARTIFACTS:
        declaration_errors.append(
            {
                "path": "",
                "code": "artifact_declaration_limit_exceeded",
                "message": f"产物声明最多允许 {MAX_DECLARED_ARTIFACTS} 个文件。",
            }
        )
    structured["artifacts"] = normalized
    if declaration_errors:
        structured["artifact_errors"] = declaration_errors


def _run_timeout_seconds(skill: GeneralSkill) -> float:
    runtime_config = getattr(skill, "runtime_config_json", None)
    config = runtime_config if isinstance(runtime_config, Mapping) else {}
    try:
        timeout = float(config.get("timeout_seconds") or RUN_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = float(RUN_TIMEOUT_SECONDS)
    return max(1.0, min(timeout, 120.0))


def _raise_if_cancelled(
    is_cancelled: CancellationCheck | None,
    *,
    process: subprocess.Popen[bytes] | None = None,
) -> None:
    if not callable(is_cancelled) or not is_cancelled():
        return
    if process is not None and process.poll() is None:
        process.kill()
    raise GeneralSkillExecutionCancelled("General skill execution was cancelled.")


def _stream_process_output_selectors(
    process: subprocess.Popen[bytes],
    trace: list[dict[str, Any]],
    event_sink: TraceSink | None,
    attempt: int,
    timeout_seconds: float = RUN_TIMEOUT_SECONDS,
    is_cancelled: CancellationCheck | None = None,
) -> tuple[str, str, bool]:
    selector = selectors.DefaultSelector()
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    streams: list[tuple[Any, str]] = []
    if process.stdout:
        streams.append((process.stdout, "stdout"))
    if process.stderr:
        streams.append((process.stderr, "stderr"))
    for stream, name in streams:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, data=name)

    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    try:
        while selector.get_map():
            _raise_if_cancelled(is_cancelled, process=process)
            if time.monotonic() > deadline:
                timed_out = True
                process.kill()
                break
            events = selector.select(timeout=0.1)
            if not events and process.poll() is not None:
                events = [(key, selectors.EVENT_READ) for key in list(selector.get_map().values())]
            for key, _ in events:
                name = str(key.data)
                try:
                    chunk = os.read(key.fileobj.fileno(), 4096)
                except BlockingIOError:
                    continue
                if not chunk:
                    try:
                        selector.unregister(key.fileobj)
                    except KeyError:
                        pass
                    continue
                text = chunk.decode("utf-8", errors="replace")
                if name == "stdout":
                    stdout_parts.append(text)
                    phase = "stdout_chunk"
                else:
                    stderr_parts.append(text)
                    phase = "stderr_chunk"
                _emit(
                    trace,
                    build_general_skill_trace_payload(
                        phase,
                        params={"attempt": attempt},
                        **{"raw_stdout": text}
                        if phase == "stdout_chunk"
                        else {"raw_stderr": text},
                    ),
                    event_sink,
                )
    finally:
        selector.close()
    return "".join(stdout_parts), "".join(stderr_parts), timed_out


def _use_thread_reader() -> bool:
    return sys.platform == "win32"


def _stream_process_output(
    process,
    trace,
    event_sink,
    attempt,
    timeout_seconds=RUN_TIMEOUT_SECONDS,
    is_cancelled=None,
):
    if _use_thread_reader():
        return _stream_process_output_threaded(
            process,
            trace,
            event_sink,
            attempt,
            timeout_seconds,
            is_cancelled,
        )
    return _stream_process_output_selectors(
        process,
        trace,
        event_sink,
        attempt,
        timeout_seconds,
        is_cancelled,
    )


def _stream_process_output_threaded(
    process,
    trace,
    event_sink,
    attempt,
    timeout_seconds=RUN_TIMEOUT_SECONDS,
    is_cancelled=None,
):
    q: queue.Queue[tuple[str, bytes]] = queue.Queue()
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    def _reader(stream, name: str) -> None:
        try:
            for chunk in iter(lambda: stream.read(4096), b""):
                q.put((name, chunk))
        finally:
            q.put((name, b""))  # EOF 标记

    stream_map = [(process.stdout, "stdout"), (process.stderr, "stderr")]
    threads: list[threading.Thread] = []
    for stream, name in stream_map:
        if stream is None:
            continue
        t = threading.Thread(target=_reader, args=(stream, name), daemon=True)
        t.start()
        threads.append(t)

    open_streams = sum(1 for s, _ in stream_map if s is not None)
    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    eof_count = 0
    while eof_count < open_streams:
        _raise_if_cancelled(is_cancelled, process=process)
        if time.monotonic() > deadline:
            timed_out = True
            process.kill()
            break
        try:
            name, chunk = q.get(timeout=0.1)
        except queue.Empty:
            continue
        if chunk == b"":
            eof_count += 1
            continue
        text = chunk.decode("utf-8", errors="replace")
        if name == "stdout":
            stdout_parts.append(text)
            phase = "stdout_chunk"
        else:
            stderr_parts.append(text)
            phase = "stderr_chunk"
        _emit(
            trace,
            build_general_skill_trace_payload(
                phase,
                params={"attempt": attempt},
                **{"raw_stdout": text}
                if phase == "stdout_chunk"
                else {"raw_stderr": text},
            ),
            event_sink,
        )

    for t in threads:
        t.join(timeout=1.0)
    return "".join(stdout_parts), "".join(stderr_parts), timed_out


def _bash_supported() -> bool:
    if sys.platform == "win32":
        return False
    if paths.is_frozen():
        return False
    return Path("/bin/bash").exists()


def _emit(
    trace: list[dict[str, Any]],
    item: Mapping[str, Any],
    event_sink: TraceSink | None = None,
) -> None:
    """Append and stream one canonical Skill trace descriptor."""
    payload = canonical_general_skill_trace_payload(item)
    trace.append(payload)
    if event_sink:
        event_sink(payload)


def _execution_needs_retry(stdout: str, stderr: str, structured_result: dict[str, Any]) -> bool:
    if structured_result.get("success") is False:
        if structured_result.get("retryable") is False or structured_result.get("terminal") is True:
            return False
        return True
    if structured_result.get("error") or structured_result.get("error_code"):
        return True
    if stderr.strip():
        return True
    if not stdout.strip():
        return True
    return False


def _normalize_failure_diagnostics(structured_result: dict[str, Any]) -> None:
    if structured_result.get("success") is not False:
        return
    diagnostic_keys = {
        "diagnostics",
        "attempted_urls",
        "status_code",
        "exception",
        "exception_type",
        "response_preview",
        "parse_strategy",
    }
    if any(key in structured_result for key in diagnostic_keys):
        return
    structured_result.setdefault("diagnostics_missing", True)
    structured_result.setdefault(
        "diagnostics_required",
        [
            "attempted_urls",
            "status_code",
            "exception_type",
            "exception_message",
            "response_preview",
            "parse_strategy",
            "retryable",
        ],
    )


def _fallback_reply(
    structured_result: dict[str, Any],
    language_context: LanguageContext | None = None,
) -> str:
    """Return a locale-bound safe fallback without projecting raw runner diagnostics."""
    if structured_result.get("success") is False:
        return localized_compat_text(
            language_context,
            zh_cn="抱歉，通用技能运行失败。",
            en_us="Sorry, the Skill run failed.",
        )
    return localized_compat_text(
        language_context,
        zh_cn="通用技能已运行完成，结果已展示在运行输出中。",
        en_us="The Skill run completed and its result is available in the run output.",
    )

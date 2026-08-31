from __future__ import annotations

import json
import logging
from collections.abc import Callable
from threading import Lock
from typing import Any

from sqlmodel import Session

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor
from app.contracts.event_registry import (
    EVENT_REGISTRY,
    EventContractViolation,
    EventRegistry,
)
from app.contracts.events import EventVisibility, SystemEvent
from app.db.models import AgentEvent
from app.i18n.language_context import LanguageContext

logger = logging.getLogger(__name__)

LEGACY_EVENT_BOUNDARY = "LEGACY-BE-TEXT-EVENT"
"""Stable boundary identifier for the temporary raw event compatibility adapter."""

# This is deliberately an exact set.  New event names must use ``record_system_event``;
# adding a value here is a reviewed migration step, not a prefix-based compatibility rule.
_LEGACY_EVENT_ALLOWLIST = frozenset(
    {
        "agent_loop_completed",
        "agent_loop_continued",
        "assistant_message_created",
        "async_job_enqueued",
        "error_occurred",
        "general_skill_run_finished",
        "general_skill_trace",
        "graph_pending_steps_updated",
        "capability_described",
        "capability_search_completed",
        "harness_action_created",
        "harness_action_failed",
        "harness_action_repair_requested",
        "harness_action_sequence_accepted",
        "harness_completion_blocked",
        "harness_mcp_app_view",
        "harness_step_continuation_deferred",
        "harness_step_timeout",
        "harness_structured_result_adapted",
        "harness_tool_completed",
        "human_handoff_requested",
        "knowledge_result",
        "knowledge_query_finished",
        "knowledge_query_started",
        "memory_recalled",
        "reflection_decision",
        "router_decision_created",
        "session_state_changed",
        "skill_action",
        "skill_completed",
        "skill_resumed",
        "skill_started",
        "skill_state",
        "skill_state_pruned",
        "skill_step_changed",
        "slot_updated",
        "slots_hydrated",
        "step_agent_result_created",
        "step_agent_result_repaired",
        "step_result",
        "stream_delta",
        "stream_end",
        "stream_replace",
        "stream_status",
        "task_frame_completed",
        "task_frame_dependencies_released",
        "task_frame_dependency_waiting",
        "task_frame_finished",
        "task_frame_started",
        "tool_result",
        "turn_action_budget_exhausted",
        "turn_plan_created",
        "turn_rejected",
        "user_message_received",
    }
)

# Raw business text is allowed only for named success/output fields.  The mapping is
# also the machine-readable marker for the compatibility window; it is intentionally not
# inferred from arbitrary key names such as ``message`` or ``text``.
LEGACY_RAW_EVENT_FIELDS: dict[str, frozenset[str]] = {
    "assistant_message_created": frozenset({"reply"}),
    "general_skill_run_finished": frozenset({"reply", "task_summary"}),
    "general_skill_trace": frozenset({"reply", "content", "output"}),
    "memory_recalled": frozenset({"memories"}),
    "step_agent_result_created": frozenset({"reply"}),
    "step_result": frozenset({"reply", "content", "task_summary"}),
    "stream_delta": frozenset({"content"}),
    "stream_replace": frozenset({"content"}),
    "stream_status": frozenset({"text"}),
    "task_frame_finished": frozenset({"task_summary"}),
    "user_message_received": frozenset({"message"}),
}

_LEGACY_ERROR_FIELDS = frozenset({"error", "error_json"})
_LEGACY_CODE_PATTERN = r"^[A-Z][A-Z0-9_.-]{2,127}$"
_legacy_event_usage_lock = Lock()
_legacy_event_usage = {"hits": 0, "rejected": 0}


def reset_legacy_event_usage() -> None:
    """Reset process-local compatibility counters for tests and controlled migration checks."""
    with _legacy_event_usage_lock:
        _legacy_event_usage.update(hits=0, rejected=0)


def get_legacy_event_usage() -> dict[str, Any]:
    """Return immutable migration telemetry and explicit conditions for removing the adapter."""
    with _legacy_event_usage_lock:
        counters = dict(_legacy_event_usage)
    return {
        "boundary": LEGACY_EVENT_BOUNDARY,
        **counters,
        "allowlist": tuple(sorted(_LEGACY_EVENT_ALLOWLIST)),
        "raw_fields": {
            event_type: tuple(sorted(fields))
            for event_type, fields in sorted(LEGACY_RAW_EVENT_FIELDS.items())
        },
        "removal_conditions": (
            "all production producers call record_system_event",
            "hits remains zero for one complete compatibility observation window",
            "public stream/replay consumers pass canonical event contract checks",
        ),
    }


# A short alias keeps migration dashboards easy to discover without exposing mutable state.
legacy_event_usage = get_legacy_event_usage


def _is_code_like(value: object) -> bool:
    """Return whether a legacy semantic code has the registry's stable identifier shape."""
    import re

    return isinstance(value, str) and re.fullmatch(_LEGACY_CODE_PATTERN, value) is not None


def _normalize_legacy_error(value: object, *, event_type: str, field: str) -> dict[str, Any]:
    """Project a legacy error to a registry-shaped descriptor without preserving prose."""
    if not isinstance(value, dict):
        raise EventContractViolation(
            f"{LEGACY_EVENT_BOUNDARY} {event_type}.{field} must be a structured error"
        )
    code = value.get("code")
    entry = ERROR_REGISTRY.get(code) if _is_code_like(code) else None
    params = value.get("params", {})
    if not isinstance(params, dict):
        params = {}
    retryable = value.get(
        "retryable",
        entry.retryable_default if entry is not None else False,
    )
    if not isinstance(retryable, bool):
        retryable = entry.retryable_default if entry is not None else False
    if entry is None:
        return {
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": None,
            "trace_id": None,
        }
    descriptor = ErrorDescriptor(
        code=entry.code,
        params=params,
        retryable=retryable,
        request_id=value.get("request_id")
        if isinstance(value.get("request_id"), str)
        else None,
        trace_id=value.get("trace_id")
        if isinstance(value.get("trace_id"), str)
        else None,
    )
    try:
        ERROR_REGISTRY.validate(
            # Registry validation is deliberately performed before accepting a
            # legacy descriptor, but malformed metadata still fails closed below.
            descriptor
        )
    except (EventContractViolation, ValueError, TypeError):
        return {
            "code": "INTERNAL_ERROR",
            "params": {},
            "retryable": False,
            "request_id": None,
            "trace_id": None,
        }
    return descriptor.model_dump(mode="json")


def _sanitize_legacy_error_fields(value: object, *, event_type: str, field: str = "payload") -> object:
    """Recursively replace nested legacy error objects while preserving success content verbatim."""
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, child in value.items():
            if key in _LEGACY_ERROR_FIELDS:
                if isinstance(child, dict):
                    sanitized[key] = _normalize_legacy_error(
                        child,
                        event_type=event_type,
                        field=key,
                    )
                elif field == "payload":
                    raise EventContractViolation(
                        f"{LEGACY_EVENT_BOUNDARY} {event_type}.{key} must be a structured error"
                    )
                else:
                    sanitized[key] = _normalize_legacy_error(
                        {},
                        event_type=event_type,
                        field=key,
                    )
            else:
                sanitized[key] = _sanitize_legacy_error_fields(
                    child,
                    event_type=event_type,
                    field=key,
                )
        return sanitized
    if isinstance(value, list):
        return [
            _sanitize_legacy_error_fields(item, event_type=event_type, field=field)
            for item in value
        ]
    return value


def _validate_legacy_payload(event_type: str, payload: object) -> dict[str, Any]:
    """Validate one exact legacy event shape before it reaches the database or sink."""
    if event_type not in _LEGACY_EVENT_ALLOWLIST:
        raise EventContractViolation(
            f"{LEGACY_EVENT_BOUNDARY} event type is not allowlisted: {event_type}"
        )
    if not isinstance(payload, dict):
        raise EventContractViolation(
            f"{LEGACY_EVENT_BOUNDARY} payload must be a JSON object"
        )
    try:
        json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise EventContractViolation(
            f"{LEGACY_EVENT_BOUNDARY} payload must contain JSON values"
        ) from exc
    for field in _LEGACY_ERROR_FIELDS.intersection(payload):
        # Top-level string errors are ambiguous natural-language diagnostics.  Reject
        # rather than silently persisting the value under a legacy event name.
        if not isinstance(payload[field], dict):
            raise EventContractViolation(
                f"{LEGACY_EVENT_BOUNDARY} {event_type}.{field} must be a structured error"
            )
    payload = _sanitize_legacy_error_fields(payload, event_type=event_type)
    if event_type in {"error_occurred", "turn_rejected"}:
        message = payload.get("message")
        if message is not None and not _is_code_like(message):
            raise EventContractViolation(
                f"{LEGACY_EVENT_BOUNDARY} {event_type}.message must be a semantic code"
            )
    return payload


def _count_legacy_event(*, accepted: bool) -> None:
    """Count compatibility adapter decisions without making telemetry persistence part of the event write."""
    with _legacy_event_usage_lock:
        _legacy_event_usage["hits" if accepted else "rejected"] += 1


class EventLog:
    def __init__(
        self,
        db: Session,
        *,
        event_sink: Callable[[str, dict[str, Any]], None] | None = None,
        event_registry: EventRegistry | None = None,
    ):
        """Bind persistence, an optional sink, and the product-event registry without writing data."""
        self.db = db
        self._event_sink = event_sink
        self._event_registry = event_registry or EVENT_REGISTRY
        self._turn_id: str | None = None
        self._client_turn_id: str | None = None
        self._language_context: LanguageContext | None = None

    def bind_turn(
        self,
        turn_id: str,
        client_turn_id: str | None = None,
        *,
        language_context: LanguageContext | None = None,
    ) -> None:
        """Bind turn correlation and an immutable language snapshot for later event writes."""
        self._turn_id = str(turn_id or "").strip() or None
        self._client_turn_id = str(client_turn_id or "").strip() or None
        if language_context is not None:
            self._language_context = language_context

    def record(
        self,
        tenant_id: str,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        raw_fields: set[str] | frozenset[str] | None = None,
    ) -> AgentEvent:
        """Write one allowlisted legacy event while counting its removal-boundary usage.

        ``record_system_event`` is the required path for new product events.  This method
        remains only for the exact compatibility set above; malformed or unknown inputs
        fail before staging a database row or notifying the sink.
        """
        try:
            traced_payload = _validate_legacy_payload(event_type, payload)
        except EventContractViolation:
            _count_legacy_event(accepted=False)
            raise
        if raw_fields is not None:
            requested_raw_fields = set(raw_fields)
            declared_raw_fields = LEGACY_RAW_EVENT_FIELDS.get(event_type, frozenset())
            if not requested_raw_fields.issubset(declared_raw_fields):
                _count_legacy_event(accepted=False)
                raise EventContractViolation(
                    f"{LEGACY_EVENT_BOUNDARY} raw fields are not allowlisted for {event_type}"
                )
            traced_payload.setdefault(
                "raw_source_fields",
                sorted(requested_raw_fields),
            )
        if self._turn_id:
            traced_payload.setdefault("turn_id", self._turn_id)
            traced_payload.setdefault("user_message_id", self._turn_id)
        if self._client_turn_id:
            traced_payload.setdefault("client_turn_id", self._client_turn_id)
        if self._language_context is not None:
            traced_payload.setdefault(
                "language_context", self._language_context.model_dump(mode="json")
            )
        event = AgentEvent(
            tenant_id=tenant_id,
            session_id=session_id,
            event_type=event_type,
            payload_json=traced_payload,
        )
        _count_legacy_event(accepted=True)
        self._store_and_notify(event, event_type, traced_payload)
        return event

    def record_legacy_event(
        self,
        tenant_id: str,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        raw_fields: set[str] | frozenset[str] | None = None,
    ) -> AgentEvent:
        """Write one explicitly named compatibility event through the guarded legacy adapter.

        This method is the only producer-facing compatibility entry point during the
        migration.  It preserves the exact allowlist, nested error projection, raw-success
        markers, correlation fields, and process-local usage counters implemented by
        :meth:`record`; unregistered or malformed payloads still fail before persistence.
        """
        return self.record(
            tenant_id,
            session_id,
            event_type,
            payload,
            raw_fields=raw_fields,
        )

    def record_system_event(self, product_event: SystemEvent) -> AgentEvent:
        """Validate and persist one canonical event, then emit its bounded legacy projection."""
        # Add bound correlation only when the producer did not already provide immutable turn IDs.
        updates: dict[str, Any] = {}
        if self._turn_id and not product_event.turn_id:
            updates["turn_id"] = self._turn_id
        if self._client_turn_id and not product_event.client_turn_id:
            updates["client_turn_id"] = self._client_turn_id
        if self._language_context is not None and not product_event.language_context:
            updates["language_context"] = self._language_context
        traced_event = product_event.model_copy(update=updates) if updates else product_event

        # Validate before serialization so unregistered or unsafe params never reach storage or sinks.
        validated_event = self._event_registry.validate(traced_event)
        registry_entry = self._event_registry.require(validated_event.event_code)
        event_type = registry_entry.legacy_event_type or validated_event.event_code
        payload = validated_event.model_dump(mode="json")
        event = AgentEvent(
            tenant_id=validated_event.tenant_id,
            session_id=validated_event.aggregate_id,
            event_type=event_type,
            payload_json=payload,
        )
        self._store_and_notify(
            event,
            event_type,
            payload,
            notify_sink=validated_event.visibility is EventVisibility.PUBLIC,
        )
        return event

    def _store_and_notify(
        self,
        event: AgentEvent,
        event_type: str,
        payload: dict[str, Any],
        *,
        notify_sink: bool = True,
    ) -> None:
        """Stage one event and conditionally notify the product sink without propagating sink faults."""
        self.db.add(event)
        if notify_sink and self._event_sink is not None:
            try:
                self._event_sink(event_type, payload)
            except Exception:
                logger.exception("event_sink 调用失败 event_type=%s", event_type)

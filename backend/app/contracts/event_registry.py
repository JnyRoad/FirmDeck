"""Registry and safe-parameter validation for versioned product event codes."""

from __future__ import annotations

from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.contracts.errors import JsonValue
from app.contracts.events import EventVisibility, SystemEvent

EventParamKind: TypeAlias = Literal["string", "integer", "number", "boolean"]


class EventContractViolation(ValueError):
    """Report an unregistered or schema-incompatible product event."""


class EventRegistryEntry(BaseModel):
    """Define one event's localization, safe params, visibility, and legacy projection."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    event_code: str = Field(pattern=r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$")
    message_key: str | None = None
    params_schema: dict[str, EventParamKind] = Field(default_factory=dict)
    visibility: EventVisibility
    legacy_event_type: str | None = None
    raw_source_allowed: bool = False
    requires_language_context: bool = False

    @field_validator("message_key")
    @classmethod
    def validate_message_key(cls, value: str | None) -> str | None:
        """Require semantic identifiers for localized event messages, never natural-language prose."""
        import re

        if value is not None and not re.fullmatch(
            r"[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,}", value
        ):
            raise ValueError("message_key must be a stable semantic identifier")
        return value


def _matches_kind(value: JsonValue, kind: EventParamKind) -> bool:
    """Validate one primitive JSON param without accepting bool as a numeric value."""
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class EventRegistry:
    """Own event metadata and fail closed when a producer violates its registered shape."""

    def __init__(self) -> None:
        """Create an empty in-memory registry with no database or process-global mutation."""
        self._entries: dict[str, EventRegistryEntry] = {}

    def register(self, entry: EventRegistryEntry) -> None:
        """Register one localized event contract and reject unlocalizable public producers."""
        if (
            entry.visibility is EventVisibility.PUBLIC
            and not entry.raw_source_allowed
            and not entry.message_key
        ):
            raise EventContractViolation(
                f"public non-raw event requires message_key: {entry.event_code}"
            )
        if entry.event_code in self._entries:
            raise EventContractViolation(f"event code already registered: {entry.event_code}")
        self._entries[entry.event_code] = entry

    def get(self, event_code: str) -> EventRegistryEntry | None:
        """Return registered metadata without creating a fallback or changing registry state."""
        return self._entries.get(event_code)

    def require(self, event_code: str) -> EventRegistryEntry:
        """Return a known event entry or raise a stable contract violation."""
        entry = self.get(event_code)
        if entry is None:
            raise EventContractViolation(f"unregistered event code: {event_code}")
        return entry

    def validate(self, event: SystemEvent) -> SystemEvent:
        """Validate visibility, exact safe params, primitive kinds, and required language context."""
        entry = self.require(event.event_code)
        if event.visibility is not entry.visibility:
            raise EventContractViolation(f"{event.event_code} visibility does not match registry")
        if entry.requires_language_context and not event.language_context:
            raise EventContractViolation(f"{event.event_code} requires language_context")

        expected_names = set(entry.params_schema)
        actual_names = set(event.params)
        missing = sorted(expected_names - actual_names)
        unexpected = sorted(actual_names - expected_names)
        if missing:
            raise EventContractViolation(
                f"{event.event_code} missing params: {', '.join(missing)}"
            )
        if unexpected:
            raise EventContractViolation(
                f"{event.event_code} unexpected params: {', '.join(unexpected)}"
            )
        for name, kind in entry.params_schema.items():
            if not _matches_kind(event.params[name], kind):
                raise EventContractViolation(
                    f"{event.event_code} param {name} must be {kind}"
                )
        return event

    def entries(self) -> tuple[EventRegistryEntry, ...]:
        """Return an immutable deterministic snapshot for governance coverage checks."""
        return tuple(self._entries[code] for code in sorted(self._entries))


EVENT_REGISTRY = EventRegistry()


# The public job event set is deliberately declared here, next to the canonical event registry.
# Producers import these immutable definitions instead of registering events from decorator order.
PUBLIC_JOB_EVENT_TYPES: tuple[str, ...] = (
    "job.cancel_requested",
    "job.queued",
    "knowledge.ingest.cancelled",
    "knowledge.ingest.entry.started",
    "knowledge.ingest.failed",
    "knowledge.ingest.started",
    "knowledge.ingest.succeeded",
    "run.action.failed",
    "run.action.started",
    "run.cancelled",
    "run.capability.completed",
    "run.capability.described",
    "run.capability.search",
    "run.citation",
    "run.executing",
    "run.failed",
    "run.intent",
    "run.loop.completed",
    "run.loop.continued",
    "run.output.completed",
    "run.output.delta",
    "run.output.replace",
    "run.plan",
    "run.skill.completed",
    "run.skill.trace",
    "run.sop.state",
    "run.sop.step",
    "run.sop.step.timeout",
    "run.started",
    "run.status",
    "run.succeeded",
    "run.task_frame.completed",
    "run.task_frame.finished",
    "run.task_frame.released",
    "run.task_frame.started",
    "run.task_frame.waiting",
    "run.tool.completed",
    "sop.generate.cancelled",
    "sop.generate.failed",
    "sop.generate.learning",
    "sop.generate.started",
    "sop.generate.succeeded",
    "sop.rewrite.cancelled",
    "sop.rewrite.failed",
    "sop.rewrite.rewriting",
    "sop.rewrite.started",
    "sop.rewrite.succeeded",
)

RAW_SOURCE_EVENT_TYPES = frozenset(
    {"run.output.completed", "run.output.delta", "run.output.replace"}
)

JOB_EVENT_PARAMS: dict[str, dict[str, EventParamKind]] = {
    "job.cancel_requested": {"job_id": "string"},
    "job.queued": {"job_id": "string", "kind": "string"},
    "knowledge.ingest.entry.started": {"index": "integer"},
    "run.executing": {"session_id": "string", "engine": "string"},
    "run.failed": {"job_id": "string", "error_code": "string", "retryable": "boolean"},
    "run.intent": {"decision": "string"},
    "run.plan": {"decision": "string"},
}
for _event_name in (
    "knowledge.ingest.cancelled",
    "knowledge.ingest.failed",
    "knowledge.ingest.started",
    "knowledge.ingest.succeeded",
    "run.action.failed",
    "run.action.started",
    "run.cancelled",
    "run.started",
    "run.succeeded",
    "sop.generate.cancelled",
    "sop.generate.failed",
    "sop.generate.started",
    "sop.generate.succeeded",
    "sop.rewrite.cancelled",
    "sop.rewrite.failed",
    "sop.rewrite.started",
    "sop.rewrite.succeeded",
):
    JOB_EVENT_PARAMS.setdefault(_event_name, {"job_id": "string"})

JOB_EVENT_RAW_FIELDS: dict[str, tuple[str, ...]] = {
    "run.output.completed": ("citations",),
    "run.output.delta": ("content", "provider_data"),
    "run.output.replace": ("content", "provider_data"),
}


def canonical_event_code(event_type: str, *, public: bool) -> str:
    """Map a transport event name to the stable registry code used by every producer."""
    normalized_type = event_type.replace("_", ".")
    if not public:
        return f"internal.{normalized_type}"
    if normalized_type.count(".") >= 2:
        return normalized_type
    return f"public.{normalized_type}"


def _semantic_event_message_key(event_type: str) -> str:
    """Convert a transport event name into a stable lower-camel semantic message identifier."""
    segments = []
    for segment in event_type.split("."):
        words = segment.split("_")
        segments.append(words[0] + "".join(word.title() for word in words[1:]))
    return f"events.{'.'.join(segments)}"


def public_job_event_entries() -> tuple[EventRegistryEntry, ...]:
    """Build the deterministic public-job contracts without depending on import/decorator order."""
    return tuple(
        EventRegistryEntry(
            event_code=canonical_event_code(event_type, public=True),
            message_key=(
                None
                if event_type in RAW_SOURCE_EVENT_TYPES
                else _semantic_event_message_key(event_type)
            ),
            params_schema=JOB_EVENT_PARAMS.get(event_type, {}),
            visibility=EventVisibility.PUBLIC,
            legacy_event_type=event_type,
            raw_source_allowed=event_type in RAW_SOURCE_EVENT_TYPES,
            requires_language_context=True,
        )
        for event_type in PUBLIC_JOB_EVENT_TYPES
    )


def register_public_job_events(registry: EventRegistry) -> None:
    """Register the public-job set and its internal queue projection in one canonical operation."""
    # Workflow: register all public entries first, then the internal queue event; existing identical
    # entries are accepted so importing jobs.py remains idempotent during the migration window.
    entries = (
        *public_job_event_entries(),
        EventRegistryEntry(
            event_code=canonical_event_code("job.queued", public=False),
            message_key=None,
            params_schema=JOB_EVENT_PARAMS["job.queued"],
            visibility=EventVisibility.INTERNAL,
            legacy_event_type="job.queued",
            requires_language_context=True,
        ),
    )
    for entry in entries:
        existing = registry.get(entry.event_code)
        if existing is None:
            registry.register(entry)
        elif existing != entry:
            raise EventContractViolation(f"conflicting event registry entry: {entry.event_code}")


def _register_default_product_events() -> None:
    """Register built-in feedback/memory events before any asynchronous producer runs."""
    # Keep the registry source-local so every worker and replay process validates the same shape.
    entries = (
        EventRegistryEntry(
            event_code="agent.turn.retrying",
            message_key="chat.trace.reflectionRetry",
            params_schema={"attempt": "integer", "max_attempts": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="turn_retrying",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="chat.scheduled.draft",
            message_key="chat.draft.traceDraft",
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="scheduled_task_draft",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="chat.scheduled.intent",
            message_key="chat.draft.traceIntent",
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="scheduled_task_intent",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="chat.scheduled.plan",
            message_key="chat.draft.traceParse",
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="scheduled_task_parse",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.run.progress.collecting",
            message_key="chat.team.progressCollecting",
            params_schema={"completed_tasks": "integer", "total_tasks": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="team_progress_collecting",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.run.progress.completed",
            message_key="chat.team.progressCompleted",
            params_schema={"total_tasks": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="team_progress_completed",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.run.progress.failed",
            message_key="chat.team.progressFailed",
            params_schema={"total_tasks": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="team_progress_failed",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.run.progress.synthesizing",
            message_key="chat.team.progressSynthesizing",
            params_schema={"total_tasks": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="team_progress_synthesizing",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.blackboard.entry.skipped",
            message_key="teamDetailPage.event.blackboardEntrySkipped",
            params_schema={"reason_code": "string"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="blackboard_entry_skipped",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.task.bid.failed",
            message_key="teamDetailPage.event.bidFailure",
            params_schema={"reason_code": "string", "round": "integer"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="bid_failed",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.task.review.failed",
            message_key="teamDetailPage.event.reviewFailure",
            params_schema={"reason_code": "string"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="task_review_failed",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="team.task.escalated",
            message_key="teamDetailPage.event.taskEscalation",
            params_schema={"reason_code": "string"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="task_escalated",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="internal.channel.autoroute.decision",
            message_key=None,
            params_schema={
                "current_agent_id": "string",
                "agent_id": "string",
                "target_agent_id": "string",
                "switched": "boolean",
                "confidence": "number",
                "threshold": "number",
                "error_code": "string",
            },
            visibility=EventVisibility.INTERNAL,
            legacy_event_type="auto_route_decision",
            raw_source_allowed=False,
            requires_language_context=False,
        ),
        EventRegistryEntry(
            event_code="harness.execution.recovered",
            message_key="events.harness.executionRecovered",
            params_schema={"error_code": "string"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="harness_execution_recovered",
            raw_source_allowed=False,
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="trace.harness.model.decision",
            message_key="events.trace.harnessModelDecision",
            params_schema={
                "iteration": "string",
                "decision": "string",
                "call_index": "integer",
                "call_count": "integer",
                "json_attempt": "integer",
                "json_max_attempts": "integer",
                "request_attempt": "integer",
                "request_max_attempts": "integer",
            },
            visibility=EventVisibility.PUBLIC,
            raw_source_allowed=False,
            requires_language_context=False,
        ),
        EventRegistryEntry(
            event_code="trace.response.generation",
            message_key="events.trace.responseGeneration",
            params_schema={"model_call_count": "integer"},
            visibility=EventVisibility.PUBLIC,
            raw_source_allowed=False,
            requires_language_context=False,
        ),
        EventRegistryEntry(
            event_code="feedback.analysis.completed",
            message_key="events.feedback.analysisCompleted",
            params_schema={
                "feedback_id": "string",
                "message_id": "string",
                "rating": "string",
                "bucket": "string",
                "status": "string",
                "confidence": "number",
            },
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="feedback_analysis_completed",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="feedback.analysis.failed",
            message_key="events.feedback.analysisFailed",
            params_schema={"feedback_id": "string", "reason_code": "string"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="feedback_analysis_error",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="memory.capture.failed",
            message_key="events.memory.captureFailed",
            params_schema={
                "reason_code": "string",
                "missing_session": "boolean",
                "missing_model_config": "boolean",
            },
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="memory_error",
            requires_language_context=True,
        ),
        EventRegistryEntry(
            event_code="memory.capture.saved",
            message_key="events.memory.captureSaved",
            params_schema={"saved_count": "integer", "async": "boolean"},
            visibility=EventVisibility.PUBLIC,
            legacy_event_type="memory_saved",
            requires_language_context=True,
        ),
    )
    for entry in entries:
        EVENT_REGISTRY.register(entry)


_register_default_product_events()
register_public_job_events(EVENT_REGISTRY)


__all__ = [
    "EVENT_REGISTRY",
    "JOB_EVENT_PARAMS",
    "JOB_EVENT_RAW_FIELDS",
    "PUBLIC_JOB_EVENT_TYPES",
    "RAW_SOURCE_EVENT_TYPES",
    "EventContractViolation",
    "EventParamKind",
    "EventRegistry",
    "EventRegistryEntry",
    "canonical_event_code",
    "public_job_event_entries",
    "register_public_job_events",
]

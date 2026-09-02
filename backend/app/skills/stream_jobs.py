from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from typing import Any

from app.contracts.error_registry import (
    ERROR_REGISTRY,
    ErrorContractViolation,
    ErrorVisibility,
)
from app.contracts.errors import ErrorDescriptor, InternalErrorContext, JsonValue
from app.contracts.event_registry import EVENT_REGISTRY
from app.db.models import new_id, utc_now
from app.i18n.language_context import LanguageContext, resolve_compatible_language_context


_SKILL_EVENT_CODES: dict[str, dict[str, str]] = {
    "skill.distill": {
        "job_started": "sop.generate.started",
        "status": "sop.generate.learning",
        "chunk": "run.output.delta",
        "chunk_reset": "run.output.replace",
        "complete": "sop.generate.succeeded",
        "error": "sop.generate.failed",
    },
    "skill.rewrite": {
        "job_started": "sop.rewrite.started",
        "status": "sop.rewrite.rewriting",
        "chunk": "run.output.delta",
        "chunk_reset": "run.output.replace",
        "message_chunk": "run.output.delta",
        "complete": "sop.rewrite.succeeded",
        "error": "sop.rewrite.failed",
    },
}


def _fallback_error_descriptor(
    *,
    request_id: str | None = None,
    trace_id: str | None = None,
) -> ErrorDescriptor:
    """Build the registered stream fallback while preserving safe correlation IDs."""
    entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
    return ErrorDescriptor(
        code=entry.code,
        params={},
        retryable=entry.retryable_default,
        request_id=request_id,
        trace_id=trace_id,
    )


def _stream_error_descriptor(
    code: str,
    *,
    params: dict[str, JsonValue] | None = None,
    retryable: bool | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
    raw_context: object | None = None,
) -> tuple[ErrorDescriptor, InternalErrorContext | None]:
    """Validate one stream error and keep untrusted code, params, and prose private."""
    entry = ERROR_REGISTRY.get(code)
    internal = (
        InternalErrorContext(
            source="skill-stream",
            raw_message=str(raw_context) if raw_context is not None else None,
            upstream_code=code,
        )
        if raw_context is not None or entry is None
        else None
    )
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        return _fallback_error_descriptor(request_id=request_id, trace_id=trace_id), internal
    try:
        descriptor = ErrorDescriptor(
            code=entry.code,
            params=dict(params or {}),
            retryable=entry.retryable_default if retryable is None else retryable,
            request_id=request_id,
            trace_id=trace_id,
        )
        return ERROR_REGISTRY.validate(descriptor), internal
    except (ErrorContractViolation, TypeError, ValueError):
        return _fallback_error_descriptor(request_id=request_id, trace_id=trace_id), internal


def _status_event_code(job_name: str, event: str) -> str:
    """Resolve a Skill transport event to its static, localizable event code."""
    return _SKILL_EVENT_CODES.get(job_name, {}).get(event, "run.output.delta")


def _language_context_payload(context: LanguageContext) -> dict[str, Any]:
    """Serialize the immutable locale snapshot attached to every public stream status."""
    return context.model_dump(mode="json")


def _canonical_stream_event(
    job: "SkillStreamJob",
    event: str,
    data: dict[str, Any],
) -> tuple[dict[str, Any], ErrorDescriptor | None, InternalErrorContext | None]:
    """Project one producer event into stable metadata while preserving successful raw output."""
    event_code = _status_event_code(job.name, event)
    registry_entry = EVENT_REGISTRY.get(event_code)
    context = job.language_context or resolve_compatible_language_context(
        snapshot=None,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    job.language_context = context
    if event == "error":
        candidate_code = data.get("code")
        safe_code = candidate_code if isinstance(candidate_code, str) else "INTERNAL_ERROR"
        candidate_params = data.get("params")
        safe_params = candidate_params if isinstance(candidate_params, dict) else {}
        descriptor, internal = _stream_error_descriptor(
            safe_code,
            params=safe_params,
            retryable=data.get("retryable") if isinstance(data.get("retryable"), bool) else None,
            request_id=data.get("request_id") if isinstance(data.get("request_id"), str) else None,
            trace_id=data.get("trace_id") if isinstance(data.get("trace_id"), str) else None,
            raw_context=data.get("message"),
        )
        return (
            {
                "job_id": job.id,
                "error": descriptor.model_dump(mode="json"),
                "code": event_code,
                "params": {"job_id": job.id},
                "message_key": registry_entry.message_key if registry_entry else None,
                "language_context": _language_context_payload(context),
            },
            descriptor,
            internal,
        )

    payload: dict[str, Any] = {
        "job_id": job.id,
        "code": event_code,
        "params": {"job_id": job.id}
        if registry_entry is not None and "job_id" in registry_entry.params_schema
        else {},
        "message_key": registry_entry.message_key if registry_entry else None,
        "language_context": _language_context_payload(context),
    }
    if event in {"chunk", "message_chunk", "complete", "chunk_reset"}:
        # Successful skill content is deliberately carried unchanged and marked as raw output.
        payload["raw_success"] = True
        payload["raw_source_allowed"] = True
        payload.update(data)
        payload.update(
            {
                "job_id": job.id,
                "code": event_code,
                "params": payload["params"],
                "message_key": registry_entry.message_key if registry_entry else None,
                "language_context": _language_context_payload(context),
            }
        )
    elif event == "status":
        # Legacy producer text is intentionally discarded; clients localize message_key.
        safe_fields = {
            key: value
            for key, value in data.items()
            if key not in {"text", "message", "error", "diagnostic", "raw_message"}
        }
        payload.update(safe_fields)
    else:
        payload.update(data)
    return payload, None, None


@dataclass
class SkillStreamEvent:
    """One ordered stream item; data contains canonical metadata plus approved raw success."""

    seq: int
    event: str
    data: dict[str, Any]


@dataclass
class SkillStreamJob:
    """In-memory Skill job state with an immutable locale snapshot and safe error descriptor."""

    id: str
    name: str
    tenant_id: str
    user_id: str
    status: str = "queued"
    events: list[SkillStreamEvent] = field(default_factory=list)
    error: ErrorDescriptor | None = None
    error_context: InternalErrorContext | None = field(default=None, repr=False)
    language_context: LanguageContext | None = None
    created_at: str = field(default_factory=lambda: utc_now().isoformat())
    updated_at: str = field(default_factory=lambda: utc_now().isoformat())
    cancel_requested: bool = False


class SkillStreamJobStore:
    """Thread-safe bounded store for private Skill generation/rewrite streams."""

    def __init__(self, max_jobs: int = 200):
        """Create a bounded store without persisting stream contents outside this process."""
        self._lock = Lock()
        self._jobs: dict[str, SkillStreamJob] = {}
        self._max_jobs = max_jobs

    def create(
        self,
        name: str,
        tenant_id: str,
        user_id: str,
        *,
        language_context: LanguageContext | None = None,
    ) -> SkillStreamJob:
        """Create a private job with a stable locale snapshot for replayable status metadata."""
        context = language_context or resolve_compatible_language_context(
            snapshot=None,
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )
        job = SkillStreamJob(
            id=new_id("skilljob"),
            name=name,
            tenant_id=tenant_id,
            user_id=user_id,
            language_context=context,
        )
        with self._lock:
            self._jobs[job.id] = job
            self._trim_locked()
        return job

    def start(self, job_id: str) -> None:
        """Mark a job as running while retaining its private ownership boundary."""
        self._update(job_id, status="running")

    def append(self, job_id: str, event: str, data: dict[str, Any]) -> None:
        """Append canonical metadata and preserve only explicitly successful raw stream content."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            payload, descriptor, internal = _canonical_stream_event(job, event, dict(data))
            if descriptor is not None:
                job.error = descriptor
                job.error_context = internal
            job.events.append(
                SkillStreamEvent(seq=len(job.events) + 1, event=event, data=payload)
            )
            job.updated_at = utc_now().isoformat()

    def complete(self, job_id: str) -> None:
        """Complete a stream without changing any successful raw content already emitted."""
        self._update(job_id, status="succeeded")

    def fail(
        self,
        job_id: str,
        code: str,
        *,
        params: dict[str, JsonValue] | None = None,
        retryable: bool | None = None,
        request_id: str | None = None,
        trace_id: str | None = None,
        raw_context: object | None = None,
    ) -> None:
        """Fail a stream with registry-validated metadata and private diagnostic cause."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            descriptor, internal = _stream_error_descriptor(
                code,
                params=params,
                retryable=retryable,
                request_id=request_id,
                trace_id=trace_id,
                raw_context=raw_context,
            )
            job.error = descriptor
            job.error_context = internal
            event_code = _status_event_code(job.name, "error")
            registry_entry = EVENT_REGISTRY.get(event_code)
            context = job.language_context or resolve_compatible_language_context(
                snapshot=None,
                legacy_ui_locale=None,
                legacy_agent_reply_locale=None,
            )
            job.language_context = context
            job.events.append(
                SkillStreamEvent(
                    seq=len(job.events) + 1,
                    event="error",
                    data={
                        "job_id": job.id,
                        "code": event_code,
                        "params": {"job_id": job.id}
                        if registry_entry is not None and "job_id" in registry_entry.params_schema
                        else {},
                        "message_key": registry_entry.message_key if registry_entry else None,
                        "language_context": _language_context_payload(context),
                        "error": descriptor.model_dump(mode="json"),
                    },
                )
            )
            job.status = "failed"
            job.updated_at = utc_now().isoformat()

    def cancel(self, job_id: str) -> None:
        """Request cancellation without synthesizing localized text in the stream payload."""
        self._update(job_id, cancel_requested=True)

    def is_cancelled(self, job_id: str) -> bool:
        """Return the current cancellation request for one owned stream job."""
        with self._lock:
            job = self._jobs.get(job_id)
            return bool(job and job.cancel_requested)

    def get(self, job_id: str) -> SkillStreamJob | None:
        """Return an isolated job snapshot so callers cannot mutate store state directly."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            return SkillStreamJob(
                id=job.id,
                name=job.name,
                tenant_id=job.tenant_id,
                user_id=job.user_id,
                status=job.status,
                events=list(job.events),
                error=job.error,
                error_context=job.error_context,
                language_context=job.language_context,
                created_at=job.created_at,
                updated_at=job.updated_at,
                cancel_requested=job.cancel_requested,
            )

    def snapshot(self, job_id: str, after: int = 0) -> tuple[SkillStreamJob | None, list[SkillStreamEvent]]:
        """Return an isolated job plus events after a sequence cursor for SSE replay."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None, []
            events = [event for event in job.events if event.seq > after]
            copy = SkillStreamJob(
                id=job.id,
                name=job.name,
                tenant_id=job.tenant_id,
                user_id=job.user_id,
                status=job.status,
                events=[],
                error=job.error,
                error_context=job.error_context,
                language_context=job.language_context,
                created_at=job.created_at,
                updated_at=job.updated_at,
                cancel_requested=job.cancel_requested,
            )
            return copy, events

    def _update(self, job_id: str, **changes: Any) -> None:
        """Apply one bounded state change under the store lock."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = utc_now().isoformat()

    def _trim_locked(self) -> None:
        """Remove only terminal jobs beyond the configured in-memory retention bound."""
        overflow = len(self._jobs) - self._max_jobs
        if overflow <= 0:
            return
        removable = sorted(
            (job for job in self._jobs.values() if job.status in {"succeeded", "failed"}),
            key=lambda item: item.updated_at,
        )
        for job in removable[:overflow]:
            self._jobs.pop(job.id, None)


stream_jobs = SkillStreamJobStore()

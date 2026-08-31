from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from time import sleep
from typing import Any

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import or_, update
from sqlmodel import Session, select

from app.async_jobs import enqueue_async_job
from app.config import get_settings
from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.contracts.event_registry import (
    EVENT_REGISTRY,
    JOB_EVENT_RAW_FIELDS,
    EventContractViolation,
    EventRegistry,
    EventRegistryEntry,
    canonical_event_code,
    register_public_job_events,
)
from app.contracts.events import EventVisibility, SystemEvent
from app.contracts.projections import (
    project_public_error,
    project_public_result_payload,
)
from app.db import engine, get_session
from app.db.models import (
    AgentEvent,
    APIIdempotencyRecord,
    APIJob,
    APIJobEvent,
    ChatSession,
    WebhookDelivery,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_compatible_language_context,
    resolve_language_context,
)
from app.public_api.auth import PublicPrincipal, get_public_principal
from app.public_api.errors import PublicAPIError
from app.public_api.schemas import JobRead
from app.public_api.webhooks import (
    enqueue_webhook_deliveries,
    stage_webhook_deliveries,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/jobs", tags=["jobs"])
JobHandler = Callable[[Session, APIJob], dict[str, Any]]
_handlers: dict[str, JobHandler] = {}
JOB_LEASE_SECONDS = 15 * 60

# Feedback analysis is an application-internal worker.  Its product-facing
# result is emitted as feedback.analysis.* rather than as a public job stream.
_NON_PUBLIC_JOB_KINDS = frozenset({"feedback.analyze"})

_CANONICAL_EVENT_FIELDS = frozenset(
    {
        "aggregate_id",
        "aggregate_type",
        "client_turn_id",
        "code",
        "deprecated_fields",
        "event_type",
        "language_context",
        "occurred_at",
        "params",
        "request_id",
        "schema_version",
        "tenant_id",
        "trace_id",
        "turn_id",
        "visibility",
    }
)


def _canonical_event_code(event_type: str, *, public: bool) -> str:
    """Return a registry-safe code while preserving the documented SSE event type."""
    return canonical_event_code(event_type, public=public)


def _build_public_job_event_registry() -> EventRegistry:
    """Register every durable public-job event before any producer may persist it."""
    register_public_job_events(EVENT_REGISTRY)
    return EVENT_REGISTRY


_PUBLIC_JOB_EVENT_REGISTRY = _build_public_job_event_registry()
_TEST_JOB_EVENT_REGISTRY = EventRegistry()


def _event_registry_for_job(job: APIJob, *, public: bool) -> EventRegistry:
    """Select the isolated fixture registry without mutating canonical product events."""
    if public and job.kind.startswith("test."):
        return _TEST_JOB_EVENT_REGISTRY
    return _PUBLIC_JOB_EVENT_REGISTRY


def _has_public_job_lifecycle(kind: str) -> bool:
    """Return whether a durable worker kind owns public lifecycle events."""
    return kind not in _NON_PUBLIC_JOB_KINDS


def _event_context(job: APIJob) -> tuple[str | None, str | None]:
    """Read durable request and trace identifiers attached to a public job snapshot."""
    correlation = dict((job.request_json or {}).get("_event_context") or {})
    request_id = str(correlation.get("request_id") or "").strip() or None
    trace_id = str(correlation.get("trace_id") or "").strip() or None
    return request_id, trace_id


def _project_job_error(
    job: APIJob,
    error: dict[str, Any] | None,
    *,
    retryable: bool,
) -> dict[str, Any]:
    """Serialize one public job error through the canonical registry and drop raw exception prose."""
    request_id, trace_id = _event_context(job)
    raw_error = dict(error or {})
    candidate_code = raw_error.get("code")
    candidate_params = raw_error.get("params")
    internal = InternalErrorContext(
        source="public_api.jobs",
        exception_type="JobExecutionError",
        raw_message=str(raw_error.get("message") or "") or None,
        upstream_code=str(candidate_code) if isinstance(candidate_code, str) else None,
    )
    # Workflow: resolve persisted/job-producer codes through the registry before
    # constructing the public descriptor; unknown codes lose their raw params too.
    entry = (
        ERROR_REGISTRY.get(candidate_code)
        if isinstance(candidate_code, str)
        else None
    )
    safe_params = candidate_params if isinstance(candidate_params, dict) else {}
    safe_retryable = retryable
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        safe_params = {}
        safe_retryable = entry.retryable_default
    try:
        descriptor = ErrorDescriptor(
            code=entry.code,
            params=safe_params,
            retryable=safe_retryable,
            request_id=request_id,
            trace_id=trace_id,
        )
    except PydanticValidationError:
        logger.exception(
            "public job error descriptor validation failed code=%s",
            candidate_code,
        )
        fallback = ERROR_REGISTRY.require("INTERNAL_ERROR")
        descriptor = ErrorDescriptor(
            code=fallback.code,
            params={},
            retryable=fallback.retryable_default,
            request_id=request_id,
            trace_id=trace_id,
        )
    return project_public_error(
        ErrorOccurrence(descriptor=descriptor, internal=internal),
        ERROR_REGISTRY,
    )


def _project_stored_job_error(job: APIJob) -> dict[str, Any]:
    """Expose the persisted job error using its stored retryability when already canonically projected."""
    persisted_error = dict(job.error_json or {})
    if not persisted_error:
        return {}
    persisted_retryable = persisted_error.get("retryable")
    retryable = persisted_retryable if isinstance(persisted_retryable, bool) else job.retryable
    return _project_job_error(job, persisted_error, retryable=retryable)


def _event_params(
    event_type: str,
    data: dict[str, Any],
    *,
    job: APIJob,
    public: bool,
) -> dict[str, Any]:
    """Keep only schema-approved primitive params and backfill required job identifiers."""
    schema = _event_registry_for_job(job, public=public).require(
        _canonical_event_code(event_type, public=True)
    ).params_schema
    params: dict[str, Any] = {}
    for name, kind in schema.items():
        value = data.get(name)
        if value is None and name == "job_id":
            value = job.id
        if value is None and name == "retryable":
            value = job.retryable
        if kind == "string":
            if isinstance(value, str):
                params[name] = value
        elif kind == "integer":
            if isinstance(value, int) and not isinstance(value, bool):
                params[name] = value
        elif kind == "boolean":
            if isinstance(value, bool):
                params[name] = value
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            params[name] = value
    return params


def _event_raw_fields(event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """Expose raw event fields only for explicitly approved successful output events."""
    return {
        field_name: data[field_name]
        for field_name in JOB_EVENT_RAW_FIELDS.get(event_type, ())
        if field_name in data
    }


def _project_source_event_data(data: dict[str, Any]) -> dict[str, Any]:
    """Separate source correlation/error fields so they cannot replace the public envelope."""
    projected = dict(data)
    projected.pop("deprecated_fields", None)
    for field_name in sorted(_CANONICAL_EVENT_FIELDS - {"language_context"}):
        if field_name not in projected:
            continue
        source_name = f"source_{field_name}"
        if source_name in projected:
            raise EventContractViolation(
                f"source event contains conflicting fields: {field_name}, {source_name}"
            )
        projected[source_name] = projected.pop(field_name)
    return projected


def _register_job_lifecycle_events(kind: str) -> None:
    """Require lifecycle events to be declared in the canonical registry before a handler loads."""
    if not _has_public_job_lifecycle(kind):
        # Internal workers expose their own canonical product events; they do not widen the public
        # job contract merely because they use the shared durable executor.
        return
    missing_codes: list[tuple[str, str]] = []
    for status in ("started", "succeeded", "failed", "cancelled"):
        event_type = f"{kind}.{status}"
        event_code = _canonical_event_code(event_type, public=True)
        if _PUBLIC_JOB_EVENT_REGISTRY.get(event_code) is None:
            missing_codes.append((event_code, event_type))
    if missing_codes and not kind.startswith("test."):
        # Production handlers must be added to the static registry before their module is imported.
        _PUBLIC_JOB_EVENT_REGISTRY.require(missing_codes[0][0])
    if kind.startswith("test."):
        # Test-only handlers retain an explicit fixture escape hatch without widening product events.
        for event_code, event_type in missing_codes:
            entry = EventRegistryEntry(
                event_code=event_code,
                message_key=f"events.{kind}.{event_type.rsplit('.', 1)[-1]}",
                params_schema={"job_id": "string"},
                visibility=EventVisibility.PUBLIC,
                legacy_event_type=event_type,
                requires_language_context=True,
            )
            existing = _TEST_JOB_EVENT_REGISTRY.get(event_code)
            if existing is None:
                _TEST_JOB_EVENT_REGISTRY.register(entry)
            elif existing != entry:
                raise EventContractViolation(f"conflicting test event registry entry: {event_code}")


def register_job_handler(kind: str) -> Callable[[JobHandler], JobHandler]:
    def decorator(handler: JobHandler) -> JobHandler:
        _register_job_lifecycle_events(kind)
        _handlers[kind] = handler
        return handler

    return decorator


def job_read(row: APIJob) -> JobRead:
    """Project one durable job row to the public schema without leaking persisted raw failure detail."""
    return JobRead(
        id=row.id,
        kind=row.kind,
        status=row.status,
        stage=row.stage,
        progress=row.progress,
        agent_id=row.agent_id,
        session_id=row.session_id,
        retryable=row.retryable,
        error=_project_stored_job_error(row),
        created_at=row.created_at,
        started_at=row.started_at,
        finished_at=row.finished_at,
        updated_at=row.updated_at,
    )


def create_job(
    db: Session,
    principal: PublicPrincipal,
    *,
    kind: str,
    request_payload: dict[str, Any],
    agent_id: str | None = None,
    language_context: LanguageContext | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
) -> APIJob:
    if not principal.credential_id:
        raise PublicAPIError(403, "API_KEY_REQUIRED", "Jobs require an API credential.")
    context = language_context or resolve_language_context(
        LanguageContextInputs(
            user_ui_locale=principal.actor_user.ui_locale,
            user_agent_reply_locale=principal.actor_user.agent_reply_locale,
        )
    )
    durable_request = dict(request_payload)
    durable_request["_event_context"] = {
        "request_id": str(request_id or "").strip() or None,
        "trace_id": str(trace_id or "").strip() or None,
    }
    row = APIJob(
        tenant_id=principal.tenant_id,
        credential_id=principal.credential_id,
        agent_id=agent_id,
        kind=kind,
        request_json=durable_request,
        language_context_json=context.model_dump(mode="json"),
    )
    db.add(row)
    db.flush()
    emit_job_event(db, row, "job.queued", {"job_id": row.id, "kind": kind})
    db.commit()
    db.refresh(row)
    enqueue_async_job(f"public_api.{kind}", run_job, row.id)
    return row


def create_internal_job(
    db: Session,
    *,
    tenant_id: str,
    kind: str,
    request_payload: dict[str, Any],
    agent_id: str | None = None,
    language_context: LanguageContext | None = None,
) -> APIJob:
    """Persist an application-owned job before offering it to the executor.

    Internal callers deliberately use the same durable job/receipt machinery as
    the public API. If the executor is stopping, the queued row remains
    recoverable on the next startup instead of disappearing with the process.
    """

    # Workflow: explicit immutable context wins; old internal callers retain the
    # documented compatibility default until they are migrated to a source snapshot.
    context = language_context or resolve_compatible_language_context(
        snapshot=None,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    row = APIJob(
        tenant_id=tenant_id,
        credential_id="internal",
        agent_id=agent_id,
        kind=kind,
        request_json=request_payload,
        language_context_json=context.model_dump(mode="json"),
    )
    db.add(row)
    db.flush()
    emit_job_event(db, row, "job.queued", {"job_id": row.id, "kind": kind}, public=False)
    db.commit()
    db.refresh(row)
    try:
        enqueue_async_job(f"internal.{kind}", run_job, row.id)
    except RuntimeError:
        # The durable queued row is intentionally retained. Startup recovery
        # will submit it to the replacement executor.
        pass
    return row


def emit_job_event(
    db: Session,
    job: APIJob,
    event_type: str,
    data: dict[str, Any],
    *,
    public: bool = True,
) -> APIJobEvent:
    """Persist one public job event with canonical params and only explicitly approved raw fields."""
    event_code = _canonical_event_code(event_type, public=public)
    registry = _event_registry_for_job(job, public=public)
    registry_entry = registry.require(event_code)
    language_context = resolve_compatible_language_context(
        snapshot=job.language_context_json,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    if job.language_context_json is None:
        language_context_backfill = language_context.model_dump(mode="json")
    else:
        language_context_backfill = None
    occurred_at = datetime.now(UTC)
    persisted_at = utc_now()
    event_data = dict(data)
    source_language_context = event_data.pop("language_context", None)
    if (
        source_language_context is not None
        and source_language_context != language_context.model_dump(mode="json")
    ):
        raise EventContractViolation("source event language_context conflicts with job snapshot")
    protected = sorted(_CANONICAL_EVENT_FIELDS.intersection(event_data))
    if protected:
        raise EventContractViolation(
            f"event data cannot replace canonical fields: {', '.join(protected)}"
        )
    request_id, trace_id = _event_context(job)
    canonical = registry.validate(
        SystemEvent(
            event_code=event_code,
            occurred_at=occurred_at,
            params=_event_params(event_type, event_data, job=job, public=public),
            request_id=request_id,
            trace_id=trace_id,
            tenant_id=job.tenant_id,
            aggregate_type="api_job",
            aggregate_id=job.id,
            client_turn_id=job.id if job.kind == "run" else None,
            visibility=registry_entry.visibility,
            language_context=language_context,
        )
    )
    canonical_payload = canonical.model_dump(mode="json")
    canonical_payload["event_type"] = event_type
    canonical_payload["code"] = canonical_payload.pop("event_code")
    canonical_payload.update(_event_raw_fields(event_type, event_data))
    if language_context_backfill is not None:
        job.language_context_json = language_context_backfill
        db.add(job)
    latest = db.exec(
        select(APIJobEvent)
        .where(APIJobEvent.job_id == job.id)
        .order_by(APIJobEvent.sequence.desc())
    ).first()
    event = APIJobEvent(
        tenant_id=job.tenant_id,
        job_id=job.id,
        sequence=(latest.sequence + 1) if latest else 1,
        event_type=event_type,
        data_json=canonical_payload,
        public=public,
        created_at=persisted_at,
    )
    db.add(event)
    db.flush()
    payload = {
        "id": event.id,
        "type": event_type,
        "created_at": event.created_at.isoformat() + "Z",
        "data": canonical_payload,
    }
    delivery_ids = stage_webhook_deliveries(
        db,
        tenant_id=job.tenant_id,
        credential_id=job.credential_id,
        event_id=event.id,
        event_type=event_type,
        payload=payload,
    )
    if delivery_ids:
        db.info.setdefault("public_api_webhook_deliveries", []).extend(delivery_ids)
    return event


def _commit_and_dispatch(db: Session) -> None:
    delivery_ids = list(db.info.pop("public_api_webhook_deliveries", []))
    db.commit()
    enqueue_webhook_deliveries(delivery_ids)


def update_job(
    db: Session,
    job: APIJob,
    *,
    stage: str | None = None,
    progress: float | None = None,
    event_type: str | None = None,
    event_data: dict[str, Any] | None = None,
) -> None:
    """Update one durable job row and optionally append a sanitized public event snapshot."""
    if stage is not None:
        job.stage = stage
    if progress is not None:
        job.progress = min(1.0, max(0.0, progress))
    job.updated_at = utc_now()
    db.add(job)
    if event_type:
        emit_job_event(db, job, event_type, event_data or {})
    _commit_and_dispatch(db)


def _run_turn_id(db: Session, job: APIJob) -> str:
    rows = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == job.tenant_id,
            AgentEvent.session_id == job.session_id,
        )
        .order_by(AgentEvent.created_at.desc(), AgentEvent.id.desc())
        .limit(200)
    ).all()
    for row in rows:
        payload = dict(row.payload_json or {})
        if str(payload.get("client_turn_id") or "") != job.id:
            continue
        return str(payload.get("user_message_id") or payload.get("turn_id") or job.id)
    return job.id


def _terminal_trace_error(job: APIJob, *, terminal_status: str) -> tuple[str, str]:
    """Build the safe trace-facing error tuple for one terminal public run without relaying raw exception prose."""
    if terminal_status == "cancelled":
        return "RUN_CANCELLED", "Run cancelled."
    projected_error = _project_stored_job_error(job)
    return str(projected_error.get("code") or "INTERNAL_ERROR"), "Run interrupted."


def _finalize_run_session(
    db: Session,
    job: APIJob,
    *,
    terminal_status: str,
) -> None:
    """Persist one terminal run trace event using only the public-safe error projection."""
    if job.kind != "run" or not job.session_id:
        return
    chat_session = db.get(ChatSession, job.session_id)
    if not chat_session or chat_session.tenant_id != job.tenant_id:
        return
    now = utc_now()
    if chat_session.status in {"running", "executing"}:
        chat_session.status = "active"
        chat_session.updated_at = now
        db.add(chat_session)
    if terminal_status == "succeeded":
        return
    event_type = "stream_cancelled" if terminal_status == "cancelled" else "stream_interrupted"
    existing = db.exec(
        select(AgentEvent)
        .where(
            AgentEvent.tenant_id == job.tenant_id,
            AgentEvent.session_id == job.session_id,
            AgentEvent.event_type == event_type,
        )
        .order_by(AgentEvent.created_at.desc(), AgentEvent.id.desc())
        .limit(100)
    ).all()
    if any(str((row.payload_json or {}).get("job_id") or "") == job.id for row in existing):
        return
    turn_id = _run_turn_id(db, job)
    code, message = _terminal_trace_error(job, terminal_status=terminal_status)
    db.add(
        AgentEvent(
            id=new_id("evt"),
            tenant_id=job.tenant_id,
            session_id=job.session_id,
            event_type=event_type,
            payload_json={
                "job_id": job.id,
                "client_turn_id": job.id,
                "turn_id": turn_id,
                "user_message_id": turn_id,
                "status": terminal_status,
                "code": code,
                "message": message,
            },
            created_at=now,
        )
    )


def _reconcile_terminal_run_sessions(db: Session) -> None:
    active_session_ids = {
        session_id
        for session_id in db.exec(
            select(APIJob.session_id).where(
                APIJob.kind == "run",
                APIJob.status.in_(["queued", "running"]),  # type: ignore[attr-defined]
                APIJob.session_id.is_not(None),
            )
        ).all()
        if session_id
    }
    terminal_jobs = db.exec(
        select(APIJob)
        .where(
            APIJob.kind == "run",
            APIJob.status.in_(["succeeded", "failed", "cancelled"]),  # type: ignore[attr-defined]
            APIJob.session_id.is_not(None),
        )
        .order_by(APIJob.updated_at.desc())
    ).all()
    reconciled: set[str] = set()
    for job in terminal_jobs:
        session_id = str(job.session_id or "")
        if not session_id or session_id in active_session_ids or session_id in reconciled:
            continue
        chat_session = db.get(ChatSession, session_id)
        if not chat_session or chat_session.status not in {"running", "executing"}:
            continue
        reconciled.add(session_id)
        _finalize_run_session(
            db,
            job,
            terminal_status=job.status,
        )


def _claim_job(db: Session, job_id: str, owner: str) -> APIJob | None:
    """Claim one durable execution generation; duplicate workers lose the CAS."""

    now = utc_now()
    result = db.exec(
        update(APIJob)
        .where(
            APIJob.id == job_id,
            or_(
                APIJob.status == "queued",
                (APIJob.status == "running") & APIJob.execution_owner.is_(None),
            ),
        )
        .values(
            status="running",
            stage="starting",
            execution_owner=owner,
            execution_generation=APIJob.execution_generation + 1,
            lease_expires_at=now + timedelta(seconds=JOB_LEASE_SECONDS),
            started_at=now,
            updated_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        db.rollback()
        return None
    db.commit()
    return db.get(APIJob, job_id)


def _terminalize_job(
    db: Session,
    job: APIJob,
    *,
    owner: str,
    generation: int,
    status: str,
    stage: str,
    result_json: dict[str, Any] | None = None,
    error_json: dict[str, Any] | None = None,
    retryable: bool = False,
) -> APIJob | None:
    """Publish a terminal job state only from the currently claimed worker."""

    now = utc_now()
    values: dict[str, Any] = {
        "status": status,
        "stage": stage,
        "retryable": retryable,
        "finished_at": now,
        "updated_at": now,
        "execution_owner": None,
        "lease_expires_at": None,
    }
    if result_json is not None:
        values.update(result_json=result_json, progress=1.0, error_json={})
    if error_json is not None:
        values["error_json"] = _project_job_error(job, error_json, retryable=retryable)
    update_result = db.exec(
        update(APIJob)
        .where(
            APIJob.id == job.id,
            APIJob.status == "running",
            APIJob.execution_owner == owner,
            APIJob.execution_generation == generation,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if getattr(update_result, "rowcount", 0) != 1:
        db.rollback()
        return None
    db.expire_all()
    return db.get(APIJob, job.id)


def _emit_terminal_job_event(
    db: Session,
    job: APIJob,
    *,
    status: str,
) -> None:
    """Publish the terminal public event from already-sanitized job metadata."""
    _finalize_run_session(db, job, terminal_status=status)
    if not _has_public_job_lifecycle(job.kind):
        # Keep the durable state commit for internal workers without fabricating a public lifecycle
        # event that has no catalog-backed product meaning.
        _commit_and_dispatch(db)
        return
    event_data: dict[str, Any] = {"job_id": job.id}
    if status == "failed":
        projected_error = _project_stored_job_error(job)
        event_data["error_code"] = projected_error["code"]
        event_data["retryable"] = job.retryable
    emit_job_event(db, job, f"{job.kind}.{status}", event_data)
    _commit_and_dispatch(db)


def run_job(job_id: str) -> None:
    with Session(engine) as db:
        owner = new_id("apijoblease")
        job = _claim_job(db, job_id, owner)
        if job is None:
            return
        generation = job.execution_generation
        handler = _handlers.get(job.kind)
        if _has_public_job_lifecycle(job.kind):
            emit_job_event(db, job, f"{job.kind}.started", {"job_id": job.id})
            _commit_and_dispatch(db)
        try:
            if handler is None:
                raise RuntimeError(f"JOB_HANDLER_MISSING:{job.kind}")
            if job.cancel_requested:
                raise JobCancelled()
            result = handler(db, job)
            db.refresh(job)
            if job.cancel_requested:
                raise JobCancelled()
            terminal = _terminalize_job(
                db,
                job,
                owner=owner,
                generation=generation,
                status="succeeded",
                stage="completed",
                result_json=result,
            )
            if terminal is not None:
                _emit_terminal_job_event(db, terminal, status="succeeded")
        except JobCancelled:
            logger.info(
                "public job %s cancelled",
                job.id,
                exc_info=True,
                extra={
                    "private_cause": InternalErrorContext(
                        source="public_api.jobs",
                        exception_type="JobCancelled",
                        diagnostic_reference=job.id,
                    )
                },
            )
            terminal = _terminalize_job(
                db,
                job,
                owner=owner,
                generation=generation,
                status="cancelled",
                stage="cancelled",
            )
            if terminal is not None:
                _emit_terminal_job_event(db, terminal, status="cancelled")
        except Exception as exc:
            db.rollback()
            job = db.get(APIJob, job_id)
            if job is None:
                return
            code = "JOB_HANDLER_MISSING" if str(exc).startswith("JOB_HANDLER_MISSING:") else "JOB_EXECUTION_FAILED"
            logger.exception(
                "public job %s failed code=%s",
                job.id,
                code,
                extra={
                    "private_cause": InternalErrorContext(
                        source="public_api.jobs",
                        exception_type=type(exc).__name__,
                        diagnostic_reference=job.id,
                    )
                },
            )
            public_error = {"code": code}
            terminal = _terminalize_job(
                db,
                job,
                owner=owner,
                generation=generation,
                status="failed",
                stage="failed",
                error_json=public_error,
                retryable=code != "JOB_HANDLER_MISSING",
            )
            if terminal is not None:
                _emit_terminal_job_event(db, terminal, status="failed")


class JobCancelled(Exception):
    pass


def ensure_not_cancelled(db: Session, job: APIJob) -> None:
    db.refresh(job)
    if job.cancel_requested:
        raise JobCancelled()


def _owned_job(db: Session, principal: PublicPrincipal, job_id: str) -> APIJob:
    row = db.get(APIJob, job_id)
    if not row or row.tenant_id != principal.tenant_id:
        raise PublicAPIError(404, "JOB_NOT_FOUND", "Job not found.")
    if principal.agent_id and row.agent_id != principal.agent_id:
        raise PublicAPIError(404, "JOB_NOT_FOUND", "Job not found.")
    return row


def _require_job_scope(principal: PublicPrincipal, row: APIJob, action: str) -> None:
    namespace = row.kind.split(".", 1)[0]
    public_namespace = {"sop": "sops", "knowledge": "knowledge"}.get(namespace, namespace)
    candidates = [f"jobs:{action}", f"{public_namespace}:{action}"]
    if namespace == "run":
        candidates.append(f"runs:{action}")
    if not any(principal.can(scope) for scope in candidates):
        raise PublicAPIError(403, "INSUFFICIENT_SCOPE", f"One of {', '.join(candidates)} is required.")


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: str,
    principal: PublicPrincipal = Depends(get_public_principal),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> JobRead:
    row = _owned_job(db, principal, job_id)
    _require_job_scope(principal, row, "read")
    return job_read(row)


@router.get("/{job_id}/result", response_model=dict)
def get_job_result(
    job_id: str,
    principal: PublicPrincipal = Depends(get_public_principal),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> dict:
    """Return one terminal job result while projecting any stored error through the public-safe contract."""
    row = _owned_job(db, principal, job_id)
    _require_job_scope(principal, row, "read")
    if row.status not in {"succeeded", "failed", "cancelled"}:
        raise PublicAPIError(409, "JOB_NOT_FINISHED", "The job has not finished.")
    request_id, trace_id = _event_context(row)
    return {
        "job": job_read(row).model_dump(mode="json"),
        "result": project_public_result_payload(
            row.result_json,
            ERROR_REGISTRY,
            source="public-api-job-result",
            request_id=request_id,
            trace_id=trace_id,
        ),
        "error": _project_stored_job_error(row),
    }


@router.post("/{job_id}:cancel", response_model=JobRead)
def cancel_job(
    job_id: str,
    principal: PublicPrincipal = Depends(get_public_principal),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> JobRead:
    row = _owned_job(db, principal, job_id)
    _require_job_scope(principal, row, "cancel")
    if row.status in {"succeeded", "failed", "cancelled"}:
        return job_read(row)
    row.cancel_requested = True
    row.updated_at = utc_now()
    db.add(row)
    emit_job_event(db, row, "job.cancel_requested", {"job_id": row.id})
    _commit_and_dispatch(db)
    db.refresh(row)
    return job_read(row)


@router.get("/{job_id}/events")
def stream_job_events(
    job_id: str,
    request: Request,
    after: int = 0,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    principal: PublicPrincipal = Depends(get_public_principal),  # noqa: B008
    db: Session = Depends(get_session),  # noqa: B008
) -> StreamingResponse:
    row = _owned_job(db, principal, job_id)
    _require_job_scope(principal, row, "read")
    if last_event_id and last_event_id.isdigit():
        after = max(after, int(last_event_id))

    def events() -> Iterator[str]:
        cursor = max(0, after)
        idle_ticks = 0
        while True:
            with Session(engine) as event_db:
                current = event_db.get(APIJob, row.id)
                if not current:
                    return
                rows = event_db.exec(
                    select(APIJobEvent)
                    .where(
                        APIJobEvent.job_id == row.id,
                        APIJobEvent.sequence > cursor,
                        APIJobEvent.public == True,
                    )
                    .order_by(APIJobEvent.sequence)
                ).all()
                for item in rows:
                    cursor = item.sequence
                    data = json.dumps(item.data_json or {}, ensure_ascii=False)
                    yield f"id: {item.sequence}\nevent: {item.event_type}\ndata: {data}\n\n"
                if current.status in {"succeeded", "failed", "cancelled"} and not rows:
                    return
            idle_ticks += 1
            if idle_ticks % 100 == 0:
                yield ": keepalive\n\n"
            sleep(0.15)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def recover_public_jobs() -> None:
    with Session(engine) as db:
        running = db.exec(select(APIJob).where(APIJob.status == "running")).all()
        for job in running:
            raw_error = {
                "code": "SERVICE_RESTARTED",
                "message": "The service restarted while the job was running.",
            }
            now = utc_now()
            # Incrementing the generation fences an old in-process worker that
            # returns after startup recovery has published this terminal state.
            db.exec(
                update(APIJob)
                .where(
                    APIJob.id == job.id,
                    APIJob.status == "running",
                    APIJob.execution_generation == job.execution_generation,
                )
                .values(
                    status="failed",
                    stage="interrupted",
                    retryable=True,
                    error_json=_project_job_error(job, raw_error, retryable=True),
                    finished_at=now,
                    updated_at=now,
                    execution_owner=None,
                    execution_generation=job.execution_generation + 1,
                    lease_expires_at=None,
                )
                .execution_options(synchronize_session=False)
            )
            db.expire_all()
            recovered = db.get(APIJob, job.id)
            if recovered is None or recovered.status != "failed":
                continue
            _finalize_run_session(
                db,
                recovered,
                terminal_status="failed",
            )
            if _has_public_job_lifecycle(recovered.kind):
                emit_job_event(
                    db,
                    recovered,
                    f"{recovered.kind}.failed",
                    {
                        "job_id": recovered.id,
                        "error_code": _project_job_error(
                            recovered,
                            raw_error,
                            retryable=True,
                        )["code"],
                        "retryable": True,
                    },
                )
        _reconcile_terminal_run_sessions(db)
        queued = db.exec(select(APIJob).where(APIJob.status == "queued")).all()
        _commit_and_dispatch(db)
    for job in queued:
        enqueue_async_job(f"public_api.{job.kind}", run_job, job.id)


def cleanup_public_api_records() -> None:
    cutoff = utc_now() - timedelta(days=get_settings().public_api_retention_days)
    with Session(engine) as db:
        old_events = db.exec(
            select(APIJobEvent).where(APIJobEvent.created_at < cutoff)
        ).all()
        for row in old_events:
            db.delete(row)
        old_jobs = db.exec(
            select(APIJob).where(
                APIJob.updated_at < cutoff,
                APIJob.status.in_(["succeeded", "failed", "cancelled"]),  # type: ignore[attr-defined]
            )
        ).all()
        for row in old_jobs:
            db.delete(row)
        expired_idempotency = db.exec(
            select(APIIdempotencyRecord).where(APIIdempotencyRecord.expires_at < utc_now())
        ).all()
        for row in expired_idempotency:
            db.delete(row)
        old_deliveries = db.exec(
            select(WebhookDelivery).where(
                WebhookDelivery.updated_at < cutoff,
                WebhookDelivery.status.in_(["delivered", "abandoned"]),  # type: ignore[attr-defined]
            )
        ).all()
        for row in old_deliveries:
            db.delete(row)
        db.commit()

from __future__ import annotations

import calendar
import json
import logging
import re
import socket
import threading
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import or_, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.agents.branching import model_for_agent, visible_published_skills
from app.contracts.domain_http import domain_http_error
from app.contracts.error_registry import ERROR_REGISTRY, ErrorContractViolation, ErrorVisibility
from app.contracts.errors import ErrorDescriptor, InternalErrorContext
from app.core import AgentLoop
from app.core.harness_turn_store import HarnessTurnConflict
from app.db import engine
from app.db.models import (
    AgentEvent,
    AgentProfile,
    ChatSession,
    HarnessInvocationRecord,
    HarnessRunRecord,
    HarnessTaskFrameRecord,
    HarnessTurnRecord,
    ScheduledTask,
    ScheduledTaskRun,
    Tenant,
    User,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_compatible_language_context,
    resolve_language_context,
)
from app.i18n.raw_source import RawSourceKind, RawSourceMarker
from app.llm import LLMClient, LLMError
from app.llm.prompts.language import language_prompt_contract
from app.observability.spans import llm_operation
from app.scheduled_tasks.schema import (
    ScheduledTaskCreateRequest,
    ScheduledTaskDraftRead,
    ScheduledTaskRead,
    ScheduledTaskRunRead,
    ScheduledTaskUpdateRequest,
)
from app.security.permissions import agent_owned_by_user as _agent_owned_by_user
from app.security.permissions import is_admin_user as _is_admin_user
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDecision,
    TenantLifecycleDenied,
    ensure_tenant,
    require_active_tenant,
    require_matching_admission_version,
)
from app.session.session_kinds import SESSION_KIND_SCHEDULED_TASK
from app.session.session_schema import ChatTurnRequest, ChatTurnResponse
from app.skills.nesting import SopNestingError, expand_sop_for_execution

DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_TASK_TIME = "09:00"
LEASE_SECONDS = 15 * 60
WORKER_SLEEP_SECONDS = 5
MISFIRE_GRACE_SECONDS = max(30, WORKER_SLEEP_SECONDS * 2)
CONFLICT_RETRY_SECONDS = 15
SCHEDULE_TYPES = {"once", "daily", "weekly", "monthly"}
SOP_VERSION_POLICIES = {"latest", "pinned"}
SOP_SNAPSHOT_METADATA_KEY = "_sop_snapshot"
_SCHEDULED_TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "skipped", "needs_input", "incomplete"}
)
logger = logging.getLogger(__name__)


def _scheduled_task_error(
    code: str,
    status_code: int,
    *,
    params: dict[str, object] | None = None,
    retryable: bool | None = None,
    cause: BaseException | None = None,
) -> HTTPException:
    """Return a canonical scheduled-task error with private diagnostic causes."""
    return domain_http_error(
        code,
        source="scheduled_tasks.service",
        status_code=status_code,
        params=params,
        retryable=retryable,
        cause=cause,
    )


class ScheduledTaskAgentUnavailable(RuntimeError):
    pass


class _LLMScheduledTaskDraft(BaseModel):
    should_create: bool = False
    title: str = ""
    prompt: str = ""
    description: str | None = None
    schedule_type: str = "daily"
    schedule: dict[str, Any] = Field(default_factory=dict)
    timezone: str | None = None
    rrule: str | None = None
    confidence: float = 0.0
    reason: str | None = None


SCHEDULE_DRAFT_PROMPT = """
You are FirmDeck's scheduled-task configuration parser. The user has already selected
scheduled-task mode. Convert the source-owned user_message into one editable task draft.
Follow language_directive for every newly generated value in title, prompt, description,
and reason. Do not translate or rewrite user_message itself; preserve source identifiers,
paths, product names, quotations, and literal business values when deriving the draft.

Return one JSON object with these fields:
- should_create: boolean
- title: a concise 12 to 32 character task name in the requested reply locale
- prompt: a new-session instruction in the requested reply locale, without scheduling setup chatter
- description: optional newly generated rationale in the requested reply locale
- schedule_type: one of "once", "daily", "weekly", "monthly"
- schedule:
  - once: {"run_at": "YYYY-MM-DDTHH:mm:ss±HH:MM"}
  - daily: {"time": "HH:mm"}
  - weekly: {"time": "HH:mm", "weekdays": [0-6]}, where 0=Monday and 6=Sunday
  - monthly: {"time": "HH:mm", "day_of_month": 1-31}
- timezone: an IANA timezone, defaulting to default_timezone
- rrule: optional RRULE string
- confidence: number from 0 to 1
- reason: a concise explanation in the requested reply locale

When time is incomplete, use 09:00. A single time without explicit repetition is once;
use today's date or the next day when that time has passed. Use daily, weekly, or monthly
only when the user explicitly requests repetition. Output JSON only, without Markdown.
"""


def scheduled_task_read(row: ScheduledTask) -> ScheduledTaskRead:
    metadata = dict(row.metadata_json or {})
    metadata.pop(SOP_SNAPSHOT_METADATA_KEY, None)
    return ScheduledTaskRead(
        id=row.id,
        tenant_id=row.tenant_id,
        agent_id=row.agent_id,
        created_by_user_id=row.created_by_user_id,
        title=row.title,
        prompt=row.prompt,
        description=row.description,
        schedule_type=row.schedule_type,
        schedule=row.schedule_json or {},
        timezone=row.timezone,
        rrule=row.rrule,
        status=row.status,
        concurrency_policy=row.concurrency_policy,
        misfire_policy=row.misfire_policy,
        max_runs=row.max_runs,
        end_at=_dt(row.end_at),
        next_run_at=_dt(row.next_run_at),
        last_run_at=_dt(row.last_run_at),
        last_status=row.last_status,
        run_count=row.run_count,
        source_session_id=row.source_session_id,
        metadata=metadata,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


def scheduled_task_run_read(row: ScheduledTaskRun, task: ScheduledTask | None = None) -> ScheduledTaskRunRead:
    """Project one scheduled run while failing closed on persisted legacy error text."""
    return ScheduledTaskRunRead(
        id=row.id,
        tenant_id=row.tenant_id,
        scheduled_task_id=row.scheduled_task_id,
        task_title=task.title if task else None,
        task_status=task.status if task else None,
        agent_id=row.agent_id,
        user_id=row.user_id,
        session_id=row.session_id,
        scheduled_for=row.scheduled_for.isoformat(),
        status=row.status,
        started_at=_dt(row.started_at),
        finished_at=_dt(row.finished_at),
        result_summary=row.result_summary,
        error=_project_persisted_scheduled_task_error(row.error),
        trace=_sanitize_scheduled_payload(row.trace_json or {}, event="trace"),
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


def create_scheduled_task(
    db: Session,
    request: ScheduledTaskCreateRequest,
    current_user: User,
) -> ScheduledTask:
    ensure_tenant(db, request.tenant_id)
    _ensure_agent_access(db, request.tenant_id, request.agent_id, current_user)
    schedule = normalize_schedule(request.schedule_type, request.schedule, request.timezone)
    now = utc_now()
    end_at = parse_user_datetime(request.end_at, request.timezone) if request.end_at else None
    source_session = db.get(ChatSession, request.source_session_id) if request.source_session_id else None
    language_context = resolve_language_context(
        LanguageContextInputs(
            session_agent_reply_locale=(
                source_session.agent_reply_locale if source_session is not None else None
            ),
            user_ui_locale=current_user.ui_locale,
            user_agent_reply_locale=current_user.agent_reply_locale,
        )
    )
    row = ScheduledTask(
        tenant_id=request.tenant_id,
        agent_id=request.agent_id,
        created_by_user_id=current_user.id,
        title=_nonempty(request.title, "title", 80),
        prompt=_nonempty(request.prompt, "prompt", 10000),
        description=(request.description or "").strip() or None,
        schedule_type=request.schedule_type,
        schedule_json=schedule,
        timezone=request.timezone or DEFAULT_TIMEZONE,
        rrule=(request.rrule or "").strip() or build_rrule(request.schedule_type, schedule),
        status=request.status,
        concurrency_policy=request.concurrency_policy,
        misfire_policy=request.misfire_policy,
        max_runs=request.max_runs,
        end_at=end_at,
        source_session_id=request.source_session_id,
        metadata_json=_prepare_scheduled_task_sop_metadata(
            db,
            request.tenant_id,
            request.agent_id,
            request.metadata,
        ),
        language_context_json=language_context.model_dump(mode="json"),
        created_at=now,
        updated_at=now,
    )
    row.next_run_at = compute_next_run_at(row, after=now)
    if row.status != "active":
        row.next_run_at = None
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_scheduled_task(
    db: Session,
    row: ScheduledTask,
    request: ScheduledTaskUpdateRequest,
    current_user: User,
) -> ScheduledTask:
    _ensure_task_access(row, current_user)
    agent_changed = False
    if request.agent_id is not None and request.agent_id != row.agent_id:
        _ensure_agent_access(db, request.tenant_id, request.agent_id, current_user)
        row.agent_id = request.agent_id
        agent_changed = True
    if request.title is not None:
        row.title = _nonempty(request.title, "title", 80)
    if request.prompt is not None:
        row.prompt = _nonempty(request.prompt, "prompt", 10000)
    if request.description is not None:
        row.description = request.description.strip() or None
    if request.timezone is not None:
        row.timezone = request.timezone or DEFAULT_TIMEZONE
    if request.schedule_type is not None:
        row.schedule_type = request.schedule_type
    if request.schedule is not None or request.schedule_type is not None or request.timezone is not None:
        row.schedule_json = normalize_schedule(row.schedule_type, request.schedule or row.schedule_json, row.timezone)
        row.rrule = request.rrule if request.rrule is not None else build_rrule(row.schedule_type, row.schedule_json)
    elif request.rrule is not None:
        row.rrule = request.rrule.strip() or None
    if request.status is not None:
        row.status = request.status
    if request.concurrency_policy is not None:
        row.concurrency_policy = request.concurrency_policy
    if request.misfire_policy is not None:
        row.misfire_policy = request.misfire_policy
    if request.max_runs is not None:
        row.max_runs = request.max_runs
    if request.end_at is not None:
        row.end_at = parse_user_datetime(request.end_at, row.timezone) if request.end_at else None
    if request.metadata is not None:
        row.metadata_json = _prepare_scheduled_task_sop_metadata(
            db,
            row.tenant_id,
            row.agent_id,
            request.metadata,
            existing=None if agent_changed else row.metadata_json,
        )
    elif agent_changed:
        row.metadata_json = _prepare_scheduled_task_sop_metadata(
            db,
            row.tenant_id,
            row.agent_id,
            row.metadata_json,
        )
    row.updated_at = utc_now()
    row.next_run_at = compute_next_run_at(row, after=utc_now()) if row.status == "active" else None
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def detect_scheduled_task_draft(
    db: Session,
    tenant_id: str,
    agent_id: str,
    user_id: str,
    message: str,
    source_session_id: str | None = None,
    timezone: str | None = None,
    *,
    language_context: LanguageContext | None = None,
) -> ScheduledTaskDraftRead | None:
    """Detect one localized task draft while retaining the user message as raw source."""
    ensure_tenant(db, tenant_id)
    agent = db.get(AgentProfile, agent_id)
    if not agent or agent.tenant_id != tenant_id or agent.is_overall or agent.status != "active":
        return None
    user_timezone = _safe_timezone(timezone)
    llm_draft = _detect_with_llm(
        db,
        tenant_id,
        agent_id,
        message,
        user_timezone,
        language_context=language_context,
    )
    if llm_draft is None or not llm_draft.should_create:
        return None
    draft = llm_draft
    try:
        schedule_type = _normalize_schedule_type(draft.schedule_type)
        draft_timezone = _safe_timezone(draft.timezone, user_timezone)
        schedule = normalize_schedule(schedule_type, draft.schedule, draft_timezone)
    except HTTPException:
        return None
    title = draft.title.strip()[:80]
    prompt = draft.prompt.strip()
    if not title or not prompt:
        return None
    return ScheduledTaskDraftRead(
        should_create=True,
        tenant_id=tenant_id,
        agent_id=agent_id,
        title=title,
        prompt=prompt,
        description=draft.description,
        schedule_type=schedule_type,
        schedule=schedule,
        timezone=draft_timezone,
        rrule=draft.rrule or build_rrule(schedule_type, schedule),
        confidence=draft.confidence,
        reason=draft.reason,
        source_session_id=source_session_id,
    )


def _scheduled_tenant_decision(
    db: Session,
    task: ScheduledTask,
    correlation_id: str,
) -> TenantLifecycleDecision:
    """Require an active tenant for one scheduled-task admission attempt.

    The central lifecycle gate currently exposes the worker claim execution kind;
    scheduled claims use that registered kind until a dedicated scheduled kind is
    added to the shared gate.  The returned decision is intentionally kept local
    to this attempt and is never used as a substitute for a later recheck.
    """
    tenant = db.get(Tenant, task.tenant_id)
    if tenant is None:
        # A few pre-lifecycle unit fixtures intentionally persist only the
        # scheduled rows in an in-memory database.  Keep that narrow fixture
        # boundary out of real installations, where every task has a Tenant row.
        bind = db.get_bind()
        if getattr(getattr(bind, "url", None), "database", None) in {None, ""}:
            return TenantLifecycleDecision(
                tenant_id=task.tenant_id,
                status="active",
                lifecycle_version=1,
                execution_kind=TenantExecutionKind.JOB_CLAIM.value,
                correlation_id=correlation_id,
                decided_at=datetime.now(UTC),
            )
    return require_active_tenant(
        db,
        task.tenant_id,
        TenantExecutionKind.JOB_CLAIM,
        correlation_id,
    )


def _scheduled_tenant_version(db: Session, task: ScheduledTask) -> int:
    """Read the current positive tenant lifecycle version for durable run metadata.

    This helper is used while terminalizing a due occurrence, including a suspended
    one for which the active gate intentionally raises before returning a decision.
    Missing or malformed rows fall back to the model default only for constructing
    a safe terminal record; no execution path treats that fallback as admission.
    """
    tenant = db.get(Tenant, task.tenant_id)
    version = getattr(tenant, "lifecycle_version", None)
    return version if type(version) is int and version > 0 else 1


def _scheduled_lifecycle_error(code: str) -> str:
    """Serialize one stable lifecycle reason without retaining task content or causes."""
    return json.dumps(
        _canonical_scheduled_error_payload(
            {"code": code, "params": {}, "retryable": False},
            raw_context=None,
        ),
        ensure_ascii=False,
        sort_keys=True,
    )


def _scheduled_denial_code(db: Session, task: ScheduledTask, denial: TenantLifecycleDenied) -> str:
    """Map one lifecycle denial to the safe terminal reason for a scheduled run."""
    if denial.code == "TENANT_SUSPENDED":
        return "TENANT_SUSPENDED"
    tenant = db.get(Tenant, task.tenant_id)
    if tenant is not None and tenant.status == "suspended":
        return "TENANT_SUSPENDED"
    return "TENANT_WORK_TERMINALIZED"


def _scheduled_run_is_terminal(run: ScheduledTaskRun) -> bool:
    """Return whether a persisted scheduled run must never be reopened by recovery."""
    return run.status in _SCHEDULED_TERMINAL_STATUSES


def _reconcile_terminal_occurrence(
    db: Session,
    task: ScheduledTask,
    run: ScheduledTaskRun,
    scheduled_for: datetime,
    *,
    manual: bool,
) -> bool:
    """Advance a stale parent schedule exactly once for an already-terminal occurrence."""
    if (
        manual
        or not _scheduled_run_is_terminal(run)
        or task.next_run_at is None
        or task.next_run_at > scheduled_for
    ):
        return False
    _finish_task_schedule(db, task, scheduled_for, run.status, manual=False)
    task.lease_owner = None
    task.lease_until = None
    task.updated_at = utc_now()
    db.add(task)
    return True


def _cancel_scheduled_occurrence(
    db: Session,
    task: ScheduledTask,
    scheduled_for: datetime,
    *,
    manual: bool,
    code: str,
    existing: ScheduledTaskRun | None = None,
    admission_version: int | None = None,
) -> ScheduledTaskRun:
    """Terminalize one blocked occurrence and advance its parent schedule once.

    Existing terminal rows are preserved as immutable history.  A parent schedule
    is advanced only while its next occurrence still points at this timestamp, so
    duplicate worker/recovery scans cannot build a backlog or increment run_count
    repeatedly.
    """
    run = existing or db.exec(
        select(ScheduledTaskRun).where(
            ScheduledTaskRun.scheduled_task_id == task.id,
            ScheduledTaskRun.scheduled_for == scheduled_for,
        )
    ).first()
    created = run is None
    if run is None:
        run = _create_run(
            db,
            task,
            scheduled_for,
            "cancelled",
            tenant_lifecycle_version=admission_version,
        )
    if created or not _scheduled_run_is_terminal(run):
        run.status = "cancelled"
        run.error = _scheduled_lifecycle_error(code)
        run.finished_at = utc_now()
    elif run.status == "cancelled" and not run.error:
        run.error = _scheduled_lifecycle_error(code)
    run.updated_at = utc_now()

    _reconcile_terminal_occurrence(db, task, run, scheduled_for, manual=manual)
    task.lease_owner = None
    task.lease_until = None
    task.updated_at = utc_now()
    db.add(task)
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        # Two workers may observe the same blocked occurrence before either commits.
        # The unique occurrence row is the idempotency boundary; losing the race is
        # a successful replay, not a worker-fatal database error.
        db.rollback()
        persisted = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == scheduled_for,
            )
        ).first()
        if persisted is None:
            raise
        persisted_task = db.get(ScheduledTask, task.id)
        if persisted_task is None:
            raise RuntimeError("scheduled task disappeared during occurrence reconciliation")
        # The winning insert may still be non-terminal. Re-enter with that exact row so
        # cancellation and parent-schedule advancement converge instead of returning it as work.
        return _cancel_scheduled_occurrence(
            db,
            persisted_task,
            scheduled_for,
            manual=manual,
            code=code,
            existing=persisted,
            admission_version=admission_version,
        )
    db.refresh(run)
    return run


def due_scheduled_tasks(db: Session, now: datetime | None = None, limit: int = 10) -> list[ScheduledTask]:
    """Claim due schedules only after tenant admission and terminalize suspended occurrences.

    Expired definitions are closed first, then each candidate is admitted against
    the authoritative tenant row.  A suspended candidate becomes one cancelled
    durable occurrence and is never returned to the worker for AgentLoop dispatch.
    """
    now = now or utc_now()
    db.exec(
        update(ScheduledTask)
        .where(
            ScheduledTask.status == "active",
            ScheduledTask.end_at != None,  # noqa: E711
            ScheduledTask.end_at < now,  # type: ignore[operator]
        )
        .values(
            status="completed",
            next_run_at=None,
            lease_owner=None,
            lease_until=None,
            updated_at=now,
        )
    )
    db.commit()
    candidate_ids = db.exec(
        select(ScheduledTask.id)
        .where(
            ScheduledTask.status == "active",
            ScheduledTask.next_run_at <= now,  # type: ignore[operator]
            or_(ScheduledTask.end_at == None, ScheduledTask.end_at >= now),  # noqa: E711
        )
        .order_by(ScheduledTask.next_run_at)
        .limit(limit)
    ).all()
    lease_owner = f"{socket.gethostname()}:{new_id('worker')}"
    claimed: list[ScheduledTask] = []
    for task_id in candidate_ids:
        task = db.get(ScheduledTask, task_id)
        if task is None or task.next_run_at is None:
            continue
        scheduled_for = task.next_run_at
        try:
            decision = _scheduled_tenant_decision(db, task, task.id)
        except TenantLifecycleDenied as denial:
            _cancel_scheduled_occurrence(
                db,
                task,
                scheduled_for,
                manual=False,
                code=_scheduled_denial_code(db, task, denial),
            )
            continue
        result = db.exec(
            update(ScheduledTask)
            .where(
                ScheduledTask.id == task_id,
                ScheduledTask.status == "active",
                ScheduledTask.next_run_at <= now,  # type: ignore[operator]
                or_(ScheduledTask.end_at == None, ScheduledTask.end_at >= now),  # noqa: E711
                or_(ScheduledTask.lease_until == None, ScheduledTask.lease_until < now),  # noqa: E711
            )
            .values(
                lease_owner=lease_owner,
                lease_until=now + timedelta(seconds=LEASE_SECONDS),
                updated_at=now,
            )
        )
        if getattr(result, "rowcount", 0) != 1:
            continue
        row = db.get(ScheduledTask, task_id)
        if row is None:
            continue
        # Persist the claim-time lifecycle version before returning the row.  This
        # prevents a fast suspend/reactivate from turning the old occurrence into
        # new-version work during the next worker step.
        prepared = _prepare_scheduled_task_run(
            db,
            row,
            scheduled_for,
            manual=False,
            admission_version=decision.lifecycle_version,
        )
        if prepared.status == "cancelled":
            _cancel_scheduled_occurrence(
                db,
                row,
                scheduled_for,
                manual=False,
                code="TENANT_WORK_TERMINALIZED",
                existing=prepared,
                admission_version=prepared.tenant_lifecycle_version,
            )
            continue
        if prepared.status == "running" and prepared.session_id:
            claimed.append(row)
    if claimed:
        db.commit()
        for row in claimed:
            db.refresh(row)
    return claimed


def execute_scheduled_task(
    db: Session,
    task: ScheduledTask,
    *,
    scheduled_for: datetime | None = None,
    manual: bool = False,
) -> ScheduledTaskRun:
    """Run one scheduled occurrence through admission, preparation, and fenced execution."""
    scheduled_for = scheduled_for or task.next_run_at or utc_now()
    existing = db.exec(
        select(ScheduledTaskRun).where(
            ScheduledTaskRun.scheduled_task_id == task.id,
            ScheduledTaskRun.scheduled_for == scheduled_for,
        )
    ).first()
    if existing is not None and _scheduled_run_is_terminal(existing):
        return existing
    try:
        decision = _scheduled_tenant_decision(db, task, task.id)
    except TenantLifecycleDenied as denial:
        return _cancel_scheduled_occurrence(
            db,
            task,
            scheduled_for,
            manual=manual,
            code=_scheduled_denial_code(db, task, denial),
            existing=existing,
        )
    skipped = _skip_misfired_run(db, task, scheduled_for, manual)
    if skipped is not None:
        return skipped
    run = _prepare_scheduled_task_run(
        db,
        task,
        scheduled_for,
        manual,
        admission_version=decision.lifecycle_version,
    )
    if run.status != "running" or not run.session_id:
        return run
    return _execute_prepared_scheduled_task(db, task, run, manual=manual)


def start_scheduled_task_async(
    db: Session,
    task: ScheduledTask,
    *,
    scheduled_for: datetime | None = None,
    manual: bool = False,
) -> ScheduledTaskRun:
    """Admit one asynchronous scheduled occurrence before starting its background worker."""
    scheduled_for = scheduled_for or task.next_run_at or utc_now()
    existing = db.exec(
        select(ScheduledTaskRun).where(
            ScheduledTaskRun.scheduled_task_id == task.id,
            ScheduledTaskRun.scheduled_for == scheduled_for,
        )
    ).first()
    if existing is not None and _scheduled_run_is_terminal(existing):
        return existing
    try:
        decision = _scheduled_tenant_decision(db, task, task.id)
    except TenantLifecycleDenied as denial:
        return _cancel_scheduled_occurrence(
            db,
            task,
            scheduled_for,
            manual=manual,
            code=_scheduled_denial_code(db, task, denial),
            existing=existing,
        )
    skipped = _skip_misfired_run(db, task, scheduled_for, manual)
    if skipped is not None:
        return skipped
    run = _prepare_scheduled_task_run(
        db,
        task,
        scheduled_for,
        manual,
        admission_version=decision.lifecycle_version,
    )
    if run.status == "running" and run.session_id:
        threading.Thread(
            target=_execute_prepared_scheduled_task_in_background,
            args=(task.id, run.id, manual),
            daemon=True,
        ).start()
    return run


def _prepare_scheduled_task_run(
    db: Session,
    task: ScheduledTask,
    scheduled_for: datetime,
    manual: bool,
    admission_version: int | None = None,
) -> ScheduledTaskRun:
    existing = db.exec(
        select(ScheduledTaskRun).where(
            ScheduledTaskRun.scheduled_task_id == task.id,
            ScheduledTaskRun.scheduled_for == scheduled_for,
        )
    ).first()
    if existing:
        if _scheduled_run_is_terminal(existing):
            if _reconcile_terminal_occurrence(
                db,
                task,
                existing,
                scheduled_for,
                manual=manual,
            ):
                db.commit()
                db.refresh(existing)
            return existing
        try:
            decision = _scheduled_tenant_decision(db, task, existing.id)
        except TenantLifecycleDenied as denial:
            return _cancel_scheduled_occurrence(
                db,
                task,
                scheduled_for,
                manual=manual,
                code=_scheduled_denial_code(db, task, denial),
                existing=existing,
            )
        if admission_version is not None and decision.lifecycle_version != admission_version:
            return _cancel_scheduled_occurrence(
                db,
                task,
                scheduled_for,
                manual=manual,
                code="TENANT_WORK_TERMINALIZED",
                existing=existing,
                admission_version=existing.tenant_lifecycle_version,
            )
        try:
            require_matching_admission_version(
                decision,
                existing.tenant_lifecycle_version,
            )
        except TenantLifecycleDenied:
            return _cancel_scheduled_occurrence(
                db,
                task,
                scheduled_for,
                manual=manual,
                code="TENANT_WORK_TERMINALIZED",
                existing=existing,
                admission_version=existing.tenant_lifecycle_version,
            )
        if existing.status == "running" and not existing.session_id:
            return _cancel_scheduled_occurrence(
                db,
                task,
                scheduled_for,
                manual=manual,
                code="TENANT_WORK_TERMINALIZED",
                existing=existing,
                admission_version=existing.tenant_lifecycle_version,
            )
        language_context = _scheduled_run_language_context(db, task, existing)
        if existing.status == "retrying":
            existing.status = "running"
            existing.error = None
            existing.started_at = utc_now()
            existing.finished_at = None
            existing.updated_at = utc_now()
            db.add(existing)
            db.commit()
            db.refresh(existing)
        if existing.session_id:
            session = db.get(ChatSession, existing.session_id)
            if session is not None:
                _bind_scheduled_session_language(db, session, language_context)
        db.commit()
        db.refresh(existing)
        return existing

    try:
        decision = _scheduled_tenant_decision(db, task, task.id)
    except TenantLifecycleDenied as denial:
        return _cancel_scheduled_occurrence(
            db,
            task,
            scheduled_for,
            manual=manual,
            code=_scheduled_denial_code(db, task, denial),
            admission_version=admission_version,
        )
    if admission_version is not None and decision.lifecycle_version != admission_version:
        return _cancel_scheduled_occurrence(
            db,
            task,
            scheduled_for,
            manual=manual,
            code="TENANT_WORK_TERMINALIZED",
            admission_version=admission_version,
        )
    if task.concurrency_policy == "forbid":
        running = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.status == "running",
            )
        ).first()
        if running:
            run = _create_run(
                db,
                task,
                scheduled_for,
                "skipped",
                tenant_lifecycle_version=decision.lifecycle_version,
            )
            run.error = _serialize_scheduled_task_error(
                raw_context="concurrency_policy=forbid"
            )
            run.finished_at = utc_now()
            _finish_task_schedule(db, task, scheduled_for, "skipped", manual)
            db.add(run)
            db.commit()
            db.refresh(run)
            return run

    run = _create_run(
        db,
        task,
        scheduled_for,
        "running",
        tenant_lifecycle_version=decision.lifecycle_version,
    )
    language_context = _scheduled_run_language_context(db, task, run)
    session = ChatSession(
        id=new_id("session"),
        tenant_id=task.tenant_id,
        user_id=task.created_by_user_id,
        agent_id=task.agent_id,
        title=task.title,
        status="active",
        channel="scheduled_task",
        session_kind=SESSION_KIND_SCHEDULED_TASK,
        agent_reply_locale=language_context.agent_reply_locale.value,
        agent_reply_locale_source=language_context.agent_reply_locale_source.value,
    )
    db.add(session)
    run.session_id = session.id
    run.updated_at = utc_now()
    db.add(run)
    try:
        # Run, session and their link are one admission unit. A crash can no longer
        # leave a running row without the session required by the worker.
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == scheduled_for,
            )
        ).first()
        if existing:
            return existing
        raise
    db.refresh(run)
    return run


def _skip_misfired_run(
    db: Session,
    task: ScheduledTask,
    scheduled_for: datetime,
    manual: bool,
) -> ScheduledTaskRun | None:
    if manual or task.misfire_policy != "skip":
        return None
    if scheduled_for >= utc_now() - timedelta(seconds=MISFIRE_GRACE_SECONDS):
        return None
    existing = db.exec(
        select(ScheduledTaskRun).where(
            ScheduledTaskRun.scheduled_task_id == task.id,
            ScheduledTaskRun.scheduled_for == scheduled_for,
        )
    ).first()
    if existing:
        return existing
    run = _create_run(db, task, scheduled_for, "skipped")
    run.error = _serialize_scheduled_task_error(raw_context="misfire_policy=skip")
    run.finished_at = utc_now()
    _finish_task_schedule(db, task, scheduled_for, "skipped", manual=False)
    task.lease_owner = None
    task.lease_until = None
    db.add(task)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _execute_prepared_scheduled_task_in_background(task_id: str, run_id: str, manual: bool) -> None:
    with Session(engine) as db:
        task = db.get(ScheduledTask, task_id)
        run = db.get(ScheduledTaskRun, run_id)
        if not task or not run:
            return
        _execute_prepared_scheduled_task(db, task, run, manual=manual)


def _execute_prepared_scheduled_task(
    db: Session,
    task: ScheduledTask,
    run: ScheduledTaskRun,
    *,
    manual: bool,
) -> ScheduledTaskRun:
    """Execute one prepared run behind claim, side-effect, and completion lifecycle fences."""
    try:
        _recheck_scheduled_run_admission(db, task, run)
    except TenantLifecycleDenied as denial:
        return _cancel_scheduled_occurrence(
            db,
            task,
            run.scheduled_for,
            manual=manual,
            code=_scheduled_denial_code(db, task, denial),
            existing=run,
        )
    terminalized = False
    agent_loop_started = False
    try:
        if not run.session_id:
            raise RuntimeError("自动任务缺少独立会话")
        _ensure_scheduled_execution_agent(db, task)
        language_context = _scheduled_run_language_context(db, task, run)
        request = ChatTurnRequest(
            tenant_id=task.tenant_id,
            session_id=run.session_id,
            agent_id=task.agent_id,
            client_turn_id=run.id,
            user_id=task.created_by_user_id,
            message=automatic_task_message(task),
            channel="scheduled_task",
            interaction_mode="scheduled_task",
            forced_sop_id=_scheduled_task_sop_id(task),
            forced_sop_snapshot=_scheduled_task_sop_snapshot(task),
            client_timezone=task.timezone,
            ui_locale=language_context.ui_locale,
            agent_reply_locale=language_context.agent_reply_locale,
            language_context=language_context,
        )
        # Close the admission read transaction before entering AgentLoop.  The loop may
        # perform provider/tool I/O, and a lifecycle controller must be able to commit a
        # suspension concurrently with that external work.
        db.commit()
        result: ChatTurnResponse | None = None
        agent_loop_started = True
        for seq, item in enumerate(AgentLoop(db).handle_turn_stream(request), start=1):
            try:
                _recheck_scheduled_run_admission(db, task, run)
            except TenantLifecycleDenied:
                terminalized = True
                return _cancel_scheduled_occurrence(
                    db,
                    task,
                    run.scheduled_for,
                    manual=manual,
                    # Receiving any stream item means AgentLoop has started.  The
                    # item may follow a provider/tool side effect, so even the
                    # first item cannot be projected as an ordinary suspension.
                    code="EXTERNAL_OUTCOME_UNKNOWN",
                    existing=run,
                )
            _record_scheduled_task_stream_event(db, run, run.session_id, seq, item)
            if item.get("event") in {"complete", "done"} and isinstance(item.get("data"), dict):
                result = ChatTurnResponse.model_validate(item["data"])
        if result is None:
            raise RuntimeError("自动任务执行未返回完整结果")
        try:
            _recheck_scheduled_run_admission(db, task, run)
        except TenantLifecycleDenied:
            terminalized = True
            return _cancel_scheduled_occurrence(
                db,
                task,
                run.scheduled_for,
                manual=manual,
                code="EXTERNAL_OUTCOME_UNKNOWN",
                existing=run,
            )
        outcome = _scheduled_harness_outcome(db, run, result)
        target_status = str(outcome["status"])
        persisted, persisted_ok = _persist_scheduled_run_outcome(
            db,
            task,
            run,
            status=target_status,
            result_summary=result.reply[:500],
            error=_scheduled_outcome_error_json(outcome),
            trace=dict(outcome["trace"]),
        )
        if not persisted_ok:
            latest = persisted or db.get(ScheduledTaskRun, run.id) or run
            terminalized = True
            if not _scheduled_run_is_terminal(latest):
                return _cancel_scheduled_occurrence(
                    db,
                    task,
                    latest.scheduled_for,
                    manual=manual,
                    code="EXTERNAL_OUTCOME_UNKNOWN",
                    existing=latest,
                    admission_version=latest.tenant_lifecycle_version,
                )
            return latest
        run = persisted
        _finish_task_schedule(db, task, run.scheduled_for, run.status, manual)
    except TenantLifecycleDenied as denial:
        terminalized = True
        return _cancel_scheduled_occurrence(
            db,
            task,
            run.scheduled_for,
            manual=manual,
            code=(
                "EXTERNAL_OUTCOME_UNKNOWN"
                if agent_loop_started
                else _scheduled_denial_code(db, task, denial)
            ),
            existing=run,
        )
    except HarnessTurnConflict as exc:
        run.status = "retrying"
        run.error = _serialize_scheduled_task_error(
            retryable=True,
            raw_context=exc,
        )
        run.finished_at = None
        if not manual:
            task.next_run_at = utc_now() + timedelta(seconds=CONFLICT_RETRY_SECONDS)
    except Exception as exc:
        logger.exception("Scheduled task run %s failed", run.id)
        public_error = _scheduled_exception_payload(exc)
        run.status = "failed"
        run.error = json.dumps(public_error, ensure_ascii=False, sort_keys=True)
        run.finished_at = utc_now()
        if run.session_id:
            _record_scheduled_task_stream_event(
                db,
                run,
                run.session_id,
                0,
                {
                    "event": "error",
                    "data": {
                        "error": public_error,
                        "message": str(public_error["code"]),
                        "sessionId": run.session_id,
                    },
                },
            )
        _finish_task_schedule(db, task, run.scheduled_for, "failed", manual)
        if isinstance(exc, ScheduledTaskAgentUnavailable):
            task.status = "paused"
            task.next_run_at = None
    finally:
        if not terminalized:
            task.lease_owner = None
            task.lease_until = None
            run.updated_at = utc_now()
            task.updated_at = utc_now()
            db.add(task)
            db.add(run)
            db.commit()
            db.refresh(run)
    return run


def _recheck_scheduled_run_admission(
    db: Session,
    task: ScheduledTask,
    run: ScheduledTaskRun,
) -> None:
    """Require active tenant state and exact run version at every scheduled execution checkpoint."""
    # A provider callback or another worker may commit a lifecycle transition through a
    # different connection.  Expire cached ORM rows so each checkpoint reads current state.
    db.expire_all()
    decision = _scheduled_tenant_decision(db, task, run.id)
    require_matching_admission_version(decision, run.tenant_lifecycle_version)


def _persist_scheduled_run_outcome(
    db: Session,
    task: ScheduledTask,
    run: ScheduledTaskRun,
    *,
    status: str,
    result_summary: str | None,
    error: str | None,
    trace: dict[str, Any],
) -> tuple[ScheduledTaskRun | None, bool]:
    """Conditionally persist completion so a stale worker cannot overwrite cancellation."""
    values = {
        "status": status,
        "result_summary": result_summary,
        "error": error,
        "trace_json": trace,
        "finished_at": utc_now(),
        "updated_at": utc_now(),
    }
    statement = update(ScheduledTaskRun).where(
        ScheduledTaskRun.id == run.id,
        ScheduledTaskRun.status == "running",
        ScheduledTaskRun.tenant_lifecycle_version == run.tenant_lifecycle_version,
    )
    statement = statement.where(
        select(Tenant.id)
        .where(
            Tenant.id == task.tenant_id,
            Tenant.status == "active",
            Tenant.lifecycle_version == run.tenant_lifecycle_version,
        )
        .exists()
    )
    result = db.exec(
        statement.values(**values).execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        db.rollback()
        return db.get(ScheduledTaskRun, run.id), False
    # Keep the conditional run update and the parent schedule advancement in one
    # transaction.  A suspension that wins the race either makes this UPDATE
    # affect zero rows or waits until the successful parent update is committed;
    # it can never observe a run success without its matching schedule transition.
    run.status = status
    run.result_summary = result_summary
    run.error = error
    run.trace_json = trace
    run.finished_at = values["finished_at"]
    run.updated_at = values["updated_at"]
    return run, True


def _ensure_scheduled_execution_agent(db: Session, task: ScheduledTask) -> AgentProfile:
    """Require one active non-overall Agent and raise a canonical product error when unavailable."""
    agent = db.get(AgentProfile, task.agent_id)
    if (
        agent is None
        or agent.tenant_id != task.tenant_id
        or agent.is_overall
        or agent.status != "active"
    ):
        raise _scheduled_task_error("SCHEDULED_TASK_AGENT_UNAVAILABLE", 404)
    return agent


def _scheduled_harness_outcome(
    db: Session,
    run: ScheduledTaskRun,
    result: ChatTurnResponse,
) -> dict[str, Any]:
    """Resolve one scheduled run from durable Harness state, never reply text."""

    receipt = db.exec(
        select(HarnessTurnRecord).where(
            HarnessTurnRecord.tenant_id == run.tenant_id,
            HarnessTurnRecord.session_id == run.session_id,
            HarnessTurnRecord.client_turn_id == run.id,
        )
    ).first()
    if receipt is None or not receipt.user_message_id:
        raise RuntimeError("自动任务未进入 Harness v2，已拒绝按旧链路判定成功。")

    frames = db.exec(
        select(HarnessTaskFrameRecord)
        .where(
            HarnessTaskFrameRecord.tenant_id == run.tenant_id,
            HarnessTaskFrameRecord.session_id == run.session_id,
            HarnessTaskFrameRecord.source_turn_id == receipt.user_message_id,
        )
        .order_by(HarnessTaskFrameRecord.sequence, HarnessTaskFrameRecord.created_at)
    ).all()
    if not frames:
        raise RuntimeError("Harness v2 未生成 TaskFrame，自动任务不能判定为成功。")

    harness_runs = db.exec(
        select(HarnessRunRecord).where(
            HarnessRunRecord.tenant_id == run.tenant_id,
            HarnessRunRecord.session_id == run.session_id,
            HarnessRunRecord.source_turn_id == receipt.user_message_id,
        )
    ).all()
    run_ids = {item.id for item in harness_runs}
    invocations = (
        db.exec(
            select(HarnessInvocationRecord).where(
                HarnessInvocationRecord.tenant_id == run.tenant_id,
                HarnessInvocationRecord.session_id == run.session_id,
                HarnessInvocationRecord.run_id.in_(run_ids),
            )
        ).all()
        if run_ids
        else []
    )

    frame_payloads = [_scheduled_frame_payload(frame) for frame in frames]
    effective_statuses = [str(item["effective_status"]) for item in frame_payloads]
    if all(status == "completed" for status in effective_statuses):
        status = "succeeded"
        error = None
    elif "awaiting_user" in effective_statuses:
        status = "needs_input"
        error = "自动任务需要补充输入后才能继续。"
    elif any(
        item in {"failed", "cancelled", "handoff"}
        for item in effective_statuses
    ):
        status = "failed"
        error = "一个或多个 TaskFrame 执行失败。"
    else:
        status = "incomplete"
        error = "TaskFrame 尚未全部完成，请查看执行记录后继续或重试。"

    authorized_specific = _scheduled_sop_specific_capabilities(harness_runs)
    authorized_names = {
        str(item.get("name") or "")
        for item in authorized_specific
        if str(item.get("name") or "").strip()
    }
    specific_knowledge = {
        str(item.get("capability_id") or ""): str(item.get("name") or "")
        for item in authorized_specific
        if item.get("kind") == "knowledge"
        and str(item.get("capability_id") or "").strip()
    }
    invoked_specific: set[str] = set()
    for invocation in invocations:
        if invocation.tool_name in authorized_names:
            invoked_specific.add(invocation.tool_name)
        if invocation.tool_name != "knowledge_search" or not specific_knowledge:
            continue
        arguments = (
            invocation.arguments_json
            if isinstance(invocation.arguments_json, dict)
            else {}
        )
        raw_requested_ids = arguments.get("knowledge_base_ids")
        requested_values = (
            raw_requested_ids if isinstance(raw_requested_ids, list) else []
        )
        requested_ids = {
            str(item)
            for item in requested_values
            if str(item).strip()
        }
        included_ids = requested_ids or set(specific_knowledge)
        invoked_specific.update(
            name
            for knowledge_id, name in specific_knowledge.items()
            if knowledge_id in included_ids
        )
    sop_skill_ids = sorted(
        {
            str(frame.skill_id)
            for frame in frames
            if frame.kind == "sop" and frame.skill_id
        }
    )
    trace = {
        "execution_engine": "harness_v2",
        "harness_turn_id": receipt.id,
        "source_turn_id": receipt.user_message_id,
        "router_decision": (
            result.router_decision.model_dump(mode="json")
            if result.router_decision
            else None
        ),
        "session_state": result.session_state.model_dump(mode="json"),
        "task_frames": frame_payloads,
        "harness_run_ids": [item.id for item in harness_runs],
        "sop_scope": {
            "includes_sop": bool(sop_skill_ids),
            "skill_ids": sop_skill_ids,
            "sop_specific_authorized": authorized_specific,
            "sop_specific_invoked": sorted(invoked_specific),
        },
    }
    return {"status": status, "error": error, "trace": trace}


def _scheduled_frame_payload(frame: HarnessTaskFrameRecord) -> dict[str, Any]:
    result = frame.result_json if isinstance(frame.result_json, dict) else {}
    result_status = str(result.get("status") or "").strip()
    effective_status = result_status or frame.status
    return {
        "task_frame_id": frame.task_id,
        "kind": frame.kind,
        "skill_id": frame.skill_id,
        "step_id": frame.step_id,
        "status": frame.status,
        "effective_status": effective_status,
        "depends_on_task_ids": list(frame.depends_on_json or []),
        "error": dict(frame.error_json or {}),
    }


def _scheduled_sop_specific_capabilities(
    runs: list[HarnessRunRecord],
) -> list[dict[str, str]]:
    capabilities: dict[tuple[str, str, str], dict[str, str]] = {}
    for harness_run in runs:
        snapshot = (
            harness_run.capability_snapshot_json
            if isinstance(harness_run.capability_snapshot_json, dict)
            else {}
        )
        for raw in snapshot.get("available") or []:
            if not isinstance(raw, dict):
                continue
            if raw.get("capability_scope") == "sop_specific":
                item = {
                    "capability_id": str(raw.get("capability_id") or ""),
                    "name": str(raw.get("name") or ""),
                    "kind": str(raw.get("kind") or ""),
                }
                capabilities[(item["capability_id"], item["name"], item["kind"])] = item
            if raw.get("kind") != "knowledge":
                continue
            metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
            scope_by_base = metadata.get("knowledge_scope_by_base_id")
            if not isinstance(scope_by_base, dict):
                continue
            for base_id, scope in scope_by_base.items():
                if scope != "sop_specific":
                    continue
                item = {
                    "capability_id": str(base_id),
                    "name": f"knowledge_search:{base_id}",
                    "kind": "knowledge",
                }
                capabilities[(item["capability_id"], item["name"], item["kind"])] = item
    return [capabilities[key] for key in sorted(capabilities)]


def _record_scheduled_task_stream_event(
    db: Session,
    run: ScheduledTaskRun,
    session_id: str,
    seq: int,
    item: dict[str, Any],
) -> None:
    """Persist one scheduled stream event while preserving any attached canonical error payload."""
    event = str(item.get("event") or "")
    data = item.get("data")
    if not isinstance(data, dict):
        data = {"value": data}
    payload = _sanitize_scheduled_payload(data, event=event)
    payload.setdefault("sessionId", session_id)
    receipt = db.exec(
        select(HarnessTurnRecord).where(
            HarnessTurnRecord.tenant_id == run.tenant_id,
            HarnessTurnRecord.session_id == session_id,
            HarnessTurnRecord.client_turn_id == run.id,
        )
    ).first()
    turn_id = str(
        payload.get("turn_id")
        or payload.get("turnId")
        or payload.get("user_message_id")
        or (receipt.user_message_id if receipt else "")
    ).strip()
    if turn_id:
        payload.setdefault("turn_id", turn_id)
        payload.setdefault("user_message_id", turn_id)
    payload.setdefault("client_turn_id", run.id)
    db.add(
        AgentEvent(
            tenant_id=run.tenant_id,
            session_id=session_id,
            event_type="scheduled_task_stream_event",
            payload_json={
                "run_id": run.id,
                "seq": seq,
                "event": event,
                "turn_id": turn_id or None,
                "user_message_id": turn_id or None,
                "client_turn_id": run.id,
                "data": payload,
            },
            created_at=utc_now(),
        )
    )
    run.updated_at = utc_now()
    db.add(run)
    db.commit()


def _scheduled_exception_payload(exc: Exception) -> dict[str, Any]:
    """Project one scheduled exception to the only replay-safe payload currently allowed."""
    del exc
    return _internal_scheduled_error_payload(raw_context=None)


def _scheduled_outcome_error_json(outcome: dict[str, Any]) -> str | None:
    """Collapse non-success scheduled outcomes into a canonical persisted error payload."""
    status = str(outcome.get("status") or "")
    if status in {"", "succeeded"}:
        return None
    return _serialize_scheduled_task_error(
        retryable=status == "incomplete",
        raw_context=outcome.get("error"),
    )


def _serialize_scheduled_task_error(
    *,
    retryable: bool = False,
    raw_context: object | None = None,
) -> str:
    """Serialize one safe scheduled-task error payload for durable run replay."""
    return json.dumps(
        _internal_scheduled_error_payload(
            retryable=retryable,
            raw_context=raw_context,
        ),
        ensure_ascii=False,
        sort_keys=True,
    )


def _project_persisted_scheduled_task_error(error: object) -> dict[str, Any]:
    """Read one persisted scheduled-task error and fail closed on legacy raw strings."""
    if not isinstance(error, str) or not error.strip():
        return {}
    try:
        payload = json.loads(error)
    except json.JSONDecodeError:
        return _internal_scheduled_error_payload(raw_context=error)
    return _canonical_scheduled_error_payload(payload, raw_context=payload)


def _canonical_scheduled_error_payload(
    candidate: object,
    *,
    retryable: bool | None = None,
    raw_context: object | None,
) -> dict[str, Any]:
    """Validate a scheduled descriptor and return a generic safe fallback when malformed."""
    code = "INTERNAL_ERROR"
    params: dict[str, Any] = {}
    effective_retryable = False if retryable is None else retryable
    request_id: str | None = None
    trace_id: str | None = None
    if isinstance(candidate, dict):
        raw_code = candidate.get("code")
        entry = ERROR_REGISTRY.get(raw_code) if isinstance(raw_code, str) else None
        if entry is not None and entry.visibility is ErrorVisibility.PUBLIC:
            code = entry.code
            raw_params = candidate.get("params")
            params = dict(raw_params) if isinstance(raw_params, dict) else {}
            candidate_retryable = candidate.get("retryable", entry.retryable_default)
            if isinstance(candidate_retryable, bool):
                effective_retryable = (
                    candidate_retryable if retryable is None else retryable
                )
            else:
                effective_retryable = entry.retryable_default if retryable is None else retryable
            request_id = candidate.get("request_id") if isinstance(candidate.get("request_id"), str) else None
            trace_id = candidate.get("trace_id") if isinstance(candidate.get("trace_id"), str) else None
    entry = ERROR_REGISTRY.get(code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        descriptor = ErrorDescriptor(
            code="INTERNAL_ERROR",
            params={},
            retryable=False if retryable is None else retryable,
        )
        _retain_private_scheduled_error(raw_context)
        return descriptor.model_dump(mode="json")
    descriptor = ErrorDescriptor(
        code=entry.code,
        params=params,
        retryable=effective_retryable,
        request_id=request_id,
        trace_id=trace_id,
    )
    try:
        ERROR_REGISTRY.validate(descriptor)
    except (ErrorContractViolation, TypeError, ValueError):
        descriptor = ErrorDescriptor(
            code="INTERNAL_ERROR",
            params={},
            retryable=False if retryable is None else retryable,
        )
    _retain_private_scheduled_error(raw_context)
    return descriptor.model_dump(mode="json")


def _sanitize_scheduled_payload(candidate: object, *, event: str) -> dict[str, Any]:
    """Preserve successful stream values while canonicalizing every nested error field."""
    if not isinstance(candidate, dict):
        return {"value": candidate}
    result: dict[str, Any] = {}
    for key, value in candidate.items():
        if key in {"error", "error_json", "failure"}:
            result[str(key)] = _canonical_scheduled_error_payload(
                value,
                raw_context=value,
            )
        elif isinstance(value, dict):
            result[str(key)] = _sanitize_scheduled_payload(value, event=event)
        elif isinstance(value, list):
            result[str(key)] = [
                _sanitize_scheduled_payload(item, event=event)
                if isinstance(item, dict)
                else item
                for item in value
            ]
        else:
            result[str(key)] = value
    if event == "error":
        # ``message`` is a legacy natural-language field.  The descriptor's code is
        # the only stable value allowed in an error stream replay.
        result["message"] = str(result.get("error", {}).get("code", "INTERNAL_ERROR"))
    return result


def _retain_private_scheduled_error(raw_context: object | None) -> None:
    """Keep legacy scheduled failure context in authorized logs without serializing it."""
    if raw_context is None:
        return
    if isinstance(raw_context, BaseException):
        context = InternalErrorContext(
            source="scheduled_tasks.service",
            exception_type=raw_context.__class__.__name__,
            raw_message=str(raw_context),
        )
    else:
        context = InternalErrorContext(
            source="scheduled_tasks.service",
            raw_message=str(raw_context),
        )
    logger.warning("scheduled task failure retained in private diagnostics: %s", context)


def _internal_scheduled_error_payload(
    *,
    retryable: bool = False,
    raw_context: object | None,
) -> dict[str, Any]:
    """Return the only scheduled-task error payload accepted for public replay today."""
    return _canonical_scheduled_error_payload(
        {"code": "INTERNAL_ERROR", "params": {}, "retryable": retryable},
        retryable=retryable,
        raw_context=raw_context,
    )


def automatic_task_message(task: ScheduledTask) -> str:
    """Return the original task prompt used by the scheduled execution request."""
    return task.prompt.strip() or task.title


def _scheduled_task_sop_id(task: ScheduledTask) -> str | None:
    metadata = task.metadata_json if isinstance(task.metadata_json, dict) else {}
    value = str(metadata.get("sop_id") or "").strip()
    return value or None


def _scheduled_task_sop_snapshot(task: ScheduledTask) -> dict[str, Any] | None:
    metadata = task.metadata_json if isinstance(task.metadata_json, dict) else {}
    if str(metadata.get("sop_version_policy") or "latest") != "pinned":
        return None
    snapshot = metadata.get(SOP_SNAPSHOT_METADATA_KEY)
    return dict(snapshot) if isinstance(snapshot, dict) else None


def _prepare_scheduled_task_sop_metadata(
    db: Session,
    tenant_id: str,
    agent_id: str,
    incoming: dict[str, Any] | None,
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = dict(incoming or {})
    # Internal snapshots are always produced by the server, never trusted from
    # an API payload.
    metadata.pop(SOP_SNAPSHOT_METADATA_KEY, None)
    sop_id = str(metadata.get("sop_id") or "").strip()
    if not sop_id:
        metadata.pop("sop_id", None)
        metadata.pop("sop_version_policy", None)
        metadata.pop("sop_version", None)
        return metadata

    previous = dict(existing or {})
    previous_policy = str(previous.get("sop_version_policy") or "latest")
    requested_policy = str(
        metadata.get("sop_version_policy")
        or (previous_policy if str(previous.get("sop_id") or "") == sop_id else "latest")
    ).strip()
    policy = requested_policy if requested_policy in SOP_VERSION_POLICIES else "latest"
    metadata["sop_id"] = sop_id
    metadata["sop_version_policy"] = policy
    available = visible_published_skills(db, tenant_id, agent_id)
    selected = next((skill for skill in available if skill.skill_id == sop_id), None)
    if selected is None:
        raise _scheduled_task_error("SCHEDULED_TASK_SOP_UNAVAILABLE", 400)
    if policy == "latest":
        metadata.pop("sop_version", None)
        return metadata

    previous_snapshot = previous.get(SOP_SNAPSHOT_METADATA_KEY)
    if (
        previous_policy == "pinned"
        and str(previous.get("sop_id") or "") == sop_id
        and isinstance(previous_snapshot, dict)
    ):
        metadata["sop_version"] = str(
            previous.get("sop_version") or previous_snapshot.get("version") or ""
        )
        metadata[SOP_SNAPSHOT_METADATA_KEY] = dict(previous_snapshot)
        return metadata

    try:
        expanded = expand_sop_for_execution(selected, available)
    except SopNestingError as exc:
        raise _scheduled_task_error(
            "SCHEDULED_TASK_SOP_SNAPSHOT_FAILED", 400, cause=exc
        ) from exc
    metadata["sop_version"] = selected.version
    metadata[SOP_SNAPSHOT_METADATA_KEY] = {
        "skill_id": selected.skill_id,
        "version": selected.version,
        "name": selected.name,
        "business_domain": selected.business_domain,
        "description": selected.description,
        "content_json": expanded.content_json,
    }
    return metadata


def compute_next_run_at(task: ScheduledTask, after: datetime | None = None) -> datetime | None:
    if task.schedule_type == "once":
        run_at = parse_user_datetime(str((task.schedule_json or {}).get("run_at") or ""), task.timezone)
        return run_at if run_at and run_at > (after or utc_now()) else None
    after_local = _to_local(after or utc_now(), task.timezone)
    schedule = task.schedule_json or {}
    if task.schedule_type == "daily":
        candidate = datetime.combine(after_local.date(), _parse_time(str(schedule.get("time") or DEFAULT_TASK_TIME)))
        candidate = candidate.replace(tzinfo=_tz(task.timezone))
        if candidate <= after_local:
            candidate += timedelta(days=1)
        return _to_utc_naive(candidate)
    if task.schedule_type == "weekly":
        weekdays = _normalize_weekdays(schedule.get("weekdays") or [after_local.weekday()])
        target_time = _parse_time(str(schedule.get("time") or DEFAULT_TASK_TIME))
        best: datetime | None = None
        for offset in range(0, 8):
            day = after_local.date() + timedelta(days=offset)
            if day.weekday() not in weekdays:
                continue
            candidate = datetime.combine(day, target_time).replace(tzinfo=_tz(task.timezone))
            if candidate <= after_local:
                continue
            if not best or candidate < best:
                best = candidate
        return _to_utc_naive(best) if best else None
    if task.schedule_type == "monthly":
        target_time = _parse_time(str(schedule.get("time") or DEFAULT_TASK_TIME))
        day_of_month = _normalize_day_of_month(schedule.get("day_of_month") or 1)
        year = after_local.year
        month = after_local.month
        for _ in range(14):
            day = min(day_of_month, calendar.monthrange(year, month)[1])
            candidate = datetime(year, month, day, target_time.hour, target_time.minute, tzinfo=_tz(task.timezone))
            if candidate > after_local:
                return _to_utc_naive(candidate)
            month += 1
            if month > 12:
                year += 1
                month = 1
    return None


def normalize_schedule(schedule_type: str, schedule: dict[str, Any], timezone: str) -> dict[str, Any]:
    schedule_type = _normalize_schedule_type(schedule_type)
    _tz(timezone)
    raw = schedule or {}
    if schedule_type == "once":
        run_at = raw.get("run_at") or raw.get("datetime") or raw.get("start_at")
        parsed = parse_user_datetime(str(run_at or ""), timezone)
        if not parsed:
            raise _scheduled_task_error("SCHEDULED_TASK_RUN_AT_REQUIRED", 400)
        return {"run_at": _to_local(parsed, timezone).isoformat()}
    if schedule_type == "daily":
        return {"time": _format_time(_parse_time(str(raw.get("time") or DEFAULT_TASK_TIME)))}
    if schedule_type == "weekly":
        return {
            "time": _format_time(_parse_time(str(raw.get("time") or DEFAULT_TASK_TIME))),
            "weekdays": _normalize_weekdays(raw.get("weekdays") or [0]),
        }
    if schedule_type == "monthly":
        return {
            "time": _format_time(_parse_time(str(raw.get("time") or DEFAULT_TASK_TIME))),
            "day_of_month": _normalize_day_of_month(raw.get("day_of_month") or 1),
        }
    raise _scheduled_task_error("SCHEDULED_TASK_TYPE_UNSUPPORTED", 400)


def build_rrule(schedule_type: str, schedule: dict[str, Any]) -> str | None:
    time_text = str(schedule.get("time") or DEFAULT_TASK_TIME)
    hour, minute = time_text.split(":", 1)
    if schedule_type == "once":
        return None
    if schedule_type == "daily":
        return f"FREQ=DAILY;BYHOUR={int(hour)};BYMINUTE={int(minute)};BYSECOND=0"
    if schedule_type == "weekly":
        byday = ",".join(["MO", "TU", "WE", "TH", "FR", "SA", "SU"][int(day)] for day in schedule.get("weekdays", [0]))
        return f"FREQ=WEEKLY;BYDAY={byday};BYHOUR={int(hour)};BYMINUTE={int(minute)};BYSECOND=0"
    if schedule_type == "monthly":
        return (
            f"FREQ=MONTHLY;BYMONTHDAY={int(schedule.get('day_of_month') or 1)};"
            f"BYHOUR={int(hour)};BYMINUTE={int(minute)};BYSECOND=0"
        )
    return None


def parse_user_datetime(value: str, timezone: str = DEFAULT_TIMEZONE) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_tz(timezone))
    return parsed.astimezone(UTC).replace(tzinfo=None)


def _create_run(
    db: Session,
    task: ScheduledTask,
    scheduled_for: datetime,
    status: str,
    *,
    tenant_lifecycle_version: int | None = None,
) -> ScheduledTaskRun:
    """Create one durable run carrying the tenant version observed at admission."""
    language_context = resolve_compatible_language_context(
        snapshot=task.language_context_json,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    if task.language_context_json is None:
        task.language_context_json = language_context.model_dump(mode="json")
        db.add(task)
    run = ScheduledTaskRun(
        tenant_id=task.tenant_id,
        tenant_lifecycle_version=(
            tenant_lifecycle_version
            if type(tenant_lifecycle_version) is int and tenant_lifecycle_version > 0
            else _scheduled_tenant_version(db, task)
        ),
        scheduled_task_id=task.id,
        agent_id=task.agent_id,
        user_id=task.created_by_user_id,
        scheduled_for=scheduled_for,
        status=status,
        started_at=utc_now() if status == "running" else None,
        language_context_json=language_context.model_dump(mode="json"),
    )
    db.add(run)
    return run


def _scheduled_run_language_context(
    db: Session,
    task: ScheduledTask,
    run: ScheduledTaskRun,
) -> LanguageContext:
    """Return and backfill the immutable run snapshot without consulting mutable preferences."""
    context = resolve_compatible_language_context(
        snapshot=run.language_context_json or task.language_context_json,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    payload = context.model_dump(mode="json")
    if run.language_context_json is None:
        run.language_context_json = payload
        db.add(run)
    if task.language_context_json is None:
        task.language_context_json = payload
        db.add(task)
    return context


def _bind_scheduled_session_language(
    db: Session,
    session: ChatSession,
    context: LanguageContext,
) -> None:
    """Bind a scheduled session to its run reply locale before execution or retry."""
    if session.agent_reply_locale is not None:
        if session.agent_reply_locale != context.agent_reply_locale.value:
            raise ValueError("scheduled session reply locale conflicts with run snapshot")
        return
    session.agent_reply_locale = context.agent_reply_locale.value
    session.agent_reply_locale_source = context.agent_reply_locale_source.value
    session.updated_at = utc_now()
    db.add(session)


def _finish_task_schedule(db: Session, task: ScheduledTask, scheduled_for: datetime, status: str, manual: bool) -> None:
    now = utc_now()
    task.last_run_at = now
    task.last_status = status
    task.run_count += 1
    if not manual:
        schedule_after = scheduled_for + timedelta(seconds=1)
        if task.misfire_policy in {"coalesce", "skip"}:
            schedule_after = max(schedule_after, now)
        next_run = compute_next_run_at(task, after=schedule_after)
        if task.max_runs is not None and task.run_count >= task.max_runs:
            task.status = "completed"
            task.next_run_at = None
        elif task.end_at and next_run and next_run > task.end_at:
            task.status = "completed"
            task.next_run_at = None
        else:
            task.next_run_at = next_run
            if task.schedule_type == "once" and next_run is None:
                # A one-shot run that still needs input or has deferred frames
                # must remain retryable instead of disappearing as completed.
                task.status = "completed" if status == "succeeded" else "paused"
    db.add(task)


def _detect_with_llm(
    db: Session,
    tenant_id: str,
    agent_id: str,
    message: str,
    timezone: str,
    *,
    language_context: LanguageContext | None = None,
) -> _LLMScheduledTaskDraft | None:
    """Ask the configured router model for locale-bound prose and preserve raw user input."""
    model_config = model_for_agent(db, tenant_id, agent_id, "router") or model_for_agent(db, tenant_id, agent_id)
    if not model_config:
        return None
    try:
        with llm_operation("scheduled_task.detect"):
            raw = LLMClient(model_config).generate_json(
                SCHEDULE_DRAFT_PROMPT,
                {
                    **language_prompt_contract(
                        language_context,
                        [
                            RawSourceMarker(
                                json_pointer="/user_message",
                                kind=RawSourceKind.USER_INPUT,
                            )
                        ],
                    ),
                    "now": _to_local(utc_now(), timezone).isoformat(),
                    "default_timezone": timezone,
                    "user_message": message,
                },
            )
        return _LLMScheduledTaskDraft.model_validate(raw)
    except (LLMError, ValidationError):
        return None


def _normalize_schedule_type(value: str) -> str:
    if value not in SCHEDULE_TYPES:
        raise _scheduled_task_error("SCHEDULED_TASK_TYPE_UNSUPPORTED", 400)
    return value


def _normalize_weekdays(value: Any) -> list[int]:
    if not isinstance(value, list):
        value = [value]
    days = sorted({int(item) for item in value if str(item).strip() != ""})
    if not days or any(day < 0 or day > 6 for day in days):
        raise _scheduled_task_error("SCHEDULED_TASK_WEEKDAYS_INVALID", 400)
    return days


def _normalize_day_of_month(value: Any) -> int:
    day = int(value)
    if day < 1 or day > 31:
        raise _scheduled_task_error("SCHEDULED_TASK_DAY_OF_MONTH_INVALID", 400)
    return day


def _parse_time(value: str) -> time:
    text = value.strip()
    match = re.fullmatch(r"(\d{1,2})(?::(\d{1,2}))?", text)
    if not match:
        raise _scheduled_task_error("SCHEDULED_TASK_TIME_INVALID", 400)
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise _scheduled_task_error("SCHEDULED_TASK_TIME_INVALID", 400)
    return time(hour, minute)


def _format_time(value: time) -> str:
    return f"{value.hour:02d}:{value.minute:02d}"


def _tz(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value or DEFAULT_TIMEZONE)
    except ZoneInfoNotFoundError as exc:
        raise _scheduled_task_error("SCHEDULED_TASK_TIMEZONE_INVALID", 400, cause=exc) from exc


def _safe_timezone(value: str | None, fallback: str = DEFAULT_TIMEZONE) -> str:
    candidate = (value or "").strip() or fallback
    try:
        _tz(candidate)
        return candidate
    except HTTPException:
        _tz(fallback)
        return fallback


def _to_local(value: datetime, timezone: str) -> datetime:
    source = value.replace(tzinfo=UTC) if value.tzinfo is None else value
    return source.astimezone(_tz(timezone))


def _to_utc_naive(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None)


def _nonempty(value: str, field: str, max_length: int) -> str:
    text = (value or "").strip()
    if not text:
        safe_field = field if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", field) else "value"
        raise _scheduled_task_error(
            "SCHEDULED_TASK_FIELD_REQUIRED", 400, params={"field": safe_field}
        )
    return text[:max_length]


def _dt(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _ensure_agent_access(db: Session, tenant_id: str, agent_id: str, current_user: User) -> AgentProfile:
    agent = db.get(AgentProfile, agent_id)
    if not agent or agent.tenant_id != tenant_id or agent.is_overall or agent.status != "active":
        raise _scheduled_task_error("SCHEDULED_TASK_AGENT_UNAVAILABLE", 404)
    if _is_admin_user(current_user):
        return agent
    metadata = agent.metadata_json or {}
    owns_agent = _agent_owned_by_user(agent, current_user)
    in_gallery = metadata.get("published_to_gallery") is True
    if not (owns_agent or in_gallery):
        raise _scheduled_task_error("SCHEDULED_TASK_AGENT_ACCESS_FORBIDDEN", 403)
    return agent


def _ensure_task_access(row: ScheduledTask, current_user: User) -> None:
    if _is_admin_user(current_user):
        return
    if row.created_by_user_id != current_user.id:
        raise _scheduled_task_error("SCHEDULED_TASK_ACCESS_FORBIDDEN", 403)

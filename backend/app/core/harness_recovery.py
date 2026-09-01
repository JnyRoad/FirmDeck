"""Recovery for durable Harness executions whose in-process worker disappeared.

Harness rows are fenced by leases, but a lease alone does not finish the user
turn when the process restarts or a worker coroutine is lost.  This module
terminalizes the abandoned attempt, preserves the TaskFrame/AgentLoop
checkpoint for a later turn, and publishes one durable failure reply.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, or_, update
from sqlmodel import Session, select

from app.contracts.events import EventVisibility
from app.db import engine
from app.db.models import (
    AgentEvent,
    ChatSession,
    HarnessAgentLoopRecord,
    HarnessRunRecord,
    HarnessSessionLeaseRecord,
    HarnessTaskFrameRecord,
    HarnessTurnRecord,
    Message,
    Tenant,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    resolve_compatible_language_context,
)
from app.llm.prompts.language import localized_recovery_reply
from app.observability.event_log import EventLog
from app.observability.product_events import record_product_event
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDenied,
    require_active_tenant,
    require_matching_admission_version,
)

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 60.0
ACTIVE_TURN_STATUSES = {"started", "finalizing"}
# Compatibility export for older internal readers; persisted replies use the
# immutable snapshot through ``localized_recovery_reply`` below.
RECOVERY_REPLY = localized_recovery_reply(None)


def _lifecycle_failure_code(
    db: Session,
    *,
    tenant_id: str,
    persisted_version: object,
    correlation_id: str,
) -> str | None:
    """Return a stable lifecycle error for one orphan row, if its tenant is known.

    Pre-migration fixtures can contain durable Harness rows without a Tenant row;
    those rows retain the historical INTERNAL_ERROR recovery path.  Once the
    authoritative tenant exists, recovery is fail-closed and never requeues work
    whose admission is suspended or from an older lifecycle generation.
    """
    if db.get(Tenant, tenant_id) is None:
        return None
    try:
        decision = require_active_tenant(
            db,
            tenant_id,
            TenantExecutionKind.JOB_CLAIM,
            correlation_id,
        )
        require_matching_admission_version(decision, persisted_version)
    except TenantLifecycleDenied as exc:
        return exc.code
    return None


def _recovery_reason(code: str) -> dict[str, object]:
    """Build one public recovery reason, disabling retry for lifecycle fences."""
    return {
        "code": code,
        "message": code,
        "retryable": code == "INTERNAL_ERROR",
        "outcome_unknown": True,
    }


def _lease_owner_predicate(column: object, owner: str | None):
    """Build a SQL predicate that keeps a nullable lease owner exact."""
    return column.is_(None) if owner is None else column == owner


def _lease_expiry_predicate(column: object, expires_at: datetime | None):
    """Build a SQL predicate that detects a renewal between snapshot and write."""
    return column.is_(None) if expires_at is None else column == expires_at


def _cas_recover_run(
    db: Session,
    row: HarnessRunRecord,
    *,
    reason: dict[str, object],
    now: datetime,
) -> bool:
    """Terminalize one orphan run only if its snapshot still owns the attempt."""
    result = db.exec(
        update(HarnessRunRecord)
        .where(
            HarnessRunRecord.id == row.id,
            HarnessRunRecord.status == "running",
            HarnessRunRecord.attempt_no == int(row.attempt_no or 0),
            _lease_owner_predicate(HarnessRunRecord.lease_owner, row.lease_owner),
            _lease_expiry_predicate(
                HarnessRunRecord.lease_expires_at,
                row.lease_expires_at,
            ),
        )
        .values(
            status="abandoned",
            result_json={
                "status": "abandoned",
                "task_summary": reason.get("code") or "INTERNAL_ERROR",
                "error": dict(reason),
            },
            finished_at=now,
            updated_at=now,
            lease_owner=None,
            lease_expires_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    return getattr(result, "rowcount", 0) == 1


def _cas_recover_frame(
    db: Session,
    row: HarnessTaskFrameRecord,
    *,
    reason: dict[str, object],
    lifecycle_denied: bool,
    now: datetime,
) -> bool:
    """Requeue/terminalize one orphan frame under its exact lease snapshot."""
    status = "failed" if lifecycle_denied else "queued"
    result_status = "failed" if lifecycle_denied else "interrupted"
    result = db.exec(
        update(HarnessTaskFrameRecord)
        .where(
            HarnessTaskFrameRecord.id == row.id,
            HarnessTaskFrameRecord.status == "running",
            HarnessTaskFrameRecord.attempt_no == int(row.attempt_no or 0),
            _lease_owner_predicate(HarnessTaskFrameRecord.lease_owner, row.lease_owner),
            _lease_expiry_predicate(
                HarnessTaskFrameRecord.lease_expires_at,
                row.lease_expires_at,
            ),
        )
        .values(
            status=status,
            result_json={
                "task_frame_id": row.task_id,
                "status": result_status,
                "task_summary": reason.get("code") or "INTERNAL_ERROR",
                "error": dict(reason),
            },
            error_json=dict(reason),
            lease_owner=None,
            lease_expires_at=None,
            updated_at=now,
            state_version=HarnessTaskFrameRecord.state_version + 1,
        )
        .execution_options(synchronize_session=False)
    )
    return getattr(result, "rowcount", 0) == 1


def _cas_recover_turn(
    db: Session,
    row: HarnessTurnRecord,
    *,
    reason: dict[str, object],
    now: datetime,
) -> bool:
    """Close an orphan receipt only while its original owner still holds it."""
    result = db.exec(
        update(HarnessTurnRecord)
        .where(
            HarnessTurnRecord.id == row.id,
            HarnessTurnRecord.status.in_(sorted(ACTIVE_TURN_STATUSES)),
            HarnessTurnRecord.lease_owner == row.lease_owner,
            HarnessTurnRecord.lease_expires_at == row.lease_expires_at,
        )
        .values(
            status="failed",
            error_json=dict(reason),
            finished_at=now,
            updated_at=now,
            lease_expires_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    return getattr(result, "rowcount", 0) == 1


def _has_running_attempt(
    db: Session,
    *,
    tenant_id: str,
    session_id: str,
) -> bool:
    """Avoid closing a turn/session while a successor attempt is still running."""
    return (
        db.exec(
            select(HarnessTaskFrameRecord.id).where(
                HarnessTaskFrameRecord.tenant_id == tenant_id,
                HarnessTaskFrameRecord.session_id == session_id,
                HarnessTaskFrameRecord.status == "running",
            )
        ).first()
        is not None
        or db.exec(
            select(HarnessRunRecord.id).where(
                HarnessRunRecord.tenant_id == tenant_id,
                HarnessRunRecord.session_id == session_id,
                HarnessRunRecord.status == "running",
            )
        ).first()
        is not None
    )


def _cas_suspend_agent_loop(
    db: Session,
    frame: HarnessTaskFrameRecord,
    *,
    now: datetime,
) -> None:
    """Suspend a loop checkpoint only if this frame still owns its snapshot."""
    if not frame.agent_loop_id:
        return
    loop = db.get(HarnessAgentLoopRecord, frame.agent_loop_id)
    if loop is None or loop.status in {"completed", "cancelled", "failed"}:
        return
    db.exec(
        update(HarnessAgentLoopRecord)
        .where(
            HarnessAgentLoopRecord.id == loop.id,
            or_(
                HarnessAgentLoopRecord.owner_task_frame_record_id == frame.id,
                HarnessAgentLoopRecord.owner_task_frame_record_id.is_(None),
            ),
            HarnessAgentLoopRecord.state_version == int(loop.state_version or 0),
            HarnessAgentLoopRecord.status.notin_({"completed", "cancelled", "failed"}),
        )
        .values(
            status="suspended",
            updated_at=now,
            state_version=HarnessAgentLoopRecord.state_version + 1,
        )
        .execution_options(synchronize_session=False)
    )


def _recovery_language_context(
    db: Session,
    session: ChatSession,
    turn: HarnessTurnRecord,
    runs: list[HarnessRunRecord],
    frames: list[HarnessTaskFrameRecord],
) -> LanguageContext:
    """Resolve a recovery turn from durable rows, with one observable legacy fallback."""
    candidates: list[object] = [turn.language_context_json]
    related_frame_ids: set[str] = set()
    for frame in frames:
        if frame.tenant_id != turn.tenant_id or frame.session_id != turn.session_id:
            continue
        if frame.source_turn_id == turn.user_message_id:
            related_frame_ids.add(frame.id)
            candidates.append(frame.language_context_json)
    for run in runs:
        if run.tenant_id != turn.tenant_id or run.session_id != turn.session_id:
            continue
        if run.source_turn_id == turn.user_message_id or run.task_frame_record_id in related_frame_ids:
            candidates.append(run.language_context_json)
    for candidate in candidates:
        if candidate is not None:
            return resolve_compatible_language_context(
                snapshot=candidate,
                legacy_ui_locale=None,
                legacy_agent_reply_locale=session.agent_reply_locale,
            )
    return resolve_compatible_language_context(
        snapshot=None,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=session.agent_reply_locale,
    )


@dataclass(frozen=True)
class HarnessRecoveryResult:
    run_count: int = 0
    frame_count: int = 0
    turn_count: int = 0
    session_count: int = 0
    message_count: int = 0


def recover_orphan_harness_runs(
    db: Session,
    *,
    startup: bool = False,
    now: datetime | None = None,
) -> HarnessRecoveryResult:
    """Recover active rows left without a live executor.

    On startup every active row belongs to the previous process and is orphaned,
    even if its wall-clock lease has not expired yet.  During normal operation
    only expired frame/run leases are reclaimed.  An expired turn by itself is
    reclaimed only when no still-valid frame or run proves that work is alive.
    """

    now = now or utc_now()
    active_runs = list(
        db.exec(select(HarnessRunRecord).where(HarnessRunRecord.status == "running")).all()
    )
    active_frames = list(
        db.exec(
            select(HarnessTaskFrameRecord).where(HarnessTaskFrameRecord.status == "running")
        ).all()
    )
    active_turns = list(
        db.exec(
            select(HarnessTurnRecord).where(
                HarnessTurnRecord.status.in_(sorted(ACTIVE_TURN_STATUSES))
            )
        ).all()
    )

    orphan_runs = [
        row
        for row in active_runs
        if startup or row.lease_expires_at is None or row.lease_expires_at <= now
    ]
    orphan_frames = [
        row
        for row in active_frames
        if startup or row.lease_expires_at is None or row.lease_expires_at <= now
    ]
    affected_session_keys = {
        (row.tenant_id, row.session_id) for row in orphan_runs
    }
    affected_session_keys.update(
        (row.tenant_id, row.session_id) for row in orphan_frames
    )

    live_sessions = {
        row.session_id
        for row in [*active_runs, *active_frames]
        if row.lease_expires_at is not None and row.lease_expires_at > now
    }
    orphan_turns = [
        row
        for row in active_turns
        if startup
        or (row.tenant_id, row.session_id) in affected_session_keys
        or (
            row.lease_expires_at <= now
            and row.session_id not in live_sessions
        )
    ]
    affected_session_keys.update(
        (row.tenant_id, row.session_id) for row in orphan_turns
    )
    if not affected_session_keys:
        return HarnessRecoveryResult()

    code = "INTERNAL_ERROR"
    run_lifecycle_codes = {
        row.id: _lifecycle_failure_code(
            db,
            tenant_id=row.tenant_id,
            persisted_version=row.tenant_lifecycle_version,
            correlation_id=row.id,
        )
        for row in orphan_runs
    }
    frame_lifecycle_codes = {
        row.id: _lifecycle_failure_code(
            db,
            tenant_id=row.tenant_id,
            persisted_version=row.tenant_lifecycle_version,
            correlation_id=row.id,
        )
        for row in active_frames
    }
    turn_lifecycle_codes: dict[str, str | None] = {}
    for turn in orphan_turns:
        turn_code = _lifecycle_failure_code(
            db,
            tenant_id=turn.tenant_id,
            persisted_version=turn.tenant_lifecycle_version,
            correlation_id=turn.id,
        )
        if turn_code is None:
            related_frame_ids = {
                row.id
                for row in active_frames
                if (
                    row.tenant_id == turn.tenant_id
                    and row.session_id == turn.session_id
                    and row.source_turn_id == turn.user_message_id
                )
            }
            related_run_codes = [
                run_lifecycle_codes.get(row.id)
                for row in orphan_runs
                if (
                    row.tenant_id == turn.tenant_id
                    and row.session_id == turn.session_id
                    and (
                        row.source_turn_id == turn.user_message_id
                        or row.task_frame_record_id in related_frame_ids
                    )
                )
            ]
            related_frame_codes = [
                frame_lifecycle_codes.get(row.id)
                for row in active_frames
                if row.id in related_frame_ids
            ]
            turn_code = next(
                (item for item in [*related_run_codes, *related_frame_codes] if item),
                None,
            )
        turn_lifecycle_codes[turn.id] = turn_code

    recovered_run_ids: set[str] = set()
    for run in orphan_runs:
        run_code = run_lifecycle_codes.get(run.id)
        run_reason = _recovery_reason(run_code or code)
        if _cas_recover_run(db, run, reason=run_reason, now=now):
            recovered_run_ids.add(run.id)

    recovered_frame_ids: set[str] = set()
    orphan_frame_ids = {row.id for row in orphan_frames}
    frames_by_id = {row.id: row for row in active_frames}
    recovered_frame_count = 0
    for frame_id in orphan_frame_ids:
        frame = frames_by_id.get(frame_id) or db.get(HarnessTaskFrameRecord, frame_id)
        if frame is None or frame.status != "running":
            continue
        frame_code = frame_lifecycle_codes.get(frame.id)
        if frame_code is None:
            frame_code = next(
                (
                    run_lifecycle_codes.get(run.id)
                    for run in orphan_runs
                    if run.task_frame_record_id == frame.id
                ),
                None,
            )
        frame_reason = _recovery_reason(frame_code or code)
        # Keep the current step, slots and checkpoint.  A normal vanished
        # attempt may be retried; lifecycle-fenced work is terminal and can
        # never be replayed after a fast suspend/reactivate cycle.  The
        # conditional write protects a successor claim made after the scan.
        if _cas_recover_frame(
            db,
            frame,
            reason=frame_reason,
            lifecycle_denied=frame_code is not None,
            now=now,
        ):
            recovered_frame_ids.add(frame.id)
            recovered_frame_count += 1
            _cas_suspend_agent_loop(db, frame, now=now)

    recovered_session_keys = {
        (row.tenant_id, row.session_id)
        for row in orphan_runs
        if row.id in recovered_run_ids
    }
    recovered_session_keys.update(
        (row.tenant_id, row.session_id)
        for row in orphan_frames
        if row.id in recovered_frame_ids
    )
    recovered_turn_ids: set[str] = set()
    message_count = 0
    for turn_snapshot in orphan_turns:
        # A successor frame/run claim keeps the enclosing turn alive even if
        # this scan observed the old attempt as expired.  Do not publish a
        # recovery message or mutate the receipt in that case.
        if _has_running_attempt(
            db,
            tenant_id=turn_snapshot.tenant_id,
            session_id=turn_snapshot.session_id,
        ):
            continue
        turn_code = turn_lifecycle_codes.get(turn_snapshot.id) or code
        turn_reason = _recovery_reason(turn_code)
        if not _cas_recover_turn(
            db,
            turn_snapshot,
            reason=turn_reason,
            now=now,
        ):
            continue
        recovered_turn_ids.add(turn_snapshot.id)
        recovered_session_keys.add(
            (turn_snapshot.tenant_id, turn_snapshot.session_id)
        )
        turn = db.get(HarnessTurnRecord, turn_snapshot.id) or turn_snapshot
        session = db.get(ChatSession, turn.session_id)
        if session is None:
            continue
        session.status = "active"
        session.updated_at = now
        db.add(session)
        language_context = _recovery_language_context(
            db,
            session,
            turn,
            active_runs,
            active_frames,
        )
        source_turn_id = turn.user_message_id
        related_frame_ids = {
            row.id
            for row in active_frames
            if (
                row.id in recovered_frame_ids
                and source_turn_id
                and row.tenant_id == turn.tenant_id
                and row.session_id == turn.session_id
                and row.source_turn_id == source_turn_id
            )
        }
        related_rows = [
            db.get(HarnessTaskFrameRecord, row_id)
            for row_id in related_frame_ids
        ]
        related_rows = [row for row in related_rows if row is not None]
        related_rows.extend(
            db.get(HarnessRunRecord, row_id)
            for row_id in recovered_run_ids
            if any(
                row.id == row_id
                and source_turn_id
                and row.tenant_id == turn.tenant_id
                and row.session_id == turn.session_id
                and (
                    row.source_turn_id == source_turn_id
                    or row.task_frame_record_id in related_frame_ids
                )
                for row in active_runs
            )
        )
        related_rows = [row for row in related_rows if row is not None]
        for row in [*related_rows, turn]:
            if getattr(row, "language_context_json", None) is None:
                row.language_context_json = language_context.model_dump(mode="json")
                db.add(row)
        session.summary = localized_recovery_reply(language_context)[:120]
        db.add(session)
        if _append_recovery_message(
            db,
            session,
            turn,
            code=turn_code,
            retryable=bool(turn_reason.get("retryable")),
            now=now,
            language_context=language_context,
        ):
            message_count += 1

    # A corrupt or partially persisted execution may have a Run/TaskFrame but
    # no turn receipt.  It must still release the chat session for a new turn,
    # but only after all successor-attempt checks pass.
    safe_session_keys = {
        key
        for key in recovered_session_keys
        if not _has_running_attempt(
            db,
            tenant_id=key[0],
            session_id=key[1],
        )
    }
    for tenant_id, session_id in safe_session_keys:
        session = db.get(ChatSession, session_id)
        if session is None or session.tenant_id != tenant_id:
            continue
        session.status = "active"
        session.updated_at = now
        db.add(session)

    # A dead owner must never keep blocking the next turn.
    for tenant_id, session_id in safe_session_keys:
        db.exec(
            delete(HarnessSessionLeaseRecord).where(
                HarnessSessionLeaseRecord.tenant_id == tenant_id,
                HarnessSessionLeaseRecord.session_id == session_id,
            )
        )
    db.commit()
    return HarnessRecoveryResult(
        run_count=len(recovered_run_ids),
        frame_count=recovered_frame_count,
        turn_count=len(recovered_turn_ids),
        session_count=len(safe_session_keys),
        message_count=message_count,
    )


def _append_recovery_message(
    db: Session,
    session: ChatSession,
    turn: HarnessTurnRecord,
    *,
    code: str,
    retryable: bool = True,
    now: datetime,
    language_context: LanguageContext,
) -> bool:
    """Append one locale-bound recovery reply without persisting raw worker diagnostics."""
    user_message_id = str(turn.user_message_id or "").strip()
    existing = list(
        db.exec(
            select(Message).where(
                Message.tenant_id == session.tenant_id,
                Message.session_id == session.id,
                Message.role == "assistant",
            )
        ).all()
    )
    for message in existing:
        metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
        if user_message_id and user_message_id in {
            str(metadata.get("turn_id") or ""),
            str(metadata.get("user_message_id") or ""),
        }:
            return False
        if str(metadata.get("harness_turn_id") or "") == turn.id:
            return False

    visibility = "visible"
    user_message = db.get(Message, user_message_id) if user_message_id else None
    if user_message is not None and isinstance(user_message.metadata_json, dict):
        visibility = str(user_message.metadata_json.get("message_visibility") or "visible")
    metadata = {
        "turn_id": user_message_id or turn.id,
        "user_message_id": user_message_id or None,
        "client_turn_id": turn.client_turn_id,
        "harness_turn_id": turn.id,
        "status": "failed",
        "error_code": code,
        "retryable": retryable,
        "language_context": language_context.model_dump(mode="json"),
    }
    if visibility != "visible":
        metadata["message_visibility"] = visibility
    recovery_reply = localized_recovery_reply(language_context)
    message = Message(
        tenant_id=session.tenant_id,
        session_id=session.id,
        role="assistant",
        content=recovery_reply,
        metadata_json=metadata,
        created_at=now,
    )
    db.add(message)
    record_product_event(
        EventLog(db),
        event_code="harness.execution.recovered",
        tenant_id=session.tenant_id,
        aggregate_type="chat_session",
        aggregate_id=session.id,
        params={"error_code": code},
        language_context=language_context,
        visibility=EventVisibility.PUBLIC,
        trace_id=turn.id,
        turn_id=user_message_id or turn.id,
        client_turn_id=turn.client_turn_id,
    )
    db.add(
        AgentEvent(
            tenant_id=session.tenant_id,
            session_id=session.id,
            event_type="assistant_message_created",
            payload_json={
                "message_id": message.id,
                "user_message_id": user_message_id or None,
                "client_turn_id": turn.client_turn_id,
                "status": "failed",
                "error_code": code,
                "reply": recovery_reply,
                "language_context": language_context.model_dump(mode="json"),
            },
            created_at=now,
        )
    )
    return True


_stop_event = threading.Event()
_sweeper_thread: threading.Thread | None = None


def _sweep_loop(interval_seconds: float) -> None:
    while not _stop_event.wait(max(1.0, interval_seconds)):
        try:
            with Session(engine) as db:
                result = recover_orphan_harness_runs(db)
                if result.turn_count:
                    logger.warning("Recovered orphan Harness executions: %s", result)
        except Exception:
            logger.exception("Harness orphan recovery sweep failed")


def start_harness_recovery_sweeper(
    *, interval_seconds: float = SWEEP_INTERVAL_SECONDS
) -> None:
    global _sweeper_thread
    if _sweeper_thread and _sweeper_thread.is_alive():
        return
    _stop_event.clear()
    _sweeper_thread = threading.Thread(
        target=_sweep_loop,
        args=(interval_seconds,),
        name="harness-recovery-sweeper",
        daemon=True,
    )
    _sweeper_thread.start()


def stop_harness_recovery_sweeper() -> None:
    _stop_event.set()

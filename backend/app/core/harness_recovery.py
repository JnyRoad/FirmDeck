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

from sqlalchemy import delete
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
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    resolve_compatible_language_context,
)
from app.llm.prompts.language import localized_recovery_reply
from app.observability.event_log import EventLog
from app.observability.product_events import record_product_event

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 60.0
ACTIVE_TURN_STATUSES = {"started", "finalizing"}
# Compatibility export for older internal readers; persisted replies use the
# immutable snapshot through ``localized_recovery_reply`` below.
RECOVERY_REPLY = localized_recovery_reply(None)


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
    reason = {
        "code": code,
        "message": code,
        "retryable": True,
        "outcome_unknown": True,
    }

    for run in orphan_runs:
        run.status = "abandoned"
        run.result_json = {
            "status": "abandoned",
            "task_summary": code,
            "error": dict(reason),
        }
        run.finished_at = now
        run.updated_at = now
        run.lease_owner = None
        run.lease_expires_at = None
        db.add(run)

    orphan_frame_ids = {row.id for row in orphan_frames}
    orphan_frame_ids.update(row.task_frame_record_id for row in orphan_runs)
    frames_by_id = {row.id: row for row in active_frames}
    recovered_frame_count = 0
    for frame_id in orphan_frame_ids:
        frame = frames_by_id.get(frame_id) or db.get(HarnessTaskFrameRecord, frame_id)
        if frame is None or frame.status != "running":
            continue
        # Keep the current step, slots and checkpoint.  The next user turn can
        # claim this frame again, but this vanished attempt is never replayed.
        frame.status = "queued"
        frame.result_json = {
            "task_frame_id": frame.task_id,
            "status": "interrupted",
            "task_summary": code,
            "error": dict(reason),
        }
        frame.error_json = dict(reason)
        frame.lease_owner = None
        frame.lease_expires_at = None
        frame.updated_at = now
        frame.state_version = max(1, int(frame.state_version or 0) + 1)
        db.add(frame)
        recovered_frame_count += 1
        if frame.agent_loop_id:
            loop = db.get(HarnessAgentLoopRecord, frame.agent_loop_id)
            if loop is not None and loop.status not in {"completed", "cancelled", "failed"}:
                loop.status = "suspended"
                loop.updated_at = now
                loop.state_version = max(1, int(loop.state_version or 0) + 1)
                db.add(loop)

    message_count = 0
    for turn in orphan_turns:
        turn.status = "failed"
        turn.error_json = dict(reason)
        turn.finished_at = now
        turn.updated_at = now
        turn.lease_expires_at = now
        db.add(turn)
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
                source_turn_id
                and row.tenant_id == turn.tenant_id
                and row.session_id == turn.session_id
                and row.source_turn_id == source_turn_id
            )
        }
        related_rows = [
            row
            for row in active_frames
            if row.id in related_frame_ids
        ]
        related_rows.extend(
            row
            for row in active_runs
            if (
                source_turn_id
                and row.tenant_id == turn.tenant_id
                and row.session_id == turn.session_id
                and (
                    row.source_turn_id == source_turn_id
                    or row.task_frame_record_id in related_frame_ids
                )
            )
        )
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
            code=code,
            now=now,
            language_context=language_context,
        ):
            message_count += 1

    # A corrupt or partially persisted execution may have a Run/TaskFrame but
    # no turn receipt.  It must still release the chat session for a new turn.
    for tenant_id, session_id in affected_session_keys:
        session = db.get(ChatSession, session_id)
        if session is None or session.tenant_id != tenant_id:
            continue
        session.status = "active"
        session.updated_at = now
        db.add(session)

    # A dead owner must never keep blocking the next turn.
    for tenant_id, session_id in affected_session_keys:
        db.exec(
            delete(HarnessSessionLeaseRecord).where(
                HarnessSessionLeaseRecord.tenant_id == tenant_id,
                HarnessSessionLeaseRecord.session_id == session_id,
            )
        )
    db.commit()
    return HarnessRecoveryResult(
        run_count=len(orphan_runs),
        frame_count=recovered_frame_count,
        turn_count=len(orphan_turns),
        session_count=len(affected_session_keys),
        message_count=message_count,
    )


def _append_recovery_message(
    db: Session,
    session: ChatSession,
    turn: HarnessTurnRecord,
    *,
    code: str,
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
        "retryable": True,
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

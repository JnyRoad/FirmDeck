"""RED contracts for scheduled-task tenant lifecycle admission and recovery fences."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import AgentProfile, ScheduledTask, ScheduledTaskRun, Tenant, User
from app.scheduled_tasks import service as scheduled_service
from app.scheduled_tasks import worker as scheduled_worker
from app.security.tenant import TenantLifecycleDenied

_TENANT_ID = "tenant-scheduled"
_AGENT_ID = "agent-scheduled"
_USER_ID = "user-scheduled"
_TASK_ID = "scheduled-lifecycle"
_DUE_AT = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)


def _engine() -> object:
    """Create an isolated in-memory database for one lifecycle contract case."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _file_engine(path: Path) -> object:
    """Create a file-backed database so independent Sessions can exercise a commit race."""
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    with engine.connect() as connection:
        # WAL lets the independent race participants keep reading while one writer commits.
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.exec_driver_sql("PRAGMA busy_timeout=30000")
        connection.commit()
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_scheduled_task(
    db: Session,
    *,
    tenant_status: str,
    lifecycle_version: int,
    scheduled_for: datetime = _DUE_AT,
) -> tuple[Tenant, ScheduledTask]:
    """Persist only the tenant control rows required to exercise one scheduled occurrence."""
    tenant = Tenant(
        id=_TENANT_ID,
        slug="scheduled-lab",
        name="Scheduled Lifecycle Lab",
        status=tenant_status,
        lifecycle_version=lifecycle_version,
    )
    user = User(
        id=_USER_ID,
        tenant_id=_TENANT_ID,
        username="scheduler-admin",
        role="admin",
        password_hash="test-password-hash",
    )
    agent = AgentProfile(
        id=_AGENT_ID,
        tenant_id=_TENANT_ID,
        name="Scheduled Agent",
        status="active",
    )
    task = ScheduledTask(
        id=_TASK_ID,
        tenant_id=_TENANT_ID,
        agent_id=_AGENT_ID,
        created_by_user_id=_USER_ID,
        title="生命周期日报",
        prompt="生成一份不应在停用租户中执行的日报",
        schedule_type="daily",
        schedule_json={"time": "12:00"},
        timezone="UTC",
        status="active",
        concurrency_policy="forbid",
        misfire_policy="coalesce",
        next_run_at=scheduled_for,
    )
    db.add_all([tenant, user, agent, task])
    db.commit()
    db.refresh(tenant)
    db.refresh(task)
    return tenant, task


def _suspend(db: Session, tenant: Tenant) -> None:
    """Apply the minimum committed suspension transition used to model a claim race."""
    tenant.status = "suspended"
    tenant.lifecycle_version += 1
    db.add(tenant)
    db.commit()
    db.refresh(tenant)


def _error_code(run: ScheduledTaskRun) -> str | None:
    """Read only the stable persisted lifecycle reason from a scheduled run error envelope."""
    if not run.error:
        return None
    payload = json.loads(run.error)
    if not isinstance(payload, dict):
        return None
    code = payload.get("code") or payload.get("reason")
    return code if isinstance(code, str) else None


def _assert_suspended_terminal_run(run: ScheduledTaskRun) -> None:
    """Require a non-retryable cancellation with no raw task content in its public error."""
    assert run.status == "cancelled"
    assert run.finished_at is not None
    assert _error_code(run) == "TENANT_SUSPENDED"
    assert "生成一份不应在停用租户中执行的日报" not in repr(run.error)
    assert "password" not in repr(run.error).lower()


def _agent_loop_must_not_run(calls: list[str]):
    """Return a deterministic AgentLoop double that records any forbidden construction or call."""

    class ForbiddenAgentLoop:
        """Fail the test immediately if suspended scheduled work reaches AgentLoop."""

        def __init__(self, _db: Session) -> None:
            """Record construction without touching a provider or any external service."""
            calls.append("construct")

        def handle_turn_stream(self, _request):
            """Record invocation and raise so a missing lifecycle gate cannot look successful."""
            calls.append("handle_turn_stream")
            raise AssertionError("suspended scheduled work reached AgentLoop")

    return ForbiddenAgentLoop


def test_suspended_due_occurrence_is_cancelled_and_schedule_advances() -> None:
    """A due scan must terminalize a suspended occurrence and avoid claiming it for execution."""
    engine = _engine()
    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="suspended",
            lifecycle_version=2,
        )

        claimed = scheduled_service.due_scheduled_tasks(db, now=_DUE_AT)

        assert claimed == []
        db.refresh(task)
        runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(runs) == 1
        _assert_suspended_terminal_run(runs[0])
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status == "cancelled"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


def test_suspension_after_due_claim_fences_agent_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """A tenant suspension committed after claim must cancel the run before AgentLoop construction."""
    engine = _engine()
    calls: list[str] = []
    monkeypatch.setattr(
        scheduled_service,
        "AgentLoop",
        _agent_loop_must_not_run(calls),
    )

    with Session(engine) as db:
        tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )
        claimed = scheduled_service.due_scheduled_tasks(db, now=_DUE_AT)
        assert [row.id for row in claimed] == [task.id]

        _suspend(db, tenant)
        run = scheduled_service.execute_scheduled_task(
            db,
            claimed[0],
            scheduled_for=_DUE_AT,
        )

        assert calls == []
        _assert_suspended_terminal_run(run)
        assert task.last_status != "succeeded"


def test_suspended_running_run_never_calls_agent_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """A prepared running run must be rechecked before its first AgentLoop side effect."""
    engine = _engine()
    calls: list[str] = []
    monkeypatch.setattr(
        scheduled_service,
        "AgentLoop",
        _agent_loop_must_not_run(calls),
    )

    with Session(engine) as db:
        tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )
        run = scheduled_service._prepare_scheduled_task_run(
            db,
            task,
            _DUE_AT,
            manual=True,
        )
        assert run.status == "running"

        _suspend(db, tenant)
        terminal = scheduled_service._execute_prepared_scheduled_task(
            db,
            task,
            run,
            manual=True,
        )

        assert calls == []
        _assert_suspended_terminal_run(terminal)


def test_suspended_occurrence_cannot_mark_parent_schedule_succeeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancellation must update the parent schedule as terminal cancellation, never ordinary success."""
    engine = _engine()
    calls: list[str] = []
    monkeypatch.setattr(
        scheduled_service,
        "AgentLoop",
        _agent_loop_must_not_run(calls),
    )

    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="suspended",
            lifecycle_version=2,
        )
        run = scheduled_service.execute_scheduled_task(
            db,
            task,
            scheduled_for=_DUE_AT,
            manual=False,
        )

        assert calls == []
        _assert_suspended_terminal_run(run)
        db.refresh(task)
        assert task.last_status == "cancelled"
        assert task.run_count == 1
        assert task.status == "active"
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


def test_worker_restart_does_not_dispatch_suspended_due_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh worker scan must reuse the lifecycle fence instead of redispatching suspended work."""
    engine = _engine()
    calls: list[str] = []
    monkeypatch.setattr(
        scheduled_service,
        "AgentLoop",
        _agent_loop_must_not_run(calls),
    )
    monkeypatch.setattr(scheduled_worker, "engine", engine)
    monkeypatch.setattr(scheduled_worker, "init_db", lambda: None)
    monkeypatch.setattr(scheduled_worker, "seed_demo_data", lambda _db: None)
    scheduled_worker._stopped = False

    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="suspended",
            lifecycle_version=2,
        )

    scheduled_worker.run_worker(once=True, poll_seconds=0)

    with Session(engine) as db:
        task = db.get(ScheduledTask, _TASK_ID)
        assert task is not None
        runs = db.exec(
            select(ScheduledTaskRun).where(ScheduledTaskRun.scheduled_task_id == _TASK_ID)
        ).all()
        assert calls == []
        assert len(runs) == 1
        _assert_suspended_terminal_run(runs[0])
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


def test_fast_reactivation_does_not_backfill_terminalized_occurrence() -> None:
    """Reactivation must admit only later occurrences and never reopen an old cancelled due time."""
    engine = _engine()
    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=3,
        )
        run = ScheduledTaskRun(
            id="scheduled-cancelled-before-reactivation",
            tenant_id=_TENANT_ID,
            tenant_lifecycle_version=1,
            scheduled_task_id=task.id,
            agent_id=_AGENT_ID,
            user_id=_USER_ID,
            scheduled_for=_DUE_AT,
            status="cancelled",
            finished_at=_DUE_AT + timedelta(seconds=1),
            error=json.dumps(
                {"code": "TENANT_SUSPENDED", "params": {}, "retryable": False},
                sort_keys=True,
            ),
        )
        db.add(run)
        db.commit()

        due_after_reactivation = scheduled_service.due_scheduled_tasks(
            db,
            now=_DUE_AT,
        )

        assert due_after_reactivation == []
        db.refresh(task)
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT
        assert task.run_count == 1
        persisted_runs = db.exec(
            select(ScheduledTaskRun).where(ScheduledTaskRun.scheduled_task_id == task.id)
        ).all()
        assert len(persisted_runs) == 1
        assert persisted_runs[0].status == "cancelled"


def test_completion_cas_zero_terminalizes_run_and_never_marks_parent_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lifecycle version change after the final fence must not strand a running completion."""
    engine = _engine()

    class CompletingAgentLoop:
        """Return one complete response without calling a provider."""

        def __init__(self, _db: Session) -> None:
            """Keep the fake side-effect free while exercising the scheduler completion path."""

        def handle_turn_stream(self, request):
            """Emit the complete response shape consumed by the real scheduler."""
            yield {
                "event": "complete",
                "data": {
                    "reply": "已完成",
                    "session_id": request.session_id,
                    "session_state": {
                        "session_id": request.session_id,
                        "tenant_id": request.tenant_id,
                    },
                },
            }

    monkeypatch.setattr(scheduled_service, "AgentLoop", CompletingAgentLoop)
    monkeypatch.setattr(
        scheduled_service,
        "_ensure_scheduled_execution_agent",
        lambda _db, _task: object(),
    )

    def stale_outcome(db: Session, _run: ScheduledTaskRun, _result: object) -> dict[str, object]:
        """Win the tenant lifecycle race after the final admission check and before completion CAS."""
        tenant = db.get(Tenant, _TENANT_ID)
        assert tenant is not None
        tenant.status = "suspended"
        tenant.lifecycle_version += 1
        db.add(tenant)
        db.commit()
        return {"status": "succeeded", "trace": {}}

    monkeypatch.setattr(scheduled_service, "_scheduled_harness_outcome", stale_outcome)

    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )
        claimed = scheduled_service.due_scheduled_tasks(db, now=_DUE_AT)
        assert [row.id for row in claimed] == [task.id]
        run = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).one()

        terminal = scheduled_service._execute_prepared_scheduled_task(
            db,
            task,
            run,
            manual=False,
        )

        assert terminal.status == "cancelled"
        assert terminal.finished_at is not None
        assert _error_code(terminal) == "EXTERNAL_OUTCOME_UNKNOWN"
        db.refresh(task)
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status != "succeeded"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


def test_running_orphan_without_session_is_recovered_and_parent_schedule_advances() -> None:
    """A stale run without its session must converge instead of blocking every future due scan."""
    engine = _engine()
    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )
        task.lease_owner = "stale-worker"
        task.lease_until = _DUE_AT - timedelta(seconds=1)
        orphan = ScheduledTaskRun(
            id="scheduled-orphan-without-session",
            tenant_id=_TENANT_ID,
            tenant_lifecycle_version=1,
            scheduled_task_id=task.id,
            agent_id=_AGENT_ID,
            user_id=_USER_ID,
            scheduled_for=_DUE_AT,
            status="running",
            started_at=_DUE_AT - timedelta(seconds=2),
        )
        db.add_all([task, orphan])
        db.commit()

        claimed = scheduled_service.due_scheduled_tasks(db, now=_DUE_AT)

        assert claimed == []
        db.refresh(task)
        db.refresh(orphan)
        assert orphan.status in {"cancelled", "failed"}
        assert orphan.finished_at is not None
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status != "succeeded"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT
        persisted_runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(persisted_runs) == 1


def test_suspended_occurrence_unique_key_race_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two concurrent cancellation callers must leave one terminal occurrence without surfacing IntegrityError."""
    engine = _file_engine(tmp_path / "scheduled-cancel-race.sqlite")
    barrier = threading.Barrier(2)
    original_create_run = scheduled_service._create_run

    def synchronized_create_run(*args, **kwargs):
        """Ensure both Sessions pass the read-before-insert window before either commit."""
        barrier.wait(timeout=10)
        return original_create_run(*args, **kwargs)

    monkeypatch.setattr(scheduled_service, "_create_run", synchronized_create_run)

    with Session(engine) as db:
        _seed_scheduled_task(
            db,
            tenant_status="suspended",
            lifecycle_version=2,
        )

    errors: list[BaseException] = []

    def cancel_from_independent_session() -> None:
        """Run the same suspended occurrence cancellation from a second database Session."""
        try:
            with Session(engine) as db:
                task = db.get(ScheduledTask, _TASK_ID)
                assert task is not None
                scheduled_service._cancel_scheduled_occurrence(
                    db,
                    task,
                    _DUE_AT,
                    manual=False,
                    code="TENANT_SUSPENDED",
                )
        except BaseException as exc:  # noqa: BLE001 - the contract asserts no race exception escapes
            errors.append(exc)

    threads = [
        threading.Thread(target=cancel_from_independent_session, daemon=True)
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=35)

    assert not any(thread.is_alive() for thread in threads)
    assert errors == []

    with Session(engine) as db:
        task = db.get(ScheduledTask, _TASK_ID)
        assert task is not None
        runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == _TASK_ID,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(runs) == 1
        assert runs[0].status == "cancelled"
        assert _error_code(runs[0]) == "TENANT_SUSPENDED"
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status == "cancelled"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


@pytest.mark.parametrize(
    "denial_code",
    ["TENANT_NOT_FOUND", "TENANT_LIFECYCLE_CHECK_FAILED"],
)
def test_non_admissible_tenant_denial_terminalizes_occurrence_without_polling_forever(
    monkeypatch: pytest.MonkeyPatch,
    denial_code: str,
) -> None:
    """Missing or corrupt lifecycle state must produce one stable terminal occurrence."""
    engine = _engine()

    def reject_tenant(_db: Session, _task: ScheduledTask, _correlation_id: str):
        """Inject the central gate's stable denial code while keeping scheduler behavior real."""
        raise TenantLifecycleDenied(
            denial_code,
            {
                "tenant_id": None if denial_code == "TENANT_NOT_FOUND" else _TENANT_ID,
                "execution_kind": "job.claim",
                "correlation_id": _TASK_ID,
            },
        )

    monkeypatch.setattr(scheduled_service, "_scheduled_tenant_decision", reject_tenant)

    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )

        assert scheduled_service.due_scheduled_tasks(db, now=_DUE_AT) == []
        db.refresh(task)
        runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(runs) == 1
        assert runs[0].status == "cancelled"
        assert _error_code(runs[0]) == "TENANT_WORK_TERMINALIZED"
        assert task.last_status == "cancelled"
        assert task.run_count == 1
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT

        # A second poll at the same due time must not create a duplicate or retry forever.
        assert scheduled_service.due_scheduled_tasks(db, now=_DUE_AT) == []
        persisted_runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(persisted_runs) == 1


def test_cancellation_race_with_running_winner_still_terminalizes_parent_schedule(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cancellation losing the occurrence insert race must still close a competing running run."""
    engine = _file_engine(tmp_path / "scheduled-cancel-running-race.sqlite")
    with Session(engine) as db:
        _seed_scheduled_task(
            db,
            tenant_status="suspended",
            lifecycle_version=2,
        )

    original_create_run = scheduled_service._create_run
    injected = False

    def competing_running_run(db, task, scheduled_for, status, **kwargs):
        """Insert the competing running occurrence after the cancellation read but before its commit."""
        nonlocal injected
        if status == "cancelled" and not injected:
            injected = True
            with Session(engine) as winner_db:
                winner_db.add(
                    ScheduledTaskRun(
                        id="scheduled-running-wins-cancel-race",
                        tenant_id=task.tenant_id,
                        tenant_lifecycle_version=1,
                        scheduled_task_id=task.id,
                        agent_id=task.agent_id,
                        user_id=task.created_by_user_id,
                        session_id="session-existing",
                        scheduled_for=scheduled_for,
                        status="running",
                    )
                )
                winner_db.commit()
        return original_create_run(db, task, scheduled_for, status, **kwargs)

    monkeypatch.setattr(scheduled_service, "_create_run", competing_running_run)

    with Session(engine) as db:
        task = db.get(ScheduledTask, _TASK_ID)
        assert task is not None
        terminal = scheduled_service._cancel_scheduled_occurrence(
            db,
            task,
            _DUE_AT,
            manual=False,
            code="TENANT_SUSPENDED",
        )
        assert terminal.status == "cancelled"

    with Session(engine) as db:
        task = db.get(ScheduledTask, _TASK_ID)
        assert task is not None
        runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == _TASK_ID,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(runs) == 1
        assert runs[0].status == "cancelled"
        assert _error_code(runs[0]) == "TENANT_SUSPENDED"
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status == "cancelled"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT


def test_existing_succeeded_run_advances_parent_schedule_when_occurrence_is_still_due() -> None:
    """A terminal success row must reconcile a stale parent schedule instead of remaining due forever."""
    engine = _engine()
    with Session(engine) as db:
        _tenant, task = _seed_scheduled_task(
            db,
            tenant_status="active",
            lifecycle_version=1,
        )
        succeeded = ScheduledTaskRun(
            id="scheduled-succeeded-before-parent-advance",
            tenant_id=_TENANT_ID,
            tenant_lifecycle_version=1,
            scheduled_task_id=task.id,
            agent_id=_AGENT_ID,
            user_id=_USER_ID,
            scheduled_for=_DUE_AT,
            status="succeeded",
            finished_at=_DUE_AT + timedelta(seconds=1),
        )
        db.add(succeeded)
        db.commit()

        assert scheduled_service.due_scheduled_tasks(db, now=_DUE_AT) == []
        db.refresh(task)
        assert task.lease_owner is None
        assert task.lease_until is None
        assert task.last_status == "succeeded"
        assert task.run_count == 1
        assert task.next_run_at is not None
        assert task.next_run_at > _DUE_AT
        persisted_runs = db.exec(
            select(ScheduledTaskRun).where(
                ScheduledTaskRun.scheduled_task_id == task.id,
                ScheduledTaskRun.scheduled_for == _DUE_AT,
            )
        ).all()
        assert len(persisted_runs) == 1
        assert persisted_runs[0].status == "succeeded"

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import (
    AgentProfile,
    ChatSession,
    Team,
    TeamMember,
    TeamRun,
    TeamTask,
    TeamTaskBid,
    TeamTaskEvent,
    TeamWakeEvent,
    Tenant,
    utc_now,
)
from app.session.session_schema import PlannedTaskFrame
from app.teams import sweeper, wakeup
from app.teams.wakeup import (
    claim_wake_event,
    dispatch_pending_wake_events,
    execute_wake_event,
    recover_orphaned_wake_events,
)


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _session() -> Session:
    return Session(_engine())


def _seed_team(
    db: Session,
    *,
    tenant_status: str = "active",
    tenant_lifecycle_version: int = 1,
) -> Team:
    """Create only the durable team boundary needed by lifecycle tests."""
    tenant = Tenant(
        id="tenant_demo",
        name="Demo",
        status=tenant_status,
        lifecycle_version=tenant_lifecycle_version,
    )
    team = Team(
        id="team_demo",
        tenant_id=tenant.id,
        name="Lifecycle team",
        owner_user_id="user_admin",
    )
    db.add_all(
        [
            tenant,
            AgentProfile(id="agent_tl", tenant_id=tenant.id, name="TL"),
            AgentProfile(id="agent_worker", tenant_id=tenant.id, name="Worker"),
            team,
            TeamMember(team_id=team.id, agent_id="agent_tl", role="leader"),
            TeamMember(team_id=team.id, agent_id="agent_worker", role="member"),
            ChatSession(
                id="session_tl",
                tenant_id=tenant.id,
                user_id="user_admin",
                agent_id="agent_tl",
                team_id=team.id,
                title="Lifecycle team TL",
            ),
        ]
    )
    db.commit()
    db.refresh(team)
    return team


def _seed_task_and_wake(
    db: Session,
    team: Team,
    *,
    task_id: str = "task_lifecycle",
    wake_id: str = "wake_lifecycle",
    task_status: str = "pending",
    wake_status: str = "pending",
    tenant_lifecycle_version: int = 1,
    updated_at=None,
    team_run_id: str | None = None,
) -> tuple[TeamTask, TeamWakeEvent]:
    task = TeamTask(
        id=task_id,
        team_id=team.id,
        tenant_id=team.tenant_id,
        tenant_lifecycle_version=tenant_lifecycle_version,
        team_run_id=team_run_id,
        title="Lifecycle task",
        status=task_status,
        assignee_agent_id="agent_worker",
        updated_at=updated_at or utc_now(),
    )
    wake = TeamWakeEvent(
        id=wake_id,
        team_id=team.id,
        tenant_id=team.tenant_id,
        tenant_lifecycle_version=tenant_lifecycle_version,
        target_agent_id="agent_worker",
        trigger_type="task_assigned",
        payload_json={
            "task_id": task.id,
            **({"team_run_id": team_run_id} if team_run_id else {}),
        },
        status=wake_status,
        updated_at=updated_at or utc_now(),
    )
    db.add_all([task, wake])
    db.commit()
    db.refresh(task)
    db.refresh(wake)
    return task, wake


def _lifecycle_error(exc: BaseException) -> str | None:
    return getattr(exc, "code", None)


def _reclaim_wake(
    db: Session,
    wake: TeamWakeEvent,
    *,
    owner: str = "worker-new",
    generation: int | None = None,
) -> None:
    """Model recovery/new-claim winning while the old worker is in a turn."""
    old_generation = int(wake.worker_generation or 0)
    next_generation = generation if generation is not None else old_generation + 1
    with Session(db.get_bind()) as successor_db:
        result = successor_db.exec(
            update(TeamWakeEvent)
            .where(
                TeamWakeEvent.id == wake.id,
                TeamWakeEvent.status == "claimed",
                TeamWakeEvent.worker_owner == wake.worker_owner,
                TeamWakeEvent.worker_generation == old_generation,
            )
            .values(
                worker_owner=owner,
                worker_generation=next_generation,
                worker_lease_until=utc_now() + timedelta(minutes=3),
                updated_at=utc_now(),
            )
        )
        assert result.rowcount == 1
        successor_db.commit()


def test_team_run_task_and_wake_inherit_the_authoritative_admission_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A team plan must retain one immutable tenant version across derived rows."""
    with _session() as db:
        team = _seed_team(db, tenant_lifecycle_version=7)
        started: list[str] = []
        monkeypatch.setattr(wakeup, "start_wakeup_async", started.append)
        session = db.get(ChatSession, "session_tl")
        assert session is not None

        result = wakeup.publish_team_planner_frames(
            db,
            team=team,
            session=session,
            source_turn_id="source-turn-version",
            created_by_user_id="user_admin",
            frames=[
                PlannedTaskFrame(
                    task_id="versioned-task",
                    user_intent="Versioned member work",
                    requirements=["Keep the admission snapshot"],
                    execution_target="team_member",
                    assignee_agent_id="agent_worker",
                )
            ],
        )

        assert result is not None
        run = db.get(TeamRun, result.run_id)
        task = db.get(TeamTask, result.task_ids[0])
        wake = db.exec(select(TeamWakeEvent)).one()
        assert run is not None and run.tenant_lifecycle_version == 7
        assert task is not None and task.tenant_lifecycle_version == 7
        assert wake.tenant_lifecycle_version == 7
        assert started == [wake.id]


def test_suspended_team_plan_is_denied_before_creating_executable_rows() -> None:
    """Suspension must fail closed before a run, task, or member wake is persisted."""
    with _session() as db:
        team = _seed_team(db, tenant_status="suspended", tenant_lifecycle_version=2)
        session = db.get(ChatSession, "session_tl")
        assert session is not None

        with pytest.raises(Exception) as exc_info:
            wakeup.publish_team_planner_frames(
                db,
                team=team,
                session=session,
                source_turn_id="source-turn-suspended",
                created_by_user_id="user_admin",
                frames=[
                    PlannedTaskFrame(
                        task_id="must-not-run",
                        user_intent="No work while suspended",
                        execution_target="team_member",
                        assignee_agent_id="agent_worker",
                    )
                ],
            )

        assert _lifecycle_error(exc_info.value) == "TENANT_SUSPENDED"
        assert db.exec(select(TeamRun)).all() == []
        assert db.exec(select(TeamTask)).all() == []
        assert db.exec(select(TeamWakeEvent)).all() == []


def test_wake_claim_race_rechecks_lifecycle_before_agentloop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A claimed wake must not enter AgentLoop after a concurrent suspension."""
    engine = _engine()
    with Session(engine) as setup:
        team = _seed_team(setup)
        _task, wake = _seed_task_and_wake(setup, team)
        wake_id = wake.id
        team_id = team.id

    # Separate sessions model two workers racing on the same conditional claim.
    with Session(engine) as claimant_one, Session(engine) as claimant_two:
        assert claim_wake_event(claimant_one, wake_id) is True
        assert claim_wake_event(claimant_two, wake_id) is False

    with Session(engine) as control:
        tenant = control.get(Tenant, "tenant_demo")
        assert tenant is not None
        tenant.status = "suspended"
        tenant.lifecycle_version = 2
        control.add(tenant)
        control.commit()

    with Session(engine) as db:
        wake = db.get(TeamWakeEvent, wake_id)
        assert wake is not None
        agent_loop_calls: list[str] = []

        def forbidden_agent_turn(*_args: object, **_kwargs: object) -> object:
            agent_loop_calls.append("called")
            raise AssertionError("suspended wake reached AgentLoop")

        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_agent_turn)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        result = execute_wake_event(db, wake)

        assert agent_loop_calls == []
        assert result.status == "failed"
        assert result.error == "TENANT_SUSPENDED"
        stored_task = db.exec(
            select(TeamTask).where(TeamTask.team_id == team_id, TeamTask.id == "task_lifecycle")
        ).one()
        assert stored_task.status == "escalated"
        assert db.exec(select(ChatSession).where(ChatSession.id != "session_tl")).all() == []


def test_stale_wake_completion_after_suspend_cannot_mark_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker holding a pre-suspension claim cannot publish ordinary success."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-stale-completion",
            wake_id="wake-stale-completion",
            task_status="in_progress",
            wake_status="claimed",
        )
        tenant = db.get(Tenant, team.tenant_id)
        assert tenant is not None
        tenant.status = "suspended"
        tenant.lifecycle_version = 2
        db.add(tenant)
        db.commit()

        def fake_member_execution(*_args: object, **_kwargs: object) -> None:
            """Model a worker that finished using the old claim."""
            task.status = "review"
            db.add(task)

        monkeypatch.setattr(wakeup, "_execute_member_task", fake_member_execution)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        result = execute_wake_event(db, wake)

        assert result.status == "failed"
        assert result.error == "TENANT_SUSPENDED"
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None and stored_task.status == "escalated"


def test_timeout_sweep_terminalizes_suspended_team_work_with_stable_reason() -> None:
    """Timeout handling must not turn suspended work into an ordinary timeout retry."""
    with _session() as db:
        team = _seed_team(db, tenant_status="suspended", tenant_lifecycle_version=2)
        team.config_json = {"task_timeout_minutes": 1}
        db.add(team)
        db.commit()
        stale_at = utc_now() - timedelta(minutes=10)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-timeout-suspended",
            wake_id="wake-timeout-suspended",
            task_status="in_progress",
            updated_at=stale_at,
        )

        escalated = sweeper.sweep_timed_out_tasks(db, now=utc_now())

        assert [item.id for item in escalated] == [task.id]
        stored_task = db.get(TeamTask, task.id)
        stored_wake = db.get(TeamWakeEvent, wake.id)
        assert stored_task is not None and stored_task.status == "escalated"
        assert stored_wake is not None
        assert stored_wake.status == "failed"
        assert stored_wake.error == "TENANT_SUSPENDED"


def test_suspended_orphan_recovery_terminalizes_wake_task_and_run_without_requeue() -> None:
    """Startup recovery must drop a suspended orphan instead of returning it to pending."""
    with _session() as db:
        team = _seed_team(db, tenant_status="suspended", tenant_lifecycle_version=2)
        run = TeamRun(
            id="run-suspended-orphan",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-orphan",
            status="running",
        )
        db.add(run)
        db.commit()
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-suspended-orphan",
            wake_id="wake-suspended-orphan",
            task_status="in_progress",
            wake_status="claimed",
            tenant_lifecycle_version=1,
            updated_at=utc_now() - timedelta(minutes=10),
            team_run_id=run.id,
        )

        recovered = recover_orphaned_wake_events(
            db,
            now=utc_now(),
            lease_timeout_seconds=60,
        )

        assert recovered == [wake.id]
        stored_wake = db.get(TeamWakeEvent, wake.id)
        stored_task = db.get(TeamTask, task.id)
        stored_run = db.get(TeamRun, run.id)
        assert stored_wake is not None and stored_wake.status == "failed"
        assert stored_wake.error == "TENANT_SUSPENDED"
        assert stored_task is not None and stored_task.status == "escalated"
        assert stored_run is not None and stored_run.status == "failed"


def test_fast_reactivation_does_not_redispatch_a_pre_transition_team_wake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reactivation increments the version; an old wake stays terminal and is never replayed."""
    with _session() as db:
        team = _seed_team(db, tenant_lifecycle_version=3)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-fast-reactivation",
            wake_id="wake-fast-reactivation",
            task_status="in_progress",
            wake_status="claimed",
            tenant_lifecycle_version=1,
            updated_at=utc_now() - timedelta(minutes=10),
        )

        recovered = recover_orphaned_wake_events(
            db,
            now=utc_now(),
            lease_timeout_seconds=60,
        )

        assert recovered == [wake.id]
        stored_wake = db.get(TeamWakeEvent, wake.id)
        stored_task = db.get(TeamTask, task.id)
        assert stored_wake is not None and stored_wake.status == "failed"
        assert stored_wake.error == "TENANT_LIFECYCLE_CHECK_FAILED"
        assert stored_task is not None and stored_task.status == "escalated"

        dispatched: list[str] = []
        monkeypatch.setattr(wakeup, "start_wakeup_async", dispatched.append)
        assert dispatch_pending_wake_events(db, now=utc_now()) == []
        assert dispatched == []


def test_orphan_reclaim_fences_the_old_wake_worker_after_a_new_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker with an expired claim must not overwrite its successor's terminal result."""
    engine = _engine()
    with Session(engine) as setup:
        team = _seed_team(setup)
        _task, wake = _seed_task_and_wake(
            setup,
            team,
            task_id="task-orphan-reclaim",
            wake_id="wake-orphan-reclaim",
        )
        assert claim_wake_event(setup, wake.id) is True
        claimed = setup.get(TeamWakeEvent, wake.id)
        assert claimed is not None and claimed.status == "claimed"
        claimed.updated_at = utc_now() - timedelta(minutes=10)
        setup.add(claimed)
        setup.commit()

    # Keep the first worker's ORM identity alive while recovery and the new
    # claim happen in separate sessions; this models a stale worker without
    # turning its event snapshot into a duplicate INSERT.
    with Session(engine) as old_worker_db:
        old_worker_event = old_worker_db.get(TeamWakeEvent, "wake-orphan-reclaim")
        assert old_worker_event is not None and old_worker_event.status == "claimed"

        with Session(engine) as recovery_db:
            assert recover_orphaned_wake_events(
                recovery_db,
                now=utc_now(),
                lease_timeout_seconds=60,
            ) == ["wake-orphan-reclaim"]

        with Session(engine) as new_worker_db:
            assert claim_wake_event(new_worker_db, "wake-orphan-reclaim") is True
            new_worker_event = new_worker_db.get(TeamWakeEvent, "wake-orphan-reclaim")
            assert new_worker_event is not None and new_worker_event.status == "claimed"

            def new_worker_fails(*_args: object, **_kwargs: object) -> None:
                """Make the successor worker terminalize the wake for a non-lifecycle error."""
                raise RuntimeError("successor worker failed")

            monkeypatch.setattr(wakeup, "_execute_member_task", new_worker_fails)
            monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)
            result = execute_wake_event(new_worker_db, new_worker_event)
            assert result.status == "failed"
            assert result.error == "TEAM_WAKE_EXECUTION_FAILED"

        monkeypatch.setattr(
            wakeup,
            "_execute_member_task",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)
        execute_wake_event(old_worker_db, old_worker_event)

    with Session(engine) as verify_db:
        stored = verify_db.get(TeamWakeEvent, "wake-orphan-reclaim")
        assert stored is not None
        assert stored.status == "failed"
        assert stored.error == "TEAM_WAKE_EXECUTION_FAILED"


def test_member_completion_is_fenced_before_durable_done_after_suspension(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Member completion must not commit done after the tenant changes lifecycle."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-member-fence",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-member-fence",
            status="running",
        )
        db.add(run)
        db.commit()
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-member-fence",
            wake_id="wake-member-fence",
            task_status="in_progress",
            wake_status="claimed",
            team_run_id=run.id,
        )
        tenant = db.get(Tenant, team.tenant_id)
        assert tenant is not None

        def provider_returns_after_suspend(*_args: object, **_kwargs: object):
            tenant.status = "suspended"
            tenant.lifecycle_version = 2
            db.add(tenant)
            db.commit()
            return wakeup.TeamAgentTurnResult(
                reply="member result",
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "run_agent_turn", provider_returns_after_suspend)
        monkeypatch.setattr(
            wakeup,
            "_team_harness_outcome",
            lambda *_args, **_kwargs: "completed",
        )
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        result = execute_wake_event(db, wake)

        assert result.status == "failed"
        assert result.error == "TENANT_SUSPENDED"
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None
        assert stored_task.status == "escalated"


def test_team_synthesis_completion_is_fenced_before_durable_completed_after_suspension(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Synthesis must not commit completed or publish a final message after suspension."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-synthesis-fence",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-synthesis-fence",
            status="running",
        )
        db.add(run)
        db.commit()
        _task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-synthesis-fence",
            wake_id="wake-synthesis-fence",
            task_status="done",
            wake_status="claimed",
            team_run_id=run.id,
        )
        wake.trigger_type = "team_synthesis"
        wake.target_agent_id = "agent_tl"
        wake.payload_json = {"team_run_id": run.id}
        db.add(wake)
        db.commit()
        tenant = db.get(Tenant, team.tenant_id)
        assert tenant is not None

        def provider_returns_after_suspend(*_args: object, **_kwargs: object):
            tenant.status = "suspended"
            tenant.lifecycle_version = 2
            db.add(tenant)
            db.commit()
            return wakeup.TeamAgentTurnResult(
                reply="synthesis result",
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "run_agent_turn", provider_returns_after_suspend)
        monkeypatch.setattr(
            wakeup.AgentLoop,
            "_finalize_turn",
            lambda *_args, **_kwargs: "synthesis result",
        )
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        result = execute_wake_event(db, wake)

        assert result.status == "failed"
        assert result.error == "TENANT_SUSPENDED"
        stored_run = db.get(TeamRun, run.id)
        assert stored_run is not None
        assert stored_run.status == "failed"


def test_member_completion_requires_the_current_wake_claim_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reclaimed wake cannot persist member report/status under the successor claim."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-member-claim-fence",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-member-claim-fence",
            status="running",
        )
        db.add(run)
        db.commit()
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-member-claim-fence",
            wake_id="wake-member-claim-fence",
            task_status="pending",
            wake_status="claimed",
            team_run_id=run.id,
        )
        wake.worker_owner = "worker-old"
        wake.worker_generation = 7
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()

        def turn_returns_after_reclaim(*_args: object, **_kwargs: object):
            """The successor takes the lease before the old worker stores its result."""
            with Session(db.get_bind()) as successor_db:
                successor_db.exec(
                    update(TeamWakeEvent)
                    .where(
                        TeamWakeEvent.id == wake.id,
                        TeamWakeEvent.status == "claimed",
                        TeamWakeEvent.worker_owner == "worker-old",
                        TeamWakeEvent.worker_generation == 7,
                    )
                    .values(
                        worker_owner="worker-new",
                        worker_generation=8,
                        worker_lease_until=utc_now() + timedelta(minutes=3),
                    )
                )
                successor_db.commit()
            return wakeup.TeamAgentTurnResult(
                reply="late member result",
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "run_agent_turn", turn_returns_after_reclaim)
        monkeypatch.setattr(wakeup, "_team_harness_outcome", lambda *_args, **_kwargs: "completed")
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        stored_task = db.get(TeamTask, task.id)
        stored_wake = db.get(TeamWakeEvent, wake.id)
        assert stored_task is not None
        assert stored_task.status == "in_progress"
        assert stored_task.report_json == {}
        assert stored_wake is not None
        assert stored_wake.status == "claimed"
        assert stored_wake.worker_owner == "worker-new"
        assert stored_wake.worker_generation == 8


def test_member_model_call_rechecks_admission_after_prompt_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A suspension while building the member prompt must prevent the model call."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-member-model-gate",
            wake_id="wake-member-model-gate",
            wake_status="claimed",
        )
        wake.worker_owner = "worker-model"
        wake.worker_generation = 3
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        model_calls: list[str] = []

        def suspend_while_building(*_args: object, **_kwargs: object) -> str:
            tenant = db.get(Tenant, team.tenant_id)
            assert tenant is not None
            tenant.status = "suspended"
            tenant.lifecycle_version = 2
            db.add(tenant)
            db.commit()
            return "member prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object):
            model_calls.append("called")
            return wakeup.TeamAgentTurnResult(
                reply="must not be used",
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "build_member_task_message", suspend_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None and stored_task.status == "escalated"


def test_team_synthesis_model_call_rechecks_admission_after_prompt_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A suspension while building synthesis input must prevent the model call."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-synthesis-model-gate",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-synthesis-model-gate",
            status="synthesizing",
        )
        task = TeamTask(
            id="task-synthesis-model-gate",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            team_run_id=run.id,
            title="Completed member work",
            status="done",
            assignee_agent_id="agent_worker",
        )
        wake = TeamWakeEvent(
            id="wake-synthesis-model-gate",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            worker_owner="worker-synthesis",
            worker_generation=5,
            worker_lease_until=utc_now() + timedelta(minutes=3),
            target_agent_id="agent_tl",
            trigger_type="team_synthesis",
            payload_json={"team_run_id": run.id},
            status="claimed",
        )
        db.add_all([run, task, wake])
        db.commit()
        model_calls: list[str] = []

        def suspend_while_building(*_args: object, **_kwargs: object) -> str:
            tenant = db.get(Tenant, team.tenant_id)
            assert tenant is not None
            tenant.status = "suspended"
            tenant.lifecycle_version = 2
            db.add(tenant)
            db.commit()
            return "synthesis prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object):
            model_calls.append("called")
            return wakeup.TeamAgentTurnResult(
                reply="must not be used",
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "build_team_synthesis_message", suspend_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        stored_run = db.get(TeamRun, run.id)
        assert stored_run is not None and stored_run.status == "failed"


def test_member_terminal_write_is_fenced_when_tenant_changes_after_admission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tenant suspension between admission and done write must not commit done."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-member-terminal-fence",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-member-terminal-fence",
            status="running",
        )
        db.add(run)
        db.commit()
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-member-terminal-fence",
            wake_id="wake-member-terminal-fence",
            wake_status="claimed",
            team_run_id=run.id,
        )
        wake.worker_owner = "worker-terminal"
        wake.worker_generation = 4
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        original_gate = wakeup._require_wake_execution_admission
        gate_calls = 0

        def suspend_after_final_gate(*args: object, **kwargs: object):
            nonlocal gate_calls
            decision = original_gate(*args, **kwargs)
            gate_calls += 1
            if gate_calls == 4:
                tenant = db.get(Tenant, team.tenant_id)
                assert tenant is not None
                tenant.status = "suspended"
                tenant.lifecycle_version = 2
                db.add(tenant)
                db.commit()
            return decision

        monkeypatch.setattr(wakeup, "run_agent_turn", lambda *_args, **_kwargs: "member result")
        monkeypatch.setattr(wakeup, "_team_harness_outcome", lambda *_args, **_kwargs: "completed")
        monkeypatch.setattr(wakeup, "_require_wake_execution_admission", suspend_after_final_gate)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None
        assert stored_task.status != "done"
        assert stored_task.report_json == {}


def test_synthesis_claim_and_wake_creation_roll_back_together_on_enqueue_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed synthesis wake insert must not strand its run in synthesizing."""
    with _session() as db:
        team = _seed_team(db)
        run = TeamRun(
            id="run-synthesis-atomic-enqueue",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            tl_session_id="session_tl",
            source_turn_id="source-synthesis-atomic-enqueue",
            status="running",
        )
        task = TeamTask(
            id="task-synthesis-atomic-enqueue",
            team_id=team.id,
            tenant_id=team.tenant_id,
            tenant_lifecycle_version=1,
            team_run_id=run.id,
            title="Completed member work",
            status="done",
            assignee_agent_id="agent_worker",
        )
        db.add_all([run, task])
        db.commit()

        def enqueue_fails(*_args: object, **_kwargs: object):
            raise RuntimeError("injected synthesis wake enqueue failure")

        monkeypatch.setattr(wakeup, "enqueue_wake_event", enqueue_fails)

        with pytest.raises(RuntimeError, match="injected synthesis wake enqueue failure"):
            wakeup.maybe_enqueue_team_synthesis(db, team, run.id)

        db.rollback()
        stored_run = db.get(TeamRun, run.id)
        assert stored_run is not None
        assert stored_run.status == "running"
        assert db.exec(select(TeamWakeEvent)).all() == []


def test_wake_heartbeat_stops_after_database_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A heartbeat DB failure must fail closed so orphan recovery can reclaim the wake."""
    class StopProbe:
        def __init__(self) -> None:
            self.wait_calls = 0
            self.set_calls = 0

        def wait(self, _timeout: float) -> bool:
            self.wait_calls += 1
            return self.wait_calls > 1

        def set(self) -> None:
            self.set_calls += 1

    class FailingSession:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> object:
            raise RuntimeError("database unavailable")

        def __exit__(self, *_args: object) -> None:
            return None

    stop = StopProbe()
    heartbeat_failed = threading.Event()
    monkeypatch.setattr(wakeup, "Session", FailingSession)
    wakeup._wake_heartbeat(
        "wake-heartbeat-failure",
        stop,
        heartbeat_failure_event=heartbeat_failed,
    )  # type: ignore[arg-type]

    assert stop.set_calls == 1
    assert stop.wait_calls == 2
    assert heartbeat_failed.is_set()


def test_heartbeat_failure_fences_main_execution(monkeypatch: pytest.MonkeyPatch) -> None:
    """The main wake executor must stop when its heartbeat can no longer prove ownership."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-heartbeat-main-fence",
            wake_id="wake-heartbeat-main-fence",
            wake_status="claimed",
        )
        wake.worker_owner = "worker-heartbeat"
        wake.worker_generation = 2
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        heartbeat_failed = threading.Event()
        heartbeat_failed.set()
        model_calls: list[str] = []

        def forbidden_model_call(*_args: object, **_kwargs: object) -> object:
            model_calls.append("called")
            raise AssertionError("a wake with a failed heartbeat reached the model")

        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        result = execute_wake_event(
            db,
            wake,
            heartbeat_failure_event=heartbeat_failed,
        )

        assert model_calls == []
        assert result.status == "failed"
        assert result.error == "TEAM_WAKE_HEARTBEAT_FAILED"
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None and stored_task.status == "escalated"


def test_wake_terminal_cas_requires_active_tenant_admission_version() -> None:
    """A terminal wake CAS must reject a tenant that changed lifecycle version."""
    with _session() as db:
        team = _seed_team(db)
        _task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-wake-tenant-cas",
            wake_id="wake-wake-tenant-cas",
            wake_status="claimed",
        )
        wake.worker_owner = "worker-cas"
        wake.worker_generation = 4
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        tenant = db.get(Tenant, team.tenant_id)
        assert tenant is not None
        tenant.lifecycle_version = 2
        db.add(tenant)
        db.commit()

        assert (
            wakeup._cas_wake_event_state(
                db,
                wake,
                worker_owner="worker-cas",
                worker_generation=4,
                expected_status="claimed",
                target_status="done",
                commit=False,
            )
            is False
        )
        db.refresh(wake)
        assert wake.status == "claimed"


def test_tl_review_model_call_rechecks_current_wake_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A recovered TL review must not call the model using the old claim."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-tl-claim-gate",
            wake_id="wake-tl-claim-gate",
            task_status="review",
            wake_status="claimed",
        )
        wake.trigger_type = "task_report"
        wake.target_agent_id = "agent_tl"
        wake.worker_owner = "worker-tl-old"
        wake.worker_generation = 3
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        model_calls: list[str] = []

        def reclaim_while_building(*_args: object, **_kwargs: object) -> str:
            _reclaim_wake(db, wake, owner="worker-tl-new", generation=4)
            return "review prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object) -> object:
            model_calls.append("called")
            return wakeup.TeamAgentTurnResult(
                reply='```json\n{"team_review":{"verdict":"approve","comment":"ok"}}\n```',
                message_id=None,
                metadata={},
                citations=[],
                artifacts=[],
            )

        monkeypatch.setattr(wakeup, "build_tl_review_message", reclaim_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        stored_task = db.get(TeamTask, task.id)
        stored_wake = db.get(TeamWakeEvent, wake.id)
        assert stored_task is not None and stored_task.status == "review"
        assert stored_wake is not None
        assert stored_wake.status == "claimed"
        assert stored_wake.worker_owner == "worker-tl-new"
        assert stored_wake.worker_generation == 4


def test_bid_request_model_call_rechecks_current_wake_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reclaimed candidate wake must not submit a bid from the old claim."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-bid-request-claim-gate",
            wake_id="wake-bid-request-claim-gate",
            task_status="bidding",
            wake_status="claimed",
        )
        wake.trigger_type = "bid_request"
        wake.payload_json = {"task_id": task.id, "round": 1}
        wake.worker_owner = "worker-bid-old"
        wake.worker_generation = 5
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        model_calls: list[str] = []

        def reclaim_while_building(*_args: object, **_kwargs: object) -> str:
            _reclaim_wake(db, wake, owner="worker-bid-new", generation=6)
            return "bid prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object) -> object:
            model_calls.append("called")
            return "```json\n{\"bid\":{\"plan\":\"late\"}}\n```"

        monkeypatch.setattr(wakeup, "build_bid_request_message", reclaim_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        assert db.exec(select(TeamTaskBid).where(TeamTaskBid.task_id == task.id)).all() == []
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None and stored_task.status == "bidding"


def test_bid_score_write_rechecks_current_wake_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reclaimed judge wake must not persist scores from the old generation."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-bid-score-claim-gate",
            wake_id="wake-bid-score-claim-gate",
            task_status="bidding",
            wake_status="claimed",
        )
        wake.trigger_type = "bid_judge"
        wake.target_agent_id = "agent_tl"
        wake.payload_json = {"task_id": task.id, "mode": "score", "round": 1}
        wake.worker_owner = "worker-score-old"
        wake.worker_generation = 7
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.add(
            TeamTaskEvent(
                task_id=task.id,
                team_id=team.id,
                actor_type="system",
                event_type="task_bidding_started",
                payload_json={"candidate_agent_ids": ["agent_worker"]},
            )
        )
        bid = TeamTaskBid(
            task_id=task.id,
            team_id=team.id,
            tenant_id=team.tenant_id,
            agent_id="agent_worker",
            round=1,
            kind="statement",
            content="candidate plan",
        )
        db.add(bid)
        db.commit()
        model_calls: list[str] = []

        def reclaim_while_building(*_args: object, **_kwargs: object) -> str:
            _reclaim_wake(db, wake, owner="worker-score-new", generation=8)
            return "score prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object) -> object:
            model_calls.append("called")
            return '```json\n{"bid_scores":{"agent_worker":{"score":9,"rationale":"late"}}}\n```'

        monkeypatch.setattr(wakeup, "build_bid_score_message", reclaim_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        stored_bid = db.get(TeamTaskBid, bid.id)
        assert stored_bid is not None and stored_bid.score is None


def test_bid_award_write_rechecks_current_wake_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reclaimed award wake must not assign or advance the task from the old claim."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-bid-award-claim-gate",
            wake_id="wake-bid-award-claim-gate",
            task_status="bidding",
            wake_status="claimed",
        )
        task.assignee_agent_id = None
        wake.trigger_type = "bid_judge"
        wake.target_agent_id = "agent_tl"
        wake.payload_json = {"task_id": task.id, "mode": "award"}
        wake.worker_owner = "worker-award-old"
        wake.worker_generation = 9
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.add(
            TeamTaskEvent(
                task_id=task.id,
                team_id=team.id,
                actor_type="system",
                event_type="task_bidding_started",
                payload_json={"candidate_agent_ids": ["agent_worker"]},
            )
        )
        bid = TeamTaskBid(
            task_id=task.id,
            team_id=team.id,
            tenant_id=team.tenant_id,
            agent_id="agent_worker",
            round=1,
            kind="statement",
            content="candidate plan",
        )
        db.add(bid)
        db.commit()
        model_calls: list[str] = []

        def reclaim_while_building(*_args: object, **_kwargs: object) -> str:
            _reclaim_wake(db, wake, owner="worker-award-new", generation=10)
            return "award prompt"

        def forbidden_model_call(*_args: object, **_kwargs: object) -> object:
            model_calls.append("called")
            return '```json\n{"bid_award":{"winner_agent_id":"agent_worker","scores":{},"comment":"late"}}\n```'

        monkeypatch.setattr(wakeup, "build_bid_judge_message", reclaim_while_building)
        monkeypatch.setattr(wakeup, "run_agent_turn", forbidden_model_call)
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        execute_wake_event(db, wake)

        assert model_calls == []
        stored_task = db.get(TeamTask, task.id)
        assert stored_task is not None
        assert stored_task.status == "bidding"
        assert stored_task.assignee_agent_id is None


def test_run_agent_turn_accepts_wake_admission_token_and_fails_closed_before_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Heartbeat/recovery fencing must be checked before a team turn enters Harness."""
    with _session() as db:
        team = _seed_team(db)
        _task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-run-agent-token",
            wake_id="wake-run-agent-token",
            wake_status="claimed",
        )
        wake.worker_owner = "worker-token-old"
        wake.worker_generation = 11
        wake.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(wake)
        db.commit()
        heartbeat_failed = threading.Event()
        heartbeat_failed.set()
        model_calls: list[str] = []

        class ForbiddenLoop:
            def __init__(self, *_args: object, **_kwargs: object) -> None:
                pass

            def handle_turn_stream(self, *_args: object, **_kwargs: object):
                model_calls.append("entered")
                yield {"event": "done", "data": {}}

        monkeypatch.setattr(wakeup, "AgentLoop", ForbiddenLoop)
        with pytest.raises(wakeup._WakeExecutionFenced, match="HEARTBEAT_FAILED"):
            wakeup.run_agent_turn(
                db,
                team=team,
                agent=db.get(AgentProfile, "agent_worker"),
                session_id="session_tl",
                wake_event_id=wake.id,
                message="must not run",
                interaction_mode="team_task",
                heartbeat_failure_event=heartbeat_failed,
            )
        assert model_calls == []


def test_child_bid_judge_wake_carries_parent_claim_fence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A derived bid-judge wake must retain the parent claim identity snapshot."""
    with _session() as db:
        team = _seed_team(db)
        task, parent = _seed_task_and_wake(
            db,
            team,
            task_id="task-child-claim-fence",
            wake_id="wake-child-claim-fence-parent",
            task_status="bidding",
            wake_status="claimed",
        )
        parent.worker_owner = "worker-parent"
        parent.worker_generation = 13
        parent.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(parent)
        db.commit()
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        wakeup._enqueue_bid_judge(
            db,
            team,
            task,
            mode="award",
            event=parent,
        )
        children = db.exec(
            select(TeamWakeEvent).where(
                TeamWakeEvent.id != parent.id,
                TeamWakeEvent.trigger_type == "bid_judge",
            )
        ).all()
        assert len(children) == 1
        payload = children[0].payload_json
        assert payload["parent_wake_event_id"] == parent.id
        assert payload["parent_worker_owner"] == "worker-parent"
        assert payload["parent_worker_generation"] == 13
        assert payload["parent_tenant_lifecycle_version"] == 1


def test_failed_bid_request_followup_wake_keeps_parent_claim_fence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed candidate wake must fence any next-round wake before terminalizing itself."""
    with _session() as db:
        team = _seed_team(db)
        task, parent = _seed_task_and_wake(
            db,
            team,
            task_id="task-failed-bid-child-fence",
            wake_id="wake-failed-bid-child-fence-parent",
            task_status="bidding",
            wake_status="claimed",
        )
        parent.trigger_type = "bid_request"
        parent.payload_json = {"task_id": task.id, "round": 1}
        parent.target_agent_id = "agent_worker"
        parent.worker_owner = "worker-failed-bid"
        parent.worker_generation = 14
        parent.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add_all(
            [
                parent,
                TeamTaskEvent(
                    task_id=task.id,
                    team_id=team.id,
                    actor_type="system",
                    event_type="task_bidding_started",
                    payload_json={"candidate_agent_ids": ["agent_worker", "agent_tl"]},
                ),
                TeamTaskBid(
                    task_id=task.id,
                    team_id=team.id,
                    tenant_id=team.tenant_id,
                    agent_id="agent_tl",
                    round=1,
                    kind="statement",
                    content="existing candidate plan",
                ),
            ]
        )
        db.commit()
        monkeypatch.setattr(wakeup, "run_agent_turn", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider failed")))
        monkeypatch.setattr(wakeup, "start_wakeup_async", lambda _wake_id: True)

        wakeup.execute_wake_event(db, parent)

        children = db.exec(
            select(TeamWakeEvent).where(
                TeamWakeEvent.id != parent.id,
                TeamWakeEvent.trigger_type == "bid_judge",
            )
        ).all()
        assert len(children) == 1
        payload = children[0].payload_json
        assert payload["parent_wake_event_id"] == parent.id
        assert payload["parent_worker_owner"] == "worker-failed-bid"
        assert payload["parent_worker_generation"] == 14
        assert payload["mode"] == "award"
        assert db.get(TeamWakeEvent, parent.id).status == "failed"


def test_sweeper_timeout_cas_does_not_overwrite_a_claimed_successor() -> None:
    """The timeout writer must be a pending-only CAS tied to the task admission."""
    with _session() as db:
        team = _seed_team(db)
        task, wake = _seed_task_and_wake(
            db,
            team,
            task_id="task-sweeper-cas",
            wake_id="wake-sweeper-cas",
            task_status="in_progress",
            wake_status="pending",
            updated_at=utc_now() - timedelta(minutes=10),
        )
        with Session(db.get_bind()) as successor_db:
            result = successor_db.exec(
                update(TeamWakeEvent)
                .where(
                    TeamWakeEvent.id == wake.id,
                    TeamWakeEvent.status == "pending",
                )
                .values(
                    status="claimed",
                    worker_owner="successor",
                    worker_generation=2,
                    worker_lease_until=utc_now() + timedelta(minutes=3),
                )
            )
            assert result.rowcount == 1
            successor_db.commit()

        assert (
            sweeper._cas_pending_wake_timeout(
                db,
                task=task,
                wake=wake,
                now=utc_now(),
            )
            is False
        )
        db.refresh(wake)
        assert wake.status == "claimed"
        assert wake.worker_owner == "successor"


def test_wake_write_fence_rejects_reclaimed_parent_before_visible_side_effect() -> None:
    """A parent claim fence must fail before a stale worker writes an audit/blackboard row."""
    with _session() as db:
        team = _seed_team(db)
        _task, parent = _seed_task_and_wake(
            db,
            team,
            task_id="task-parent-write-fence",
            wake_id="wake-parent-write-fence",
            wake_status="claimed",
        )
        parent.worker_owner = "worker-old"
        parent.worker_generation = 4
        parent.worker_lease_until = utc_now() + timedelta(minutes=3)
        db.add(parent)
        db.commit()
        _reclaim_wake(db, parent, owner="worker-new", generation=5)

        with pytest.raises(wakeup._WakeExecutionFenced, match="WRITE_FENCED"):
            wakeup._fence_wake_write(db, parent)

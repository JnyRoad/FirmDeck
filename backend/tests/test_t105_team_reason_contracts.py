"""T105 contract tests for locale-independent team skip and failure reasons."""

from __future__ import annotations

import json

import pytest
from sqlmodel import select
from test_teams_api import (
    _admin_user,
    _make_task,
    _seed_team,
    _test_session,
)

from app.api import teams as teams_api
from app.db.models import TeamTaskEvent, TeamWakeEvent
from app.teams import wakeup
from app.teams.schema import TeamBlackboardEntryCreateRequest
from app.teams.service import write_blackboard_entries


def test_blackboard_skip_exposes_canonical_reason_and_raw_business_excerpt() -> None:
    """Return a stable skip event and mark the unchanged business excerpt as raw source."""
    with _test_session() as db:
        team = _seed_team(db)
        first, _ = write_blackboard_entries(
            db,
            team=team,
            entries=[{"content": "竞品报价 99 元", "tags": ["pricing"]}],
            source_type="human",
        )
        db.commit()
        assert len(first) == 1

        response = teams_api.create_blackboard_entry(
            team.id,
            TeamBlackboardEntryCreateRequest(
                tenant_id="tenant_demo",
                content="竞品报价 99 元",
            ),
            db,
            _admin_user(),
        )

        assert len(response.skipped) == 1
        skipped = response.skipped[0]
        assert skipped.event_code == "team.blackboard.entry.skipped"
        assert skipped.params == {"reason_code": "duplicate_existing"}
        assert skipped.raw == {"content_excerpt": "竞品报价 99 元"}
        assert skipped.raw_source_markers[0].json_pointer == "/raw/content_excerpt"
        assert skipped.raw_source_markers[0].kind.value == "business_record"


def test_bid_failure_event_uses_typed_reason_params_without_provider_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish only the bid failure code/round while keeping the provider cause private."""
    raw_error = "provider token=secret-t105 /private/bid.sock"

    def fail_bid(*_args: object, **_kwargs: object) -> None:
        """Raise the private cause that must not cross the team event boundary."""
        raise RuntimeError(raw_error)

    with _test_session() as db:
        team = _seed_team(db)
        task = _make_task(db, team, status="bidding")
        wake = wakeup.enqueue_wake_event(
            db,
            team=team,
            target_agent_id="agent_worker",
            trigger_type="bid_request",
            payload={"task_id": task.id, "round": 2},
        )
        db.commit()
        monkeypatch.setattr(wakeup, "_execute_bid_request", fail_bid)
        monkeypatch.setattr(wakeup, "_maybe_advance_bidding", lambda *_a, **_k: None)

        wakeup.execute_wake_event(db, db.get(TeamWakeEvent, wake.id))

        failed = next(
            row
            for row in db.exec(select(TeamTaskEvent)).all()
            if row.event_type == "bid_failed"
        )
        assert failed.payload_json["event_code"] == "team.task.bid.failed"
        assert failed.payload_json["params"] == {
            "reason_code": "execution_failed",
            "round": 2,
        }
        assert failed.payload_json["reason"] == {
            "code": "execution_failed",
            "params": {"round": 2},
        }
        assert raw_error not in json.dumps(failed.payload_json, ensure_ascii=False)
        api_events = teams_api.list_team_events(
            team.id,
            tenant_id="tenant_demo",
            limit=50,
            db=db,
            current_user=_admin_user(),
        )
        api_failed = next(item for item in api_events if item.event_type == "bid_failed")
        assert api_failed.payload["event_code"] == "team.task.bid.failed"
        assert api_failed.payload["params"] == {
            "reason_code": "execution_failed",
            "round": 2,
        }


def test_review_failure_event_is_distinct_and_provider_text_stays_private(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose an acceptance failure descriptor instead of the generic wake exception text."""
    raw_error = "provider token=secret-t105 /private/review.sock"

    def fail_review(*_args: object, **_kwargs: object) -> None:
        """Raise the private review cause that must be retained only in logs."""
        raise RuntimeError(raw_error)

    with _test_session() as db:
        team = _seed_team(db)
        task = _make_task(db, team, status="review")
        wake = wakeup.enqueue_wake_event(
            db,
            team=team,
            target_agent_id="agent_tl",
            trigger_type="task_report",
            payload={"task_id": task.id},
        )
        db.commit()
        monkeypatch.setattr(wakeup, "_execute_tl_review", fail_review)

        wakeup.execute_wake_event(db, db.get(TeamWakeEvent, wake.id))

        escalated = next(
            row
            for row in db.exec(select(TeamTaskEvent)).all()
            if row.event_type == "task_escalated"
        )
        assert escalated.payload_json["event_code"] == "team.task.review.failed"
        assert escalated.payload_json["params"] == {"reason_code": "execution_failed"}
        assert escalated.payload_json["reason"] == {
            "code": "execution_failed",
            "params": {},
        }
        assert raw_error not in json.dumps(escalated.payload_json, ensure_ascii=False)
        api_events = teams_api.list_team_events(
            team.id,
            tenant_id="tenant_demo",
            limit=50,
            db=db,
            current_user=_admin_user(),
        )
        api_escalated = next(
            item for item in api_events if item.event_type == "task_escalated"
        )
        assert api_escalated.payload["event_code"] == "team.task.review.failed"
        assert api_escalated.payload["params"] == {"reason_code": "execution_failed"}


def test_review_repair_failure_publishes_typed_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """Expose an acceptance repair failure as a stable code while keeping the task raw-free."""
    with _test_session() as db:
        team = _seed_team(db)
        task = _make_task(db, team, status="review")
        wake = wakeup.enqueue_wake_event(
            db,
            team=team,
            target_agent_id="agent_tl",
            trigger_type="task_report",
            payload={"task_id": task.id},
        )
        db.commit()
        monkeypatch.setattr(wakeup, "run_agent_turn", lambda *_a, **_k: "not a review")
        monkeypatch.setattr(wakeup, "collect_turn_reply_fragments", lambda *_a, **_k: [])

        wakeup.execute_wake_event(db, db.get(TeamWakeEvent, wake.id))

        failed = next(
            row
            for row in db.exec(select(TeamTaskEvent)).all()
            if row.event_type == "tl_review_repair_failed"
        )
        assert failed.payload_json["event_code"] == "team.task.review.failed"
        assert failed.payload_json["params"] == {"reason_code": "repair_failed"}
        assert failed.payload_json["reason"] == {
            "code": "repair_failed",
            "params": {},
        }

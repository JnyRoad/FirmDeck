"""T094 regression tests for Harness locale boundaries and team progress metadata."""

from types import SimpleNamespace

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.contracts.error_registry import ERROR_REGISTRY
from app.core.harness_v2_engine import (
    _combine_results,
    _enforce_required_slots,
    _team_progress_metadata,
)
from app.core.task_frame_store import TaskFrameStore
from app.core.task_request_compiler import TaskExecutionResult
from app.db.models import ChatSession, Tenant
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.session.session_schema import PlannedTaskFrame, TurnPlan

EXPECTED_HARNESS_RUNTIME_ERRORS = {
    "ACTION_BUDGET_EXHAUSTED",
    "DEPENDENCY_WAITING",
    "HANDOFF_NOT_ALLOWED",
    "HARNESS_ACTION_INVALID",
    "KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED",
    "NON_RETRYABLE_ACTION_REPEATED",
    "REQUIRED_CAPABILITY_NOT_INVOKED",
    "SOP_NOT_AVAILABLE",
    "SOP_STEP_TIMEOUT",
}


def _language_context(locale: SupportedLocale) -> LanguageContext:
    """Build a deterministic turn snapshot for one Agent reply locale."""
    return LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=locale,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def test_team_progress_metadata_uses_canonical_code_and_exact_params() -> None:
    """Keep team progress chrome locale-independent and free of deprecated status text."""
    progress = _team_progress_metadata(
        completed_tasks=2,
        total_tasks=5,
    )

    assert progress == {
        "phase": "collecting",
        "code": "team.run.progress.collecting",
        "event_code": "team.run.progress.collecting",
        "params": {"completed_tasks": 2, "total_tasks": 5},
    }
    assert "status_text" not in progress


@pytest.mark.parametrize(
    ("locale", "expected"),
    [
        (SupportedLocale.ZH_CN, "还需要您补充：客户编号。"),
        (SupportedLocale.EN_US, "Please provide: 客户编号."),
    ],
)
def test_required_slot_reply_uses_agent_reply_locale_and_preserves_raw_slot_name(
    locale: SupportedLocale,
    expected: str,
) -> None:
    """Localize only the compatibility shell while retaining the raw slot identifier."""
    result = TaskExecutionResult(
        task_frame_id="task-required-slot",
        status="completed",
        reply_fragment="",
    )
    requirement = SimpleNamespace(required_slots=["客户编号"])
    session = ChatSession(
        id="session-required-slot",
        tenant_id="tenant_demo",
        user_id="user_demo",
        slots_json={},
    )

    enforced = _enforce_required_slots(
        result,
        requirement,
        session,
        language_context=_language_context(locale),
    )

    assert enforced.status == "awaiting_user"
    assert enforced.reply_fragment == expected
    assert "客户编号" in enforced.reply_fragment


@pytest.mark.parametrize(
    ("locale", "expected"),
    [
        (SupportedLocale.ZH_CN, "当前 TaskFrame 未产生执行结果。"),
        (SupportedLocale.EN_US, "This TaskFrame produced no execution result."),
    ],
)
def test_empty_task_result_reply_uses_agent_reply_locale(
    locale: SupportedLocale,
    expected: str,
) -> None:
    """Use the persisted reply locale for the empty-result Agent-facing fallback."""
    result = _combine_results(
        "task-empty-result",
        [],
        language_context=_language_context(locale),
    )

    assert result.reply_fragment == expected
    assert result.error == {"code": "INTERNAL_ERROR"}


def test_task_frame_and_run_persist_the_turn_language_snapshot() -> None:
    """Persist one immutable locale through TaskFrame creation and HarnessRun start."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    context = _language_context(SupportedLocale.EN_US)
    expected = context.model_dump(mode="json")
    with Session(engine) as db:
        session = ChatSession(
            id="session-harness-locale",
            tenant_id="tenant-harness-locale",
            user_id="user-harness-locale",
        )
        db.add_all(
            [
                Tenant(id="tenant-harness-locale", name="Harness locale"),
                session,
            ]
        )
        db.commit()
        store = TaskFrameStore(db)
        row = store.persist_plan(
            session,
            "turn-harness-locale",
            TurnPlan(
                decision="answer_only",
                user_intent="preserve locale",
                task_frames=[
                    PlannedTaskFrame(
                        task_id="task-harness-locale",
                        kind="conversation",
                        decision="answer_only",
                        user_intent="preserve locale",
                        requirements=["preserve locale"],
                    )
                ],
            ),
            language_context=context,
        )[0]
        store.mark_running(row)
        run = store.start_run(
            row,
            requirement={"task_frame_id": row.task_id},
            capability_snapshot={"available": []},
            language_context=context,
        )
        db.commit()
        db.refresh(row)
        db.refresh(run)

    assert row.language_context_json == expected
    assert run.language_context_json == expected


def test_harness_runtime_error_codes_have_public_localization_contracts() -> None:
    """Prevent Harness results and trace errors from collapsing to INTERNAL_ERROR."""
    for code in EXPECTED_HARNESS_RUNTIME_ERRORS:
        entry = ERROR_REGISTRY.require(code)
        assert entry.message_key.startswith("errors.harness.")
        assert entry.params_schema == {}

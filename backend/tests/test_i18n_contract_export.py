"""RED contract tests for the generated backend error/event internationalization artifact."""

from __future__ import annotations

import json

import pytest

from app.contracts.event_registry import (
    EVENT_REGISTRY,
    PUBLIC_JOB_EVENT_TYPES,
    public_job_event_entries,
    register_public_job_events,
)
from app.contracts.i18n_contract import (
    CONTRACT_SCHEMA_VERSION,
    build_i18n_contract,
    validate_i18n_contract,
)

EXPECTED_INTERNAL_EVENT_CODES = frozenset(
    {
        "internal.channel.autoroute.decision",
        "internal.job.queued",
        "system.auth.rejected",
        "system.control.conflict",
        "tenant.password.change.required",
        "tenant.lifecycle.suspended",
        "tenant.lifecycle.check.failed",
        "tenant.work.terminalized",
        "tenant.work.outcome.unknown",
    }
)


def test_backend_contract_is_deterministic_and_contains_exact_error_event_fields() -> None:
    """Require one stable, JSON-serializable artifact for both backend product registries."""
    first = build_i18n_contract()
    second = build_i18n_contract()

    assert first == second
    assert first["schema_version"] == CONTRACT_SCHEMA_VERSION
    assert json.dumps(first, sort_keys=True)
    assert set(first) == {"schema_version", "errors", "events"}

    error = next(item for item in first["errors"] if item["code"] == "VALIDATION_ERROR")
    assert set(error) == {
        "code",
        "message_key",
        "status",
        "retryable",
        "params",
        "visibility",
    }
    assert error["params"] == {"error_count": "integer"}

    event = next(item for item in first["events"] if item["event_code"] == "agent.turn.retrying")
    assert set(event) == {
        "event_code",
        "message_key",
        "params",
        "visibility",
        "raw_source_allowed",
        "requires_language_context",
        "legacy_event_type",
    }
    assert event["message_key"] == "chat.trace.reflectionRetry"
    assert event["params"] == {"attempt": "integer", "max_attempts": "integer"}


def test_chat_and_team_product_events_export_exact_localization_contracts() -> None:
    """Require replayable chat/team chrome to export codes and exact safe parameters."""
    contract = build_i18n_contract()
    events = {item["event_code"]: item for item in contract["events"]}

    assert {
        code: (events[code]["message_key"], events[code]["params"])
        for code in (
            "chat.scheduled.draft",
            "chat.scheduled.intent",
            "chat.scheduled.plan",
            "team.run.progress.collecting",
            "team.run.progress.completed",
            "team.run.progress.failed",
            "team.run.progress.synthesizing",
        )
    } == {
        "chat.scheduled.draft": ("chat.draft.traceDraft", {}),
        "chat.scheduled.intent": ("chat.draft.traceIntent", {}),
        "chat.scheduled.plan": ("chat.draft.traceParse", {}),
        "team.run.progress.collecting": (
            "chat.team.progressCollecting",
            {"completed_tasks": "integer", "total_tasks": "integer"},
        ),
        "team.run.progress.completed": (
            "chat.team.progressCompleted",
            {"total_tasks": "integer"},
        ),
        "team.run.progress.failed": (
            "chat.team.progressFailed",
            {"total_tasks": "integer"},
        ),
        "team.run.progress.synthesizing": (
            "chat.team.progressSynthesizing",
            {"total_tasks": "integer"},
        ),
    }
    for code in (
        "chat.scheduled.draft",
        "chat.scheduled.intent",
        "chat.scheduled.plan",
        "team.run.progress.collecting",
        "team.run.progress.completed",
        "team.run.progress.failed",
        "team.run.progress.synthesizing",
    ):
        assert events[code]["visibility"] == "public"
        assert events[code]["requires_language_context"] is True
        assert events[code]["raw_source_allowed"] is False


def test_every_public_non_raw_event_has_a_semantic_message_key_and_exact_job_set() -> None:
    """Reject public event entries that cannot be localized or that depend on import order."""
    contract = build_i18n_contract()
    public_events = [item for item in contract["events"] if item["visibility"] == "public"]
    job_events = [
        item
        for item in public_events
        if item["legacy_event_type"] in {"job.queued", "job.cancel_requested"}
        or str(item["legacy_event_type"]).startswith(("knowledge.", "run.", "sop."))
    ]

    assert len({item["legacy_event_type"] for item in job_events}) == 47
    for item in public_events:
        if not item["raw_source_allowed"]:
            assert isinstance(item["message_key"], str)
            assert item["message_key"]


def test_contract_validator_rejects_drifted_or_missing_machine_metadata() -> None:
    """Fail closed when generated contract data drops a key or changes a parameter schema."""
    contract = build_i18n_contract()

    validate_i18n_contract(contract)

    missing_message_key = {
        **contract,
        "events": [
            {
                **event,
                "message_key": None,
            }
            if event["event_code"] == "agent.turn.retrying"
            else event
            for event in contract["events"]
        ],
    }
    with pytest.raises(ValueError, match="message_key"):
        validate_i18n_contract(missing_message_key)

    changed_params = {
        **contract,
        "errors": [
            {
                **error,
                "params": {**error["params"], "unexpected": "string"},
            }
            if error["code"] == "VALIDATION_ERROR"
            else error
            for error in contract["errors"]
        ],
    }
    with pytest.raises(ValueError, match="params"):
        validate_i18n_contract(changed_params)


def test_public_job_registration_is_idempotent_and_has_no_feedback_worker_side_effects() -> None:
    """Keep repeated imports/registrations deterministic and exclude internal worker lifecycles."""
    first = build_i18n_contract()
    job_entries = public_job_event_entries()

    assert len(PUBLIC_JOB_EVENT_TYPES) == 47
    assert len(job_entries) == 47
    assert len({entry.event_code for entry in job_entries}) == 47
    assert not any(
        str(entry.get("legacy_event_type") or "").startswith("feedback.analyze.")
        for entry in first["events"]
    )
    assert len(first["events"]) == 78
    assert sum(item["visibility"] == "public" for item in first["events"]) == 69
    assert sum(item["visibility"] == "internal" for item in first["events"]) == 9
    assert {
        item["event_code"] for item in first["events"] if item["visibility"] == "internal"
    } == EXPECTED_INTERNAL_EVENT_CODES
    assert {
        item["legacy_event_type"] for item in first["events"] if item["raw_source_allowed"]
    } == {"run.output.completed", "run.output.delta", "run.output.replace"}

    # Workflow: replay the same registration operation twice, as application imports do, then
    # compare the complete serialized snapshot rather than only checking the dictionary size.
    register_public_job_events(EVENT_REGISTRY)
    second = build_i18n_contract()
    register_public_job_events(EVENT_REGISTRY)
    third = build_i18n_contract()

    assert second == first
    assert third == first
    assert len({entry.event_code for entry in EVENT_REGISTRY.entries()}) == 78


def test_test_job_registration_isolated_from_canonical_contract() -> None:
    """Keep test-only lifecycle fixtures out of the generated product event artifact."""
    from app.public_api.jobs import _TEST_JOB_EVENT_REGISTRY, register_job_handler

    before = tuple(entry.model_dump(mode="json") for entry in EVENT_REGISTRY.entries())
    register_job_handler("test.contract.isolated")(lambda _db, _job: {})
    register_job_handler("test.contract.isolated")(lambda _db, _job: {})

    after = tuple(entry.model_dump(mode="json") for entry in EVENT_REGISTRY.entries())
    assert after == before
    assert len(EVENT_REGISTRY.entries()) == 78
    assert len(_TEST_JOB_EVENT_REGISTRY.entries()) == 4

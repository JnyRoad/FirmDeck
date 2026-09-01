"""Behavior contracts for the central fail-closed tenant lifecycle decision."""

from __future__ import annotations

import importlib
import importlib.util
import logging
import traceback
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import models


def _session() -> Session:
    """Create an isolated authoritative store for lifecycle decision tests."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _lifecycle_module():
    """Load T012's central decision API while retaining a clear collected RED failure if it is absent."""
    assert importlib.util.find_spec("app.security.tenant") is not None, (
        "T012 must provide app.security.tenant"
    )
    lifecycle = importlib.import_module("app.security.tenant")
    required = (
        "require_active_tenant",
        "require_matching_admission_version",
        "TenantLifecycleDecision",
        "TenantLifecycleDenied",
        "TenantExecutionKind",
    )
    for name in required:
        assert getattr(lifecycle, name, None) is not None, (
            f"T012 missing lifecycle contract: {name}"
        )
    return lifecycle


def _tenant(*, tenant_id: str = "tenant_1", status: str = "active", version: int = 1):
    """Build one future lifecycle-aware tenant row with a deliberately controlled state."""
    return models.Tenant(
        id=tenant_id,
        name="Tenant One",
        status=status,
        lifecycle_version=version,
    )


class _ControlledTenantRead:
    """Return one complete model row without asking SQLite to accept deliberately corrupt state."""

    def __init__(self, tenant: models.Tenant | None) -> None:
        """Retain the authoritative-read result; this fake has no writes or external side effects."""
        self._tenant = tenant

    def get(self, model_type, tenant_id: str):
        """Mirror Session.get for the one Tenant lookup exercised by the lifecycle decision."""
        if model_type is not models.Tenant:
            raise AssertionError("lifecycle decision queried an unexpected model")
        if self._tenant is not None and self._tenant.id != tenant_id:
            return None
        return self._tenant


def _assert_denied(
    action, lifecycle, *, code: str, tenant_id: str | None, execution_kind: str
) -> None:
    """Assert fail-closed denial keeps only the safe identity and correlation evidence public."""
    with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
        action()
    error = denied.value
    assert error.code == code
    assert error.evidence["tenant_id"] == tenant_id
    assert error.evidence["execution_kind"] == execution_kind
    assert error.evidence["correlation_id"] == "corr-1"
    rendered = repr(error.evidence)
    assert "raw payload" not in rendered
    assert "database exploded" not in rendered


def test_active_tenant_returns_an_immutable_correlated_decision() -> None:
    """Allow only an active positive-version row and retain the exact execution admission context."""
    lifecycle = _lifecycle_module()
    with _session() as db:
        db.add(_tenant())
        db.commit()

        decision = lifecycle.require_active_tenant(
            db,
            tenant_id="tenant_1",
            execution_kind="a2a.client.submit",
            correlation_id="corr-1",
        )

    assert isinstance(decision, lifecycle.TenantLifecycleDecision)
    assert decision.tenant_id == "tenant_1"
    assert decision.status == "active"
    assert decision.lifecycle_version == 1
    assert decision.execution_kind == "a2a.client.submit"
    assert decision.correlation_id == "corr-1"
    assert decision.decided_at is not None
    with pytest.raises((FrozenInstanceError, TypeError, ValidationError)):
        decision.lifecycle_version = 2


def test_suspended_tenant_denies_with_safe_stable_evidence() -> None:
    """Deny a known suspended tenant without exposing its reason or any work payload."""
    lifecycle = _lifecycle_module()
    with _session() as db:
        db.add(_tenant(status="suspended", version=2))
        db.commit()
        _assert_denied(
            lambda: lifecycle.require_active_tenant(
                db,
                tenant_id="tenant_1",
                execution_kind="a2a.client.submit",
                correlation_id="corr-1",
            ),
            lifecycle,
            code="TENANT_SUSPENDED",
            tenant_id="tenant_1",
            execution_kind="a2a.client.submit",
        )


def test_missing_unknown_and_invalid_tenant_state_all_deny_fail_closed() -> None:
    """Deny missing, unrecognized status, and non-positive lifecycle versions without fallback admission."""
    lifecycle = _lifecycle_module()
    with _session() as db:
        _assert_denied(
            lambda: lifecycle.require_active_tenant(
                db,
                tenant_id="missing",
                execution_kind="job.claim",
                correlation_id="corr-1",
            ),
            lifecycle,
            code="TENANT_NOT_FOUND",
            tenant_id=None,
            execution_kind="job.claim",
        )

    corrupt_status = _ControlledTenantRead(
        _tenant(tenant_id="unknown-status", status="retired", version=1)
    )
    _assert_denied(
        lambda: lifecycle.require_active_tenant(
            corrupt_status,
            tenant_id="unknown-status",
            execution_kind="job.claim",
            correlation_id="corr-1",
        ),
        lifecycle,
        code="TENANT_LIFECYCLE_CHECK_FAILED",
        tenant_id="unknown-status",
        execution_kind="job.claim",
    )
    corrupt_version = _ControlledTenantRead(
        _tenant(tenant_id="invalid-version", status="active", version=0)
    )
    _assert_denied(
        lambda: lifecycle.require_active_tenant(
            corrupt_version,
            tenant_id="invalid-version",
            execution_kind="job.claim",
            correlation_id="corr-1",
        ),
        lifecycle,
        code="TENANT_LIFECYCLE_CHECK_FAILED",
        tenant_id="invalid-version",
        execution_kind="job.claim",
    )


def test_execution_kind_enum_is_normalized_and_unregistered_values_are_denied() -> None:
    """Accept a registered enum member but never admit empty or arbitrary execution labels."""
    lifecycle = _lifecycle_module()
    controlled = _ControlledTenantRead(_tenant())

    decision = lifecycle.require_active_tenant(
        controlled,
        tenant_id="tenant_1",
        execution_kind=lifecycle.TenantExecutionKind.JOB_CLAIM,
        correlation_id="corr-1",
    )
    assert decision.execution_kind == "job.claim"

    for malformed_kind in ("", "raw prompt content", "job.claim.extra"):
        with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
            lifecycle.require_active_tenant(
                controlled,
                tenant_id="tenant_1",
                execution_kind=malformed_kind,
                correlation_id="corr-1",
            )
        assert denied.value.code == "TENANT_LIFECYCLE_CHECK_FAILED"
        assert denied.value.evidence == {
            "tenant_id": "tenant_1",
            "execution_kind": None,
            "correlation_id": "corr-1",
        }
        if malformed_kind:
            assert malformed_kind not in str(denied.value)


def test_bounded_provider_correlation_identifier_allows_qualified_subject() -> None:
    """Accept a bounded provider subject in correlation evidence without admitting free-form text."""
    lifecycle = _lifecycle_module()
    decision = lifecycle.require_active_tenant(
        _ControlledTenantRead(_tenant()),
        tenant_id="tenant_1",
        execution_kind="channel.delivery",
        correlation_id="notice:binding-1:wechat_p2p_user_ab12cd34@im.wechat",
    )

    assert decision.correlation_id.endswith("@im.wechat")


@pytest.mark.parametrize(
    ("tenant_id", "correlation_id", "expected_tenant_id", "expected_correlation_id"),
    [
        ("", "corr-1", None, "corr-1"),
        ("tenant_1", "", "tenant_1", None),
        ("raw tenant payload", "corr-1", None, "corr-1"),
    ],
)
def test_malformed_identifiers_deny_without_echoing_raw_input(
    tenant_id: str,
    correlation_id: str,
    expected_tenant_id: str | None,
    expected_correlation_id: str | None,
) -> None:
    """Reject malformed identity inputs while retaining only independently allowlisted evidence."""
    lifecycle = _lifecycle_module()

    with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
        lifecycle.require_active_tenant(
            _ControlledTenantRead(_tenant()),
            tenant_id=tenant_id,
            execution_kind="job.claim",
            correlation_id=correlation_id,
        )

    assert denied.value.code == "TENANT_LIFECYCLE_CHECK_FAILED"
    assert denied.value.evidence == {
        "tenant_id": expected_tenant_id,
        "execution_kind": "job.claim",
        "correlation_id": expected_correlation_id,
    }
    if tenant_id:
        assert tenant_id not in str(denied.value)
    if correlation_id:
        assert correlation_id not in str(denied.value)


def test_authoritative_read_failure_is_denied_without_raw_exception_text(
    monkeypatch,
    caplog,
) -> None:
    """Never infer active state when the authoritative tenant read raises an infrastructure exception."""
    lifecycle = _lifecycle_module()
    with _session() as db:

        def fail_read(*_args, **_kwargs):
            """Represent a failing database read while preserving no provider or payload data."""
            raise SQLAlchemyError("database exploded with raw payload")

        monkeypatch.setattr(db, "get", fail_read)
        with caplog.at_level(logging.WARNING, logger="app.security.tenant"):
            _assert_denied(
                lambda: lifecycle.require_active_tenant(
                    db,
                    tenant_id="tenant_1",
                    execution_kind="channel.delivery",
                    correlation_id="corr-1",
                ),
                lifecycle,
                code="TENANT_LIFECYCLE_CHECK_FAILED",
                tenant_id="tenant_1",
                execution_kind="channel.delivery",
            )

    record = caplog.records[-1]
    assert record.getMessage() == "tenant.lifecycle.check.failed"
    assert record.event_code == "tenant.lifecycle.check.failed"
    assert record.lifecycle_evidence == {
        "tenant_id": "tenant_1",
        "execution_kind": "channel.delivery",
        "correlation_id": "corr-1",
    }
    assert "database exploded" not in caplog.text
    assert "raw payload" not in caplog.text


def test_read_failure_denial_does_not_retain_the_raw_exception_chain() -> None:
    """Discard the infrastructure exception object so later traceback rendering cannot reveal it."""
    lifecycle = _lifecycle_module()
    sensitive_sentinel = "secret SQL payload from provider"

    class _ExplodingTenantRead:
        """Represent an authoritative store that fails before it can establish tenant state."""

        def get(self, _model_type, _tenant_id: str):
            """Raise one sentinel-bearing storage failure without any external side effects."""
            raise SQLAlchemyError(sensitive_sentinel)

    with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
        lifecycle.require_active_tenant(
            _ExplodingTenantRead(),
            tenant_id="tenant_1",
            execution_kind="channel.delivery",
            correlation_id="corr-1",
        )

    error = denied.value
    rendered_traceback = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    assert error.__cause__ is None
    assert error.__context__ is None
    assert sensitive_sentinel not in str(error)
    assert sensitive_sentinel not in repr(error)
    assert sensitive_sentinel not in rendered_traceback


def test_denial_allows_exception_runtime_traceback_updates_but_freezes_business_fields() -> None:
    """Let Python attach traceback metadata while keeping the denial contract immutable."""
    lifecycle = _lifecycle_module()
    evidence = {
        "tenant_id": None,
        "execution_kind": "job.claim",
        "correlation_id": "corr-1",
    }
    error = lifecycle.TenantLifecycleDenied("TENANT_NOT_FOUND", evidence)

    @contextmanager
    def passthrough_context():
        """Mirror contextlib's exception path, which writes the traceback back to the error."""
        yield

    with pytest.raises(lifecycle.TenantLifecycleDenied) as denied, passthrough_context():
        raise error

    assert denied.value is error
    assert error.__traceback__ is not None
    with pytest.raises(AttributeError):
        error._code = "TENANT_SUSPENDED"
    with pytest.raises(AttributeError):
        error._evidence = {}


def test_suspended_denial_emits_one_safe_structured_signal(caplog) -> None:
    """Emit the suspended signal exactly once with only the three correlated evidence fields."""
    lifecycle = _lifecycle_module()
    with (
        caplog.at_level(logging.WARNING, logger="app.security.tenant"),
        pytest.raises(lifecycle.TenantLifecycleDenied),
    ):
        lifecycle.require_active_tenant(
            _ControlledTenantRead(_tenant(status="suspended", version=2)),
            tenant_id="tenant_1",
            execution_kind="a2a.client.submit",
            correlation_id="corr-1",
        )

    records = [
        record for record in caplog.records if record.getMessage() == "tenant.lifecycle.suspended"
    ]
    assert len(records) == 1
    assert records[0].event_code == "tenant.lifecycle.suspended"
    assert records[0].lifecycle_evidence == {
        "tenant_id": "tenant_1",
        "execution_kind": "a2a.client.submit",
        "correlation_id": "corr-1",
    }


@pytest.mark.parametrize("version", [True, False])
def test_boolean_lifecycle_versions_are_never_positive_integers(version: bool) -> None:
    """Reject corrupt boolean row versions even though bool subclasses int in Python."""
    lifecycle = _lifecycle_module()
    _assert_denied(
        lambda: lifecycle.require_active_tenant(
            _ControlledTenantRead(_tenant(version=version)),
            tenant_id="tenant_1",
            execution_kind="job.claim",
            correlation_id="corr-1",
        ),
        lifecycle,
        code="TENANT_LIFECYCLE_CHECK_FAILED",
        tenant_id="tenant_1",
        execution_kind="job.claim",
    )


def test_stale_durable_admission_version_cannot_match_a_reactivated_tenant() -> None:
    """Reject persisted work admitted at an older lifecycle version even if the tenant is active again."""
    lifecycle = _lifecycle_module()
    with _session() as db:
        db.add(_tenant(version=3))
        db.commit()
        decision = lifecycle.require_active_tenant(
            db,
            tenant_id="tenant_1",
            execution_kind="a2a.client.recovery",
            correlation_id="corr-1",
        )
        _assert_denied(
            lambda: lifecycle.require_matching_admission_version(
                decision,
                persisted_lifecycle_version=1,
            ),
            lifecycle,
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            tenant_id="tenant_1",
            execution_kind="a2a.client.recovery",
        )


def test_exact_positive_admission_version_matches_and_bool_never_matches() -> None:
    """Return the same decision only for an exactly equal strict positive persisted version."""
    lifecycle = _lifecycle_module()
    decision = lifecycle.require_active_tenant(
        _ControlledTenantRead(_tenant(version=3)),
        tenant_id="tenant_1",
        execution_kind="a2a.client.recovery",
        correlation_id="corr-1",
    )

    assert lifecycle.require_matching_admission_version(decision, 3) is decision
    for invalid_version in (True, False, 0, -1, 3.0, "3"):
        _assert_denied(
            lambda invalid_version=invalid_version: lifecycle.require_matching_admission_version(
                decision,
                invalid_version,
            ),
            lifecycle,
            code="TENANT_LIFECYCLE_CHECK_FAILED",
            tenant_id="tenant_1",
            execution_kind="a2a.client.recovery",
        )


def test_denial_contract_and_evidence_are_immutable() -> None:
    """Prevent callers from rewriting the stable denial code or its safe evidence after rejection."""
    lifecycle = _lifecycle_module()
    with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
        lifecycle.require_active_tenant(
            _ControlledTenantRead(None),
            tenant_id="tenant_1",
            execution_kind="job.claim",
            correlation_id="corr-1",
        )

    with pytest.raises((AttributeError, FrozenInstanceError, TypeError)):
        denied.value.code = "INTERNAL_ERROR"
    with pytest.raises(TypeError):
        denied.value.evidence["tenant_id"] = "tenant_other"


def test_decision_constructor_enforces_its_immutable_admission_invariants() -> None:
    """Prevent direct construction from manufacturing a non-active or malformed admission decision."""
    lifecycle = _lifecycle_module()
    valid = {
        "tenant_id": "tenant_1",
        "status": "active",
        "lifecycle_version": 1,
        "execution_kind": "job.claim",
        "correlation_id": "corr-1",
        "decided_at": datetime.now(UTC),
    }
    naive_time = datetime.now(UTC).replace(tzinfo=None)
    invalid_overrides = (
        {"status": "suspended"},
        {"lifecycle_version": True},
        {"lifecycle_version": 0},
        {"execution_kind": "raw prompt content"},
        {"tenant_id": "raw tenant payload"},
        {"correlation_id": ""},
        {"decided_at": naive_time},
    )

    for overrides in invalid_overrides:
        with pytest.raises(ValueError) as invalid:
            lifecycle.TenantLifecycleDecision(**(valid | overrides))
        assert "raw prompt content" not in str(invalid.value)
        assert "raw tenant payload" not in str(invalid.value)


def test_denial_constructor_rejects_unregistered_codes_and_unsafe_evidence() -> None:
    """Prevent direct exception construction from retaining raw values or unregistered evidence keys."""
    lifecycle = _lifecycle_module()
    safe_evidence = {
        "tenant_id": "tenant_1",
        "execution_kind": "job.claim",
        "correlation_id": "corr-1",
    }
    invalid_contracts = (
        ("RAW_FAILURE", safe_evidence),
        (
            "TENANT_LIFECYCLE_CHECK_FAILED",
            safe_evidence | {"payload": "raw payload"},
        ),
        (
            "TENANT_LIFECYCLE_CHECK_FAILED",
            safe_evidence | {"tenant_id": "raw tenant payload"},
        ),
    )

    for code, evidence in invalid_contracts:
        with pytest.raises(ValueError) as invalid:
            lifecycle.TenantLifecycleDenied(code, evidence)
        assert "raw payload" not in str(invalid.value)
        assert "raw tenant payload" not in str(invalid.value)

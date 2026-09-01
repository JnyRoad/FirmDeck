"""RED contracts for public-job and webhook tenant lifecycle fences."""

from __future__ import annotations

import threading
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import Request
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import (
    APIClient,
    APICredential,
    APIJob,
    APIJobEvent,
    APISOPDraft,
    ChatSession,
    Tenant,
    User,
    WebhookDelivery,
    WebhookEndpoint,
    utc_now,
)
from app.public_api import auth as public_auth
from app.public_api import jobs as public_jobs
from app.public_api import resources as public_resources
from app.public_api import runs as public_runs
from app.public_api import sops as public_sops
from app.public_api import webhooks as public_webhooks
from app.public_api.auth import PublicPrincipal
from app.public_api.errors import PublicAPIError
from app.security import tenant as lifecycle
from app.session.helpers import public_session

TENANT_ID = "tenant-public-lifecycle"
CLIENT_ID = "client-public-lifecycle"
CREDENTIAL_ID = "credential-public-lifecycle"
ACTOR_ID = "user-public-lifecycle"
ENDPOINT_ID = "webhook-public-lifecycle"


@pytest.fixture
def _engine():
    """Create an isolated authoritative SQLite store with no external service dependencies."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _principal() -> PublicPrincipal:
    """Build a tenant-owned public principal whose actor is safe test identity data."""
    return PublicPrincipal(
        tenant_id=TENANT_ID,
        actor_user=User(
            id=ACTOR_ID,
            tenant_id=TENANT_ID,
            username="lifecycle-admin",
            role="admin",
            password_hash="test-only-hash",
        ),
        scopes=frozenset({"*"}),
        client_id=CLIENT_ID,
        credential_id=CREDENTIAL_ID,
    )


def _seed_tenant(engine, *, status: str = "active", version: int = 1) -> None:
    """Persist one tenant lifecycle row at an explicit state and version."""
    with Session(engine) as db:
        db.add(
            Tenant(
                id=TENANT_ID,
                slug="public-lifecycle",
                name="Public Lifecycle Tenant",
                status=status,
                lifecycle_version=version,
            )
        )
        db.commit()


def _seed_webhook_context(engine, *, status: str = "active", version: int = 1) -> None:
    """Persist a tenant, public credential, endpoint, and receiver-free webhook fixture."""
    with Session(engine) as db:
        db.add(
            Tenant(
                id=TENANT_ID,
                slug="public-lifecycle",
                name="Public Lifecycle Tenant",
                status=status,
                lifecycle_version=version,
            )
        )
        db.add(
            APIClient(
                id=CLIENT_ID,
                tenant_id=TENANT_ID,
                name="lifecycle-client",
                scopes_json=["*"],
                created_by_user_id=ACTOR_ID,
            )
        )
        db.add(
            APICredential(
                id=CREDENTIAL_ID,
                tenant_id=TENANT_ID,
                client_id=CLIENT_ID,
                name="lifecycle-key",
                key_prefix="sd_live_lifecycle",
                key_digest="test-only-digest",
                scopes_json=["*"],
            )
        )
        db.add(
            WebhookEndpoint(
                id=ENDPOINT_ID,
                tenant_id=TENANT_ID,
                client_id=CLIENT_ID,
                name="lifecycle receiver",
                url="https://receiver.invalid/events",
                secret_encrypted="test-only-ciphertext",
                events_json=["*"],
            )
        )
        db.commit()


def test_api_key_missing_tenant_is_a_stable_client_denial(_engine, monkeypatch) -> None:
    """A deleted credential tenant is invalid client state, not a retryable control-plane outage."""
    token = "sd_live_missing_tenant_credential"
    digest = "missing-tenant-digest"
    with Session(_engine) as db:
        db.add(
            User(
                id=ACTOR_ID,
                tenant_id=TENANT_ID,
                username="lifecycle-admin",
                role="admin",
                password_hash="test-only-hash",
            )
        )
        db.add(
            APIClient(
                id=CLIENT_ID,
                tenant_id=TENANT_ID,
                name="lifecycle-client",
                scopes_json=["*"],
                created_by_user_id=ACTOR_ID,
            )
        )
        db.add(
            APICredential(
                id=CREDENTIAL_ID,
                tenant_id=TENANT_ID,
                client_id=CLIENT_ID,
                name="lifecycle-key",
                key_prefix=token[:20],
                key_digest=digest,
                scopes_json=["*"],
            )
        )
        db.commit()
        monkeypatch.setattr(public_auth, "_credential_digest", lambda _token: digest)

        with pytest.raises(PublicAPIError) as denied:
            public_auth._api_key_principal(token, db)

    assert denied.value.status_code == 403
    assert denied.value.code == "TENANT_NOT_FOUND"


def _set_tenant_state(db: Session, *, status: str, version: int) -> None:
    """Commit a control-plane lifecycle transition on the shared authoritative session."""
    tenant = db.get(Tenant, TENANT_ID)
    assert tenant is not None
    tenant.status = status
    tenant.lifecycle_version = version
    db.add(tenant)
    db.commit()


def _set_tenant_state_in_new_session(engine, *, status: str, version: int) -> None:
    """Commit a lifecycle transition from a separate worker/control transaction."""
    with Session(engine) as db:
        _set_tenant_state(db, status=status, version=version)


def _job(*, kind: str, status: str = "queued", version: int = 1) -> APIJob:
    """Build a durable public job with an explicit admission version and no raw secrets."""
    return APIJob(
        id=f"apijob-{kind.replace('.', '-')}",
        tenant_id=TENANT_ID,
        tenant_lifecycle_version=version,
        credential_id=CREDENTIAL_ID,
        kind=kind,
        status=status,
        stage="queued" if status == "queued" else "starting",
        request_json={"input": "test lifecycle input"},
    )


def _delivery(*, event_id: str, status: str = "queued", version: int = 1) -> WebhookDelivery:
    """Build one due webhook delivery with a stable payload and explicit lifecycle version."""
    return WebhookDelivery(
        id=f"delivery-{event_id}",
        tenant_id=TENANT_ID,
        tenant_lifecycle_version=version,
        endpoint_id=ENDPOINT_ID,
        event_id=event_id,
        event_type="run.succeeded",
        payload_json={"id": event_id, "type": "run.succeeded", "data": {"ok": True}},
        status=status,
        delivery_owner="worker-old" if status == "sending" else None,
        lease_expires_at=(utc_now() + timedelta(minutes=10)) if status == "sending" else None,
        next_attempt_at=utc_now(),
    )


def _row_optional(row: object, field_name: str) -> Any:
    """Read a lifecycle evidence field while keeping the pre-implementation RED collected."""
    return getattr(row, field_name, None)


def _successful_handler(_db: Session, _job: APIJob) -> dict[str, bool]:
    """Represent a recoverable handler whose invocation must be fenced by tenant lifecycle state."""
    return {"executed": True}


def _session_without_expiration(engine):
    """Open the recovery fixture without expiring queued rows at its final commit."""
    return Session(engine, expire_on_commit=False)


def _denial_code(error: BaseException) -> str | None:
    """Extract the stable code from either the public or central lifecycle denial contract."""
    return getattr(error, "code", None)


def test_public_job_admission_persists_active_lifecycle_version(_engine, monkeypatch) -> None:
    """Persist the authoritative tenant lifecycle version on an admitted public job."""
    _seed_tenant(_engine, version=7)
    queued: list[str] = []
    monkeypatch.setattr(
        public_jobs,
        "enqueue_async_job",
        lambda _name, _handler, job_id: queued.append(job_id),
    )

    with Session(_engine) as db:
        admitted = public_jobs.create_job(
            db,
            _principal(),
            kind="run",
            request_payload={"input": "active request"},
        )
        assert admitted.tenant_lifecycle_version == 7
    assert queued == [admitted.id]


def test_public_job_admission_rejects_suspended_tenant(_engine, monkeypatch) -> None:
    """Reject suspended job admission without persisting or dispatching new durable work."""
    _seed_tenant(_engine, status="suspended", version=8)
    queued: list[str] = []
    monkeypatch.setattr(
        public_jobs,
        "enqueue_async_job",
        lambda _name, _handler, job_id: queued.append(job_id),
    )

    with (
        Session(_engine) as db,
        pytest.raises((PublicAPIError, lifecycle.TenantLifecycleDenied)) as denied,
    ):
            public_jobs.create_job(
                db,
                _principal(),
                kind="run",
                request_payload={"input": "blocked request"},
            )

    assert _denial_code(denied.value) == "TENANT_SUSPENDED"
    with Session(_engine) as db:
        rows = db.exec(select(APIJob)).all()
        assert rows == []
    assert queued == []


def test_internal_job_admission_rejects_suspended_tenant(_engine, monkeypatch) -> None:
    """Internal durable jobs must not be created while their tenant is suspended."""
    _seed_tenant(_engine, status="suspended", version=8)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)

    with (
        Session(_engine) as db,
        pytest.raises(lifecycle.TenantLifecycleDenied) as denied,
    ):
        public_jobs.create_internal_job(
            db,
            tenant_id=TENANT_ID,
            kind="feedback.analyze",
            request_payload={"feedback_id": "blocked-feedback"},
        )

    assert denied.value.code == "TENANT_SUSPENDED"
    with Session(_engine) as db:
        assert db.exec(select(APIJob)).all() == []


def test_internal_job_admission_persists_active_lifecycle_version(_engine, monkeypatch) -> None:
    """Internal durable jobs must retain the active tenant lifecycle generation."""
    _seed_tenant(_engine, version=7)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)

    with Session(_engine) as db:
        created = public_jobs.create_internal_job(
            db,
            tenant_id=TENANT_ID,
            kind="feedback.analyze",
            request_payload={"feedback_id": "active-feedback"},
        )

    assert created.tenant_lifecycle_version == 7


def test_public_job_claim_rechecks_lifecycle_before_handler(monkeypatch, _engine) -> None:
    """A suspension committed after claim must cancel the job before its handler is invoked."""
    _seed_tenant(_engine)
    kind = "test.lifecycle.claim"
    handler_calls = 0

    def handler(_db: Session, _job: APIJob) -> dict[str, bool]:
        """Represent a provider/tool handler that must never run for a suspended tenant."""
        nonlocal handler_calls
        handler_calls += 1
        return {"executed": True}

    public_jobs.register_job_handler(kind)(handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind))
        db.commit()

    original_claim = public_jobs._claim_job

    def claim_then_suspend(db: Session, job_id: str, owner: str) -> APIJob | None:
        """Create the claim/suspend race after the durable lease commits."""
        claimed = original_claim(db, job_id, owner)
        assert claimed is not None
        _set_tenant_state(db, status="suspended", version=2)
        return claimed

    monkeypatch.setattr(public_jobs, "_claim_job", claim_then_suspend)
    monkeypatch.setattr(public_jobs, "engine", _engine)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    public_jobs.run_job("apijob-test-lifecycle-claim")

    assert handler_calls == 0
    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-claim")
        assert row is not None
        assert row.status == "cancelled"
        assert row.stage == "cancelled"
        assert row.retryable is False
        assert row.error_json["code"] == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
def test_public_job_rechecks_before_side_effect_after_admission(monkeypatch, _engine) -> None:
    """A second lifecycle decision immediately before the side effect must fail closed."""
    _seed_tenant(_engine)
    kind = "test.lifecycle.preside"
    gate_calls = 0
    side_effect_calls = 0

    def gate(*args, **kwargs):
        """Allow the first admission, suspend the tenant, and reject the next boundary check."""
        nonlocal gate_calls
        gate_calls += 1
        db = args[0] if args else kwargs["db"]
        tenant_id = str(kwargs.get("tenant_id") or (args[1] if len(args) > 1 else TENANT_ID))
        correlation_id = str(kwargs.get("correlation_id") or "job-pre-side-effect")
        if gate_calls == 1:
            decision = lifecycle.require_active_tenant(
                db,
                tenant_id=tenant_id,
                execution_kind="job.claim",
                correlation_id=correlation_id,
            )
            _set_tenant_state(db, status="suspended", version=2)
            return decision
        raise lifecycle.TenantLifecycleDenied(
            "TENANT_SUSPENDED",
            {
                "tenant_id": TENANT_ID,
                "execution_kind": "job.claim",
                "correlation_id": correlation_id,
            },
        )

    def handler(_db: Session, _job: APIJob) -> dict[str, bool]:
        """Represent the first external side effect that must be fenced by the second check."""
        nonlocal side_effect_calls
        side_effect_calls += 1
        return {"side_effect": True}

    public_jobs.register_job_handler(kind)(handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind))
        db.commit()

    monkeypatch.setattr(public_jobs, "require_active_tenant", gate, raising=False)
    monkeypatch.setattr(public_jobs, "engine", _engine)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    public_jobs.run_job("apijob-test-lifecycle-preside")

    assert gate_calls >= 2
    assert side_effect_calls == 0
    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-preside")
        assert row is not None
        assert row.status == "cancelled"
        assert row.error_json["code"] == "TENANT_SUSPENDED"
def test_public_job_stale_completion_records_unknown_outcome(monkeypatch, _engine) -> None:
    """A side effect that started before suspension cannot publish ordinary success or retry."""
    _seed_tenant(_engine)
    kind = "test.lifecycle.unknown"
    side_effect_calls = 0

    def handler(db: Session, _job: APIJob) -> dict[str, str]:
        """Start a simulated provider call, then commit suspension before its result returns."""
        nonlocal side_effect_calls
        side_effect_calls += 1
        _set_tenant_state(db, status="suspended", version=2)
        return {"provider_result": "must-not-be-published"}

    public_jobs.register_job_handler(kind)(handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind))
        db.commit()

    monkeypatch.setattr(public_jobs, "engine", _engine)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    public_jobs.run_job("apijob-test-lifecycle-unknown")

    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-unknown")
        assert row is not None
        assert row.status == "cancelled"
        assert row.retryable is False
        assert row.error_json["code"] == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is True
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert row.result_json == {}
    assert side_effect_calls == 1


def test_public_job_pre_side_effect_failure_does_not_record_unknown_outcome(
    monkeypatch,
    _engine,
) -> None:
    """A handler failure before any remote call must remain a known ordinary failure."""
    _seed_tenant(_engine)
    kind = "test.lifecycle.prefailure"
    handler_calls = 0

    def handler(db: Session, _job: APIJob) -> dict[str, bool]:
        """Suspend the tenant, then fail before the provider boundary is entered."""
        nonlocal handler_calls
        handler_calls += 1
        _set_tenant_state(db, status="suspended", version=2)
        raise RuntimeError("local preparation failed")

    public_jobs.register_job_handler(kind)(handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind))
        db.commit()

    monkeypatch.setattr(public_jobs, "engine", _engine)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    public_jobs.run_job("apijob-test-lifecycle-prefailure")

    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-prefailure")
        assert row is not None
        assert row.status == "cancelled"
        assert row.retryable is False
        assert row.error_json["code"] == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is False
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
    assert handler_calls == 1


def test_public_job_startup_recovery_terminalizes_suspended_work(monkeypatch, _engine) -> None:
    """Startup recovery must terminalize queued suspended jobs without dispatching a handler."""
    _seed_tenant(_engine, status="suspended", version=2)
    kind = "test.lifecycle.recovery"
    public_jobs.register_job_handler(kind)(_successful_handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind, version=1))
        db.commit()

    dispatches: list[str] = []
    monkeypatch.setattr(public_jobs, "engine", _engine)
    # The legacy recovery helper materializes queued ORM rows before its final commit.  Disable
    # SQLAlchemy's post-commit expiration here so a RED assertion reaches lifecycle behavior.
    monkeypatch.setattr(public_jobs, "Session", _session_without_expiration)
    monkeypatch.setattr(
        public_jobs,
        "enqueue_async_job",
        lambda _name, _handler, job_id: dispatches.append(job_id),
    )
    public_jobs.recover_public_jobs()

    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-recovery")
        assert row is not None
        assert row.status == "cancelled"
        assert row.stage == "cancelled"
        assert row.retryable is False
        assert row.error_json["code"] == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
    assert dispatches == []


def test_public_job_fast_reactivation_does_not_replay_terminalized_work(monkeypatch, _engine) -> None:
    """Reactivation increments the version but never returns suspension-terminalized jobs to queued."""
    _seed_tenant(_engine, status="suspended", version=2)
    kind = "test.lifecycle.noreplay"
    public_jobs.register_job_handler(kind)(_successful_handler)
    with Session(_engine) as db:
        db.add(_job(kind=kind, version=1))
        db.commit()

    dispatches: list[str] = []
    monkeypatch.setattr(public_jobs, "engine", _engine)
    # The legacy recovery helper materializes queued ORM rows before its final commit.  Disable
    # SQLAlchemy's post-commit expiration here so a RED assertion reaches lifecycle behavior.
    monkeypatch.setattr(public_jobs, "Session", _session_without_expiration)
    monkeypatch.setattr(
        public_jobs,
        "enqueue_async_job",
        lambda _name, _handler, job_id: dispatches.append(job_id),
    )
    public_jobs.recover_public_jobs()
    _set_tenant_state_in_new_session(_engine, status="active", version=3)
    public_jobs.recover_public_jobs()

    with Session(_engine) as db:
        row = db.get(APIJob, "apijob-test-lifecycle-noreplay")
        assert row is not None
        assert row.status == "cancelled"
        assert row.tenant_lifecycle_version == 1
        assert row.retryable is False
    assert dispatches == []


def test_webhook_admission_persists_active_lifecycle_version(_engine) -> None:
    """Persist the authoritative tenant lifecycle version on a staged delivery."""
    _seed_webhook_context(_engine, version=7)
    with Session(_engine) as db:
        first = public_webhooks.stage_webhook_deliveries(
            db,
            tenant_id=TENANT_ID,
            credential_id=CREDENTIAL_ID,
            event_id="event-active",
            event_type="run.succeeded",
            payload={"id": "event-active", "type": "run.succeeded", "data": {}},
        )
        assert len(first) == 1
        active_delivery = db.get(WebhookDelivery, first[0])
        assert active_delivery is not None
        assert active_delivery.tenant_lifecycle_version == 7
    with Session(_engine) as db:
        assert len(db.exec(select(WebhookDelivery)).all()) == 1


def test_webhook_admission_skips_suspended_tenant(_engine) -> None:
    """Do not stage a new sendable delivery after the source tenant is suspended."""
    _seed_webhook_context(_engine, status="suspended", version=8)
    with Session(_engine) as db:
        try:
            blocked = public_webhooks.stage_webhook_deliveries(
                db,
                tenant_id=TENANT_ID,
                credential_id=CREDENTIAL_ID,
                event_id="event-suspended",
                event_type="run.succeeded",
                payload={"id": "event-suspended", "type": "run.succeeded", "data": {}},
            )
        except (PublicAPIError, lifecycle.TenantLifecycleDenied):
            blocked = []

    assert blocked == []
    with Session(_engine) as db:
        assert db.exec(select(WebhookDelivery)).all() == []


def test_webhook_final_gate_uses_fresh_transaction_and_skips_http_after_suspend(
    monkeypatch,
    tmp_path,
) -> None:
    """A suspension after endpoint lookup must win the final gate before the receiver call."""
    # A file-backed engine with WAL gives the control-plane update a genuinely independent
    # transaction while the worker still holds the endpoint-read snapshot open.
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'webhook-final-gate.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    _seed_webhook_context(race_engine)
    with Session(race_engine) as db:
        db.add(_delivery(event_id="event-final-gate"))
        db.commit()

    original_gate = public_webhooks._require_webhook_lifecycle
    gate_calls = 0
    gate_transaction_states: list[bool] = []

    def suspend_before_final_gate(db: Session, delivery: WebhookDelivery):
        """Commit suspension after endpoint lookup and before the second lifecycle decision."""
        nonlocal gate_calls
        gate_calls += 1
        gate_transaction_states.append(db.in_transaction())
        if gate_calls == 2:
            _set_tenant_state_in_new_session(race_engine, status="suspended", version=2)
        return original_gate(db, delivery)

    http_calls: list[str] = []

    def fake_post(*_args, **_kwargs) -> httpx.Response:
        """Record an accidental receiver attempt without making a network request."""
        http_calls.append("called")
        return httpx.Response(200)

    monkeypatch.setattr(public_webhooks, "_require_webhook_lifecycle", suspend_before_final_gate)
    monkeypatch.setattr(public_webhooks, "engine", race_engine)
    monkeypatch.setattr(public_webhooks, "decrypt_secret", lambda _value: "test-secret")
    monkeypatch.setattr(public_webhooks.httpx, "post", fake_post)
    public_webhooks.deliver_webhook("delivery-event-final-gate")

    with Session(race_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-final-gate")
        assert row is not None
        assert gate_calls >= 2
        assert gate_transaction_states[1] is False
        assert http_calls == []
        assert row.status == "abandoned"
        assert row.next_attempt_at is None
        assert row.last_error == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is False


def test_webhook_claim_rechecks_lifecycle_before_http_call(monkeypatch, _engine) -> None:
    """A queued delivery for a suspended tenant is abandoned without invoking the receiver."""
    _seed_webhook_context(_engine, status="suspended", version=2)
    with Session(_engine) as db:
        db.add(_delivery(event_id="event-claim", version=1))
        db.commit()

    http_calls: list[str] = []

    def fake_post(*_args, **_kwargs) -> httpx.Response:
        """Record an accidental receiver attempt without making a network request."""
        http_calls.append("called")
        return httpx.Response(200)

    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(public_webhooks, "decrypt_secret", lambda _value: "test-secret")
    monkeypatch.setattr(public_webhooks.httpx, "post", fake_post)
    public_webhooks.deliver_webhook("delivery-event-claim")

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-claim")
        assert row is not None
        assert http_calls == []
        assert row.status == "abandoned"
        assert row.next_attempt_at is None
        assert row.last_error == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is False


def test_webhook_stale_completion_cannot_mark_suspended_delivery_delivered(_engine) -> None:
    """A late worker completion must not overwrite a delivery after suspension commits."""
    _seed_webhook_context(_engine, version=1)
    with Session(_engine) as db:
        db.add(_delivery(event_id="event-stale", status="sending", version=1))
        db.commit()
        _set_tenant_state(db, status="suspended", version=2)

        delivery = db.get(WebhookDelivery, "delivery-event-stale")
        assert delivery is not None
        completed = public_webhooks._finish_webhook_delivery(
            db,
            delivery,
            "worker-old",
            {
                "status": "delivered",
                "attempt_count": 1,
                "next_attempt_at": None,
                "last_status_code": 200,
                "last_error": None,
                "delivered_at": utc_now(),
            },
        )
        assert completed is False

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-stale")
        assert row is not None
        assert row.status != "delivered"


def test_webhook_completion_cas_miss_terminalizes_after_lifecycle_race(
    monkeypatch,
    tmp_path,
) -> None:
    """A tenant suspension between gate and completion must terminalize the owned delivery."""
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'webhook-completion-race.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    _seed_webhook_context(race_engine, version=1)
    with Session(race_engine) as db:
        db.add(_delivery(event_id="event-completion-race", status="sending", version=1))
        db.commit()

    original_gate = public_webhooks._require_webhook_lifecycle
    gate_calls = 0

    def gate_then_suspend(db: Session, delivery: WebhookDelivery):
        """Return an active decision once, then race a control-plane suspension into completion."""
        nonlocal gate_calls
        gate_calls += 1
        decision = original_gate(db, delivery)
        if gate_calls == 1:
            _set_tenant_state_in_new_session(race_engine, status="suspended", version=2)
        return decision

    monkeypatch.setattr(public_webhooks, "_require_webhook_lifecycle", gate_then_suspend)
    with Session(race_engine) as db:
        delivery = db.get(WebhookDelivery, "delivery-event-completion-race")
        assert delivery is not None
        completed = public_webhooks._finish_webhook_delivery(
            db,
            delivery,
            "worker-old",
            {
                "status": "delivered",
                "attempt_count": 1,
                "next_attempt_at": None,
                "last_status_code": 200,
                "last_error": None,
                "delivered_at": utc_now(),
            },
        )
        assert completed is False

    with Session(race_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-completion-race")
        assert row is not None
        assert gate_calls >= 2
        assert row.status == "abandoned"
        assert row.last_error == "TENANT_SUSPENDED"
        assert row.next_attempt_at is None


def test_webhook_started_call_records_unknown_outcome_after_suspension(monkeypatch, _engine) -> None:
    """An uncertain receiver result after suspension is abandoned as unknown and never retried."""
    _seed_webhook_context(_engine, version=1)
    with Session(_engine) as db:
        db.add(_delivery(event_id="event-unknown", version=1))
        db.commit()

    http_calls = 0

    def fake_post(*_args, **_kwargs) -> httpx.Response:
        """Start the receiver call, suspend the tenant, and hide the remote outcome."""
        nonlocal http_calls
        http_calls += 1
        _set_tenant_state_in_new_session(_engine, status="suspended", version=2)
        raise httpx.ReadTimeout("receiver outcome unknown")

    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(public_webhooks, "decrypt_secret", lambda _value: "test-secret")
    monkeypatch.setattr(public_webhooks.httpx, "post", fake_post)
    public_webhooks.deliver_webhook("delivery-event-unknown")

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-unknown")
        assert row is not None
        assert http_calls == 1
        assert row.status == "abandoned"
        assert row.next_attempt_at is None
        assert row.last_error == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is True


def test_webhook_startup_recovery_and_fast_reactivation_never_replay(monkeypatch, _engine) -> None:
    """Recovery terminalizes suspended deliveries and reactivation does not enqueue their old work."""
    _seed_webhook_context(_engine, status="suspended", version=2)
    with Session(_engine) as db:
        db.add(_delivery(event_id="event-recovery", version=1))
        db.commit()

    dispatches: list[str] = []
    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(
        public_webhooks,
        "enqueue_async_job",
        lambda _name, _handler, delivery_id: dispatches.append(delivery_id),
    )
    public_webhooks.enqueue_due_webhook_deliveries()
    _set_tenant_state_in_new_session(_engine, status="active", version=3)
    public_webhooks.enqueue_due_webhook_deliveries()

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-recovery")
        assert row is not None
        assert row.status == "abandoned"
        assert row.next_attempt_at is None
        assert row.last_error == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
    assert dispatches == []


def test_webhook_recovery_terminalizes_expired_sending_without_replay(monkeypatch, _engine) -> None:
    """An expired sending lease has an unknown receiver outcome and must never be re-enqueued."""
    _seed_webhook_context(_engine, version=1)
    with Session(_engine) as db:
        delivery = _delivery(event_id="event-expired-sending", status="sending", version=1)
        delivery.lease_expires_at = utc_now() - timedelta(minutes=1)
        db.add(delivery)
        db.commit()

    dispatches: list[str] = []
    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(
        public_webhooks,
        "enqueue_async_job",
        lambda _name, _handler, delivery_id: dispatches.append(delivery_id),
    )
    public_webhooks.enqueue_due_webhook_deliveries()

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-expired-sending")
        assert row is not None
        assert row.status == "abandoned"
        assert row.next_attempt_at is None
        assert row.last_error == "EXTERNAL_OUTCOME_UNKNOWN"
        assert _row_optional(row, "terminal_reason") == "EXTERNAL_OUTCOME_UNKNOWN"
        assert _row_optional(row, "outcome_unknown") is True
        assert row.delivery_owner is None
        assert row.lease_expires_at is None
    assert dispatches == []


def test_direct_expired_sending_delivery_is_terminalized_without_http(monkeypatch, _engine) -> None:
    """A direct worker retry must recover an expired sending row instead of calling the receiver again."""
    _seed_webhook_context(_engine, version=1)
    with Session(_engine) as db:
        delivery = _delivery(event_id="event-direct-expired", status="sending", version=1)
        delivery.lease_expires_at = utc_now() - timedelta(minutes=1)
        db.add(delivery)
        db.commit()

    http_calls: list[str] = []

    def fake_post(*_args, **_kwargs) -> httpx.Response:
        """Record an accidental receiver attempt without making a network request."""
        http_calls.append("called")
        return httpx.Response(200)

    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(public_webhooks, "decrypt_secret", lambda _value: "test-secret")
    monkeypatch.setattr(public_webhooks.httpx, "post", fake_post)
    public_webhooks.deliver_webhook("delivery-event-direct-expired")

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-direct-expired")
        assert row is not None
        assert http_calls == []
        assert row.status == "abandoned"
        assert row.last_error == "EXTERNAL_OUTCOME_UNKNOWN"
        assert _row_optional(row, "terminal_reason") == "EXTERNAL_OUTCOME_UNKNOWN"
        assert _row_optional(row, "outcome_unknown") is True
        assert row.next_attempt_at is None


def test_expired_sending_recovery_preserves_lifecycle_denial_and_unknown_outcome(
    monkeypatch,
    _engine,
) -> None:
    """A suspended tenant still wins expiry recovery without making the outcome retryable."""
    _seed_webhook_context(_engine, status="suspended", version=2)
    with Session(_engine) as db:
        delivery = _delivery(event_id="event-expired-suspended", status="sending", version=1)
        delivery.lease_expires_at = utc_now() - timedelta(minutes=1)
        db.add(delivery)
        db.commit()

    dispatches: list[str] = []
    monkeypatch.setattr(public_webhooks, "engine", _engine)
    monkeypatch.setattr(
        public_webhooks,
        "enqueue_async_job",
        lambda _name, _handler, delivery_id: dispatches.append(delivery_id),
    )
    public_webhooks.enqueue_due_webhook_deliveries()

    with Session(_engine) as db:
        row = db.get(WebhookDelivery, "delivery-event-expired-suspended")
        assert row is not None
        assert row.status == "abandoned"
        assert row.last_error == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is True
        assert row.next_attempt_at is None
    assert dispatches == []


def test_public_run_polling_closes_main_transaction_around_worker_wait(monkeypatch, tmp_path) -> None:
    """The public run poller must not hold its read transaction across provider waiting."""
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'public-run-polling.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()

    session_id = "session-public-run-polling"
    job_id = "apijob-public-run-polling"
    with Session(race_engine) as db:
        db.add(
            Tenant(
                id=TENANT_ID,
                slug="public-lifecycle",
                name="Public Lifecycle Tenant",
                status="active",
                lifecycle_version=1,
            )
        )
        db.add(
            User(
                id=ACTOR_ID,
                tenant_id=TENANT_ID,
                username="lifecycle-admin",
                role="admin",
                password_hash="test-only-hash",
            )
        )
        db.add(
            APIClient(
                id=CLIENT_ID,
                tenant_id=TENANT_ID,
                name="lifecycle-client",
                scopes_json=["*"],
                created_by_user_id=ACTOR_ID,
            )
        )
        db.add(
            APICredential(
                id=CREDENTIAL_ID,
                tenant_id=TENANT_ID,
                client_id=CLIENT_ID,
                name="lifecycle-key",
                key_prefix="sd_live_lifecycle",
                key_digest="test-only-digest",
                scopes_json=["*"],
            )
        )
        db.add(
            ChatSession(
                id=session_id,
                tenant_id=TENANT_ID,
                user_id=ACTOR_ID,
                agent_id="agent-polling",
            )
        )
        db.add(
            APIJob(
                id=job_id,
                tenant_id=TENANT_ID,
                tenant_lifecycle_version=1,
                credential_id=CREDENTIAL_ID,
                agent_id="agent-polling",
                kind="run",
                status="running",
                stage="starting",
                session_id=session_id,
                request_json={
                    "session_id": session_id,
                    "session_mode": "stateful",
                    "input": "poll while provider is waiting",
                },
            )
        )
        db.commit()

    provider_started = threading.Event()
    release_provider = threading.Event()
    observed_wait_transactions: list[bool] = []

    class BlockingLoop:
        """Pause inside the harness boundary while the public poller observes the job."""

        def __init__(self, db: Session):
            self.db = db

        def handle_turn_stream(self, request):
            provider_started.set()
            if not release_provider.wait(5):
                raise RuntimeError("test provider did not receive release")
            session = self.db.get(ChatSession, request.session_id)
            assert session is not None
            yield {
                "event": "complete",
                "data": {
                    "reply": "provider complete",
                    "session_id": request.session_id,
                    "session_state": public_session(session).model_dump(mode="json"),
                },
            }

    real_event = public_runs.threading.Event

    class RecordingEvent:
        """Observe the main Session exactly when execute_run waits for the worker."""

        def __init__(self):
            self._event = real_event()

        def set(self) -> None:
            self._event.set()

        def is_set(self) -> bool:
            return self._event.is_set()

        def wait(self, timeout: float | None = None) -> bool:
            if (
                timeout == 0.1
                and provider_started.is_set()
                and not self._event.is_set()
            ):
                observed_wait_transactions.append(main_db.in_transaction())
                release_provider.set()
            return self._event.wait(timeout)

    monkeypatch.setattr(public_runs, "engine", race_engine)
    monkeypatch.setattr(public_runs, "AgentLoop", BlockingLoop)
    monkeypatch.setattr(public_runs.threading, "Event", RecordingEvent)
    boundary_transactions: list[bool] = []
    original_marker = public_runs.mark_side_effect_started

    def observe_run_boundary(db: Session) -> None:
        """Ensure the run provider boundary starts after the lifecycle read transaction closes."""
        boundary_transactions.append(db.in_transaction())
        original_marker(db)

    monkeypatch.setattr(public_runs, "mark_side_effect_started", observe_run_boundary)
    with Session(race_engine) as main_db:
        job = main_db.get(APIJob, job_id)
        assert job is not None
        result = public_runs.execute_run(main_db, job)

    assert result["reply"] == "provider complete"
    assert observed_wait_transactions == [False]
    assert boundary_transactions == [False]


class _GateTransactionDB:
    """Minimal Session seam for asserting a fresh transaction at provider boundaries."""

    def __init__(self) -> None:
        self.info: dict[str, object] = {}
        self._in_transaction = False

    def in_transaction(self) -> bool:
        return self._in_transaction

    def rollback(self) -> None:
        self._in_transaction = False


def _open_gate(db: _GateTransactionDB, _job: APIJob) -> None:
    """Model a lifecycle read that leaves a read transaction until the handler closes it."""
    db._in_transaction = True


def test_sop_generate_gate_closes_read_transaction_before_provider(monkeypatch) -> None:
    """SOP generation must rollback immediately after its final lifecycle gate."""
    db = _GateTransactionDB()
    job = APIJob(
        id="apijob-sop-generate-boundary",
        tenant_id=TENANT_ID,
        credential_id=CREDENTIAL_ID,
        agent_id="agent-boundary",
        kind="sop.generate",
        request_json={"title": "Boundary", "raw_content": "Provider input"},
    )
    observed_transactions: list[bool] = []

    class FailingDistiller:
        """Fail at the provider call after recording the transaction boundary."""

        def distill(self, _request, _model, **_kwargs):
            observed_transactions.append(db.in_transaction())
            raise RuntimeError("provider failure")

    monkeypatch.setattr(public_sops, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(public_sops, "_get_request_model", lambda *_args, **_kwargs: object(), raising=False)
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_get_request_model",
        lambda *_args, **_kwargs: object(),
    )
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_with_available_tools",
        lambda _db, request: request,
    )
    monkeypatch.setattr(public_sops, "_require_job_lifecycle", _open_gate)
    monkeypatch.setattr(public_sops, "SkillDistiller", FailingDistiller)

    with pytest.raises(RuntimeError, match="provider failure"):
        public_sops.execute_sop_generate(db, job)

    assert observed_transactions == [False]
    assert db.info.get(public_jobs._SIDE_EFFECT_STARTED_INFO_KEY) is True


def test_sop_rewrite_gate_closes_read_transaction_before_provider(monkeypatch) -> None:
    """SOP rewrite must rollback immediately after its final lifecycle gate."""
    db = _GateTransactionDB()
    job = APIJob(
        id="apijob-sop-rewrite-boundary",
        tenant_id=TENANT_ID,
        credential_id=CREDENTIAL_ID,
        agent_id="agent-boundary",
        kind="sop.rewrite",
        request_json={
            "current_skill": {
                "skill_id": "boundary-skill",
                "name": "Boundary skill",
                "nodes": [{"node_id": "start", "name": "Start"}],
                "start_node_id": "start",
                "terminal_node_ids": ["start"],
            },
            "instruction": "Rewrite this",
        },
    )
    observed_transactions: list[bool] = []

    class FailingEditor:
        """Fail at the provider call after recording the transaction boundary."""

        def rewrite(self, _request, _model, **_kwargs):
            observed_transactions.append(db.in_transaction())
            raise RuntimeError("provider failure")

    monkeypatch.setattr(public_sops, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_get_request_model",
        lambda *_args, **_kwargs: object(),
    )
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_with_available_context_for_rewrite",
        lambda _db, request: request,
    )
    monkeypatch.setattr(public_sops, "_require_job_lifecycle", _open_gate)
    monkeypatch.setattr(public_sops, "SkillEditor", FailingEditor)

    with pytest.raises(RuntimeError, match="provider failure"):
        public_sops.execute_sop_rewrite(db, job)

    assert observed_transactions == [False]
    assert db.info.get(public_jobs._SIDE_EFFECT_STARTED_INFO_KEY) is True


def test_knowledge_ingest_gate_closes_read_transaction_before_nested_worker(monkeypatch) -> None:
    """Knowledge ingestion must rollback immediately before creating its nested durable worker."""
    db = _GateTransactionDB()
    job = APIJob(
        id="apijob-knowledge-ingest-boundary",
        tenant_id=TENANT_ID,
        credential_id=CREDENTIAL_ID,
        agent_id="agent-boundary",
        kind="knowledge.ingest",
        request_json={
            "knowledge_base_id": "kb-boundary",
            "entries": [{"external_id": "entry-1", "content": "Document"}],
        },
    )
    observed_transactions: list[bool] = []

    def failing_upload(*_args, **_kwargs):
        """Fail at nested durable-worker admission after recording the transaction state."""
        observed_transactions.append(db.in_transaction())
        raise RuntimeError("nested worker failure")

    monkeypatch.setattr(public_resources, "_job_actor", lambda *_args, **_kwargs: (object(), object()))
    monkeypatch.setattr(public_resources, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(public_resources, "_require_job_lifecycle", _open_gate)
    monkeypatch.setattr(public_resources.internal_knowledge, "upload_document", failing_upload)

    with pytest.raises(RuntimeError, match="nested worker failure"):
        public_resources.execute_knowledge_ingest(db, job)

    assert observed_transactions == [False]
    assert db.info.get(public_jobs._SIDE_EFFECT_STARTED_INFO_KEY) is True


def test_knowledge_ingest_polling_stops_at_total_deadline(monkeypatch) -> None:
    """A nested ingest that stays pending must terminate instead of occupying a worker forever."""
    db = _GateTransactionDB()
    job = APIJob(
        id="apijob-knowledge-ingest-timeout",
        tenant_id=TENANT_ID,
        credential_id=CREDENTIAL_ID,
        agent_id="agent-boundary",
        kind="knowledge.ingest",
        request_json={
            "knowledge_base_id": "kb-boundary",
            "entries": [{"external_id": "entry-1", "content": "Document"}],
        },
    )
    inner = SimpleNamespace(id="inner-pending")
    reads = 0
    clock = iter((10.0, 10.0, 10.3))

    def get(_model, _inner_id):
        nonlocal reads
        reads += 1
        return SimpleNamespace(
            id="inner-pending",
            status="pending" if reads < 3 else "failed",
            stage="extracting",
            error=None,
            document_id=None,
        )

    db.get = get  # type: ignore[method-assign]
    db.expire_all = lambda: None  # type: ignore[method-assign]
    monkeypatch.setattr(public_resources, "_job_actor", lambda *_args, **_kwargs: (object(), object()))
    monkeypatch.setattr(public_resources, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(public_resources, "_require_job_lifecycle", _open_gate)
    monkeypatch.setattr(public_resources, "sleep", lambda _delay: None)
    monkeypatch.setattr(public_resources, "monotonic", lambda: next(clock), raising=False)
    monkeypatch.setattr(public_resources, "KNOWLEDGE_INGEST_POLL_TIMEOUT_SECONDS", 0.2, raising=False)
    monkeypatch.setattr(public_resources.internal_knowledge, "upload_document", lambda *_args, **_kwargs: inner)

    with pytest.raises(TimeoutError, match="(?i)knowledge ingest polling timed out"):
        public_resources.execute_knowledge_ingest(db, job)


@pytest.mark.parametrize("operation", ["generate", "rewrite"])
def test_sop_draft_write_rechecks_lifecycle_after_provider(
    monkeypatch,
    operation: str,
) -> None:
    """SOP draft persistence must have its own post-provider lifecycle fence."""
    db = _GateTransactionDB()
    if operation == "generate":
        job = APIJob(
            id="apijob-sop-generate-draft-fence",
            tenant_id=TENANT_ID,
            credential_id=CREDENTIAL_ID,
            agent_id="agent-boundary",
            kind="sop.generate",
            request_json={"title": "Boundary", "raw_content": "Provider input"},
        )
    else:
        job = APIJob(
            id="apijob-sop-rewrite-draft-fence",
            tenant_id=TENANT_ID,
            credential_id=CREDENTIAL_ID,
            agent_id="agent-boundary",
            kind="sop.rewrite",
            request_json={
                "current_skill": {
                    "skill_id": "boundary-skill",
                    "name": "Boundary skill",
                    "nodes": [{"node_id": "start", "name": "Start"}],
                    "start_node_id": "start",
                    "terminal_node_ids": ["start"],
                },
                "instruction": "Rewrite this",
            },
        )
    gate_calls: list[bool] = []
    draft_transactions: list[bool] = []
    execution_fence_calls: list[str] = []

    def observe_gate(gate_db: _GateTransactionDB, _job: APIJob) -> None:
        gate_calls.append(gate_db.in_transaction())
        gate_db._in_transaction = True

    def observe_execution_fence(_gate_db: _GateTransactionDB, fence_job: APIJob) -> None:
        execution_fence_calls.append(fence_job.id)

    class DraftSkill:
        def model_dump(self, **_kwargs):
            return {
                "skill_id": "boundary-skill",
                "name": "Boundary skill",
                "nodes": [{"node_id": "start", "name": "Start"}],
                "start_node_id": "start",
                "terminal_node_ids": ["start"],
            }

    provider_result = SimpleNamespace(
        draft_skill=DraftSkill(),
        warnings=[],
        tool_suggestions=[],
        changed_paths=[],
        assistant_message="",
    )

    class Provider:
        def distill(self, _request, _model, **_kwargs):
            db._in_transaction = True
            return provider_result

        def rewrite(self, _request, _model, **_kwargs):
            db._in_transaction = True
            return provider_result

    def observe_draft(draft_db, **_kwargs):
        draft_transactions.append(draft_db.in_transaction())
        return SimpleNamespace()

    monkeypatch.setattr(public_sops, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_get_request_model",
        lambda *_args, **_kwargs: object(),
    )
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_with_available_tools",
        lambda _db, request: request,
    )
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_with_available_context_for_rewrite",
        lambda _db, request: request,
    )
    monkeypatch.setattr(public_sops, "_require_job_lifecycle", observe_gate)
    monkeypatch.setattr(
        public_sops,
        "_require_job_execution_fence",
        observe_execution_fence,
        raising=False,
    )
    monkeypatch.setattr(public_sops, "SkillDistiller", Provider)
    monkeypatch.setattr(public_sops, "SkillEditor", Provider)
    monkeypatch.setattr(public_sops, "_new_draft", observe_draft)
    monkeypatch.setattr(public_sops, "_draft_payload", lambda _row: {"id": "draft"})

    if operation == "generate":
        result = public_sops.execute_sop_generate(db, job)
    else:
        result = public_sops.execute_sop_rewrite(db, job)

    assert result["draft"] == {"id": "draft"}
    assert len(gate_calls) == 3
    # Admission covers the initial progress event, provider, and draft write.
    assert execution_fence_calls == [job.id] * 3
    assert draft_transactions == [False]


def test_sop_draft_write_cas_rejects_suspend_after_draft_flush(monkeypatch, tmp_path) -> None:
    """A draft flushed by a claimed worker must roll back when lifecycle changes before commit."""
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'sop-draft-cas.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    _seed_tenant(race_engine)
    job_id = "apijob-sop-generate-draft-cas"
    owner = "sop-worker-owner"
    with Session(race_engine) as db:
        job = APIJob(
            id=job_id,
            tenant_id=TENANT_ID,
            tenant_lifecycle_version=1,
            credential_id=CREDENTIAL_ID,
            agent_id="agent-boundary",
            kind="sop.generate",
            status="running",
            stage="learning",
            execution_owner=owner,
            execution_generation=1,
            request_json={"title": "Boundary", "raw_content": "Provider input"},
        )
        db.add(job)
        db.commit()

    class DraftSkill:
        def model_dump(self, **_kwargs):
            return {
                "skill_id": "boundary-skill",
                "name": "Boundary skill",
                "nodes": [{"node_id": "start", "name": "Start"}],
                "start_node_id": "start",
                "terminal_node_ids": ["start"],
            }

    provider_result = SimpleNamespace(
        draft_skill=DraftSkill(),
        warnings=[],
        tool_suggestions=[],
    )

    class Provider:
        def distill(self, _request, _model, **_kwargs):
            return provider_result

    original_new_draft = public_sops._new_draft

    def flush_then_suspend(draft_db, **kwargs):
        kwargs.pop("commit", None)
        row = original_new_draft(draft_db, commit=False, **kwargs)
        return row

    gate_calls = 0
    original_gate = public_sops._require_job_lifecycle

    def final_gate_then_suspend(gate_db, gate_job):
        nonlocal gate_calls
        gate_calls += 1
        decision = original_gate(gate_db, gate_job)
        # The third check is the fresh post-provider gate.  At this point the
        # read transaction is rolled back by the handler before draft flush;
        # the persisted transition then makes the final owner/lifecycle CAS fail.
        if gate_calls == 3:
            _set_tenant_state_in_new_session(race_engine, status="suspended", version=2)
        return decision

    monkeypatch.setattr(public_sops, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_get_request_model",
        lambda *_args, **_kwargs: object(),
    )
    monkeypatch.setattr(
        public_sops.internal_skills,
        "_with_available_tools",
        lambda _db, request: request,
    )
    monkeypatch.setattr(public_sops, "SkillDistiller", Provider)
    monkeypatch.setattr(public_sops, "_new_draft", flush_then_suspend)
    monkeypatch.setattr(public_sops, "_require_job_lifecycle", final_gate_then_suspend)

    with Session(race_engine) as db:
        job = db.get(APIJob, job_id)
        assert job is not None
        db.info[public_jobs._EXECUTION_FENCE_INFO_KEY] = (owner, 1)
        with pytest.raises(lifecycle.TenantLifecycleDenied) as denied:
            public_sops.execute_sop_generate(db, job)
        assert denied.value.code == "TENANT_SUSPENDED"

    with Session(race_engine) as db:
        assert db.exec(select(APISOPDraft)).all() == []


def test_knowledge_ingest_rechecks_lifecycle_before_each_entry_update(monkeypatch) -> None:
    """Each ingest entry status write must follow its own lifecycle admission fence."""
    db = _GateTransactionDB()
    job = APIJob(
        id="apijob-knowledge-ingest-entry-fence",
        tenant_id=TENANT_ID,
        credential_id=CREDENTIAL_ID,
        agent_id="agent-boundary",
        kind="knowledge.ingest",
        request_json={
            "knowledge_base_id": "kb-boundary",
            "entries": [
                {"external_id": "entry-1", "content": "Document 1"},
                {"external_id": "entry-2", "content": "Document 2"},
            ],
        },
    )
    update_transactions: list[bool] = []
    gate_calls: list[bool] = []
    execution_fence_calls: list[str] = []
    inner_jobs: dict[str, SimpleNamespace] = {}
    upload_count = 0

    def observe_gate(gate_db: _GateTransactionDB, _job: APIJob) -> None:
        gate_calls.append(gate_db.in_transaction())
        gate_db._in_transaction = True

    def observe_execution_fence(_gate_db: _GateTransactionDB, fence_job: APIJob) -> None:
        execution_fence_calls.append(fence_job.id)

    def observe_update(update_db: _GateTransactionDB, *_args, **_kwargs) -> None:
        update_transactions.append(update_db.in_transaction())
        # Model a durable status write leaving the caller's transaction open until
        # the next explicit lifecycle boundary.
        update_db._in_transaction = True

    def upload(*_args, **_kwargs):
        nonlocal upload_count
        upload_count += 1
        db._in_transaction = True
        inner = SimpleNamespace(id=f"inner-{upload_count}")
        inner_jobs[inner.id] = SimpleNamespace(
            id=inner.id,
            status="succeeded",
            stage="completed",
            error=None,
            document_id=f"document-{upload_count}",
        )
        return inner

    def get(_model, inner_id):
        return inner_jobs.get(inner_id)

    db.get = get  # type: ignore[method-assign]
    db.expire_all = lambda: None  # type: ignore[method-assign]
    monkeypatch.setattr(public_resources, "_job_actor", lambda *_args, **_kwargs: (object(), object()))
    monkeypatch.setattr(public_resources, "update_job", observe_update)
    monkeypatch.setattr(public_resources, "_require_job_lifecycle", observe_gate)
    monkeypatch.setattr(
        public_resources,
        "_require_job_execution_fence",
        observe_execution_fence,
        raising=False,
    )
    monkeypatch.setattr(public_resources.internal_knowledge, "upload_document", upload)
    monkeypatch.setattr(public_resources, "sleep", lambda _delay: None)

    result = public_resources.execute_knowledge_ingest(db, job)

    assert len(result["documents"]) == 2
    assert upload_count == 2
    assert update_transactions == [False, False]
    # One gate before each durable entry update, one before each nested worker,
    # and one before each inner-worker status observation.
    assert len(gate_calls) == 6
    # Owner/generation admission is required at each durable update and nested worker.
    assert execution_fence_calls == [job.id] * 4


@pytest.mark.asyncio
async def test_generic_job_sse_stops_before_next_yield_after_tenant_suspension(
    monkeypatch,
    tmp_path,
) -> None:
    """Generic job SSE must gate every poll before exposing events after suspension."""
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'generic-job-sse.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    _seed_tenant(race_engine)
    job_id = "apijob-generic-sse-lifecycle"
    with Session(race_engine) as db:
        db.add(
            APIJob(
                id=job_id,
                tenant_id=TENANT_ID,
                tenant_lifecycle_version=1,
                credential_id=CREDENTIAL_ID,
                kind="custom.lifecycle",
                status="running",
            )
        )
        db.add(
            APIJobEvent(
                id="event-generic-sse-first",
                tenant_id=TENANT_ID,
                job_id=job_id,
                sequence=1,
                event_type="job.progress",
                data_json={"sequence": 1},
                public=True,
            )
        )
        db.commit()

    def suspend_and_append_event(_delay: float) -> None:
        """Create a second event only after the first batch has been yielded."""
        _set_tenant_state_in_new_session(race_engine, status="suspended", version=2)
        with Session(race_engine) as db:
            db.add(
                APIJobEvent(
                    id="event-generic-sse-second",
                    tenant_id=TENANT_ID,
                    job_id=job_id,
                    sequence=2,
                    event_type="job.progress",
                    data_json={"sequence": 2},
                    public=True,
                )
            )
            db.commit()

    monkeypatch.setattr(public_jobs, "engine", race_engine)
    monkeypatch.setattr(public_jobs, "sleep", suspend_and_append_event)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/jobs/{job_id}/events",
            "headers": [],
            "query_string": b"",
        }
    )
    with Session(race_engine) as db:
        response = public_jobs.stream_job_events(
            job_id,
            request,
            last_event_id=None,
            principal=_principal(),
            db=db,
        )
        iterator = response.body_iterator
        first = await anext(iterator)
        assert '"sequence": 1' in first
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)


@pytest.mark.asyncio
async def test_public_run_sse_yields_only_after_event_session_closes(monkeypatch, _engine) -> None:
    """Run SSE must not hold its event Session open while yielding a public chunk."""
    _seed_tenant(_engine)
    job_id = "apijob-public-run-sse-session-fence"
    with Session(_engine) as db:
        job = _job(kind="run", status="succeeded")
        job.id = job_id
        db.add(job)
        db.add(
            APIJobEvent(
                id="event-public-run-sse-session-fence",
                tenant_id=TENANT_ID,
                job_id=job_id,
                sequence=1,
                event_type="run.output.delta",
                data_json={"content": "safe chunk"},
                public=True,
            )
        )
        db.commit()

    tracked_sessions: list[object] = []

    class TrackingSession:
        """Observe whether the event query Session remains active at lifecycle/yield time."""

        def __init__(self, engine):
            self._session = Session(engine)
            self.active = False
            tracked_sessions.append(self)

        def __enter__(self):
            self._session.__enter__()
            self.active = True
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            self.active = False
            return self._session.__exit__(exc_type, exc_value, traceback)

        def get(self, *args, **kwargs):
            return self._session.get(*args, **kwargs)

        def exec(self, *args, **kwargs):
            return self._session.exec(*args, **kwargs)

        def in_transaction(self) -> bool:
            return self._session.in_transaction()

    gate_observations: list[bool] = []
    gate_calls = 0

    def observe_gate(_tenant_id: str, _admission_version: int, _correlation_id: str) -> bool:
        """Record the event Session state at the per-chunk gate."""
        nonlocal gate_calls
        gate_calls += 1
        if tracked_sessions and gate_calls == 2:
            event_session = tracked_sessions[-1]
            gate_observations.append(
                bool(getattr(event_session, "active", False))
                and event_session.in_transaction()
            )
        return True

    monkeypatch.setattr(public_runs, "Session", TrackingSession)
    monkeypatch.setattr(public_runs.public_jobs, "engine", _engine)
    monkeypatch.setattr(public_runs, "_require_public_run_stream_lifecycle", lambda *_args: None)
    monkeypatch.setattr(public_runs, "_public_run_stream_lifecycle_active", observe_gate)
    monkeypatch.setattr(public_runs.public_jobs, "sleep", lambda _delay: None)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/runs/{job_id}/events",
            "headers": [],
            "query_string": b"",
        }
    )
    with Session(_engine) as db:
        run = db.get(APIJob, job_id)
        assert run is not None
        response = public_runs._public_run_event_stream(
            run,
            request,
            after=0,
            last_event_id=None,
            principal=_principal(),
        )
        iterator = response.body_iterator
        first = await anext(iterator)
        assert "safe chunk" in first
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)

    assert gate_observations == [False]


@pytest.mark.asyncio
async def test_public_run_sse_stops_after_fast_suspend_reactivate(monkeypatch, _engine) -> None:
    """A stream admitted at v1 must stop after suspend/reactivate advances the version."""
    _seed_tenant(_engine, version=1)
    job_id = "apijob-public-run-sse-fast-reactivate"
    with Session(_engine) as db:
        job = _job(kind="run", status="succeeded", version=1)
        job.id = job_id
        db.add(job)
        db.add_all(
            [
                APIJobEvent(
                    id="event-public-run-sse-fast-reactivate-1",
                    tenant_id=TENANT_ID,
                    job_id=job_id,
                    sequence=1,
                    event_type="run.output.delta",
                    data_json={"content": "first"},
                    public=True,
                ),
                APIJobEvent(
                    id="event-public-run-sse-fast-reactivate-2",
                    tenant_id=TENANT_ID,
                    job_id=job_id,
                    sequence=2,
                    event_type="run.output.delta",
                    data_json={"content": "must-not-leak"},
                    public=True,
                ),
            ]
        )
        db.commit()

    original_active = public_runs._public_run_stream_lifecycle_active
    gate_calls = 0

    def suspend_then_reactivate(tenant_id: str, admission_version: int, correlation_id: str) -> bool:
        """Advance lifecycle between the first and second chunk while ending active."""
        nonlocal gate_calls
        gate_calls += 1
        allowed = original_active(tenant_id, admission_version, correlation_id)
        if gate_calls == 2:
            _set_tenant_state_in_new_session(_engine, status="suspended", version=2)
            _set_tenant_state_in_new_session(_engine, status="active", version=3)
        return allowed

    monkeypatch.setattr(public_runs, "engine", _engine)
    monkeypatch.setattr(public_runs.public_jobs, "engine", _engine)
    monkeypatch.setattr(public_runs, "_public_run_stream_lifecycle_active", suspend_then_reactivate)
    monkeypatch.setattr(public_runs.public_jobs, "sleep", lambda _delay: None)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/runs/{job_id}/events",
            "headers": [],
            "query_string": b"",
        }
    )
    with Session(_engine) as db:
        run = db.get(APIJob, job_id)
        assert run is not None
        response = public_runs._public_run_event_stream(
            run,
            request,
            after=0,
            last_event_id=None,
            principal=_principal(),
        )
        iterator = response.body_iterator
        first = await anext(iterator)
        assert "first" in first
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)

    assert gate_calls >= 2


def test_public_job_completion_cas_miss_terminalizes_after_lifecycle_race(
    monkeypatch,
    tmp_path,
) -> None:
    """A completion CAS miss after suspension must not leave the claimed job runnable."""
    race_engine = create_engine(
        f"sqlite:///{tmp_path / 'public-job-completion-race.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(race_engine)
    with race_engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    _seed_tenant(race_engine, version=1)
    kind = "test.lifecycle.casrun"
    public_jobs.register_job_handler(kind)(_successful_handler)
    job_id = "apijob-test-lifecycle-completion-cas"
    with Session(race_engine) as db:
        job = _job(kind=kind)
        job.id = job_id
        db.add(job)
        db.commit()

    original_terminalize = public_jobs._terminalize_job
    suspended = False

    def terminalize_after_suspend(db: Session, job: APIJob, **kwargs):
        """Race suspension into the success completion before its lifecycle CAS update."""
        nonlocal suspended
        if kwargs.get("status") == "succeeded" and not suspended:
            suspended = True
            db.rollback()
            _set_tenant_state_in_new_session(race_engine, status="suspended", version=2)
            db.rollback()
        return original_terminalize(db, job, **kwargs)

    monkeypatch.setattr(public_jobs, "_terminalize_job", terminalize_after_suspend)
    monkeypatch.setattr(public_jobs, "engine", race_engine)
    monkeypatch.setattr(public_jobs, "enqueue_async_job", lambda *_args, **_kwargs: None)
    public_jobs.run_job(job_id)

    with Session(race_engine) as db:
        row = db.get(APIJob, job_id)
        assert row is not None
        assert suspended is True
        assert row.status == "cancelled"
        assert row.stage == "cancelled"
        assert row.retryable is False
        assert row.result_json == {}
        assert row.error_json["code"] == "TENANT_SUSPENDED"
        assert _row_optional(row, "terminal_reason") == "TENANT_SUSPENDED"
        assert _row_optional(row, "outcome_unknown") is True

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.schema import AgentAPICredentialCreateRequest
from app.api import agents as agents_api
from app.api import auth as auth_api
from app.api.agents import (
    create_agent_api_credential,
    delete_agent_api_credential,
    list_agent_api_credentials,
    revoke_agent_api_credential,
    rotate_agent_api_credential,
)
from app.api.auth import (
    AccountAPICredentialCreateRequest,
    create_account_api_credential,
    delete_account_api_credential,
    list_account_api_credentials,
    revoke_account_api_credential,
    rotate_account_api_credential,
)
from app.db import get_session
from app.db.models import (
    AgentEvent,
    AgentProfile,
    APIClient,
    APICredential,
    APIJob,
    APIJobEvent,
    APISOPDraft,
    ChatSession,
    KnowledgeBase,
    KnowledgeBaseVersion,
    Message,
    Skill,
    Tenant,
    User,
    WebhookDelivery,
    utc_now,
)
from app.public_api import jobs as public_jobs
from app.public_api import runs as public_runs
from app.public_api.app import create_public_api_app
from app.public_api.credential_profiles import (
    AGENT_RUNTIME_SCOPES,
    USER_FULL_ACCESS_SCOPES,
)
from app.public_api.errors import PublicAPIError, problem_response
from app.public_api.jobs import recover_public_jobs, register_job_handler, run_job
from app.public_api.json_patch import JSONPatchError, apply_json_patch
from app.public_api.runs import execute_run
from app.security.auth import create_access_token
from app.security.encryption import decrypt_recoverable_api_key
from app.session.helpers import public_session
from app.session.session_schema import ChatTurnRequest, ChatTurnResponse


def _skill_card() -> dict:
    return {
        "skill_id": "expense_policy_v1",
        "name": "报销制度",
        "version": "1.0.0",
        "description": "回答报销政策",
        "trigger_intents": ["查询报销制度"],
        "nodes": [
            {
                "node_id": "answer",
                "type": "respond",
                "name": "回答",
                "instruction": "依据制度回答并给出引用",
                "capability_refs": {
                    "general_skill_ids": [],
                    "tool_ids": [],
                    "knowledge_base_ids": [],
                },
            }
        ],
        "edges": [],
        "start_node_id": "answer",
        "terminal_node_ids": ["answer"],
    }


def _language_snapshot() -> dict[str, object]:
    """Return one mixed immutable locale snapshot with explicit public ingress provenance."""
    return {
        "version": 1,
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "explicit_request",
        "agent_reply_locale_source": "explicit_request",
    }


def _legacy_language_snapshot() -> dict[str, object]:
    """Return the controlled compatibility snapshot for public requests without locale hints."""
    return {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "legacy_default",
        "agent_reply_locale_source": "legacy_default",
    }


def _client(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_api", name="API Tenant"))
        admin = User(
            id="user_api_admin",
            tenant_id="tenant_api",
            username="api_admin",
            role="admin",
            password_hash="x",
        )
        db.add(admin)
        db.add(
            AgentProfile(
                id="agent_api",
                tenant_id="tenant_api",
                name="API Employee",
                status="active",
                is_overall=False,
                metadata_json={"owner_user_id": admin.id, "owner_username": admin.username},
            )
        )
        db.add(
            AgentProfile(
                id="agent_other",
                tenant_id="tenant_api",
                name="Other Employee",
                status="active",
                is_overall=False,
                metadata_json={"owner_user_id": admin.id, "owner_username": admin.username},
            )
        )
        db.commit()
        token = create_access_token(admin)

    app = create_public_api_app()

    def session_override():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = session_override
    monkeypatch.setattr("app.public_api.app.engine", engine)
    monkeypatch.setattr("app.public_api.jobs.enqueue_async_job", lambda *args, **kwargs: "queued")
    return TestClient(app), engine, token


def _tenant_key(client: TestClient, admin_token: str, scopes: list[str]) -> str:
    created = client.post(
        "/api-clients",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"name": "integration", "scopes": ["*"]},
    )
    assert created.status_code == 201, created.text
    credential = client.post(
        f"/api-clients/{created.json()['id']}/credentials",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"name": "tenant runtime", "scopes": scopes},
    )
    assert credential.status_code == 201, credential.text
    return credential.json()["api_key"]


def test_problem_details_and_openapi_contract(monkeypatch) -> None:
    client, _engine, _token = _client(monkeypatch)
    unauthorized = client.get("/agents")
    assert unauthorized.status_code == 401
    assert unauthorized.headers["content-type"].startswith("application/problem+json")
    assert unauthorized.json()["code"] == "NOT_AUTHENTICATED"
    assert unauthorized.json()["request_id"].startswith("req_")

    schema = client.get("/openapi.json").json()
    expected = {
        "/agents/{agent_id}/runs",
        "/agents/{agent_id}/runs:stream",
        "/runs/{run_id}/events",
        "/agents/{agent_id}/sops:generate",
        "/agents/{agent_id}/sops/{sop_id}",
        "/sops/{sop_id}:publish",
        "/agents/{agent_id}/knowledge-bases/{knowledge_base_id}/entries",
        "/agents/{agent_id}/tools",
        "/agents/{agent_id}/scheduled-tasks",
        "/gallery/agents",
        "/gallery/agents/{agent_id}:add",
    }
    assert expected.issubset(schema["paths"])


def test_public_problem_preserves_request_trace_and_safe_canonical_fields(monkeypatch) -> None:
    """Project canonical metadata while retaining only a stable v1 compatibility detail."""
    client, _engine, _token = _client(monkeypatch)
    response = client.get(
        "/agents",
        headers={"X-Request-ID": "req-contract", "X-Trace-ID": "trace-contract"},
    )

    payload = response.json()
    assert payload["request_id"] == "req-contract"
    assert payload["trace_id"] == "trace-contract"
    assert payload["params"] == {}
    assert payload["retryable"] is False
    assert payload["detail"] == "NOT_AUTHENTICATED"
    assert payload["deprecated_fields"] == ["detail"]


def test_public_http_exception_does_not_publish_raw_provider_message(monkeypatch) -> None:
    """Map arbitrary HTTP exception prose to a registered safe fallback instead of public detail."""
    client, _engine, _token = _client(monkeypatch)
    raw_provider_message = "provider body token=do-not-publish"

    def raise_provider_failure() -> None:
        """Raise one seeded legacy exception so the public boundary must sanitize it."""
        raise HTTPException(status_code=502, detail=raw_provider_message)

    client.app.add_api_route("/_contract/provider-failure", raise_provider_failure)
    response = client.get(
        "/_contract/provider-failure",
        headers={"X-Request-ID": "req-provider", "X-Trace-ID": "trace-provider"},
    )

    payload = response.json()
    assert payload["code"] == "INTERNAL_ERROR"
    assert payload["request_id"] == "req-provider"
    assert payload["trace_id"] == "trace-provider"
    assert raw_provider_message not in response.text


def test_public_api_error_fail_closes_unknown_and_malformed_codes(monkeypatch) -> None:
    """Project unknown or malformed Public API errors to a safe fallback without leaking raw detail."""
    client, _engine, _token = _client(monkeypatch)
    raw_detail = "provider body token=do-not-publish"
    raw_params = {"provider_message": raw_detail}

    def raise_unknown_public_error() -> None:
        """Raise one unregistered public error to verify the compatibility boundary fails closed."""
        raise PublicAPIError(
            502,
            "UNREGISTERED_PROVIDER_FAILURE",
            raw_detail,
            params=raw_params,
            retryable=True,
        )

    def raise_malformed_public_error() -> None:
        """Raise one malformed code to verify descriptor validation never escapes the handler."""
        raise PublicAPIError(
            502,
            "bad-code",
            raw_detail,
            params=raw_params,
            retryable=True,
        )

    client.app.add_api_route("/_contract/public-error-unknown", raise_unknown_public_error)
    client.app.add_api_route("/_contract/public-error-malformed", raise_malformed_public_error)

    for path, request_id, trace_id in (
        ("/_contract/public-error-unknown", "req-unknown-public", "trace-unknown-public"),
        ("/_contract/public-error-malformed", "req-bad-public", "trace-bad-public"),
    ):
        response = client.get(path, headers={"X-Request-ID": request_id, "X-Trace-ID": trace_id})
        payload = response.json()
        assert response.status_code == 502
        assert payload["code"] == "INTERNAL_ERROR"
        assert payload["params"] == {}
        assert payload["retryable"] is False
        assert payload["request_id"] == request_id
        assert payload["trace_id"] == trace_id
        assert payload["detail"] == "INTERNAL_ERROR"
        assert raw_detail not in response.text
        assert "UNREGISTERED_PROVIDER_FAILURE" not in response.text


def test_public_api_error_never_publishes_known_code_legacy_detail(monkeypatch) -> None:
    """Keep deprecated detail stable even when a registered error carries provider prose."""
    client, _engine, _token = _client(monkeypatch)
    seeded_secret = "provider token=seeded-secret dynamic-detail-do-not-publish"

    def raise_known_public_error() -> None:
        """Raise a registered error with diagnostic prose that must remain private."""
        raise PublicAPIError(
            502,
            "NOT_AUTHENTICATED",
            seeded_secret,
            params={},
            retryable=False,
        )

    client.app.add_api_route("/_contract/public-error-known", raise_known_public_error)
    response = client.get(
        "/_contract/public-error-known",
        headers={"X-Request-ID": "req-known-public", "X-Trace-ID": "trace-known-public"},
    )

    payload = response.json()
    assert response.status_code == 502
    assert payload["code"] == "NOT_AUTHENTICATED"
    assert payload["params"] == {}
    assert payload["retryable"] is False
    assert payload["request_id"] == "req-known-public"
    assert payload["trace_id"] == "trace-known-public"
    assert payload["detail"] == "NOT_AUTHENTICATED"
    assert payload["deprecated_fields"] == ["detail"]
    assert seeded_secret not in response.text


def test_problem_response_never_publishes_direct_legacy_detail(monkeypatch) -> None:
    """Keep direct problem_response callers from leaking a seeded provider detail."""
    client, _engine, _token = _client(monkeypatch)
    seeded_secret = "provider token=direct-seeded-secret dynamic-detail-do-not-publish"

    def direct_problem_response(request: Request):
        """Return the compatibility response with caller-owned prose as diagnostic input."""
        return problem_response(
            request,
            status_code=409,
            code="NOT_AUTHENTICATED",
            detail=seeded_secret,
            params={},
            retryable=False,
        )

    client.app.add_api_route("/_contract/problem-response-detail", direct_problem_response)
    response = client.get(
        "/_contract/problem-response-detail",
        headers={"X-Request-ID": "req-direct-problem", "X-Trace-ID": "trace-direct-problem"},
    )

    payload = response.json()
    assert response.status_code == 409
    assert payload["code"] == "NOT_AUTHENTICATED"
    assert payload["detail"] == "NOT_AUTHENTICATED"
    assert payload["request_id"] == "req-direct-problem"
    assert payload["trace_id"] == "trace-direct-problem"
    assert seeded_secret not in response.text


def test_public_validation_projects_codes_without_framework_messages(monkeypatch) -> None:
    """Expose stable validation paths/codes and counts without publishing framework prose."""
    client, _engine, _token = _client(monkeypatch)

    def validate_limit(limit: int) -> dict[str, int]:
        """Return the parsed query value so an invalid value exercises the real validation handler."""
        return {"limit": limit}

    client.app.add_api_route("/_contract/validation", validate_limit)
    response = client.get(
        "/_contract/validation?limit=not-an-integer",
        headers={"X-Request-ID": "req-validation", "X-Trace-ID": "trace-validation"},
    )

    payload = response.json()
    assert payload["code"] == "VALIDATION_ERROR"
    assert payload["params"] == {"error_count": 1}
    assert payload["request_id"] == "req-validation"
    assert payload["trace_id"] == "trace-validation"
    assert payload["errors"] == [{"path": "query.limit", "code": "int_parsing"}]


def test_api_key_scope_agent_boundary_and_idempotent_run(monkeypatch) -> None:
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["agents:read", "runs:create", "runs:read"])
    headers = {"Authorization": f"Bearer {tenant_key}", "Idempotency-Key": "run-order-1"}

    first = client.post(
        "/agents/agent_api/runs",
        headers=headers,
        json={"input": "查询制度", "session_mode": "stateless"},
    )
    second = client.post(
        "/agents/agent_api/runs",
        headers=headers,
        json={"input": "查询制度", "session_mode": "stateless"},
    )
    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    with Session(engine) as db:
        assert len(db.exec(select(APIJob)).all()) == 1

    client_row = client.get(
        "/api-clients",
        headers={"Authorization": f"Bearer {admin_token}"},
    ).json()[0]
    employee_credential = client.post(
        f"/api-clients/{client_row['id']}/credentials",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "name": "employee runtime",
            "agent_id": "agent_api",
            "scopes": ["agents:read", "runs:create", "runs:read"],
        },
    )
    assert employee_credential.status_code == 201, employee_credential.text
    employee_key = employee_credential.json()["api_key"]
    assert client.get(
        "/agents/agent_other",
        headers={"Authorization": f"Bearer {employee_key}"},
    ).status_code == 403


def test_streaming_run_endpoint_emits_reply_deltas(monkeypatch) -> None:
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["agents:read", "runs:create", "runs:read"])

    class FakeStreamingLoop:
        def __init__(self, db):
            self.db = db

        def handle_turn_stream(self, request):
            session = self.db.get(ChatSession, request.session_id)
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="stream_delta",
                    payload_json={"content": "流式答复", "turn_id": request.client_turn_id},
                )
            )
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="stream_end",
                    payload_json={"turn_id": request.client_turn_id},
                )
            )
            self.db.add(
                Message(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    role="assistant",
                    content="流式答复",
                    metadata_json={"client_turn_id": request.client_turn_id},
                )
            )
            self.db.commit()
            response = ChatTurnResponse(
                reply="流式答复",
                session_id=request.session_id,
                session_state=public_session(session),
            )
            yield {"event": "complete", "data": response.model_dump(mode="json")}

    monkeypatch.setattr("app.public_api.jobs.engine", engine)
    monkeypatch.setattr("app.public_api.runs.engine", engine)
    monkeypatch.setattr("app.public_api.runs.AgentLoop", FakeStreamingLoop)
    monkeypatch.setattr(
        "app.public_api.jobs.enqueue_async_job",
        lambda _name, func, job_id: func(job_id),
    )
    response = client.post(
        "/agents/agent_api/runs:stream",
        headers={
            "Authorization": f"Bearer {tenant_key}",
            "Idempotency-Key": "stream-run-1",
            "Accept": "text/event-stream",
        },
        json={"input": "请流式回答", "session_mode": "stateless"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-run-id"].startswith("apijob_")
    assert "event: run.output.delta" in response.text
    assert '"content": "流式答复"' in response.text
    assert "event: run.output.completed" in response.text


def test_public_run_trace_maps_harness_actions_and_failures() -> None:
    from app.public_api.runs import _TRACE_EVENT_MAP

    assert _TRACE_EVENT_MAP["harness_action_created"] == "run.action.started"
    assert _TRACE_EVENT_MAP["harness_action_failed"] == "run.action.failed"
    assert _TRACE_EVENT_MAP["error_occurred"] == "run.failed"


@pytest.mark.parametrize(
    ("source_error", "expected_code", "expected_retryable"),
    [
        (
            {"code": "MODEL_UPSTREAM_ERROR", "params": {}, "retryable": False},
            "MODEL_UPSTREAM_ERROR",
            True,
        ),
        ({"code": "UNREGISTERED_PROVIDER_FAILURE", "params": {}}, "INTERNAL_ERROR", False),
        (
            {"code": "KNOWLEDGE_UPSTREAM_TIMEOUT", "params": {"provider_id": 7}},
            "INTERNAL_ERROR",
            False,
        ),
    ],
)
def test_agent_loop_error_event_relay_projects_registered_failure_descriptor(
    monkeypatch,
    source_error: dict[str, object],
    expected_code: str,
    expected_retryable: bool,
) -> None:
    """Relay AgentLoop failures with registry-owned retryability and no diagnostic prose."""
    _client_value, engine, _token = _client(monkeypatch)
    raw_error = "provider token=do-not-publish path=/private/runtime.sock"
    with Session(engine) as db:
        chat_session = ChatSession(
            id="session_error_relay",
            tenant_id="tenant_api",
            user_id="user_api_admin",
            agent_id="agent_api",
            status="running",
        )
        job = APIJob(
            id="apijob_error_relay",
            tenant_id="tenant_api",
            credential_id="credential_error_relay",
            agent_id="agent_api",
            kind="run",
            status="running",
            session_id=chat_session.id,
            request_json={
                "_event_context": {
                    "request_id": "req-error-relay",
                    "trace_id": "trace-error-relay",
                }
            },
            language_context_json=_language_snapshot(),
        )
        db.add(chat_session)
        db.add(job)
        db.add(
            AgentEvent(
                tenant_id="tenant_api",
                session_id=chat_session.id,
                event_type="error_occurred",
                payload_json={
                    **source_error,
                    "client_turn_id": job.id,
                    "message": raw_error,
                    "text": raw_error,
                    "status_text": raw_error,
                    "error_details": {"traceback": raw_error},
                },
            )
        )
        db.commit()

        public_runs._relay_agent_events(db, job, chat_session.id, set())
        db.commit()
        failed_event = db.exec(
            select(APIJobEvent).where(
                APIJobEvent.job_id == job.id,
                APIJobEvent.event_type == "run.failed",
            )
        ).one()

    assert failed_event.data_json["params"] == {
        "job_id": "apijob_error_relay",
        "error_code": expected_code,
        "retryable": expected_retryable,
    }
    assert failed_event.data_json["request_id"] == "req-error-relay"
    assert failed_event.data_json["trace_id"] == "trace-error-relay"
    assert failed_event.data_json["client_turn_id"] == "apijob_error_relay"
    assert "source_code" not in failed_event.data_json
    assert raw_error not in json.dumps(failed_event.data_json, ensure_ascii=False)


def test_successful_job_clears_stale_restart_error(monkeypatch) -> None:
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        client = APIClient(
            id="client_recovered",
            tenant_id="tenant_api",
            name="recovered-client",
            scopes_json=["runs:*"],
            created_by_user_id="user_api_admin",
        )
        credential = APICredential(
            id="credential_recovered",
            tenant_id="tenant_api",
            client_id=client.id,
            name="runtime",
            key_prefix="sd_live_recovered",
            key_digest="digest",
            scopes_json=["runs:create", "runs:read"],
        )
        job = APIJob(
            id="apijob_recovered",
            tenant_id="tenant_api",
            credential_id=credential.id,
            agent_id="agent_api",
            kind="test.recovered",
            status="running",
            stage="interrupted",
            retryable=True,
            error_json={"code": "SERVICE_RESTARTED"},
        )
        db.add(client)
        db.add(credential)
        db.add(job)
        db.commit()

    register_job_handler("test.recovered")(lambda _db, _job: {"ok": True})
    monkeypatch.setattr("app.public_api.jobs.engine", engine)
    run_job("apijob_recovered")

    with Session(engine) as db:
        completed = db.get(APIJob, "apijob_recovered")
        assert completed is not None
        assert completed.status == "succeeded"
        assert completed.stage == "completed"
        assert completed.error_json == {}
        assert completed.retryable is False


def test_failed_run_job_releases_session_and_emits_terminal_event(monkeypatch) -> None:
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        api_client = APIClient(
            id="client_failed_run",
            tenant_id="tenant_api",
            name="failed-run-client",
            scopes_json=["runs:*"],
            created_by_user_id="user_api_admin",
        )
        credential = APICredential(
            id="credential_failed_run",
            tenant_id="tenant_api",
            client_id=api_client.id,
            name="runtime",
            key_prefix="sd_live_failed_run",
            key_digest="digest",
            scopes_json=["runs:create", "runs:read"],
        )
        chat_session = ChatSession(
            id="session_failed_run",
            tenant_id="tenant_api",
            user_id="user_api_admin",
            agent_id="agent_api",
            status="running",
        )
        job = APIJob(
            id="apijob_failed_run",
            tenant_id="tenant_api",
            credential_id=credential.id,
            agent_id="agent_api",
            kind="run",
            status="queued",
            session_id=chat_session.id,
        )
        db.add(api_client)
        db.add(credential)
        db.add(chat_session)
        db.add(job)
        db.commit()

    raw_error = "provider token=do-not-publish"

    def fail_run(_db, _job):
        raise RuntimeError(raw_error)

    monkeypatch.setitem(public_jobs._handlers, "run", fail_run)
    monkeypatch.setattr("app.public_api.jobs.engine", engine)
    run_job("apijob_failed_run")

    with Session(engine) as db:
        failed = db.get(APIJob, "apijob_failed_run")
        chat_session = db.get(ChatSession, "session_failed_run")
        event = db.exec(
            select(AgentEvent).where(
                AgentEvent.session_id == "session_failed_run",
                AgentEvent.event_type == "stream_interrupted",
            )
        ).one()
        assert failed is not None and failed.status == "failed"
        assert chat_session is not None and chat_session.status == "active"
        assert event.payload_json["job_id"] == "apijob_failed_run"
        assert event.payload_json["code"] == "INTERNAL_ERROR"
        assert event.payload_json["message"] == "Run interrupted."
        assert raw_error not in json.dumps(event.payload_json, ensure_ascii=False)


def test_failed_job_read_result_sse_and_webhook_expose_only_safe_error_fields(monkeypatch) -> None:
    """Project failed job errors canonically across stored state, API reads, SSE, and webhook payloads."""
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(
        client,
        admin_token,
        ["runs:read", "runs:create", "webhooks:write", "webhooks:read"],
    )
    raw_error = "provider token=do-not-publish"
    creation_headers = {
        "Authorization": f"Bearer {tenant_key}",
        "Idempotency-Key": "failed-job-safe-error",
        "X-Request-ID": "req-failed-job",
        "X-Trace-ID": "trace-failed-job",
    }
    created = client.post(
        "/webhooks",
        headers={"Authorization": f"Bearer {tenant_key}"},
        json={"name": "run events", "url": "https://example.com/hook", "events": ["run.*"]},
    )
    assert created.status_code == 201, created.text
    run = client.post(
        "/agents/agent_api/runs",
        headers=creation_headers,
        json={"input": "触发失败", "session_mode": "stateless"},
    )
    assert run.status_code == 202, run.text
    job_id = run.json()["id"]

    def fail_run(_db, _job):
        raise RuntimeError(raw_error)

    monkeypatch.setitem(public_jobs._handlers, "run", fail_run)
    monkeypatch.setattr("app.public_api.jobs.engine", engine)
    run_job(job_id)

    replay_headers = {"Authorization": f"Bearer {tenant_key}"}
    job_response = client.get(f"/jobs/{job_id}", headers=replay_headers)
    result_response = client.get(f"/jobs/{job_id}/result", headers=replay_headers)
    events_response = client.get(f"/runs/{job_id}/events", headers=replay_headers)

    with Session(engine) as db:
        failed = db.get(APIJob, job_id)
        assert failed is not None
        failed_event = db.exec(
            select(APIJobEvent)
            .where(APIJobEvent.job_id == job_id, APIJobEvent.event_type == "run.failed")
            .order_by(APIJobEvent.sequence.desc())
        ).first()
        delivery = db.exec(
            select(WebhookDelivery).where(WebhookDelivery.event_type == "run.failed")
        ).first()

    assert job_response.status_code == 200, job_response.text
    assert result_response.status_code == 200, result_response.text
    assert events_response.status_code == 200, events_response.text
    assert failed is not None
    assert failed.error_json == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": "req-failed-job",
        "trace_id": "trace-failed-job",
    }
    assert job_response.json()["error"] == failed.error_json
    assert result_response.json()["error"] == failed.error_json
    assert raw_error not in job_response.text
    assert raw_error not in result_response.text
    assert failed_event is not None
    assert failed_event.data_json["code"] == "public.run.failed"
    assert failed_event.data_json["params"] == {
        "job_id": job_id,
        "error_code": "INTERNAL_ERROR",
        "retryable": True,
    }
    assert "message" not in failed_event.data_json
    assert "source_message" not in failed_event.data_json
    assert raw_error not in json.dumps(failed_event.data_json, ensure_ascii=False)
    assert delivery is not None
    assert delivery.payload_json["data"] == failed_event.data_json
    assert raw_error not in json.dumps(delivery.payload_json, ensure_ascii=False)
    assert raw_error not in events_response.text


def test_recovery_repairs_terminal_run_session(monkeypatch) -> None:
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        api_client = APIClient(
            id="client_reconcile_run",
            tenant_id="tenant_api",
            name="reconcile-run-client",
            scopes_json=["runs:*"],
            created_by_user_id="user_api_admin",
        )
        credential = APICredential(
            id="credential_reconcile_run",
            tenant_id="tenant_api",
            client_id=api_client.id,
            name="runtime",
            key_prefix="sd_live_reconcile_run",
            key_digest="digest",
            scopes_json=["runs:create", "runs:read"],
        )
        chat_session = ChatSession(
            id="session_reconcile_run",
            tenant_id="tenant_api",
            user_id="user_api_admin",
            agent_id="agent_api",
            status="running",
        )
        job = APIJob(
            id="apijob_reconcile_run",
            tenant_id="tenant_api",
            credential_id=credential.id,
            agent_id="agent_api",
            kind="run",
            status="failed",
            stage="interrupted",
            session_id=chat_session.id,
            error_json={
                "code": "SERVICE_RESTARTED",
                "message": "The service restarted while the job was running.",
            },
        )
        db.add(api_client)
        db.add(credential)
        db.add(chat_session)
        db.add(job)
        db.commit()

    monkeypatch.setattr("app.public_api.jobs.engine", engine)
    recover_public_jobs()

    with Session(engine) as db:
        chat_session = db.get(ChatSession, "session_reconcile_run")
        event = db.exec(
            select(AgentEvent).where(
                AgentEvent.session_id == "session_reconcile_run",
                AgentEvent.event_type == "stream_interrupted",
            )
        ).one()
        assert chat_session is not None and chat_session.status == "active"
        assert event.payload_json["code"] == "INTERNAL_ERROR"
        assert event.payload_json["message"] == "Run interrupted."


def test_sop_changes_remain_isolated_until_publish(monkeypatch) -> None:
    client, engine, admin_token = _client(monkeypatch)
    key = _tenant_key(client, admin_token, ["sops:read", "sops:write", "sops:publish"])
    headers = {"Authorization": f"Bearer {key}", "Idempotency-Key": "sop-create-1"}
    created = client.post(
        "/agents/agent_api/sops",
        headers=headers,
        json={"content": _skill_card()},
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    with Session(engine) as db:
        assert db.exec(select(APISOPDraft)).first() is not None
        assert db.exec(select(Skill).where(Skill.skill_id == "expense_policy_v1")).first() is None

    missing_etag = client.patch(
        f"/agents/agent_api/sops/expense_policy_v1?draft_id={draft['id']}",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json-patch+json"},
        json=[{"op": "replace", "path": "/description", "value": "新版"}],
    )
    assert missing_etag.status_code == 428

    patched = client.patch(
        f"/agents/agent_api/sops/expense_policy_v1?draft_id={draft['id']}",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json-patch+json",
            "If-Match": draft["etag"],
        },
        json=[{"op": "replace", "path": "/description", "value": "新版"}],
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["content"]["description"] == "新版"
    stale = client.patch(
        f"/agents/agent_api/sops/expense_policy_v1?draft_id={draft['id']}",
        headers={"Authorization": f"Bearer {key}", "If-Match": '"stale"'},
        json=[{"op": "replace", "path": "/description", "value": "覆盖"}],
    )
    assert stale.status_code == 412
    validation = client.post(
        f"/sops/expense_policy_v1:validate?agent_id=agent_api&draft_id={draft['id']}",
        headers={"Authorization": f"Bearer {key}"},
    )
    assert validation.status_code == 200, validation.text
    assert validation.json()["valid"] is True
    published = client.post(
        "/sops/expense_policy_v1:publish?agent_id=agent_api",
        headers={"Authorization": f"Bearer {key}"},
        json={"draft_id": draft["id"]},
    )
    assert published.status_code == 200, published.text
    with Session(engine) as db:
        assert db.exec(select(Skill).where(Skill.skill_id == "expense_policy_v1")).first() is not None
        assert db.get(APISOPDraft, draft["id"]).status == "published"


def test_sop_validation_projects_only_safe_codes_and_paths(monkeypatch) -> None:
    """Persist and return SOP validation errors without natural-language diagnostic detail."""
    client, engine, admin_token = _client(monkeypatch)
    key = _tenant_key(client, admin_token, ["sops:read", "sops:write"])
    content = _skill_card()
    content["nodes"][0]["capability_refs"]["general_skill_ids"] = ["missing_general_skill"]
    created = client.post(
        "/agents/agent_api/sops",
        headers={"Authorization": f"Bearer {key}", "Idempotency-Key": "sop-validation-safe"},
        json={"content": content},
    )
    assert created.status_code == 201, created.text
    draft = created.json()

    validation = client.post(
        f"/sops/expense_policy_v1:validate?agent_id=agent_api&draft_id={draft['id']}",
        headers={"Authorization": f"Bearer {key}"},
    )

    with Session(engine) as db:
        row = db.get(APISOPDraft, draft["id"])

    assert validation.status_code == 200, validation.text
    assert validation.json() == {
        "valid": False,
        "errors": [
            {
                "path": "capability_refs.general_skill",
                "code": "CAPABILITY_UNAVAILABLE",
            }
        ],
        "warnings": [],
    }
    assert row is not None
    assert row.validation_json == validation.json()
    assert "detail" not in validation.text


def test_rfc6902_supports_array_append_move_copy_and_test() -> None:
    source = {"nodes": [{"id": "a"}], "meta": {"owner": "x"}}
    patched = apply_json_patch(
        source,
        [
            {"op": "test", "path": "/meta/owner", "value": "x"},
            {"op": "add", "path": "/nodes/-", "value": {"id": "b"}},
            {"op": "copy", "from": "/meta/owner", "path": "/meta/reviewer"},
            {"op": "move", "from": "/nodes/0", "path": "/nodes/1"},
        ],
    )
    assert patched["nodes"] == [{"id": "b"}, {"id": "a"}]
    assert patched["meta"]["reviewer"] == "x"
    assert source == {"nodes": [{"id": "a"}], "meta": {"owner": "x"}}
    try:
        apply_json_patch(source, [{"op": "test", "path": "/meta/owner", "value": "no"}])
    except JSONPatchError:
        pass
    else:
        raise AssertionError("A failed RFC6902 test operation must abort the patch")


def test_resource_wrappers_derive_tenant_and_mask_tool_secrets(monkeypatch) -> None:
    client, _engine, admin_token = _client(monkeypatch)
    key = _tenant_key(
        client,
        admin_token,
        [
            "knowledge:read",
            "knowledge:write",
            "skills:read",
            "skills:write",
            "tools:read",
            "tools:write",
            "scheduled_tasks:read",
            "scheduled_tasks:write",
        ],
    )
    auth = {"Authorization": f"Bearer {key}"}
    knowledge = client.post(
        "/agents/agent_api/knowledge-bases",
        headers=auth,
        json={"name": "Policy", "description": "Expense policy", "capability_scope": "general"},
    )
    assert knowledge.status_code == 201, knowledge.text
    assert knowledge.json()["mode"] == "dedicated"
    listed_knowledge = client.get("/agents/agent_api/knowledge-bases", headers=auth)
    assert listed_knowledge.status_code == 200
    assert [row["id"] for row in listed_knowledge.json()["data"]] == [
        knowledge.json()["id"]
    ]

    skill = client.post(
        "/agents/agent_api/general-skills",
        headers=auth,
        json={
            "name": "Weather",
            "slug": "weather",
            "markdown": "---\nname: Weather\ndescription: Weather lookup\n---\n# Weather\nUse the available weather source.",
            "status": "published",
            "capability_scope": "general",
        },
    )
    assert skill.status_code == 201, skill.text
    assert client.get("/agents/agent_api/general-skills", headers=auth).status_code == 200

    tool = client.post(
        "/agents/agent_api/tools",
        headers=auth,
        json={
            "name": "policy_api",
            "method": "GET",
            "url": "https://example.com/policy",
            "headers": {"Authorization": "Bearer secret"},
            "auth": {"token": "secret"},
            "capability_scope": "general",
        },
    )
    assert tool.status_code == 201, tool.text
    assert tool.json()["headers"]["Authorization"] == "********"
    assert tool.json()["auth"]["token"] == "********"
    listed = client.get("/agents/agent_api/tools", headers=auth)
    assert listed.status_code == 200, listed.text
    assert listed.json()["data"][0]["headers"]["Authorization"] == "********"

    scheduled = client.post(
        "/agents/agent_api/scheduled-tasks",
        headers=auth,
        json={
            "title": "Daily policy check",
            "prompt": "检查报销制度更新",
            "schedule_type": "daily",
            "schedule": {"time": "09:00"},
            "timezone": "Asia/Shanghai",
        },
    )
    assert scheduled.status_code == 201, scheduled.text
    assert client.get("/agents/agent_api/scheduled-tasks", headers=auth).status_code == 200


def test_public_employee_resource_create_rejects_shared_knowledge_mode(monkeypatch) -> None:
    """员工资源 API 只能创建专用知识库，不能绕过团队共享配置入口。"""
    client, engine, admin_token = _client(monkeypatch)
    key = _tenant_key(client, admin_token, ["knowledge:read", "knowledge:write"])
    auth = {"Authorization": f"Bearer {key}"}

    response = client.post(
        "/agents/agent_api/knowledge-bases",
        headers=auth,
        json={"name": "Forbidden shared", "mode": "shared"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "KNOWLEDGE_MODE_INVALID"
    with Session(engine) as db:
        assert db.exec(
            select(KnowledgeBase).where(KnowledgeBase.name == "Forbidden shared")
        ).first() is None


def test_public_employee_resource_write_rejects_shared_knowledge_base(monkeypatch) -> None:
    """员工资源写入口不能向共享正式库排队写入任务。"""
    client, engine, admin_token = _client(monkeypatch)
    key = _tenant_key(client, admin_token, ["knowledge:read", "knowledge:write"])
    auth = {
        "Authorization": f"Bearer {key}",
        "Idempotency-Key": "shared-write-denied-1",
    }
    with Session(engine) as db:
        shared = KnowledgeBase(
            id="kb_public_shared",
            tenant_id="tenant_api",
            name="Shared managed elsewhere",
            mode="shared",
            status="active",
        )
        db.add(shared)
        db.flush()
        released = KnowledgeBaseVersion(
            id="kbver_public_shared",
            tenant_id="tenant_api",
            knowledge_base_id=shared.id,
            version="1.0.0",
            name=shared.name,
            status="active",
            publication_state="released",
        )
        db.add(released)
        db.flush()
        shared.published_version_id = released.id
        db.add(shared)
        db.commit()

    response = client.post(
        "/agents/agent_api/knowledge-bases/kb_public_shared/entries",
        headers=auth,
        json={"entries": [{"title": "blocked", "content": "must not enqueue"}]},
    )

    assert response.status_code == 404
    with Session(engine) as db:
        assert db.exec(
            select(APIJob).where(APIJob.kind == "knowledge.ingest")
        ).first() is None


def test_public_employee_resource_update_rejects_shared_knowledge_base(monkeypatch) -> None:
    """员工资源 API 不能通过通用更新入口修改团队管理的共享知识库。"""
    client, engine, admin_token = _client(monkeypatch)
    key = _tenant_key(client, admin_token, ["knowledge:read", "knowledge:write"])
    auth = {"Authorization": f"Bearer {key}"}
    with Session(engine) as db:
        db.add(
            KnowledgeBase(
                id="kb_public_shared_patch",
                tenant_id="tenant_api",
                name="Shared before patch",
                mode="shared",
                status="active",
            )
        )
        db.commit()

    response = client.patch(
        "/agents/agent_api/knowledge-bases/kb_public_shared_patch",
        headers=auth,
        json={"name": "Shared after patch"},
    )

    assert response.status_code == 404
    assert response.json()["code"] == "KNOWLEDGE_BASE_NOT_FOUND"
    with Session(engine) as db:
        row = db.get(KnowledgeBase, "kb_public_shared_patch")
        assert row is not None
        assert row.name == "Shared before patch"


def test_run_handler_relays_live_public_trace_and_returns_citations(monkeypatch) -> None:
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        client = APIClient(
            id="client_run",
            tenant_id="tenant_api",
            name="run-client",
            scopes_json=["runs:*"],
            created_by_user_id="user_api_admin",
        )
        credential = APICredential(
            id="credential_run",
            tenant_id="tenant_api",
            client_id=client.id,
            name="runtime",
            key_prefix="sd_live_test_prefix",
            key_digest="digest",
            scopes_json=["runs:create", "runs:read"],
        )
        job = APIJob(
            id="apijob_live_trace",
            tenant_id="tenant_api",
            credential_id=credential.id,
            agent_id="agent_api",
            kind="run",
            status="running",
            request_json={"input": "查询政策", "session_mode": "stateless"},
        )
        db.add(client)
        db.add(credential)
        db.add(job)
        db.commit()

    class FakeLoop:
        def __init__(self, db):
            self.db = db

        def handle_turn(self, request):
            session = self.db.get(ChatSession, request.session_id)
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="turn_plan_created",
                    payload_json={
                        "decision": "answer_only",
                        "reason": "policy query",
                        "client_turn_id": request.client_turn_id,
                        "system_prompt": "must not leak",
                    },
                )
            )
            self.db.add(
                Message(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    role="assistant",
                    content="制度答复 [1]",
                    metadata_json={
                        "client_turn_id": request.client_turn_id,
                        "knowledge_citations": [{"label": "[1]", "document_id": "doc_1"}],
                    },
                )
            )
            self.db.commit()
            return ChatTurnResponse(
                reply="制度答复 [1]",
                session_id=request.session_id,
                session_state=public_session(session),
            )

        def handle_turn_stream(self, request):
            response = self.handle_turn(request)
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="stream_delta",
                    payload_json={"content": "制度答复 [1]", "turn_id": request.client_turn_id},
                    # A late database insert may carry an older source timestamp.
                    created_at=utc_now() - timedelta(days=1),
                )
            )
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="stream_delta",
                    payload_json={"content": "另一轮内容", "client_turn_id": "other-run"},
                )
            )
            self.db.add(
                AgentEvent(
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    event_type="stream_end",
                    payload_json={"turn_id": request.client_turn_id},
                )
            )
            self.db.commit()
            yield {"event": "complete", "data": response.model_dump(mode="json")}

    monkeypatch.setattr("app.public_api.runs.engine", engine)
    monkeypatch.setattr("app.public_api.runs.AgentLoop", FakeLoop)
    with Session(engine) as db:
        job = db.get(APIJob, "apijob_live_trace")
        result = execute_run(db, job)
        public_events = db.exec(
            select(APIJobEvent).where(APIJobEvent.job_id == job.id)
        ).all()
    assert result["citations"] == [{"label": "[1]", "document_id": "doc_1"}]
    plan_event = next(event for event in public_events if event.event_type == "run.plan")
    assert plan_event.data_json["params"] == {"decision": "answer_only"}
    assert "system_prompt" not in plan_event.data_json
    output_event = next(event for event in public_events if event.event_type == "run.output.delta")
    assert output_event.data_json["content"] == "制度答复 [1]"
    assert not any(
        event.data_json.get("content") == "另一轮内容"
        for event in public_events
        if event.event_type == "run.output.delta"
    )
    completed_event = next(
        event for event in public_events if event.event_type == "run.output.completed"
    )
    assert completed_event.data_json["citations"] == [
        {"label": "[1]", "document_id": "doc_1"}
    ]


def test_employee_settings_manage_runtime_keys(monkeypatch) -> None:
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        created = create_agent_api_credential(
            "agent_api",
            AgentAPICredentialCreateRequest(
                tenant_id="tenant_api",
                name="财务助手运行密钥",
                access="runtime",
            ),
            db,
            admin,
        )
        assert created.api_key.startswith("sd_live_")
        assert set(created.scopes) == set(AGENT_RUNTIME_SCOPES)
        assert "runs:create" in created.scopes
        assert "knowledge:read" not in created.scopes
        assert "knowledge:write" not in created.scopes

        stored = db.get(APICredential, created.id)
        assert stored is not None
        assert stored.key_digest != created.api_key

        listed = list_agent_api_credentials("agent_api", "tenant_api", db, admin)
        assert listed[0].access == "runtime"
        assert not hasattr(listed[0], "api_key")

        rotated = rotate_agent_api_credential(
            "agent_api", created.id, "tenant_api", db, admin
        )
        assert rotated.api_key.startswith("sd_live_")
        assert rotated.api_key != created.api_key

        revoked = revoke_agent_api_credential(
            "agent_api", created.id, "tenant_api", db, admin
        )
        assert revoked.status == "revoked"


def test_account_credential_reveal_returns_the_created_value_to_its_owner(monkeypatch) -> None:
    """防止账户密钥没有加密副本时仍声称可以在列表中复制完整值。"""
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        assert admin is not None
        created = create_account_api_credential(
            AccountAPICredentialCreateRequest(name="可复制账户密钥"), admin, db
        )
        stored = db.get(APICredential, created.id)
        assert stored is not None
        assert getattr(stored, "encrypted_key", None) not in (None, created.api_key)

        reveal = getattr(auth_api, "reveal_account_api_credential", None)
        assert callable(reveal)
        assert reveal(created.id, admin, db).api_key == created.api_key

        listed = list_account_api_credentials(admin, db)
        assert created.api_key not in listed[0].model_dump().values()
        assert getattr(listed[0], "can_reveal", False) is True


def test_employee_credential_reveal_returns_the_created_value_to_its_manager(monkeypatch) -> None:
    """防止员工密钥的完整值绕过员工管理授权或只保留不可恢复的摘要。"""
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        assert admin is not None
        created = create_agent_api_credential(
            "agent_api",
            AgentAPICredentialCreateRequest(
                tenant_id="tenant_api", name="可复制员工密钥", access="runtime"
            ),
            db,
            admin,
        )
        stored = db.get(APICredential, created.id)
        assert stored is not None
        assert getattr(stored, "encrypted_key", None) not in (None, created.api_key)

        reveal = getattr(agents_api, "reveal_agent_api_credential", None)
        assert callable(reveal)
        assert reveal("agent_api", created.id, "tenant_api", db, admin).api_key == created.api_key

        listed = list_agent_api_credentials("agent_api", "tenant_api", db, admin)
        assert created.api_key not in listed[0].model_dump().values()
        assert getattr(listed[0], "can_reveal", False) is True


def test_public_api_credential_lifecycle_refreshes_its_recovery_copy(monkeypatch) -> None:
    """防止公共 API 创建或轮换后，控制台复制到旧值或不可复制的值。"""
    client, engine, admin_token = _client(monkeypatch)
    headers = {"Authorization": f"Bearer {admin_token}"}
    client_response = client.post(
        "/api-clients",
        headers=headers,
        json={"name": "可复制公共客户端", "scopes": ["*"]},
    )
    assert client_response.status_code == 201, client_response.text

    created_response = client.post(
        f"/api-clients/{client_response.json()['id']}/credentials",
        headers=headers,
        json={"name": "可复制公共密钥", "scopes": ["runs:create"]},
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    with Session(engine) as db:
        stored = db.get(APICredential, created["id"])
        assert stored is not None
        assert decrypt_recoverable_api_key(stored.encrypted_key) == created["api_key"]

    rotated_response = client.post(f"/credentials/{created['id']}:rotate", headers=headers)
    assert rotated_response.status_code == 200, rotated_response.text
    rotated = rotated_response.json()
    assert rotated["api_key"] != created["api_key"]
    with Session(engine) as db:
        stored = db.get(APICredential, created["id"])
        assert stored is not None
        assert decrypt_recoverable_api_key(stored.encrypted_key) == rotated["api_key"]

    revoked_response = client.post(f"/credentials/{created['id']}:revoke", headers=headers)
    assert revoked_response.status_code == 200, revoked_response.text
    with Session(engine) as db:
        stored = db.get(APICredential, created["id"])
        assert stored is not None
        assert stored.encrypted_key is None


def test_credential_reveal_rejects_inactive_legacy_and_unauthorized_access(monkeypatch) -> None:
    """防止已失效、旧版或无权密钥通过复制完整值重新暴露。"""
    _client_value, engine, _token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        assert admin is not None
        outsider = User(
            id="user_api_reveal_outsider",
            tenant_id="tenant_api",
            username="api_reveal_outsider",
            role="member",
            password_hash="x",
        )
        db.add(outsider)
        db.commit()
        account_credential = create_account_api_credential(
            AccountAPICredentialCreateRequest(name="受限账户密钥"), admin, db
        )
        employee_credential = create_agent_api_credential(
            "agent_api",
            AgentAPICredentialCreateRequest(
                tenant_id="tenant_api", name="受限员工密钥", access="runtime"
            ),
            db,
            admin,
        )

        reveal_account = getattr(auth_api, "reveal_account_api_credential", None)
        reveal_employee = getattr(agents_api, "reveal_agent_api_credential", None)
        assert callable(reveal_account)
        assert callable(reveal_employee)

        with pytest.raises(HTTPException) as account_forbidden:
            reveal_account(account_credential.id, outsider, db)
        assert account_forbidden.value.status_code == 404

        with pytest.raises(HTTPException) as employee_forbidden:
            reveal_employee(
                "agent_api", employee_credential.id, "tenant_api", db, outsider
            )
        assert employee_forbidden.value.status_code == 403

        revoked_account = revoke_account_api_credential(account_credential.id, admin, db)
        assert revoked_account.can_reveal is False
        stored_account = db.get(APICredential, account_credential.id)
        assert stored_account is not None
        assert stored_account.encrypted_key is None
        with pytest.raises(HTTPException) as inactive:
            reveal_account(account_credential.id, admin, db)
        assert inactive.value.status_code == 409

        stored = db.get(APICredential, employee_credential.id)
        assert stored is not None
        stored.encrypted_key = None
        db.add(stored)
        db.commit()
        with pytest.raises(HTTPException) as legacy:
            reveal_employee("agent_api", employee_credential.id, "tenant_api", db, admin)
        assert legacy.value.status_code == 409

        stored.encrypted_key = "not-a-valid-encrypted-key"
        db.add(stored)
        db.commit()
        with pytest.raises(HTTPException) as unreadable:
            reveal_employee("agent_api", employee_credential.id, "tenant_api", db, admin)
        assert unreadable.value.status_code == 409

        revoked_employee = revoke_agent_api_credential(
            "agent_api", employee_credential.id, "tenant_api", db, admin
        )
        assert revoked_employee.can_reveal is False
        db.refresh(stored)
        assert stored.encrypted_key is None


def test_api_credential_deletion_is_scoped_and_invalidates_tokens(monkeypatch) -> None:
    client, engine, _admin_token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        assert admin is not None
        outsider = User(
            id="user_api_outsider",
            tenant_id="tenant_api",
            username="api_outsider",
            role="member",
            password_hash="x",
        )
        db.add(outsider)
        db.commit()

        employee_credential = create_agent_api_credential(
            "agent_api",
            AgentAPICredentialCreateRequest(
                tenant_id="tenant_api",
                name="待删除员工密钥",
                access="runtime",
            ),
            db,
            admin,
        )
        account_credential = create_account_api_credential(
            AccountAPICredentialCreateRequest(name="待删除账号密钥"),
            admin,
            db,
        )

        with pytest.raises(HTTPException) as forbidden:
            delete_agent_api_credential(
                "agent_api", employee_credential.id, "tenant_api", db, outsider
            )
        assert forbidden.value.status_code == 403
        assert forbidden.value.detail["code"] == "AGENT_MANAGE_FORBIDDEN"
        assert forbidden.value.detail["params"] == {}
        assert "Only the creator or administrator" not in repr(forbidden.value.detail)

        with pytest.raises(HTTPException) as missing:
            delete_account_api_credential(account_credential.id, outsider, db)
        assert missing.value.status_code == 404
        assert (
            missing.value.detail["code"]
            == "AUTH_ACCOUNT_API_CREDENTIAL_NOT_FOUND"
        )
        assert missing.value.detail["params"] == {}
        assert "Account API credential not found" not in repr(missing.value.detail)

        delete_agent_api_credential(
            "agent_api", employee_credential.id, "tenant_api", db, admin
        )
        assert db.get(APICredential, employee_credential.id) is None

        delete_account_api_credential(account_credential.id, admin, db)
        assert db.get(APICredential, account_credential.id) is None

    response = client.get(
        "/agents",
        headers={"Authorization": f"Bearer {account_credential.api_key}"},
    )
    assert response.status_code == 401


def test_account_master_key_follows_user_visible_agents(monkeypatch) -> None:
    client, engine, _admin_token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        member = User(
            id="user_api_member",
            tenant_id="tenant_api",
            username="api_member",
            role="member",
            password_hash="x",
        )
        db.add(member)
        db.add_all(
            [
                AgentProfile(
                    id="agent_member_owned",
                    tenant_id="tenant_api",
                    name="Member Employee",
                    status="active",
                    is_overall=False,
                    metadata_json={"owner_user_id": member.id},
                ),
                AgentProfile(
                    id="agent_published",
                    tenant_id="tenant_api",
                    name="Published Employee",
                    status="active",
                    is_overall=False,
                    metadata_json={
                        "owner_user_id": admin.id,
                        "published_to_gallery": True,
                    },
                ),
                AgentProfile(
                    id="agent_private",
                    tenant_id="tenant_api",
                    name="Private Employee",
                    status="active",
                    is_overall=False,
                    metadata_json={"owner_user_id": admin.id},
                ),
                AgentProfile(
                    id="agent_overall",
                    tenant_id="tenant_api",
                    name="Overall Employee",
                    status="active",
                    is_overall=True,
                    metadata_json={"owner_user_id": admin.id},
                ),
            ]
        )
        db.commit()

        created = create_account_api_credential(
            AccountAPICredentialCreateRequest(
                name="成员账号全量密钥",
            ),
            member,
            db,
        )
        assert created.api_key.startswith("sd_live_")
        assert set(created.scopes) == set(USER_FULL_ACCESS_SCOPES)
        assert "knowledge:read" in created.scopes
        assert "knowledge:write" in created.scopes
        assert "gallery:use" in created.scopes
        stored = db.get(APICredential, created.id)
        assert stored is not None and stored.agent_id is None

    auth = {"Authorization": f"Bearer {created.api_key}"}
    listed_agents = client.get("/agents", headers=auth)
    assert listed_agents.status_code == 200, listed_agents.text
    agent_ids = {row["id"] for row in listed_agents.json()["data"]}
    assert {"agent_member_owned", "agent_published", "agent_overall"} <= agent_ids
    assert "agent_private" not in agent_ids
    assert "agent_api" not in agent_ids

    for agent_id in ("agent_member_owned", "agent_published", "agent_overall"):
        response = client.get(f"/agents/{agent_id}/capabilities", headers=auth)
        assert response.status_code == 200, response.text
    private_response = client.get("/agents/agent_private/capabilities", headers=auth)
    assert private_response.status_code == 404
    assert private_response.json()["code"] == "AGENT_NOT_FOUND"

    gallery = client.get("/gallery/agents", headers=auth)
    assert gallery.status_code == 200, gallery.text
    gallery_rows = gallery.json()["data"]
    assert [row["id"] for row in gallery_rows] == ["agent_published"]
    assert gallery_rows[0]["added"] is False

    added = client.post(
        "/gallery/agents/agent_published:add",
        headers={**auth, "Idempotency-Key": "add-published-1"},
    )
    replayed = client.post(
        "/gallery/agents/agent_published:add",
        headers={**auth, "Idempotency-Key": "add-published-1"},
    )
    assert added.status_code == replayed.status_code == 200
    assert added.json()["id"] == replayed.json()["id"] == "agent_published"
    assert added.json()["added"] is True
    assert client.get("/gallery/agents", headers=auth).json()["data"][0]["added"] is True
    assert client.post(
        "/gallery/agents/agent_private:add",
        headers={**auth, "Idempotency-Key": "add-private-1"},
    ).status_code == 404

    created_agent = client.post(
        "/agents",
        headers={**auth, "Idempotency-Key": "create-member-agent-1"},
        json={"name": "Member API Employee", "source_mode": "blank"},
    )
    assert created_agent.status_code == 201, created_agent.text
    assert created_agent.json()["metadata"]["owner_user_id"] == "user_api_member"
    published = client.get("/agents/agent_published", headers=auth)
    assert published.status_code == 200
    forbidden = client.patch(
        "/agents/agent_published",
        headers={**auth, "If-Match": published.headers["etag"]},
        json={"description": "不应允许修改"},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["code"] == "AGENT_MANAGE_FORBIDDEN"
    # Visibility is evaluated on every request, not frozen into the key.
    with Session(engine) as db:
        private = db.get(AgentProfile, "agent_private")
        private.metadata_json = {
            **dict(private.metadata_json or {}),
            "published_to_gallery": True,
        }
        db.add(private)
        db.commit()
    refreshed_agents = client.get("/agents", headers=auth)
    assert "agent_private" in {row["id"] for row in refreshed_agents.json()["data"]}

    with Session(engine) as db:
        member = db.get(User, "user_api_member")
        rows = list_account_api_credentials(member, db)
        assert rows[0].access == "user_full_access"
        assert not hasattr(rows[0], "api_key")
        rotated = rotate_account_api_credential(
            created.id, member, db
        )
        assert rotated.api_key != created.api_key
        revoked = revoke_account_api_credential(
            created.id, member, db
        )
        assert revoked.status == "revoked"


def test_gallery_directory_supports_search_and_cursor_pagination(monkeypatch) -> None:
    client, engine, _admin_token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        assert admin is not None
        db.add_all(
            [
                AgentProfile(
                    id="gallery_hr",
                    tenant_id="tenant_api",
                    name="人事助手",
                    description="查询员工休假与薪酬制度",
                    status="active",
                    is_overall=False,
                    metadata_json={
                        "owner_user_id": admin.id,
                        "published_to_gallery": True,
                        "expertise_tags": ["年假", "薪酬"],
                    },
                ),
                AgentProfile(
                    id="gallery_legal",
                    tenant_id="tenant_api",
                    name="法务助手",
                    description="处理合同、用印和合规问题",
                    status="active",
                    is_overall=False,
                    metadata_json={
                        "owner_user_id": admin.id,
                        "published_to_gallery": True,
                        "expertise_tags": ["合同", "用印"],
                    },
                ),
                AgentProfile(
                    id="gallery_finance",
                    tenant_id="tenant_api",
                    name="财务助手",
                    description="处理报销与预算问题",
                    status="active",
                    is_overall=False,
                    metadata_json={
                        "owner_user_id": admin.id,
                        "published_to_gallery": True,
                        "expertise_tags": ["报销", "预算"],
                    },
                ),
            ]
        )
        db.commit()
        created = create_account_api_credential(
            AccountAPICredentialCreateRequest(name="目录分页密钥"),
            admin,
            db,
        )

    auth = {"Authorization": f"Bearer {created.api_key}"}
    first = client.get("/gallery/agents?limit=2", headers=auth)
    assert first.status_code == 200, first.text
    assert len(first.json()["data"]) == 2
    assert first.json()["next_cursor"]

    second = client.get(
        "/gallery/agents",
        headers=auth,
        params={"limit": 2, "cursor": first.json()["next_cursor"]},
    )
    assert second.status_code == 200, second.text
    first_ids = {row["id"] for row in first.json()["data"]}
    second_ids = {row["id"] for row in second.json()["data"]}
    assert first_ids.isdisjoint(second_ids)
    assert first_ids | second_ids == {"gallery_hr", "gallery_legal", "gallery_finance"}

    searched = client.get(
        "/gallery/agents",
        headers=auth,
        params={"query": "用印", "limit": 20},
    )
    assert searched.status_code == 200, searched.text
    assert [row["id"] for row in searched.json()["data"]] == ["gallery_legal"]

    invalid = client.get("/gallery/agents?cursor=not-a-cursor", headers=auth)
    assert invalid.status_code == 400
    invalid_payload = invalid.json()
    assert invalid_payload["code"] == "INVALID_CURSOR"
    assert invalid_payload["params"] == {}
    assert invalid_payload["retryable"] is False
    assert "not-a-cursor" not in invalid.text


def test_admin_account_master_key_sees_all_visible_tenant_agents(monkeypatch) -> None:
    client, engine, _admin_token = _client(monkeypatch)
    with Session(engine) as db:
        admin = db.get(User, "user_api_admin")
        db.add(
            AgentProfile(
                id="agent_hidden",
                tenant_id="tenant_api",
                name="Hidden Employee",
                status="active",
                is_overall=False,
                metadata_json={
                    "owner_user_id": admin.id,
                    "hidden_from_staffdeck": True,
                },
            )
        )
        db.commit()
        created = create_account_api_credential(
            AccountAPICredentialCreateRequest(
                name="管理员账号全量密钥",
            ),
            admin,
            db,
        )

    response = client.get(
        "/agents",
        headers={"Authorization": f"Bearer {created.api_key}"},
    )
    assert response.status_code == 200, response.text
    agent_ids = {row["id"] for row in response.json()["data"]}
    assert {"agent_api", "agent_other"} <= agent_ids
    assert "agent_hidden" not in agent_ids


def test_public_api_rejects_new_full_access_employee_keys(monkeypatch) -> None:
    client, _engine, admin_token = _client(monkeypatch)
    api_client = client.post(
        "/api-clients",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"name": "employee-full-access", "scopes": ["*"]},
    ).json()
    credential = client.post(
        f"/api-clients/{api_client['id']}/credentials",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "name": "employee master key",
            "agent_id": "agent_api",
            "scopes": sorted(USER_FULL_ACCESS_SCOPES),
        },
    )
    assert credential.status_code == 400
    credential_payload = credential.json()
    assert credential_payload["code"] == "AGENT_SCOPE_INVALID"
    assert credential_payload["params"] == {}
    assert "employee master key" not in credential.text


def test_internal_job_remains_durably_queued_when_executor_is_stopping(monkeypatch) -> None:
    _client_instance, engine, _admin_token = _client(monkeypatch)

    def reject_submission(*args, **kwargs):
        raise RuntimeError("executor is shutting down")

    monkeypatch.setattr(public_jobs, "enqueue_async_job", reject_submission)
    with Session(engine) as db:
        created = public_jobs.create_internal_job(
            db,
            tenant_id="tenant_api",
            kind="feedback.analyze",
            request_payload={"feedback_id": "feedback-1"},
        )
        persisted = db.get(APIJob, created.id)

    assert persisted is not None
    assert persisted.status == "queued"
    assert persisted.credential_id == "internal"


def test_public_run_idempotent_replay_reuses_ingress_language_snapshot(monkeypatch) -> None:
    """Persist explicit public locales once and replay the same job without translating input."""
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["runs:create", "runs:read"])
    headers = {
        "Authorization": f"Bearer {tenant_key}",
        "Idempotency-Key": "language-run-replay",
    }
    body = {
        "input": "原始客户请求《不要翻译》",
        "session_mode": "stateless",
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
    }

    first = client.post("/agents/agent_api/runs", headers=headers, json=body)
    replay = client.post("/agents/agent_api/runs", headers=headers, json=body)

    assert first.status_code == replay.status_code == 202
    assert first.json()["id"] == replay.json()["id"]
    with Session(engine) as db:
        jobs = db.exec(select(APIJob)).all()
        assert len(jobs) == 1
        assert jobs[0].language_context_json == _language_snapshot()
        assert jobs[0].request_json["input"] == "原始客户请求《不要翻译》"


def test_public_run_without_locale_uses_controlled_legacy_snapshot(monkeypatch) -> None:
    """Backfill a versioned legacy snapshot when public ingress supplies no locale hints."""
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["runs:create", "runs:read"])

    response = client.post(
        "/agents/agent_api/runs",
        headers={
            "Authorization": f"Bearer {tenant_key}",
            "Idempotency-Key": "language-run-default",
        },
        json={"input": "保持原始输入", "session_mode": "stateless"},
    )

    assert response.status_code == 202
    with Session(engine) as db:
        job = db.get(APIJob, response.json()["id"])
        assert job is not None
        assert job.language_context_json == _legacy_language_snapshot()
        assert job.request_json["input"] == "保持原始输入"


def test_public_run_rejects_reply_locale_conflicting_with_session_snapshot(monkeypatch) -> None:
    """Fail closed before enqueue when an explicit reply locale conflicts with the session."""
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(
        client,
        admin_token,
        ["sessions:write", "runs:create", "runs:read"],
    )
    created_session = client.post(
        "/agents/agent_api/sessions",
        headers={
            "Authorization": f"Bearer {tenant_key}",
            "Idempotency-Key": "language-session-create",
        },
        json={"title": "原始会话标题"},
    )
    assert created_session.status_code == 201, created_session.text
    session_id = created_session.json()["id"]
    with Session(engine) as db:
        chat_session = db.get(ChatSession, session_id)
        assert chat_session is not None
        chat_session.agent_reply_locale = "zh-CN"
        chat_session.agent_reply_locale_source = "user_preference"
        db.add(chat_session)
        db.commit()

    response = client.post(
        "/agents/agent_api/runs",
        headers={
            "Authorization": f"Bearer {tenant_key}",
            "Idempotency-Key": "language-session-conflict",
        },
        json={
            "input": "原始冲突请求",
            "session_id": session_id,
            "ui_locale": "en-US",
            "agent_reply_locale": "en-US",
        },
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "AGENT_REPLY_LOCALE_CONFLICT"
    assert payload["params"] == {"requested": "en-US", "session": "zh-CN"}
    assert payload["retryable"] is False
    assert "原始冲突请求" not in response.text
    with Session(engine) as db:
        assert db.exec(select(APIJob)).all() == []


def test_public_session_without_title_preserves_missing_business_title(monkeypatch) -> None:
    """Leave an omitted raw business title empty so each client can localize its UI fallback."""
    client, _engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["sessions:write"])

    response = client.post(
        "/agents/agent_api/sessions",
        headers={
            "Authorization": f"Bearer {tenant_key}",
            "Idempotency-Key": "session-without-business-title",
        },
        json={},
    )

    assert response.status_code == 201, response.text
    assert response.json()["title"] is None


def test_recovered_public_run_executes_with_persisted_language_snapshot(monkeypatch) -> None:
    """Use the durable job snapshot after recovery even if the actor preference has changed."""
    _client_value, engine, _token = _client(monkeypatch)
    captured_requests: list[ChatTurnRequest] = []
    with Session(engine) as db:
        actor = db.get(User, "user_api_admin")
        assert actor is not None
        actor.ui_locale = "zh-CN"
        actor.agent_reply_locale = "en-US"
        api_client = APIClient(
            id="client_language_recovery",
            tenant_id="tenant_api",
            name="language-recovery-client",
            scopes_json=["runs:*"],
            created_by_user_id=actor.id,
        )
        credential = APICredential(
            id="credential_language_recovery",
            tenant_id="tenant_api",
            client_id=api_client.id,
            name="runtime",
            key_prefix="sd_live_language_recovery",
            key_digest="digest",
            scopes_json=["runs:create", "runs:read"],
        )
        job = APIJob(
            id="apijob_language_recovery",
            tenant_id="tenant_api",
            credential_id=credential.id,
            agent_id="agent_api",
            kind="run",
            status="running",
            stage="interrupted",
            request_json={
                "input": "恢复后仍使用《原始客户请求》",
                "session_mode": "stateless",
            },
            language_context_json=_language_snapshot(),
        )
        db.add(actor)
        db.add(api_client)
        db.add(credential)
        db.add(job)
        db.commit()

    class RecordingLoop:
        """Capture the recovered public request and return one verbatim external reply."""

        def __init__(self, db: Session) -> None:
            self.db = db

        def handle_turn_stream(self, request: ChatTurnRequest):
            captured_requests.append(request)
            session = self.db.get(ChatSession, request.session_id)
            response = ChatTurnResponse(
                reply="外部返回《保持原样》",
                session_id=request.session_id,
                session_state=public_session(session),
            )
            yield {"event": "complete", "data": response.model_dump(mode="json")}

    monkeypatch.setattr(public_jobs, "engine", engine)
    monkeypatch.setattr(public_runs, "engine", engine)
    monkeypatch.setattr(public_runs, "AgentLoop", RecordingLoop)

    run_job("apijob_language_recovery")

    assert len(captured_requests) == 1
    request = captured_requests[0]
    assert request.language_context is not None
    assert request.language_context.model_dump(mode="json") == _language_snapshot()
    assert request.message == "恢复后仍使用《原始客户请求》"
    with Session(engine) as db:
        completed = db.get(APIJob, "apijob_language_recovery")
        assert completed is not None
        assert completed.status == "succeeded"
        assert completed.language_context_json == _language_snapshot()
        assert completed.result_json["reply"] == "外部返回《保持原样》"


def test_public_run_sse_projects_canonical_event_envelope_and_replays_it_verbatim(
    monkeypatch,
) -> None:
    """Project one async event canonically and replay the same durable snapshot without rewriting raw data."""
    client, engine, admin_token = _client(monkeypatch)
    tenant_key = _tenant_key(client, admin_token, ["runs:create", "runs:read"])
    creation_headers = {
        "Authorization": f"Bearer {tenant_key}",
        "Idempotency-Key": "canonical-event-envelope",
        "X-Request-ID": "req-event-envelope",
        "X-Trace-ID": "trace-event-envelope",
    }
    created = client.post(
        "/agents/agent_api/runs",
        headers=creation_headers,
        json={
            "input": "原始用户输入《不要翻译》",
            "session_mode": "stateless",
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
        },
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["id"]
    raw_reply = "Provider reply: 保持原文 <raw>"
    raw_provider_data = {"provider": "vendor-x", "finish_reason": "原始结束原因"}
    with Session(engine) as db:
        job = db.get(APIJob, job_id)
        assert job is not None
        public_jobs.emit_job_event(
            db,
            job,
            "run.output.delta",
            {
                "content": raw_reply,
                "provider_data": raw_provider_data,
                "text": "LEGACY_TEXT_MUST_NOT_DRIVE_UI",
                "status_text": "LEGACY_STATUS_MUST_NOT_DRIVE_UI",
            },
        )
        job.status = "succeeded"
        db.add(job)
        db.commit()

    monkeypatch.setattr(public_jobs, "engine", engine)
    replay_headers = {"Authorization": f"Bearer {tenant_key}"}
    first = client.get(f"/runs/{job_id}/events", headers=replay_headers)
    replay = client.get(f"/runs/{job_id}/events", headers=replay_headers)

    assert first.status_code == replay.status_code == 200
    assert first.text == replay.text
    data_rows = [
        json.loads(line.removeprefix("data: "))
        for line in first.text.splitlines()
        if line.startswith("data: ")
    ]
    output = next(row for row in data_rows if row["event_type"] == "run.output.delta")
    assert output["code"] == "run.output.delta"
    assert output["params"] == {}
    assert output["request_id"] == "req-event-envelope"
    assert output["trace_id"] == "trace-event-envelope"
    assert output["language_context"] == _language_snapshot()
    assert output["content"] == raw_reply
    assert output["provider_data"] == raw_provider_data
    assert "deprecated_fields" not in output
    assert "text" not in output
    assert "status_text" not in output

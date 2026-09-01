import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.a2a import codex_adapter
from app.db.models import A2ATaskEvent, A2ATaskRun
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.tools.a2a_client import A2AClientError

_TEST_CODEX_A2A_TOKEN = "test-only-codex-a2a-token"


def _fresh_engine():
    """Create an isolated in-memory schema for one adapter test."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_a2a_client_error_keeps_remote_message_private() -> None:
    """Project stable A2A metadata while retaining remote JSON-RPC prose only internally."""
    raw_provider_error = "remote A2A error includes token=do-not-publish"
    error = A2AClientError(
        "A2A_ERROR",
        raw_provider_error,
        params={"remote_task_id": "task-42"},
        retryable=True,
        request_id="req-a2a",
        trace_id="trace-a2a",
    )

    assert error.to_public_payload() == {
        "code": "A2A_ERROR",
        "params": {"remote_task_id": "task-42"},
        "retryable": True,
        "request_id": "req-a2a",
        "trace_id": "trace-a2a",
    }
    assert error.occurrence.internal is not None
    assert error.occurrence.internal.raw_message == raw_provider_error
    assert raw_provider_error not in repr(error.to_public_payload())


def test_server_task_payload_projects_error_json_without_raw_message() -> None:
    """Keep a failed server task's diagnostic private while exposing its stable machine code."""
    raw_provider_error = "Codex stderr leaked credential=do-not-publish"
    task = A2ATaskRun(
        owner_scope="system",
        direction="server",
        tenant_id=None,
        system_runtime_key="codex_a2a",
        tenant_lifecycle_version=None,
        endpoint_url="local://codex",
        status="failed",
        error_json={"code": "A2A_TASK_FAILED", "message": raw_provider_error},
    )

    payload = codex_adapter._task_payload(task)

    assert payload["status"]["error"] == {
        "code": "A2A_TASK_FAILED",
        "params": {},
        "retryable": True,
        "request_id": None,
        "trace_id": None,
    }
    assert payload["status"]["message"]["parts"] == [{"text": "A2A_TASK_FAILED"}]
    assert raw_provider_error not in repr(payload)


def test_server_task_payload_fails_closed_for_unknown_error_code() -> None:
    """Replace an unknown durable A2A code before it reaches a task response or replay."""
    raw_provider_error = "unknown provider detail token=do-not-publish"
    task = A2ATaskRun(
        owner_scope="system",
        direction="server",
        tenant_id=None,
        system_runtime_key="codex_a2a",
        tenant_lifecycle_version=None,
        endpoint_url="local://codex",
        status="failed",
        error_json={"code": "UNREGISTERED_PROVIDER_ERROR", "message": raw_provider_error},
    )

    payload = codex_adapter._task_payload(task)

    assert payload["status"]["error"]["code"] == "INTERNAL_ERROR"
    assert payload["status"]["message"]["parts"] == [{"text": "INTERNAL_ERROR"}]
    assert raw_provider_error not in repr(payload)


def _client(monkeypatch, tmp_path) -> tuple[TestClient, object]:
    engine = _fresh_engine()
    settings = SimpleNamespace(
        codex_a2a_enabled=True,
        codex_a2a_token=_TEST_CODEX_A2A_TOKEN,
        codex_a2a_workspace_root=str(tmp_path / "workspaces"),
        codex_a2a_command="codex",
        codex_a2a_timeout_seconds=30,
    )
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(codex_adapter, "get_settings", lambda: settings)
    monkeypatch.setattr(codex_adapter, "_launch", lambda *args, **kwargs: None)
    app = FastAPI()
    app.include_router(codex_adapter.router)
    return TestClient(
        app,
        headers={"Authorization": f"Bearer {_TEST_CODEX_A2A_TOKEN}"},
    ), engine


def test_codex_a2a_unknown_method_preserves_jsonrpc_code_and_hides_method(
    monkeypatch,
    tmp_path,
) -> None:
    """Keep JSON-RPC compatibility while projecting only a registered product error."""
    client, _ = _client(monkeypatch, tmp_path)
    raw_method = "ProviderSecretMethod-do-not-publish"

    response = client.post(
        "/api/a2a/codex",
        json={"jsonrpc": "2.0", "id": "request-unknown", "method": raw_method},
    )

    assert response.status_code == 400
    assert response.json()["error"] == {
        "code": -32601,
        "message": "A2A_METHOD_NOT_FOUND",
        "data": {
            "code": "A2A_METHOD_NOT_FOUND",
            "params": {},
            "retryable": False,
            "request_id": "request-unknown",
            "trace_id": None,
        },
    }
    assert raw_method not in response.text


def test_codex_a2a_rejects_malformed_language_context_without_echoing_locale(
    monkeypatch,
    tmp_path,
) -> None:
    """Fail closed on unsupported locale metadata without returning parser details."""
    client, _ = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-bad-locale",
            "method": "SendMessage",
            "params": {
                "language_context": {"ui_locale": "xx-XX"},
                "message": {
                    "messageId": "message-bad-locale",
                    "role": "ROLE_USER",
                    "parts": [{"text": "raw prompt"}],
                },
            },
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["data"]["code"] == "A2A_BAD_REQUEST"
    assert "xx-XX" not in response.text


def test_codex_a2a_disabled_keeps_http_status_and_uses_specific_code(
    monkeypatch,
) -> None:
    """Expose a stable disabled code without changing the adapter's historical 404."""
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=False, codex_a2a_token=""),
    )
    app = FastAPI()
    app.include_router(codex_adapter.router)

    response = TestClient(app).get("/.well-known/agent-card.json")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "A2A_DISABLED"
    assert "Codex A2A adapter is disabled" not in response.text


@pytest.mark.parametrize(
    ("enabled", "token"),
    [
        (False, _TEST_CODEX_A2A_TOKEN),
        (True, ""),
        (True, " \t "),
        (True, " token"),
        (True, "token "),
        (True, "\ttoken"),
        (True, "token\n"),
    ],
)
def test_codex_a2a_unavailable_configuration_rejects_every_admission_boundary(
    monkeypatch,
    enabled,
    token,
) -> None:
    """Reject card, RPC, and artifact admission unless enabled and credentialed."""
    engine = _fresh_engine()
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=enabled, codex_a2a_token=token),
    )
    app = FastAPI()
    app.include_router(codex_adapter.router)
    client = TestClient(app)

    responses = [
        client.get("/.well-known/agent-card.json"),
        client.post(
            "/api/a2a/codex",
            json={"jsonrpc": "2.0", "id": "request-gated", "method": "ListTasks"},
        ),
        client.get("/api/a2a/codex/tasks/task-gated/artifacts/result.txt"),
    ]

    assert [(response.status_code, response.json()["detail"]["code"]) for response in responses] == [
        (404, "A2A_DISABLED"),
        (404, "A2A_DISABLED"),
        (404, "A2A_DISABLED"),
    ]


@pytest.mark.parametrize(
    ("enabled", "token"),
    [
        (False, _TEST_CODEX_A2A_TOKEN),
        (True, ""),
        (True, " \n "),
        (True, " token"),
        (True, "token "),
        (True, "\ttoken"),
        (True, "token\n"),
    ],
)
def test_codex_a2a_unavailable_configuration_launches_zero_recovery_tasks(
    monkeypatch,
    enabled,
    token,
) -> None:
    """Skip every recoverable task before launch when the runtime is unavailable."""
    engine = _fresh_engine()
    with Session(engine) as db:
        db.add(
            A2ATaskRun(
                owner_scope="system",
                direction="server",
                tenant_id=None,
                system_runtime_key="codex_a2a",
                tenant_lifecycle_version=None,
                endpoint_url="local://codex",
                status="working",
            )
        )
        db.commit()
    launches: list[tuple[str, bool]] = []
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=enabled, codex_a2a_token=token),
    )
    monkeypatch.setattr(
        codex_adapter,
        "_launch",
        lambda task_id, recovery=False: launches.append((task_id, recovery)),
    )

    codex_adapter.recover_codex_a2a_tasks()

    assert launches == []


def test_codex_a2a_configured_runtime_requires_exact_bearer_without_disclosure(
    monkeypatch,
) -> None:
    """Require the exact configured Bearer value and keep both credentials out of responses."""
    expected_token = "test-only-expected-codex-token"
    supplied_token = "test-only-wrong-codex-token"
    engine = _fresh_engine()
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=True, codex_a2a_token=expected_token),
    )
    app = FastAPI()
    app.include_router(codex_adapter.router)
    client = TestClient(app)
    payload = {"jsonrpc": "2.0", "id": "request-auth", "method": "ListTasks"}

    missing = client.post("/api/a2a/codex", json=payload)
    wrong = client.post(
        "/api/a2a/codex",
        json=payload,
        headers={"Authorization": f"Bearer {supplied_token}"},
    )
    exact = client.post(
        "/api/a2a/codex",
        json=payload,
        headers={"Authorization": f"Bearer {expected_token}"},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert exact.status_code == 200
    assert expected_token not in missing.text + wrong.text
    assert supplied_token not in missing.text + wrong.text


def test_codex_a2a_configured_artifact_requires_exact_bearer(monkeypatch) -> None:
    """Protect artifact lookup with the same exact installation credential as RPC."""
    expected_token = "test-only-artifact-token"
    supplied_token = "test-only-wrong-artifact-token"
    monkeypatch.setattr(codex_adapter, "engine", _fresh_engine())
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=True, codex_a2a_token=expected_token),
    )
    app = FastAPI()
    app.include_router(codex_adapter.router)
    client = TestClient(app)
    path = "/api/a2a/codex/tasks/task-auth/artifacts/result.txt"

    missing = client.get(path)
    wrong = client.get(path, headers={"Authorization": f"Bearer {supplied_token}"})
    exact = client.get(path, headers={"Authorization": f"Bearer {expected_token}"})

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert exact.status_code == 404
    assert expected_token not in missing.text + wrong.text + exact.text
    assert supplied_token not in missing.text + wrong.text + exact.text


def test_codex_a2a_configured_agent_card_exposes_scheme_without_token(monkeypatch) -> None:
    """Advertise Bearer authentication without returning its configured credential."""
    expected_token = "test-only-agent-card-token"
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(codex_a2a_enabled=True, codex_a2a_token=expected_token),
    )
    app = FastAPI()
    app.include_router(codex_adapter.router)

    response = TestClient(app).get("/.well-known/agent-card.json")

    assert response.status_code == 200
    assert response.json()["securitySchemes"] == {
        "bearer": {"type": "http", "scheme": "bearer"}
    }
    assert expected_token not in response.text


def test_codex_a2a_configured_recovery_launches_discovered_task(monkeypatch) -> None:
    """Preserve recovery launch behavior when both enablement and credential checks pass."""
    engine = _fresh_engine()
    with Session(engine) as db:
        task = A2ATaskRun(
            owner_scope="system",
            direction="server",
            tenant_id=None,
            system_runtime_key="codex_a2a",
            tenant_lifecycle_version=None,
            endpoint_url="local://codex",
            status="submitted",
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        task_id = task.id
    launches: list[tuple[str, bool]] = []
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(
        codex_adapter,
        "get_settings",
        lambda: SimpleNamespace(
            codex_a2a_enabled=True,
            codex_a2a_token=_TEST_CODEX_A2A_TOKEN,
        ),
    )
    monkeypatch.setattr(
        codex_adapter,
        "_launch",
        lambda recovered_id, recovery=False: launches.append((recovered_id, recovery)),
    )

    codex_adapter.recover_codex_a2a_tasks()

    assert launches == [(task_id, True)]


@pytest.mark.parametrize(
    ("expected", "authorization"),
    [
        ("", None),
        ("", "Bearer "),
        (" \t", "Bearer  \t"),
        (" token", "Bearer  token"),
        ("token ", "Bearer token "),
        ("\ttoken", "Bearer \ttoken"),
        ("token\n", "Bearer token\n"),
    ],
)
def test_codex_a2a_authorization_never_accepts_an_empty_expected_credential(
    expected,
    authorization,
) -> None:
    """Fail closed in the authorization layer even if its availability precondition is bypassed."""
    with pytest.raises(HTTPException) as error:
        codex_adapter._authorize(expected, authorization)

    assert getattr(error.value, "status_code", None) == 401


def test_codex_a2a_uses_public_task_id_and_supports_continuation(monkeypatch, tmp_path) -> None:
    client, engine = _client(monkeypatch, tmp_path)
    message = {
        "messageId": "message-1",
        "role": "ROLE_USER",
        "parts": [{"text": "First request"}],
    }

    submitted = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "SendMessage",
            "params": {"message": message},
        },
    )

    assert submitted.status_code == 200
    task = submitted.json()["result"]
    assert task["status"]["state"] == "submitted"
    assert task["id"]
    with Session(engine) as db:
        stored = db.exec(select(A2ATaskRun)).one()
        assert stored.id != task["id"]
        assert stored.remote_task_id == task["id"]
        stored.status = "input-required"
        db.add(stored)
        db.commit()

    continued = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-2",
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "message-2",
                    "role": "ROLE_USER",
                    "taskId": task["id"],
                    "contextId": task["contextId"],
                    "parts": [{"text": "Follow-up input"}],
                }
            },
        },
    )

    assert continued.status_code == 200
    continued_task = continued.json()["result"]
    assert continued_task["id"] == task["id"]
    assert continued_task["contextId"] == task["contextId"]
    assert continued_task["status"]["state"] == "submitted"

    repeated_first_turn = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-3",
            "method": "SendMessage",
            "params": {"message": message},
        },
    ).json()["result"]
    assert repeated_first_turn["id"] == task["id"]
    with Session(engine) as db:
        stored = db.exec(select(A2ATaskRun)).one()
        assert stored.invocation_id == "message-1"
        message_ids = {
            event.external_event_id
            for event in db.exec(select(A2ATaskEvent)).all()
            if event.external_event_id
        }
        assert message_ids == {"message-1", "message-2"}


def test_codex_a2a_get_cancel_and_list_tasks(monkeypatch, tmp_path) -> None:
    client, _ = _client(monkeypatch, tmp_path)
    submitted = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "message-1",
                    "role": "ROLE_USER",
                    "parts": [{"text": "Do work"}],
                }
            },
        },
    ).json()["result"]

    fetched = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-2",
            "method": "GetTask",
            "params": {"id": submitted["id"]},
        },
    )
    assert fetched.status_code == 200
    assert fetched.json()["result"]["id"] == submitted["id"]

    listed = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-3",
            "method": "ListTasks",
            "params": {"contextId": submitted["contextId"]},
        },
    )
    assert [task["id"] for task in listed.json()["result"]["tasks"]] == [submitted["id"]]

    canceled = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-4",
            "method": "CancelTask",
            "params": {"id": submitted["id"]},
        },
    )
    assert canceled.status_code == 200
    assert canceled.json()["result"]["status"]["state"] == "canceled"


def test_codex_cancel_after_completion_is_idempotent(monkeypatch, tmp_path) -> None:
    """Canceling a terminal completed task must preserve its completed protocol state."""
    client, engine = _client(monkeypatch, tmp_path)
    submitted = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-completed-cancel",
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "message-completed-cancel",
                    "role": "ROLE_USER",
                    "parts": [{"text": "Complete first"}],
                }
            },
        },
    ).json()["result"]
    with Session(engine) as db:
        task = db.exec(select(A2ATaskRun)).one()
        task.status = "completed"
        task.result_json = {"text": "already complete"}
        db.add(task)
        db.commit()

    canceled = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-cancel-completed",
            "method": "CancelTask",
            "params": {"id": submitted["id"]},
        },
    )

    assert canceled.status_code == 200
    assert canceled.json()["result"]["status"]["state"] == "completed"
    with Session(engine) as db:
        stored = db.exec(select(A2ATaskRun)).one()
        assert stored.status == "completed"


def test_codex_worker_completion_cannot_overwrite_concurrent_cancel(monkeypatch, tmp_path) -> None:
    """A cancellation committed after process exit must win over the worker completion write."""
    engine = _fresh_engine()
    settings = SimpleNamespace(
        codex_a2a_enabled=True,
        codex_a2a_token=_TEST_CODEX_A2A_TOKEN,
        codex_a2a_workspace_root=str(tmp_path / "workspaces"),
        codex_a2a_command="codex",
        codex_a2a_timeout_seconds=30,
    )
    monkeypatch.setattr(codex_adapter, "engine", engine)
    monkeypatch.setattr(codex_adapter, "get_settings", lambda: settings)
    workspace = tmp_path / "task-workspace"
    with Session(engine) as db:
        task = A2ATaskRun(
            owner_scope="system",
            direction="server",
            tenant_id=None,
            system_runtime_key="codex_a2a",
            tenant_lifecycle_version=None,
            endpoint_url="local://codex",
            remote_task_id="task-cancel-race",
            status="submitted",
            request_json={
                "prompt": "race",
                "workspace": str(workspace),
                "resume": False,
            },
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        task_id = task.id

    class ExitedProcess:
        """Represent a Codex child that has exited before the completion write."""

        stdout = iter(())

        def poll(self) -> int:
            """Report an exited child to the worker loop."""
            return 0

        def wait(self, timeout: float | None = None) -> int:
            """Return a successful child exit code."""
            del timeout
            return 0

        def terminate(self) -> None:
            """Accept the cancellation signal issued by the race fixture."""
            return

    monkeypatch.setattr(codex_adapter.subprocess, "Popen", lambda *_args, **_kwargs: ExitedProcess())

    def cancel_before_completion(_root, _before) -> list[dict[str, object]]:
        """Use the real CancelTask state transition immediately before worker finalization."""
        codex_adapter._cancel(task_id)
        return []

    monkeypatch.setattr(codex_adapter, "_collect_artifacts", cancel_before_completion)
    codex_adapter._run_codex_task(task_id)

    with Session(engine) as db:
        stored = db.get(A2ATaskRun, task_id)
        assert stored is not None
        assert stored.status == "canceled"


def test_codex_a2a_message_id_is_idempotent(monkeypatch, tmp_path) -> None:
    client, engine = _client(monkeypatch, tmp_path)
    payload = {
        "jsonrpc": "2.0",
        "id": "request-idempotent",
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": "same-message",
                "role": "ROLE_USER",
                "parts": [{"text": "Do work once"}],
            }
        },
    }

    first = client.post("/api/a2a/codex", json=payload).json()["result"]
    second = client.post("/api/a2a/codex", json=payload).json()["result"]

    assert second["id"] == first["id"]
    with Session(engine) as db:
        assert len(list(db.exec(select(A2ATaskRun)).all())) == 1


def _en_us_context() -> LanguageContext:
    """Build the explicit locale snapshot used by the A2A boundary tests."""
    return LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def test_codex_a2a_submit_persists_language_snapshot_and_returns_stable_metadata(
    monkeypatch,
    tmp_path,
) -> None:
    """Persist explicit A2A locales while preserving the raw inbound user message."""
    client, engine = _client(monkeypatch, tmp_path)
    raw_message = "raw user text must remain byte-for-byte unchanged"
    response = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-locale",
            "method": "SendMessage",
            "params": {
                "ui_locale": "en-US",
                "agent_reply_locale": "en-US",
                "message": {
                    "messageId": "message-locale",
                    "role": "ROLE_USER",
                    "parts": [{"text": raw_message}],
                },
            },
        },
    )

    assert response.status_code == 200
    result = response.json()["result"]
    expected = _en_us_context().model_dump(mode="json")
    assert result["metadata"]["language_context"] == expected
    with Session(engine) as db:
        stored = db.exec(select(A2ATaskRun)).one()
        assert stored.language_context_json == expected
        assert stored.request_json["prompt"] == raw_message
        events = list(db.exec(select(A2ATaskEvent)).all())
        assert events
        assert all(event.data_json["metadata"]["language_context"] == expected for event in events)


def test_codex_a2a_stream_replays_language_metadata_without_translating_agent_output(
    monkeypatch,
    tmp_path,
) -> None:
    """Stream stable locale metadata while leaving successful Agent output raw."""
    client, engine = _client(monkeypatch, tmp_path)
    client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-stream-seed",
            "method": "SendMessage",
            "params": {
                "ui_locale": "en-US",
                "agent_reply_locale": "en-US",
                "message": {
                    "messageId": "message-stream",
                    "role": "ROLE_USER",
                    "parts": [{"text": "raw stream prompt"}],
                },
            },
        },
    ).json()["result"]
    expected = _en_us_context().model_dump(mode="json")
    with Session(engine) as db:
        task = db.exec(select(A2ATaskRun)).one()
        task.status = "completed"
        task.result_json = {"text": "raw Agent output — keep it unchanged"}
        db.add(task)
        db.commit()
        codex_adapter._append_event(
            db,
            task,
            "completed",
            codex_adapter._task_payload(task),
        )

    response = client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-stream",
            "method": "SendStreamingMessage",
            "params": {
                "message": {
                    "messageId": "message-stream",
                    "role": "ROLE_USER",
                    "parts": [{"text": "raw stream prompt"}],
                }
            },
        },
    )

    assert response.status_code == 200
    assert "raw Agent output — keep it unchanged" in response.text
    envelopes = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert envelopes
    assert all(item["result"]["metadata"]["language_context"] == expected for item in envelopes)


def test_codex_a2a_run_uses_bound_reply_locale_in_cli_prompt_and_keeps_output_raw(
    monkeypatch,
    tmp_path,
) -> None:
    """Apply the bound Agent locale only to the runtime instruction, not persisted user text."""
    client, engine = _client(monkeypatch, tmp_path)
    client.post(
        "/api/a2a/codex",
        json={
            "jsonrpc": "2.0",
            "id": "request-run-locale",
            "method": "SendMessage",
            "params": {
                "language_context": {
                    "ui_locale": "en-US",
                    "agent_reply_locale": "en-US",
                },
                "message": {
                    "messageId": "message-run-locale",
                    "role": "ROLE_USER",
                    "parts": [{"text": "raw command prompt"}],
                },
            },
        },
    ).json()["result"]
    captured: dict[str, object] = {}

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = iter(
                [
                    json.dumps({"type": "thread.started", "thread_id": "codex-session"}),
                    json.dumps(
                        {
                            "type": "message.completed",
                            "text": "raw Agent output",
                        }
                    ),
                ]
            )

        def poll(self) -> int:
            return 0

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return 0

        def terminate(self) -> None:
            return None

        def kill(self) -> None:
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return FakeProcess()

    monkeypatch.setattr(codex_adapter.subprocess, "Popen", fake_popen)
    with Session(engine) as db:
        internal_task_id = db.exec(select(A2ATaskRun)).one().id
    codex_adapter._run_codex_task(internal_task_id)

    expected = _en_us_context().model_dump(mode="json")
    with Session(engine) as db:
        stored = db.exec(select(A2ATaskRun)).one()
        assert stored.language_context_json == expected
        assert stored.request_json["prompt"] == "raw command prompt"
        assert stored.result_json["text"] == "raw Agent output"
    command = captured["command"]
    assert "en-US" in command[-1]
    assert "raw command prompt" in command[-1]


def test_codex_a2a_legacy_task_payload_backfills_controlled_default_snapshot() -> None:
    """Expose a deterministic zh-CN snapshot for pre-migration tasks with no locale column."""
    task = A2ATaskRun(
        owner_scope="system",
        direction="server",
        tenant_id=None,
        system_runtime_key="codex_a2a",
        tenant_lifecycle_version=None,
        endpoint_url="local://codex",
        remote_task_id="legacy-task",
        status="completed",
        result_json={"text": "legacy Agent output"},
        language_context_json=None,
    )

    payload = codex_adapter._task_payload(task)

    assert payload["metadata"]["language_context"] == {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "legacy_default",
        "agent_reply_locale_source": "legacy_default",
    }

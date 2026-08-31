"""Regression tests for public error projection at durable execution boundaries."""

from __future__ import annotations

import json
from types import SimpleNamespace

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.task_frame_store import TaskFrameStore
from app.db.models import (
    APIJob,
    ChatSession,
    HarnessTaskFrameRecord,
    WebhookDelivery,
    WebhookEndpoint,
)
from app.public_api import runs as public_runs
from app.public_api import webhooks as public_webhooks


def _engine():
    """Create an isolated in-memory database for one projection boundary test."""
    database = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(database)
    return database


def _principal() -> SimpleNamespace:
    """Build the minimal tenant principal required by ownership checks in direct route tests."""
    return SimpleNamespace(
        tenant_id="tenant-t090",
        client_id="client-t090",
        agent_id=None,
    )


def test_task_frame_and_harness_run_persistence_fail_closed_error_fields() -> None:
    """Persist only canonical error metadata while preserving successful business output."""
    database = _engine()
    raw_error = "provider token=secret-t090"
    result = {
        "task_frame_id": "task-t090",
        "status": "failed",
        "reply_fragment": "业务内容保持原样",
        "structured_result": {"order_id": "ORDER-原文"},
        "capability_results": [
            {
                "success": False,
                "error": {
                    "code": "unknown.provider.failure",
                    "message": raw_error,
                },
            }
        ],
        "error": {
            "code": "TOOL_UPSTREAM_ERROR",
            "params": {},
            "retryable": True,
            "message": raw_error,
        },
    }
    with Session(database) as db:
        db.add(ChatSession(id="session-t090", tenant_id="tenant-t090"))
        row = HarnessTaskFrameRecord(
            tenant_id="tenant-t090",
            session_id="session-t090",
            source_turn_id="turn-t090",
            task_id="task-t090",
            status="queued",
        )
        db.add(row)
        db.commit()

        store = TaskFrameStore(db)
        store.mark_running(row)
        run = store.start_run(
            row,
            requirement={"goal": "T090"},
            capability_snapshot={"available": []},
        )
        db.commit()
        db.refresh(row)
        db.refresh(run)

        store.finish_run(
            run,
            status="failed",
            action_count=1,
            result=result,
        )
        store.finish_frame(
            row,
            status="failed",
            step_id=None,
            slots={},
            result=result,
        )
        db.commit()
        db.refresh(row)
        db.refresh(run)

        assert row.result_json["structured_result"] == {"order_id": "ORDER-原文"}
        assert row.result_json["error"] == {
            "code": "TOOL_UPSTREAM_ERROR",
            "params": {},
            "retryable": True,
            "request_id": None,
            "trace_id": None,
        }
        assert row.error_json == row.result_json["error"]
        assert run.result_json["error"] == row.result_json["error"]
        assert raw_error not in json.dumps(row.result_json, ensure_ascii=False)
        assert raw_error not in json.dumps(run.result_json, ensure_ascii=False)
        nested_error = row.result_json["capability_results"][0]["error"]
        assert nested_error["code"] == "INTERNAL_ERROR"
        assert "message" not in nested_error


def test_succeeded_run_result_reprojects_legacy_nested_errors() -> None:
    """Fail closed when a pre-migration successful run contains a legacy raw nested error."""
    database = _engine()
    raw_error = "provider token=legacy-secret-t090"
    with Session(database) as db:
        db.add(
            APIJob(
                id="run-t090",
                tenant_id="tenant-t090",
                credential_id="credential-t090",
                agent_id="agent-t090",
                kind="run",
                status="succeeded",
                result_json={
                    "reply": "用户业务内容",
                    "task_results": [
                        {
                            "task_frame_id": "task-t090",
                            "result": {
                                "error": {
                                    "code": "TOOL_UPSTREAM_ERROR",
                                    "message": raw_error,
                                },
                                "provider_payload": {"order_id": "ORDER-原文"},
                            },
                        }
                    ],
                },
            )
        )
        db.commit()

        projected = public_runs.get_run_result(
            "run-t090",
            principal=_principal(),
            db=db,
        )

    nested_error = projected["task_results"][0]["result"]["error"]
    assert nested_error == {
        "code": "TOOL_UPSTREAM_ERROR",
        "params": {},
        "retryable": True,
        "request_id": None,
        "trace_id": None,
    }
    assert projected["task_results"][0]["result"]["provider_payload"] == {
        "order_id": "ORDER-原文"
    }
    assert raw_error not in json.dumps(projected, ensure_ascii=False)


def test_webhook_delivery_read_and_retry_never_expose_raw_exception() -> None:
    """Keep webhook retry storage and delivery audit reads on canonical safe metadata."""
    database = _engine()
    raw_error = "https://provider.invalid token=secret-t090"
    with Session(database) as db:
        db.add(
            WebhookEndpoint(
                id="webhook-t090",
                tenant_id="tenant-t090",
                client_id="client-t090",
                name="T090",
                url="https://example.invalid/webhook",
                secret_encrypted="encrypted",
            )
        )
        delivery = WebhookDelivery(
            id="delivery-t090",
            tenant_id="tenant-t090",
            endpoint_id="webhook-t090",
            event_id="event-t090",
            event_type="run.failed",
            payload_json={
                "data": {
                    "request_id": "req-t090",
                    "trace_id": "trace-t090",
                }
            },
            status="retrying",
            last_error=None,
        )
        db.add(delivery)
        db.commit()

        public_webhooks._schedule_retry(delivery, raw_error)
        db.add(delivery)
        db.commit()
        rows = public_webhooks.list_webhook_deliveries(
            "webhook-t090",
            principal=_principal(),
            db=db,
        )

    assert rows[0]["last_error"] == "INTERNAL_ERROR"
    assert rows[0]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": True,
        "request_id": "req-t090",
        "trace_id": "trace-t090",
    }
    assert raw_error not in repr(rows)

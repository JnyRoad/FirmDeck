"""Regression tests for recursively projecting persisted public job results."""

from __future__ import annotations

import json

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.contracts.error_registry import (
    ErrorRegistry,
    ErrorRegistryEntry,
    ErrorVisibility,
)
from app.contracts.projections import project_public_result_payload
from app.db.models import APIJob
from app.public_api import jobs as public_jobs


class _Principal:
    """Provide the minimum authorized principal surface required by the jobs route."""

    tenant_id = "tenant-t103"
    agent_id = None

    def can(self, _scope: str) -> bool:
        """Allow every scope in this isolated route-level projection fixture."""
        return True


def _engine():
    """Create an isolated SQLite database containing only the models used by this fixture."""
    database = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(database)
    return database


def test_get_job_result_reprojects_all_nested_legacy_errors_and_keeps_success_raw() -> None:
    """Fail closed for legacy nested errors while preserving successful business output."""
    database = _engine()
    raw_error = "provider token=legacy-secret-t103"
    result_json = {
        "reply": "成功业务输出保持原样",
        "structured_result": {"order_id": "ORDER-原文"},
        "capability_results": [
            {
                "error": {
                    "code": "TOOL_UPSTREAM_ERROR",
                    "message": raw_error,
                }
            }
        ],
        "task_results": [
            {
                "result": {
                    "nested": {
                        "error": {
                            "code": "UNKNOWN_LEGACY_ERROR",
                            "message": raw_error,
                        }
                    }
                }
            }
        ],
        "tool_calls": [
            {
                "tool_result": {
                    "deep": {
                        "error": {
                            "code": "TOOL_UPSTREAM_ERROR",
                            "params": {"unexpected": "legacy"},
                            "message": raw_error,
                        }
                    }
                }
            }
        ],
        "arbitrary_nested": {
            "branches": [
                {"error": {"code": "INTERNAL_ERROR", "message": raw_error}}
            ]
        },
    }
    with Session(database) as db:
        db.add(
            APIJob(
                id="job-t103",
                tenant_id="tenant-t103",
                credential_id="credential-t103",
                kind="knowledge.ingest",
                status="succeeded",
                result_json=result_json,
            )
        )
        db.commit()

        projected = public_jobs.get_job_result(
            "job-t103",
            principal=_Principal(),
            db=db,
        )

    result = projected["result"]
    assert projected["job"]["error"] == {}
    assert result["reply"] == "成功业务输出保持原样"
    assert result["structured_result"] == {"order_id": "ORDER-原文"}
    assert result["capability_results"][0]["error"] == {
        "code": "TOOL_UPSTREAM_ERROR",
        "params": {},
        "retryable": True,
        "request_id": None,
        "trace_id": None,
    }
    assert result["task_results"][0]["result"]["nested"]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert result["tool_calls"][0]["tool_result"]["deep"]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert result["arbitrary_nested"]["branches"][0]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert raw_error not in json.dumps(projected, ensure_ascii=False)


def test_nested_non_public_error_falls_back_to_internal_error() -> None:
    """Prevent a registered internal code from crossing the public result boundary."""
    registry = ErrorRegistry()
    registry.register(
        ErrorRegistryEntry(
            code="INTERNAL_ERROR",
            message_key="errors.common.internal",
            default_http_status=500,
            retryable_default=False,
        )
    )
    registry.register(
        ErrorRegistryEntry(
            code="PRIVATE_FAILURE",
            message_key="errors.private.failure",
            default_http_status=500,
            retryable_default=False,
            visibility=ErrorVisibility.INTERNAL,
        )
    )

    projected = project_public_result_payload(
        {"nested": {"error": {"code": "PRIVATE_FAILURE", "message": "private cause"}}},
        registry,
        source="test-t103",
    )

    assert projected["nested"]["error"] == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert "private cause" not in json.dumps(projected, ensure_ascii=False)


def test_get_job_result_fail_closes_non_mapping_persisted_result() -> None:
    """Return an empty public result when a legacy row contains a non-object JSON value."""
    database = _engine()
    with Session(database) as db:
        job = APIJob(
            id="job-t103-malformed",
            tenant_id="tenant-t103",
            credential_id="credential-t103",
            kind="knowledge.ingest",
            status="succeeded",
        )
        job.result_json = ["legacy malformed result"]  # type: ignore[assignment]
        db.add(job)
        db.commit()

        projected = public_jobs.get_job_result(
            "job-t103-malformed",
            principal=_Principal(),
            db=db,
        )

    assert projected["result"] == {}

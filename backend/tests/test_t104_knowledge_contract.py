from __future__ import annotations

import json

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api import knowledge as knowledge_api
from app.api.knowledge import job_read
from app.db.models import KnowledgeBase, KnowledgeIngestJob, Tenant
from app.knowledge.schema import KnowledgeSearchRequest
from app.knowledge.service import KnowledgeService, _ingest_steps_for


def test_malformed_persisted_ingest_error_projects_to_internal_descriptor() -> None:
    """Malformed dictionary data must become a typed safe error instead of an empty string/object."""
    row = KnowledgeIngestJob(
        id="kjob_t104_error",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_demo",
        filename="policy.md",
        error={"message": "provider secret"},
    )

    projected = job_read(row)

    assert projected.error == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert "message" not in projected.error


def test_registered_persisted_ingest_error_keeps_code_and_discards_legacy_message() -> None:
    """A registered public code survives legacy storage while its prose is discarded."""
    row = KnowledgeIngestJob(
        id="kjob_t104_registered_error",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_demo",
        filename="policy.md",
        error=json.dumps(
            {
                "code": "KNOWLEDGE_MODE_INVALID",
                "params": {},
                "retryable": False,
                "message": "private legacy explanation",
            }
        ),
    )

    projected = job_read(row)

    assert projected.error == {
        "code": "KNOWLEDGE_MODE_INVALID",
        "params": {},
        "retryable": False,
        "request_id": None,
        "trace_id": None,
    }
    assert "private legacy explanation" not in json.dumps(projected.error)


def test_legacy_ingest_metadata_projection_discards_stage_prose() -> None:
    """Legacy stage labels and details must not cross the job API response boundary."""
    row = KnowledgeIngestJob(
        id="kjob_t104_metadata",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_demo",
        filename="policy.md",
        stage="parsing",
        metadata_json={
            "stage_label": "泄露的阶段名称",
            "stage_detail": "泄露的阶段详情",
            "stage_code": "泄露的阶段代码",
            "stage_params": {"message": "泄露的阶段参数", "count": 2},
            "stage_stats": {"message": "泄露的统计说明", "chunk_count": 3},
            "ingest_steps": [
                {
                    "key": "parsing",
                    "label": "泄露的进度标签",
                    "progress": 0.08,
                    "status": "running",
                },
                {
                    "key": "未知阶段",
                    "code": "未知阶段",
                    "progress": 0.1,
                    "status": "running",
                },
            ],
        },
    )

    projected = job_read(row)

    assert "stage_label" not in projected.metadata
    assert "stage_detail" not in projected.metadata
    assert projected.metadata["stage_code"] == "parsing"
    assert projected.metadata["stage_params"] == {"count": 2}
    assert projected.metadata["stage_stats"] == {"chunk_count": 3}
    assert projected.metadata["ingest_steps"] == [
        {
            "key": "parsing",
            "code": "parsing",
            "params": {},
            "progress": 0.08,
            "status": "running",
        }
    ]
    assert "泄露的" not in json.dumps(projected.metadata, ensure_ascii=False)


def test_knowledge_search_trace_contains_stable_code_and_params_only() -> None:
    """No-visible-knowledge search must return a localizable trace descriptor, not prose."""
    response = KnowledgeService(None).search(
        KnowledgeSearchRequest(tenant_id="tenant_demo", query="配送"),
        authorized_knowledge_versions={},
    )

    assert response.route_trace == [
        {
            "phase": "no_visible_knowledge",
            "code": "no_visible_knowledge",
            "params": {},
        }
    ]
    assert all("message" not in item for item in response.route_trace)


def test_knowledge_search_api_no_visible_trace_is_typed(monkeypatch) -> None:
    """The HTTP search no-visible branch must match the service trace contract."""
    knowledge_request = KnowledgeSearchRequest(tenant_id="tenant_demo", query="配送")
    monkeypatch.setattr(knowledge_api, "require_agent_scope_viewer", lambda *args: None)
    monkeypatch.setattr(knowledge_api, "ensure_tenant", lambda *args: None)
    monkeypatch.setattr(knowledge_api, "_get_request_model", lambda *args: None)
    monkeypatch.setattr(knowledge_api, "visible_knowledge_base_version_ids", lambda *args: [])
    response = knowledge_api.search_knowledge(
        knowledge_request,
        db=None,
        current_user=object(),
    )

    assert response.route_trace == [
        {
            "phase": "no_visible_knowledge",
            "code": "no_visible_knowledge",
            "params": {},
        }
    ]
    assert all("message" not in item for item in response.route_trace)


def test_ingest_steps_use_stable_codes_and_params_without_labels() -> None:
    """Persisted ingest steps must contain machine data while leaving labels to the UI locale."""
    steps = _ingest_steps_for("parsing", 0.08, "running")

    assert steps
    assert all("label" not in item for item in steps)
    assert all(item["code"] == item["key"] for item in steps)
    assert all(item["params"] == {} for item in steps)


def test_cancelled_ingest_metadata_uses_typed_stage_detail() -> None:
    """Cancellation metadata must retain stable stage descriptors without localized prose."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(KnowledgeBase(id="kb_demo", tenant_id="tenant_demo", name="Demo"))
        db.commit()
        job = KnowledgeIngestJob(
            id="kjob_t104_cancel",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_demo",
            filename="policy.md",
            status="running",
            stage="parsing",
            progress=0.08,
        )
        db.add(job)
        db.commit()

        cancelled = KnowledgeService(db).cancel_ingest_job(job.id, "tenant_demo")

        assert cancelled is not None
        assert "stage_label" not in cancelled.metadata_json
        assert cancelled.metadata_json["stage_detail"] == {
            "code": "cancel_requested",
            "params": {},
        }
        assert "已收到取消请求" not in json.dumps(cancelled.metadata_json, ensure_ascii=False)

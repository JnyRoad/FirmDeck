"""RED contracts for durable knowledge-ingest admission and worker fencing."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, select

from app.db import database
from app.db.models import KnowledgeBase, KnowledgeDocument, KnowledgeIngestJob, Tenant, utc_now
from app.knowledge.service import IngestPayload, KnowledgeService


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _payload() -> IngestPayload:
    return IngestPayload(
        tenant_id="tenant_knowledge_fence",
        knowledge_base_id="kb_knowledge_fence",
        filename="policy.md",
        content_base64="IyB0ZXN0IHJ1bGU=" ,
    )


def test_knowledge_ingest_admission_persists_current_lifecycle_version() -> None:
    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=7,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()

        job = KnowledgeService(db).create_ingest_job(_payload())

        assert job.tenant_lifecycle_version == 7
        assert job.execution_owner is None
        assert job.execution_generation == 0
        assert job.lease_expires_at is None


def test_knowledge_ingest_admission_rejects_suspended_tenant() -> None:
    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                status="suspended",
                lifecycle_version=8,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()

        from app.security.tenant import TenantLifecycleDenied

        try:
            KnowledgeService(db).create_ingest_job(_payload())
        except TenantLifecycleDenied as denied:
            assert denied.code == "TENANT_SUSPENDED"
        else:
            raise AssertionError("suspended tenant admission unexpectedly succeeded")


def test_stale_knowledge_ingest_is_terminalized_before_document_write(monkeypatch) -> None:
    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=1,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()
        service = KnowledgeService(db)
        job = service.create_ingest_job(_payload())

        tenant = db.get(Tenant, "tenant_knowledge_fence")
        assert tenant is not None
        tenant.status = "active"
        tenant.lifecycle_version = 2
        db.add(tenant)
        db.commit()

        monkeypatch.setattr(
            "app.knowledge.service.extract_text",
            lambda *_args: (_ for _ in ()).throw(AssertionError("provider reached")),
        )
        service._run_ingest_job(job.id)

        current = db.get(type(job), job.id)
        assert current is not None
        assert current.status == "cancelled"
        assert current.document_id is None
        assert db.exec(select(KnowledgeDocument)).first() is None


def test_knowledge_ingest_claim_uses_one_owner_generation_and_lease() -> None:
    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=1,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()
        service = KnowledgeService(db)
        job = service.create_ingest_job(_payload())

        claimed = service._claim_ingest_job(job.id, "worker-one")
        assert claimed is not None
        assert claimed.status == "running"
        assert claimed.execution_owner == "worker-one"
        assert claimed.execution_generation == 1
        assert claimed.lease_expires_at is not None
        assert KnowledgeService(db)._claim_ingest_job(job.id, "worker-two") is None


def test_knowledge_ingest_claim_migration_is_additive_and_repeatable(tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'knowledge-claim.db'}")
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE tenants (id VARCHAR PRIMARY KEY, lifecycle_version INTEGER NOT NULL)"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE knowledge_ingest_jobs ("
                "id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, status VARCHAR NOT NULL)"
            )
        )
        conn.execute(text("INSERT INTO tenants (id, lifecycle_version) VALUES ('t1', 9)"))
        conn.execute(
            text("INSERT INTO knowledge_ingest_jobs (id, tenant_id, status) VALUES ('j1', 't1', 'queued')")
        )

    with engine.begin() as conn:
        database._migrate_knowledge_ingest_claim_schema(
            conn,
            {"tenants", "knowledge_ingest_jobs"},
        )
    with engine.begin() as conn:
        database._migrate_knowledge_ingest_claim_schema(
            conn,
            {"tenants", "knowledge_ingest_jobs"},
        )

    columns = {column["name"] for column in inspect(engine).get_columns("knowledge_ingest_jobs")}
    assert {
        "tenant_lifecycle_version",
        "execution_owner",
        "execution_generation",
        "lease_expires_at",
    } <= columns
    with engine.connect() as conn:
        assert conn.execute(
            text(
                "SELECT tenant_lifecycle_version, execution_owner, execution_generation, lease_expires_at "
                "FROM knowledge_ingest_jobs WHERE id = 'j1'"
            )
        ).one() == (9, None, 0, None)


def test_knowledge_ingest_claim_migration_rolls_back_additive_columns(tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'knowledge-claim-rollback.db'}")
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE tenants (id VARCHAR PRIMARY KEY, lifecycle_version INTEGER NOT NULL)")
        )
        conn.execute(
            text(
                "CREATE TABLE knowledge_ingest_jobs ("
                "id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, status VARCHAR NOT NULL)"
            )
        )
        conn.execute(text("INSERT INTO tenants (id, lifecycle_version) VALUES ('t1', 9)"))
        conn.execute(
            text("INSERT INTO knowledge_ingest_jobs (id, tenant_id, status) VALUES ('j1', 't1', 'queued')")
        )

    def fail_claim_ddl(_conn, _cursor, statement, *_args) -> None:
        if "ADD COLUMN execution_generation" in statement:
            raise RuntimeError("injected knowledge claim migration failure")

    event.listen(engine, "before_cursor_execute", fail_claim_ddl)
    try:
        with pytest.raises(RuntimeError, match="injected knowledge claim migration failure"):
            conn = engine.connect()
            conn.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                database._migrate_knowledge_ingest_claim_schema(
                    conn,
                    {"tenants", "knowledge_ingest_jobs"},
                )
            except BaseException:
                conn.rollback()
                conn.close()
                raise
            else:
                conn.commit()
                conn.close()
    finally:
        event.remove(engine, "before_cursor_execute", fail_claim_ddl)

    columns = {column["name"] for column in inspect(engine).get_columns("knowledge_ingest_jobs")}
    assert columns == {"id", "tenant_id", "status"}


def test_knowledge_ingest_success_clears_content_before_releasing_claim(monkeypatch) -> None:
    """Successful ingest must erase the embedded source while its claim is still fenced."""
    from app.knowledge import service as knowledge_service

    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=1,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()
        service = KnowledgeService(db)
        job = service.create_ingest_job(_payload())
        monkeypatch.setattr(knowledge_service, "engine", engine)

        service._run_ingest_job(job.id)

        current = db.get(type(job), job.id)
        assert current is not None
        assert current.status == "succeeded"
        assert "content_base64" not in (current.metadata_json or {})
        assert current.execution_owner is None
        assert current.lease_expires_at is None


def test_knowledge_ingest_failure_clears_content_before_releasing_claim(monkeypatch) -> None:
    """Failed ingest must not retain source content after terminalization."""
    from app.knowledge import service as knowledge_service

    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=1,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        db.commit()
        service = KnowledgeService(db)
        job = service.create_ingest_job(_payload())
        monkeypatch.setattr(knowledge_service, "engine", engine)
        monkeypatch.setattr(
            KnowledgeService,
            "_build_buckets",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("bucket failed")),
        )

        service._run_ingest_job(job.id)

        current = db.get(type(job), job.id)
        assert current is not None
        assert current.status == "failed"
        assert "content_base64" not in (current.metadata_json or {})
        assert current.execution_owner is None
        assert current.lease_expires_at is None


def test_knowledge_ingest_cancel_requested_claim_clears_content_and_releases_lease() -> None:
    """A cancellation observed by a claimed worker must also be terminal and scrubbed."""
    from datetime import timedelta

    engine = _engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_knowledge_fence",
                slug="knowledge-fence",
                name="Knowledge fence",
                lifecycle_version=1,
            )
        )
        db.add(
            KnowledgeBase(
                id="kb_knowledge_fence",
                tenant_id="tenant_knowledge_fence",
                name="Knowledge fence",
            )
        )
        job = KnowledgeIngestJob(
            id="kjob-cancel-fence",
            tenant_id="tenant_knowledge_fence",
            knowledge_base_id="kb_knowledge_fence",
            filename="policy.md",
            status="cancel_requested",
            stage="chunking",
            metadata_json={"content_base64": _payload().content_base64},
            execution_owner="worker-one",
            execution_generation=1,
            lease_expires_at=utc_now() + timedelta(minutes=5),
        )
        db.add(job)
        db.commit()
        service = KnowledgeService(db)
        service._execution_owner = "worker-one"
        service._execution_generation = 1

        service._finalize_cancelled_job(job)

        current = db.get(KnowledgeIngestJob, job.id)
        assert current is not None
        assert current.status == "cancelled"
        assert "content_base64" not in (current.metadata_json or {})
        assert current.execution_owner is None
        assert current.lease_expires_at is None

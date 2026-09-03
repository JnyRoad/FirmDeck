"""文档跨版本身份（lineage_id）的写入与继承回归测试（R5）。

覆盖 T014/T015：
- 新建文档（正常 ingest 流程）写入 metadata_json.lineage_id = 自身 id；
- clone_knowledge_version_assets 克隆版本资产时，克隆文档继承源文档的 lineage_id；
- 源文档缺失 lineage_id（历史数据）时，克隆以源文档 id 作为 lineage_id。
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, select

from app.agents.branching import clone_knowledge_version_assets
from app.db.models import KnowledgeBase, KnowledgeBaseVersion, KnowledgeDocument, Tenant
from app.knowledge.service import IngestPayload, KnowledgeService


def _engine():
    """创建隔离的 SQLite 内存引擎，供每个测试独立建表。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_base(db: Session, *, tenant_id: str, base_id: str) -> KnowledgeBase:
    """建立测试所需的租户与知识库。"""
    slug = tenant_id.replace("_", "-")
    db.add(Tenant(id=tenant_id, slug=slug, name=tenant_id, lifecycle_version=1))
    base = KnowledgeBase(id=base_id, tenant_id=tenant_id, name=base_id)
    db.add(base)
    db.commit()
    return base


def _payload(*, tenant_id: str, knowledge_base_id: str, filename: str = "policy.md") -> IngestPayload:
    """构造一次最小化的 ingest 请求（base64 内容为 "# test rule"）。"""
    return IngestPayload(
        tenant_id=tenant_id,
        knowledge_base_id=knowledge_base_id,
        filename=filename,
        content_base64="IyB0ZXN0IHJ1bGU=",
    )


def test_new_document_lineage_id_defaults_to_its_own_id() -> None:
    """新建文档（正常 ingest）应写入 metadata_json.lineage_id = 自身 id。"""
    tenant_id = "tenant_lineage_new"
    base_id = "kb_lineage_new"
    engine = _engine()
    with Session(engine) as db:
        _seed_base(db, tenant_id=tenant_id, base_id=base_id)
        service = KnowledgeService(db)
        job = service.create_ingest_job(_payload(tenant_id=tenant_id, knowledge_base_id=base_id))
        service._run_ingest_job(job.id)

        document = db.exec(select(KnowledgeDocument)).one()
        assert document.metadata_json.get("lineage_id") == document.id


def test_clone_inherits_source_lineage_id() -> None:
    """克隆版本资产时，克隆文档应继承源文档已有的 lineage_id。"""
    tenant_id = "tenant_lineage_clone"
    base_id = "kb_lineage_clone"
    engine = _engine()
    with Session(engine) as db:
        _seed_base(db, tenant_id=tenant_id, base_id=base_id)
        source_version = KnowledgeBaseVersion(
            id="kbver_source",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            version="1.0.0",
            name=base_id,
        )
        target_version = KnowledgeBaseVersion(
            id="kbver_target",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            version="1.0.1",
            name=base_id,
        )
        db.add(source_version)
        db.add(target_version)
        source_document = KnowledgeDocument(
            id="doc_source_with_lineage",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            knowledge_base_version_id=source_version.id,
            filename="content.md",
            file_type="markdown",
            title="内容方法",
            status="ready",
            metadata_json={"lineage_id": "doc_source_with_lineage"},
        )
        db.add(source_document)
        db.commit()

        clone_knowledge_version_assets(
            db,
            tenant_id,
            base_id,
            source_version.id,
            target_version.id,
        )
        db.commit()

        cloned = db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == target_version.id,
            )
        ).one()
        assert cloned.id != source_document.id
        assert cloned.metadata_json.get("lineage_id") == "doc_source_with_lineage"


def test_clone_of_legacy_document_without_lineage_uses_source_document_id() -> None:
    """克隆缺失 lineage_id 的历史文档时，应以源文档自身 id 作为 lineage_id。"""
    tenant_id = "tenant_lineage_legacy"
    base_id = "kb_lineage_legacy"
    engine = _engine()
    with Session(engine) as db:
        _seed_base(db, tenant_id=tenant_id, base_id=base_id)
        source_version = KnowledgeBaseVersion(
            id="kbver_source_legacy",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            version="1.0.0",
            name=base_id,
        )
        target_version = KnowledgeBaseVersion(
            id="kbver_target_legacy",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            version="1.0.1",
            name=base_id,
        )
        db.add(source_version)
        db.add(target_version)
        # 历史文档：没有 lineage_id（旧数据未回填）。
        legacy_document = KnowledgeDocument(
            id="doc_legacy_no_lineage",
            tenant_id=tenant_id,
            knowledge_base_id=base_id,
            knowledge_base_version_id=source_version.id,
            filename="legacy.md",
            file_type="markdown",
            title="历史文档",
            status="ready",
            metadata_json={},
        )
        db.add(legacy_document)
        db.commit()

        clone_knowledge_version_assets(
            db,
            tenant_id,
            base_id,
            source_version.id,
            target_version.id,
        )
        db.commit()

        cloned = db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == target_version.id,
            )
        ).one()
        assert cloned.id != legacy_document.id
        assert cloned.metadata_json.get("lineage_id") == "doc_legacy_no_lineage"

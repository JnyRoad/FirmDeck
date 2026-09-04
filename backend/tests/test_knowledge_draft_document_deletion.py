"""修复轮次 C1：草稿内"删除文档"（软删除 `status='archived'`）必须贯通对比/列表/发布/变基。

data-model §3 把草稿内删除定义为"该草稿版本内的文档 `status='archived'`，行保留"。本文件
按 HTTP 端到端链路证明四个消费方都把归档行当作"不存在"：

1. A2 对比（`diff.py:_load_version_documents`）把归档文档判定为 `deleted`（`summary.deleted=1`）；
2. A2b 文档列表不再返回归档行；
3. 发布（`versioning.ensure_ready`）不再因归档文档卡在 `KNOWLEDGE_VERSION_NOT_READY`；
4. 变基（`rebase._classify_lineage` + `_apply_merge_results`）保留该删除，而不是把文档恢复成活跃。

链路全部通过真实 HTTP 请求（`fastapi.testclient.TestClient`）驱动，验证阶段一律用独立
`Session(engine)` 读取，理由与 `test_knowledge_rebase_flow.py` 顶部说明一致。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api.knowledge import router as knowledge_router
from app.api.knowledge_admin import router as knowledge_admin_router
from app.api.knowledge_bases import router as knowledge_bases_router
from app.db import get_session
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.security.auth import get_current_user

BASE_ID = "kb_delete_flow"
V1_ID = "kbver_delete_v1"


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _http_client_for(engine: Any) -> TestClient:
    app = FastAPI()
    app.include_router(knowledge_bases_router)
    app.include_router(knowledge_admin_router)
    app.include_router(knowledge_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def _seed_base(engine: Any) -> None:
    """v1.0.0（已发布）含文档甲、乙，绑定一个团队。"""
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
        v1 = KnowledgeBaseVersion(
            id=V1_ID,
            tenant_id="tenant_demo",
            knowledge_base_id=BASE_ID,
            version="1.0.0",
            name="共享知识库",
            publication_state="released",
        )
        db.add(
            KnowledgeBase(
                id=BASE_ID,
                tenant_id="tenant_demo",
                name="共享知识库",
                mode="shared",
                status="active",
                published_version_id=v1.id,
            )
        )
        db.add(v1)
        for doc_id, lineage_id, filename, title, text in (
            ("kdoc_v1_jia", "L_JIA", "jia.md", "文档甲", "甲第一行\n甲第二行"),
            ("kdoc_v1_yi", "L_YI", "yi.md", "文档乙", "乙原文"),
        ):
            db.add(
                KnowledgeDocument(
                    id=doc_id,
                    tenant_id="tenant_demo",
                    knowledge_base_id=BASE_ID,
                    knowledge_base_version_id=V1_ID,
                    filename=filename,
                    file_type="md",
                    title=title,
                    status="ready",
                    metadata_json={"lineage_id": lineage_id, "raw_text": text},
                )
            )
        db.add(
            Team(
                id="team_content",
                tenant_id="tenant_demo",
                name="内容团队",
                owner_user_id="user_admin",
            )
        )
        db.add(
            TeamKnowledgeBaseBinding(
                id="teamkb_content",
                tenant_id="tenant_demo",
                team_id="team_content",
                knowledge_base_id=BASE_ID,
                status="active",
                created_by_user_id="user_admin",
            )
        )
        db.commit()


def _set_document_text(engine: Any, *, version_id: str, lineage_id: str, text: str) -> None:
    with Session(engine) as db:
        rows = db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.tenant_id == "tenant_demo",
                KnowledgeDocument.knowledge_base_version_id == version_id,
            )
        ).all()
        target = next(
            doc for doc in rows if (doc.metadata_json or {}).get("lineage_id") == lineage_id
        )
        metadata = dict(target.metadata_json or {})
        metadata["raw_text"] = text
        target.metadata_json = metadata
        db.add(target)
        db.commit()


def test_draft_document_archive_is_a_deletion_across_diff_list_publish_and_rebase() -> None:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    _seed_base(engine)
    client = _http_client_for(engine)

    def _post(path: str, json: dict[str, Any]) -> dict[str, Any]:
        response = client.post(path, json=json)
        assert response.status_code == 200, response.text
        return response.json()

    def _documents(version_id: str) -> list[dict[str, Any]]:
        response = client.get(
            f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
            f"/versions/{version_id}/documents",
            params={"tenant_id": "tenant_demo"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    # 草稿 D1、D2 都基于 v1.0.0；D2 用于后续证明变基保留删除。
    draft_1 = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D1：删除文档乙",
            "expected_published_version_id": V1_ID,
        },
    )
    draft_2 = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D2：也删除文档乙",
            "expected_published_version_id": V1_ID,
        },
    )
    draft_1_id = draft_1["id"]
    draft_2_id = draft_2["id"]

    # 在 D1 内删除文档乙 = 把该草稿版本内的克隆行置为 archived（data-model §3）。
    yi_in_draft_1 = next(item for item in _documents(draft_1_id) if item["lineage_id"] == "L_YI")
    archive_response = client.put(
        f"/api/enterprise/knowledge/documents/{yi_in_draft_1['id']}",
        json={"tenant_id": "tenant_demo", "status": "archived"},
    )
    assert archive_response.status_code == 200, archive_response.text

    # 1) A2 对比：归档文档必须判定为 deleted，前端才会显示"已删除"徽标与"恢复"按钮。
    diff_response = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
        f"/versions/{draft_1_id}/diff",
        params={"tenant_id": "tenant_demo", "against": "base"},
    )
    assert diff_response.status_code == 200, diff_response.text
    diff = diff_response.json()
    assert diff["summary"]["deleted"] == 1
    deleted_entries = [item for item in diff["documents"] if item["kind"] == "deleted"]
    assert [item["lineage_id"] for item in deleted_entries] == ["L_YI"]
    assert deleted_entries[0]["base_document_id"] == "kdoc_v1_yi"

    # 2) A2b 文档列表：归档行不再出现在草稿文档表里。
    assert [item["lineage_id"] for item in _documents(draft_1_id)] == ["L_JIA"]

    # 3) 发布：归档文档不再让 ensure_ready 卡在 KNOWLEDGE_VERSION_NOT_READY。
    published = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{draft_1_id}/publish",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": V1_ID,
            "change_reason": "发布删除了文档乙的草稿",
        },
    )
    assert published["version"] == "1.0.1"
    published_id = published["id"]
    assert [item["lineage_id"] for item in _documents(published_id)] == ["L_JIA"]

    # 归档行本身被保留（软删除），只是对所有消费方不可见。
    with Session(engine) as verify_db:
        rows = verify_db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == published_id
            )
        ).all()
        assert {row.status for row in rows} == {"ready", "archived"}

    # 4) 变基：D2 在自己的草稿里也删除了文档乙；变基到 v1.0.1 后该删除必须保留。
    yi_in_draft_2 = next(item for item in _documents(draft_2_id) if item["lineage_id"] == "L_YI")
    archive_2 = client.put(
        f"/api/enterprise/knowledge/documents/{yi_in_draft_2['id']}",
        json={"tenant_id": "tenant_demo", "status": "archived"},
    )
    assert archive_2.status_code == 200, archive_2.text
    _set_document_text(engine, version_id=draft_2_id, lineage_id="L_JIA", text="甲第一行\n甲第二行-D2")

    rebase_result = _post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
        f"/versions/{draft_2_id}/rebase",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D2 变基到 v1.0.1",
        },
    )
    assert rebase_result["status"] == "applied", rebase_result
    rebased_id = rebase_result["new_version"]["id"]

    # 新快照克隆自 v1.0.1（其中文档乙同样已被 D1 删除），删除状态保持一致；
    # 即便正式版仍带着该文档，ours 的删除也必须被套用而不是被静默丢弃。
    assert [item["lineage_id"] for item in _documents(rebased_id)] == ["L_JIA"]
    with Session(engine) as verify_db:
        rebased_rows = verify_db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == rebased_id
            )
        ).all()
        by_lineage = {
            (row.metadata_json or {}).get("lineage_id"): row for row in rebased_rows
        }
        assert by_lineage["L_YI"].status == "archived"
        assert (by_lineage["L_JIA"].metadata_json or {})["raw_text"] == "甲第一行\n甲第二行-D2"


def test_rebase_preserves_draft_deletion_when_published_version_still_has_the_document() -> None:
    """ours 删除、theirs 未改动：变基后新快照里该文档必须是归档态（删除被保留）。

    与上面的端到端链路互补——这里正式版仍然保留着文档乙（D1 没有删除它），克隆资产会把
    活跃的文档乙带进新快照，因此只有 `_apply_merge_results` 真的执行了软删除才会通过。
    """
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    _seed_base(engine)
    client = _http_client_for(engine)

    def _post(path: str, json: dict[str, Any]) -> dict[str, Any]:
        response = client.post(path, json=json)
        assert response.status_code == 200, response.text
        return response.json()

    draft_1 = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D1：只改文档甲",
            "expected_published_version_id": V1_ID,
        },
    )
    draft_2 = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D2：删除文档乙",
            "expected_published_version_id": V1_ID,
        },
    )
    _set_document_text(engine, version_id=draft_1["id"], lineage_id="L_JIA", text="甲第一行-D1\n甲第二行")
    published = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{draft_1['id']}/publish",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": V1_ID,
            "change_reason": "发布 D1",
        },
    )
    assert published["version"] == "1.0.1"

    with Session(engine) as db:
        target = next(
            row
            for row in db.exec(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.knowledge_base_version_id == draft_2["id"]
                )
            ).all()
            if (row.metadata_json or {}).get("lineage_id") == "L_YI"
        )
        target_id = target.id
    archive_response = client.put(
        f"/api/enterprise/knowledge/documents/{target_id}",
        json={"tenant_id": "tenant_demo", "status": "archived"},
    )
    assert archive_response.status_code == 200, archive_response.text

    rebase_result = _post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
        f"/versions/{draft_2['id']}/rebase",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "D2 变基",
        },
    )
    assert rebase_result["status"] == "applied", rebase_result
    rebased_id = rebase_result["new_version"]["id"]

    with Session(engine) as verify_db:
        rows = verify_db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == rebased_id
            )
        ).all()
        by_lineage = {(row.metadata_json or {}).get("lineage_id"): row for row in rows}
        assert by_lineage["L_YI"].status == "archived", "ours 的删除必须被保留，而不是被克隆恢复"
        assert by_lineage["L_JIA"].status == "ready"


def test_deleted_document_diff_entry_carries_restorable_draft_row_id() -> None:
    """A2b 不再列出归档行后，"恢复"所需的行 id 必须由 A2 的 `target_document_id` 提供。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    _seed_base(engine)
    client = _http_client_for(engine)

    draft_response = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "删除文档乙",
            "expected_published_version_id": V1_ID,
        },
    )
    assert draft_response.status_code == 200, draft_response.text
    draft_id = draft_response.json()["id"]

    documents = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
        f"/versions/{draft_id}/documents",
        params={"tenant_id": "tenant_demo"},
    ).json()
    yi_row_id = next(item for item in documents if item["lineage_id"] == "L_YI")["id"]
    archived = client.put(
        f"/api/enterprise/knowledge/documents/{yi_row_id}",
        json={"tenant_id": "tenant_demo", "status": "archived"},
    )
    assert archived.status_code == 200, archived.text

    diff = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{draft_id}/diff",
        params={"tenant_id": "tenant_demo", "against": "base"},
    ).json()
    deleted = next(item for item in diff["documents"] if item["kind"] == "deleted")
    assert deleted["target_document_id"] == yi_row_id
    assert deleted["base_document_id"] == "kdoc_v1_yi"

    # 用该 id 恢复：文档重新出现在 A2b 列表里，对比结果也不再判定为 deleted。
    restored = client.put(
        f"/api/enterprise/knowledge/documents/{deleted['target_document_id']}",
        json={"tenant_id": "tenant_demo", "status": "ready"},
    )
    assert restored.status_code == 200, restored.text
    restored_documents = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}"
        f"/versions/{draft_id}/documents",
        params={"tenant_id": "tenant_demo"},
    ).json()
    assert {item["lineage_id"] for item in restored_documents} == {"L_JIA", "L_YI"}
    restored_diff = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{draft_id}/diff",
        params={"tenant_id": "tenant_demo", "against": "base"},
    ).json()
    assert restored_diff["summary"]["deleted"] == 0

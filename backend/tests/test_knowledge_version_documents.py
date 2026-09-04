"""T080：版本文档列表端点（A2b）测试，覆盖 data-model §4 扩展与契约 A2b。

`GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/documents` 返回该版本
全部文档（含未改动的），每项携带真实行 `id`（而非仅 `lineage_id`——草稿版本里的文档是
克隆行，`lineage_id` 指向源文档，写回必须定位到当前版本内的真实行）。鉴权、错误语义与
A2 完全一致（admin 旁路 + history viewer 网关；404/403），复用同一组 `_load_admin_diff_*`
helper，因此本文件的鉴权用例直接镜像 `test_knowledge_diff.py` 对应用例。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from test_teams_api import _test_session

from app.api.knowledge_admin import list_knowledge_admin_version_documents
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)


def _admin_user(tenant_id: str = "tenant_demo") -> User:
    return User(
        id="user_admin", tenant_id=tenant_id, username="admin", role="admin", password_hash="x"
    )


def _member_user(tenant_id: str = "tenant_demo") -> User:
    return User(
        id="user_member",
        tenant_id=tenant_id,
        username="member",
        role="member",
        password_hash="x",
    )


def _seed_version_documents_fixture(db) -> None:
    """构造 1 个共享库 + 1 个草稿版本，含 3 篇文档（含未改动、含缺失 lineage_id），排序打乱。"""
    db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
    db.add(
        KnowledgeBase(
            id="kb_shared_x",
            tenant_id="tenant_demo",
            name="共享知识库",
            mode="shared",
            status="active",
            published_version_id="kbver_v1",
        )
    )
    db.add(
        KnowledgeBaseVersion(
            id="kbver_v1",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            version="1.0.0",
            name="共享知识库",
            publication_state="released",
        )
    )
    db.add(
        KnowledgeBaseVersion(
            id="kbver_v2",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            version="1.1.0",
            name="共享知识库",
            publication_state="draft",
            parent_version_id="kbver_v1",
        )
    )
    # 标题倒序插入，验证响应按 title 再 id 稳定排序，而非插入顺序或 id 顺序。
    db.add(
        KnowledgeDocument(
            id="doc_zzz",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="zzz.md",
            file_type="md",
            title="Zzz 未改动文档",
            status="ready",
            bucket_count=2,
            chunk_count=5,
            metadata_json={"lineage_id": "L_zzz", "raw_text": "z"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_aaa",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="aaa.md",
            file_type="md",
            title="Aaa 已修改文档",
            status="ready",
            bucket_count=1,
            chunk_count=3,
            metadata_json={"lineage_id": "L_aaa", "raw_text": "a"},
        )
    )
    # 缺失 lineage_id 的文档（数据质量兜底：不应导致端点报错，lineage_id 应为 null）。
    db.add(
        KnowledgeDocument(
            id="doc_mmm",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="mmm.md",
            file_type="md",
            title="Mmm 无血缘文档",
            status="processing",
            bucket_count=0,
            chunk_count=0,
            metadata_json={},
        )
    )

    db.add(Team(id="team_viewer", tenant_id="tenant_demo", name="Viewer 团队", owner_user_id="user_owner"))
    db.add(
        TeamKnowledgeBaseBinding(
            id="teamkb_viewer",
            tenant_id="tenant_demo",
            team_id="team_viewer",
            knowledge_base_id="kb_shared_x",
            status="active",
            created_by_user_id="user_owner",
        )
    )
    db.commit()


def _seed_dedicated_fixture(db) -> None:
    """构造 1 个专用（dedicated）库 + 1 个版本 + 1 篇文档，覆盖 admin 旁路与非 admin 拒绝。"""
    db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
    db.add(
        KnowledgeBase(
            id="kb_dedicated_x",
            tenant_id="tenant_demo",
            name="专用知识库",
            mode="dedicated",
            status="active",
        )
    )
    db.add(
        KnowledgeBaseVersion(
            id="kbver_dedicated_v1",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_x",
            version="1.0.0",
            name="专用知识库",
            publication_state="released",
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_dedicated_1",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_x",
            knowledge_base_version_id="kbver_dedicated_v1",
            filename="only.md",
            file_type="md",
            title="Only",
            status="ready",
            metadata_json={"lineage_id": "L_only", "raw_text": "hello"},
        )
    )
    db.commit()


# ---------------------------------------------------------------------------
# 全量文档列表：含未改动文档、真实 id、字段投影、稳定排序
# ---------------------------------------------------------------------------


def test_lists_all_documents_with_real_ids_sorted_by_title_then_id() -> None:
    with _test_session() as db:
        _seed_version_documents_fixture(db)

        response = list_knowledge_admin_version_documents(
            kb_id="kb_shared_x",
            version_id="kbver_v2",
            tenant_id="tenant_demo",
            db=db,
            current_user=_admin_user(),
        )

        # 3 篇文档全部返回（不是 diff 意义上的"改动"集合），且按 title 排序。
        assert [item.id for item in response] == ["doc_aaa", "doc_mmm", "doc_zzz"]
        assert [item.title for item in response] == [
            "Aaa 已修改文档",
            "Mmm 无血缘文档",
            "Zzz 未改动文档",
        ]

        aaa = next(item for item in response if item.id == "doc_aaa")
        assert aaa.lineage_id == "L_aaa"
        assert aaa.filename == "aaa.md"
        assert aaa.status == "ready"
        assert aaa.bucket_count == 1
        assert aaa.chunk_count == 3
        assert aaa.updated_at

        mmm = next(item for item in response if item.id == "doc_mmm")
        assert mmm.lineage_id is None  # 缺失 lineage_id 时回落 null，不报错
        assert mmm.status == "processing"


# ---------------------------------------------------------------------------
# 鉴权：admin 旁路 + history viewer 网关（镜像 A2 用例）
# ---------------------------------------------------------------------------


def test_team_owner_history_viewer_is_allowed() -> None:
    with _test_session() as db:
        _seed_version_documents_fixture(db)
        viewer = User(
            id="user_owner",
            tenant_id="tenant_demo",
            username="owner",
            role="member",
            password_hash="x",
        )

        response = list_knowledge_admin_version_documents(
            kb_id="kb_shared_x",
            version_id="kbver_v2",
            tenant_id="tenant_demo",
            db=db,
            current_user=viewer,
        )

        assert len(response) == 3


def test_non_admin_non_viewer_is_forbidden() -> None:
    with _test_session() as db:
        _seed_version_documents_fixture(db)

        with pytest.raises(HTTPException) as denied:
            list_knowledge_admin_version_documents(
                kb_id="kb_shared_x",
                version_id="kbver_v2",
                tenant_id="tenant_demo",
                db=db,
                current_user=_member_user(),
            )

        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "KNOWLEDGE_GRANT_REQUIRED"


def test_admin_can_list_dedicated_mode_version_documents() -> None:
    with _test_session() as db:
        _seed_dedicated_fixture(db)

        response = list_knowledge_admin_version_documents(
            kb_id="kb_dedicated_x",
            version_id="kbver_dedicated_v1",
            tenant_id="tenant_demo",
            db=db,
            current_user=_admin_user(),
        )

        assert [item.id for item in response] == ["doc_dedicated_1"]


def test_non_admin_on_dedicated_base_is_still_rejected() -> None:
    with _test_session() as db:
        _seed_dedicated_fixture(db)

        with pytest.raises(HTTPException) as denied:
            list_knowledge_admin_version_documents(
                kb_id="kb_dedicated_x",
                version_id="kbver_dedicated_v1",
                tenant_id="tenant_demo",
                db=db,
                current_user=_member_user(),
            )

        assert denied.value.status_code == 409
        assert denied.value.detail["code"] == "KNOWLEDGE_MODE_INVALID"


# ---------------------------------------------------------------------------
# 错误路径：版本缺失 / 跨租户
# ---------------------------------------------------------------------------


def test_missing_version_is_not_found() -> None:
    with _test_session() as db:
        _seed_version_documents_fixture(db)

        with pytest.raises(HTTPException) as missing:
            list_knowledge_admin_version_documents(
                kb_id="kb_shared_x",
                version_id="kbver_does_not_exist",
                tenant_id="tenant_demo",
                db=db,
                current_user=_admin_user(),
            )

        assert missing.value.status_code == 404
        assert missing.value.detail["code"] == "KNOWLEDGE_BASE_NOT_FOUND"


def test_cross_tenant_version_is_context_mismatch() -> None:
    with _test_session() as db:
        _seed_version_documents_fixture(db)
        db.add(Tenant(id="tenant_other", slug="tenant-other", name="Other", lifecycle_version=1))
        db.add(
            KnowledgeBaseVersion(
                id="kbver_cross_tenant",
                tenant_id="tenant_other",
                knowledge_base_id="kb_shared_x",
                version="9.9.9",
                name="共享知识库",
                publication_state="released",
            )
        )
        db.commit()

        with pytest.raises(HTTPException) as mismatch:
            list_knowledge_admin_version_documents(
                kb_id="kb_shared_x",
                version_id="kbver_cross_tenant",
                tenant_id="tenant_demo",
                db=db,
                current_user=_admin_user(),
            )

        assert mismatch.value.status_code == 403
        assert mismatch.value.detail["code"] == "KNOWLEDGE_CONTEXT_MISMATCH"

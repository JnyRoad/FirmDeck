"""T022：知识库版本对比（A2）纯函数与路由测试，覆盖 data-model §4 与契约 A2。

纯函数用例（不接触 DB）覆盖行级 hunks 区间、change 块内相似度配对、max_lines 截断、
lineage 配对与 filename 回退；DB 用例覆盖薄加载层 `diff_versions`、`against=base|
published` 两种对比目标解析，以及路由鉴权（admin 或 history viewer 均可访问，
其余 403）与版本缺失/跨租户错误。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from test_teams_api import _test_session

from app.api.knowledge_admin import get_knowledge_admin_version_diff
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.diff import (
    DocumentSnapshot,
    diff_document_lines,
    diff_document_sets,
    diff_versions,
    pair_documents,
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


# ---------------------------------------------------------------------------
# 纯函数：行级 hunks（equal/change 区间）
# ---------------------------------------------------------------------------


def test_diff_document_lines_hunks_have_base_and_target_ranges() -> None:
    base = ["a", "b", "c", "d"]
    target = ["a", "x", "y", "d"]

    hunks, truncated = diff_document_lines(base, target, max_lines=100)

    assert truncated is False
    assert [h.type for h in hunks] == ["equal", "change", "equal"]

    equal_head, change, equal_tail = hunks
    assert equal_head.base_start == 0
    assert equal_head.base_lines == ["a"]
    assert equal_head.target_start == 0
    assert equal_head.target_lines == ["a"]

    assert change.base_start == 1
    assert change.base_lines == ["b", "c"]
    assert change.target_start == 1
    assert change.target_lines == ["x", "y"]

    assert equal_tail.base_start == 3
    assert equal_tail.base_lines == ["d"]
    assert equal_tail.target_start == 3
    assert equal_tail.target_lines == ["d"]


def test_diff_document_lines_merges_adjacent_delete_and_insert_into_one_change() -> None:
    base = ["shared", "old-only"]
    target = ["shared", "new-only"]

    hunks, truncated = diff_document_lines(base, target, max_lines=100)

    assert truncated is False
    # 相邻的 delete + insert（或 replace）必须合并为一个 change 块，而不是拆成两个。
    change_hunks = [h for h in hunks if h.type == "change"]
    assert len(change_hunks) == 1
    assert change_hunks[0].base_lines == ["old-only"]
    assert change_hunks[0].target_lines == ["new-only"]


# ---------------------------------------------------------------------------
# 纯函数：change 块内相似度配对（顺序对齐，ratio() >= 0.5）
# ---------------------------------------------------------------------------


def test_diff_document_lines_pairs_are_position_aligned_and_similarity_filtered() -> None:
    base = ["apple pie", "completely unrelated text"]
    target = ["apple pies", "xyz totally different"]

    hunks, _truncated = diff_document_lines(base, target, max_lines=100)
    change = next(h for h in hunks if h.type == "change")

    # 第 0 行相似（仅追加了一个字符），第 1 行几乎无重叠字符 → 只保留第 0 对。
    assert change.pairs == [(0, 0)]


def test_diff_document_lines_no_pairs_when_all_change_lines_are_dissimilar() -> None:
    base = ["aaaaaaaaaa"]
    target = ["zzzzzzzzzz"]

    hunks, _truncated = diff_document_lines(base, target, max_lines=100)
    change = next(h for h in hunks if h.type == "change")

    assert change.pairs == []


# ---------------------------------------------------------------------------
# 纯函数：max_lines 截断
# ---------------------------------------------------------------------------


def test_diff_document_lines_truncates_when_exceeding_max_lines() -> None:
    base = [f"line-{i}" for i in range(6)]
    target = [f"line-{i}-changed" for i in range(6)]

    hunks, truncated = diff_document_lines(base, target, max_lines=5)

    assert truncated is True
    assert hunks == []


def test_diff_document_lines_does_not_truncate_at_exact_max_lines() -> None:
    base = [f"line-{i}" for i in range(5)]
    target = [f"line-{i}" for i in range(5)]

    hunks, truncated = diff_document_lines(base, target, max_lines=5)

    assert truncated is False
    assert len(hunks) == 1
    assert hunks[0].type == "equal"
    assert hunks[0].base_lines == base
    assert hunks[0].target_lines == target


# ---------------------------------------------------------------------------
# 纯函数：文档配对（lineage 优先，缺失时整体回退 filename）
# ---------------------------------------------------------------------------


def test_pair_documents_uses_lineage_and_tracks_renames() -> None:
    base_docs = [
        DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"]),
        DocumentSnapshot(lineage_id="L2", filename="b.md", title="B", lines=["y"]),
    ]
    target_docs = [
        # L1 的文件被改名，但 lineage_id 不变 → 仍应配成同一篇（modified）。
        DocumentSnapshot(lineage_id="L1", filename="a-renamed.md", title="A2", lines=["x2"]),
    ]

    pairing, paired = pair_documents(base_docs, target_docs)

    assert pairing == "lineage"
    by_key = {key: (base, target) for key, base, target in paired}
    assert by_key["L1"][0].filename == "a.md"
    assert by_key["L1"][1].filename == "a-renamed.md"
    assert by_key["L2"][1] is None  # 只在 base 中出现 → 待上层判定为 deleted


def test_pair_documents_falls_back_to_filename_when_lineage_missing() -> None:
    base_docs = [DocumentSnapshot(lineage_id=None, filename="only.md", title="Only", lines=["x"])]
    target_docs = [DocumentSnapshot(lineage_id="L9", filename="only.md", title="Only", lines=["x"])]

    pairing, paired = pair_documents(base_docs, target_docs)

    assert pairing == "filename"
    assert len(paired) == 1
    key, base_doc, target_doc = paired[0]
    assert key == "only.md"
    assert base_doc is not None
    assert target_doc is not None


# ---------------------------------------------------------------------------
# 纯函数：文档级 added/modified/deleted 清单，未变文档不出现在结果中
# ---------------------------------------------------------------------------


def test_diff_document_sets_added_modified_deleted_and_excludes_unchanged() -> None:
    base_docs = [
        DocumentSnapshot(lineage_id="L_same", filename="same.md", title="Same", lines=["a", "b"]),
        DocumentSnapshot(
            lineage_id="L_mod", filename="mod.md", title="Mod", lines=["alpha", "beta", "gamma"]
        ),
        DocumentSnapshot(lineage_id="L_del", filename="del.md", title="Del", lines=["gone"]),
    ]
    target_docs = [
        DocumentSnapshot(lineage_id="L_same", filename="same.md", title="Same", lines=["a", "b"]),
        DocumentSnapshot(
            lineage_id="L_mod",
            filename="mod.md",
            title="Mod",
            lines=["alpha", "beta value", "gamma"],
        ),
        DocumentSnapshot(lineage_id="L_add", filename="add.md", title="Add", lines=["new"]),
    ]

    result = diff_document_sets(
        base_docs,
        target_docs,
        base_version_id="kbver_base",
        target_version_id="kbver_target",
        max_lines=100,
    )

    assert result.pairing == "lineage"
    assert result.summary.added == 1
    assert result.summary.modified == 1
    assert result.summary.deleted == 1
    kinds_by_lineage = {doc.lineage_id: doc.kind for doc in result.documents}
    assert kinds_by_lineage == {"L_mod": "modified", "L_del": "deleted", "L_add": "added"}
    assert "L_same" not in kinds_by_lineage  # 未变文档不进入 documents[]

    modified_doc = next(doc for doc in result.documents if doc.lineage_id == "L_mod")
    assert modified_doc.hunks  # 修改的文档必须带 hunks
    assert modified_doc.truncated is False


# ---------------------------------------------------------------------------
# DB 用例：薄加载层 diff_versions 与 against=base|published 解析
# ---------------------------------------------------------------------------


def _seed_diff_fixture(db):
    """构造 1 个共享库 + 3 个版本（v1 已发布 <- v2 草稿 <- v3 草稿）与跨版本文档。"""
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
    db.add(
        KnowledgeBaseVersion(
            id="kbver_v3",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            version="1.2.0",
            name="共享知识库",
            publication_state="draft",
            parent_version_id="kbver_v2",
        )
    )

    # v1（已发布）：unchanged + modified(旧内容) + deleted
    db.add(
        KnowledgeDocument(
            id="doc_v1_same",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v1",
            filename="same.md",
            file_type="md",
            title="Same",
            status="ready",
            metadata_json={"lineage_id": "L_same", "raw_text": "line1\nline2\nline3"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_v1_mod",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v1",
            filename="mod.md",
            file_type="md",
            title="Mod",
            status="ready",
            metadata_json={"lineage_id": "L_mod", "raw_text": "alpha\nbeta\ngamma"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_v1_del",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v1",
            filename="del.md",
            file_type="md",
            title="Del",
            status="ready",
            metadata_json={"lineage_id": "L_del", "raw_text": "only in v1"},
        )
    )

    # v2（对比 v1 的目标）：unchanged + modified(新内容) + added
    db.add(
        KnowledgeDocument(
            id="doc_v2_same",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="same.md",
            file_type="md",
            title="Same",
            status="ready",
            metadata_json={"lineage_id": "L_same", "raw_text": "line1\nline2\nline3"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_v2_mod",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="mod.md",
            file_type="md",
            title="Mod",
            status="ready",
            metadata_json={"lineage_id": "L_mod", "raw_text": "alpha\nbeta value\ngamma"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="doc_v2_add",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v2",
            filename="add.md",
            file_type="md",
            title="Add",
            status="ready",
            metadata_json={"lineage_id": "L_add", "raw_text": "new in v2"},
        )
    )

    # v3：只延续 same 文档，作为 against=base(对比 v2) / against=published(对比 v1) 的区分目标。
    db.add(
        KnowledgeDocument(
            id="doc_v3_same",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_x",
            knowledge_base_version_id="kbver_v3",
            filename="same.md",
            file_type="md",
            title="Same",
            status="ready",
            metadata_json={"lineage_id": "L_same", "raw_text": "line1\nline2\nline3"},
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


def test_diff_versions_loads_texts_and_pairs_by_lineage() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        result = diff_versions(
            db,
            tenant_id="tenant_demo",
            base_version_id="kbver_v1",
            target_version_id="kbver_v2",
            max_lines=5000,
        )

        assert result.pairing == "lineage"
        assert result.base_version_id == "kbver_v1"
        assert result.target_version_id == "kbver_v2"
        assert result.summary.added == 1
        assert result.summary.modified == 1
        assert result.summary.deleted == 1

        modified_doc = next(doc for doc in result.documents if doc.lineage_id == "L_mod")
        assert modified_doc.kind == "modified"
        change_hunks = [h for h in modified_doc.hunks if h.type == "change"]
        assert len(change_hunks) == 1
        assert change_hunks[0].base_lines == ["beta"]
        assert change_hunks[0].target_lines == ["beta value"]
        assert change_hunks[0].pairs == [(0, 0)]  # "beta" 与 "beta value" 足够相似


def test_diff_versions_with_no_base_version_treats_all_target_docs_as_added() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        result = diff_versions(
            db,
            tenant_id="tenant_demo",
            base_version_id=None,
            target_version_id="kbver_v1",
            max_lines=5000,
        )

        assert result.base_version_id is None
        assert result.summary.added == 3
        assert result.summary.modified == 0
        assert result.summary.deleted == 0


# ---------------------------------------------------------------------------
# 路由：A2 鉴权（admin 或 history viewer）与 against=base|published 解析
# ---------------------------------------------------------------------------


def test_route_against_base_compares_parent_version() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        response = get_knowledge_admin_version_diff(
            kb_id="kb_shared_x",
            version_id="kbver_v3",
            tenant_id="tenant_demo",
            against="base",
            max_lines=5000,
            db=db,
            current_user=_admin_user(),
        )

        assert response.base_version_id == "kbver_v2"
        assert response.target_version_id == "kbver_v3"
        # v3 只延续了 same 文档；相对 v2（含 mod/add）少了 mod 与 add → 两篇 deleted。
        assert response.summary.deleted == 2
        assert response.summary.added == 0
        assert response.summary.modified == 0


def test_route_against_published_compares_kb_published_version() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        response = get_knowledge_admin_version_diff(
            kb_id="kb_shared_x",
            version_id="kbver_v3",
            tenant_id="tenant_demo",
            against="published",
            max_lines=5000,
            db=db,
            current_user=_admin_user(),
        )

        # 正式版是 v1（只有 same/mod/del），v3 只有 same → mod 相对丢失(deleted)，del 也丢失。
        assert response.base_version_id == "kbver_v1"
        assert response.target_version_id == "kbver_v3"
        assert response.summary.deleted == 2
        assert response.summary.added == 0
        assert response.summary.modified == 0


def test_route_team_owner_history_viewer_is_allowed() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)
        viewer = User(
            id="user_owner",
            tenant_id="tenant_demo",
            username="owner",
            role="member",
            password_hash="x",
        )

        response = get_knowledge_admin_version_diff(
            kb_id="kb_shared_x",
            version_id="kbver_v2",
            tenant_id="tenant_demo",
            against="base",
            max_lines=5000,
            db=db,
            current_user=viewer,
        )

        assert response.target_version_id == "kbver_v2"


def test_route_non_admin_non_viewer_is_forbidden() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        with pytest.raises(HTTPException) as denied:
            get_knowledge_admin_version_diff(
                kb_id="kb_shared_x",
                version_id="kbver_v2",
                tenant_id="tenant_demo",
                against="base",
                max_lines=5000,
                db=db,
                current_user=_member_user(),
            )

        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "KNOWLEDGE_GRANT_REQUIRED"


def test_route_missing_version_is_not_found() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)

        with pytest.raises(HTTPException) as missing:
            get_knowledge_admin_version_diff(
                kb_id="kb_shared_x",
                version_id="kbver_does_not_exist",
                tenant_id="tenant_demo",
                against="base",
                max_lines=5000,
                db=db,
                current_user=_admin_user(),
            )

        assert missing.value.status_code == 404
        assert missing.value.detail["code"] == "KNOWLEDGE_BASE_NOT_FOUND"


def test_route_cross_tenant_version_is_context_mismatch() -> None:
    with _test_session() as db:
        _seed_diff_fixture(db)
        db.add(Tenant(id="tenant_other", slug="tenant-other", name="Other", lifecycle_version=1))
        # 模拟数据错配：version 行的 tenant_id 与调用方声明的 tenant_id 不一致。
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
            get_knowledge_admin_version_diff(
                kb_id="kb_shared_x",
                version_id="kbver_cross_tenant",
                tenant_id="tenant_demo",
                against="base",
                max_lines=5000,
                db=db,
                current_user=_admin_user(),
            )

        assert mismatch.value.status_code == 403
        assert mismatch.value.detail["code"] == "KNOWLEDGE_CONTEXT_MISMATCH"

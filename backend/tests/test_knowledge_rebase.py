"""T024：草稿变基（A3/A4）三方合并纯函数与路由测试，覆盖 data-model §5 与契约 A3/A4/B1。

纯函数用例（不接触 DB）覆盖 `merge_document_sets` 的三种分类：仅 ours 变/仅 theirs 变/
双方不交叠自动合并/双方交叠产出冲突。DB + 路由用例覆盖完整变基生命周期：无冲突直接
落库、有冲突两步解决（resolve 缺失解决方案/残留冲突标记/正式版已变）、非 stale 草稿
拒绝、团队 owner 与非 owner 鉴权，以及发布端的基线过期校验（stale guard）与
`force_overwrite`、`knowledge.draft.rebased`/`knowledge.version.published` 事件。
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from test_teams_api import _test_session

from app.api.knowledge_admin import (
    rebase_knowledge_admin_draft,
    resolve_knowledge_admin_rebase,
)
from app.api.knowledge_admin import router as knowledge_admin_router
from app.db import get_session
from app.db.models import (
    AgentEvent,
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
    KnowledgeBucket,
    KnowledgeChunk,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.diff import DocumentSnapshot
from app.knowledge.errors import (
    KNOWLEDGE_BASELINE_STALE,
    KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH,
    KNOWLEDGE_GRANT_REQUIRED,
    KNOWLEDGE_MODE_INVALID,
    KNOWLEDGE_PUBLISH_CONFLICT,
    KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED,
    KNOWLEDGE_VERSION_NOT_READY,
    KnowledgeError,
)
from app.knowledge.rebase import merge_document_sets
from app.knowledge.schema import (
    KnowledgeRebaseRequest,
    KnowledgeRebaseResolutionInput,
    KnowledgeRebaseResolveRequest,
)
from app.knowledge.versioning import SharedKnowledgeVersionService
from app.security.auth import get_current_user

# ---------------------------------------------------------------------------
# 纯函数：merge_document_sets 的三方分类（仅 ours / 仅 theirs / 不交叠自动合并 / 交叠冲突）
# ---------------------------------------------------------------------------


def test_merge_document_sets_adopts_ours_when_only_ours_changed() -> None:
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x", "y"])]
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x-ours", "y"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x", "y"])]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert conflicts == []
    assert len(auto_merged) == 1
    assert auto_merged[0].lineage_id == "L1"
    assert auto_merged[0].source == "ours"
    assert auto_merged[0].action == "update"
    assert auto_merged[0].lines == ["x-ours", "y"]


def test_merge_document_sets_adopts_theirs_when_only_theirs_changed() -> None:
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x", "y"])]
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x", "y"])]
    theirs = [
        DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x", "y-theirs"])
    ]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert conflicts == []
    assert len(auto_merged) == 1
    assert auto_merged[0].source == "theirs"
    assert auto_merged[0].action == "noop"  # 已随克隆最新正式版资产带入，无需再写


def test_merge_document_sets_unchanged_document_is_skipped() -> None:
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert auto_merged == []
    assert conflicts == []


def test_merge_document_sets_auto_merges_non_overlapping_changes() -> None:
    base_lines = ["line1", "line2", "line3", "line4", "line5"]
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=base_lines)]
    ours = [
        DocumentSnapshot(
            lineage_id="L1",
            filename="a.md",
            title="A",
            lines=["line1", "line2-ours", "line3", "line4", "line5"],
        )
    ]
    theirs = [
        DocumentSnapshot(
            lineage_id="L1",
            filename="a.md",
            title="A",
            lines=["line1", "line2", "line3", "line4-theirs", "line5"],
        )
    ]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert conflicts == []
    assert len(auto_merged) == 1
    merged = auto_merged[0]
    assert merged.source == "merged"
    assert merged.action == "update"
    assert merged.lines == ["line1", "line2-ours", "line3", "line4-theirs", "line5"]


def test_merge_document_sets_produces_conflict_for_overlapping_changes() -> None:
    base_lines = ["alpha", "beta", "gamma"]
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=base_lines)]
    ours = [
        DocumentSnapshot(
            lineage_id="L1", filename="a.md", title="A", lines=["alpha", "beta-ours", "gamma"]
        )
    ]
    theirs = [
        DocumentSnapshot(
            lineage_id="L1", filename="a.md", title="A", lines=["alpha", "beta-theirs", "gamma"]
        )
    ]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert auto_merged == []
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.lineage_id == "L1"
    assert conflict.action == "update"
    assert len(conflict.blocks) == 1
    block = conflict.blocks[0]
    assert block.base_lines == ["beta"]
    assert block.ours_lines == ["beta-ours"]
    assert block.theirs_lines == ["beta-theirs"]
    assert block.context_before == ["alpha"]
    assert block.context_after == ["gamma"]


def test_merge_document_sets_same_position_zero_width_inserts_conflict() -> None:
    """回归：base 为空，ours/theirs 各自整篇新增内容，两个零宽度插入落在同一基线位置(0,0)。

    `_merge_line_ranges` 按 `start < clusters[-1]["end"]` 聚簇时，两个零宽度事件谁都不比
    谁大，永远进不了同一个簇，会被当成互不相干、按处理顺序直接拼接——`ours_lines=["A"]`
    紧跟 `theirs_lines=["B"]` 悄悄变成 `["A", "B"]`，而不是产出冲突让人工判断先后顺序。
    """
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=[])]
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["A"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["B"])]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert auto_merged == []
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.lineage_id == "L1"
    assert len(conflict.blocks) == 1
    block = conflict.blocks[0]
    assert block.base_lines == []
    assert block.ours_lines == ["A"]
    assert block.theirs_lines == ["B"]


def test_merge_document_sets_zero_width_insert_touching_same_start_conflicts() -> None:
    """回归：base 非空，ours/theirs 都在第 0 行之前插入内容（同一起点，不同零宽度 hunk）。

    同上一个用例的边界变体：base 有内容时依旧要能识别"同一插入点"的歧义，
    不能因为 base 非空就漏判。
    """
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["A", "x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["B", "x"])]

    auto_merged, conflicts = merge_document_sets(base, ours, theirs)

    assert auto_merged == []
    assert len(conflicts) == 1
    block = conflicts[0].blocks[0]
    assert block.base_lines == []
    assert block.ours_lines == ["A"]
    assert block.theirs_lines == ["B"]


# ---------------------------------------------------------------------------
# DB + 路由 fixture：1 个共享库 + v1(released) <- draft_ours(stale) 与
# v1 <- draft_theirs -> 发布为 v2，构造仅 ours/仅 theirs/双方不交叠/双方交叠 四种文档。
# ---------------------------------------------------------------------------


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _owner_user() -> User:
    return User(
        id="user_owner", tenant_id="tenant_demo", username="owner", role="member", password_hash="x"
    )


def _member_user() -> User:
    return User(
        id="user_member",
        tenant_id="tenant_demo",
        username="member",
        role="member",
        password_hash="x",
    )


def _add_document(
    db: Session, *, version_id: str, lineage_id: str, filename: str, lines: list[str]
) -> None:
    db.add(
        KnowledgeDocument(
            id=f"kdoc_{version_id}_{lineage_id}",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_rebase",
            knowledge_base_version_id=version_id,
            filename=filename,
            file_type="md",
            title=filename,
            status="ready",
            metadata_json={"lineage_id": lineage_id, "raw_text": "\n".join(lines)},
        )
    )


def _seed_rebase_fixture(db: Session) -> tuple[KnowledgeBase, KnowledgeBaseVersion]:
    """v1(released, 5 篇文档) <- draft_ours(草稿, 变基目标, ours 编辑) 并绑定团队。"""
    db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
    v1 = KnowledgeBaseVersion(
        id="kbver_v1",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_shared_rebase",
        version="1.0.0",
        name="共享知识库",
        publication_state="released",
    )
    base = KnowledgeBase(
        id="kb_shared_rebase",
        tenant_id="tenant_demo",
        name="共享知识库",
        mode="shared",
        status="active",
        published_version_id=v1.id,
    )
    db.add(base)
    db.add(v1)
    _add_document(db, version_id=v1.id, lineage_id="L_OURS", filename="ours.md", lines=["only1", "only2"])
    _add_document(
        db, version_id=v1.id, lineage_id="L_THEIRS", filename="theirs.md", lines=["theirs1", "theirs2"]
    )
    _add_document(
        db,
        version_id=v1.id,
        lineage_id="L_BOTH_OK",
        filename="both.md",
        lines=["line1", "line2", "line3", "line4", "line5"],
    )
    _add_document(
        db, version_id=v1.id, lineage_id="L_CONFLICT", filename="conflict.md", lines=["alpha", "beta", "gamma"]
    )
    _add_document(db, version_id=v1.id, lineage_id="L_SAME", filename="same.md", lines=["same"])
    db.add(
        Team(id="team_content", tenant_id="tenant_demo", name="内容团队", owner_user_id="user_owner")
    )
    db.add(
        TeamKnowledgeBaseBinding(
            id="teamkb_content",
            tenant_id="tenant_demo",
            team_id="team_content",
            knowledge_base_id=base.id,
            status="active",
            created_by_user_id="user_admin",
        )
    )
    db.commit()
    return base, v1


def _create_draft(db: Session, *, expected_published_version_id: str, reason: str) -> KnowledgeBaseVersion:
    return SharedKnowledgeVersionService(db).create_draft(
        tenant_id="tenant_demo",
        knowledge_base_id="kb_shared_rebase",
        source_team_id="team_content",
        actor_type="user",
        actor_id="user_admin",
        change_reason=reason,
        expected_published_version_id=expected_published_version_id,
    )


def _build_stale_ours_draft_and_published_theirs(
    db: Session,
) -> tuple[KnowledgeBase, KnowledgeBaseVersion, KnowledgeBaseVersion]:
    """构造完整变基场景：draft_ours（stale）与已发布的 v2（theirs），含四类文档变化。"""
    base, v1 = _seed_rebase_fixture(db)

    draft_ours = _create_draft(db, expected_published_version_id=v1.id, reason="ours 分支编辑")
    draft_theirs = _create_draft(db, expected_published_version_id=v1.id, reason="theirs 分支编辑")
    db.commit()

    # ours：仅改 L_OURS（整篇）与 L_BOTH_OK（第 2 行）、L_CONFLICT（第 2 行，制造交叠）。
    _update_document(db, version_id=draft_ours.id, lineage_id="L_OURS", lines=["only1-ours", "only2"])
    _update_document(
        db,
        version_id=draft_ours.id,
        lineage_id="L_BOTH_OK",
        lines=["line1", "line2-ours", "line3", "line4", "line5"],
    )
    _update_document(
        db, version_id=draft_ours.id, lineage_id="L_CONFLICT", lines=["alpha", "beta-ours", "gamma"]
    )

    # theirs：仅改 L_THEIRS（整篇）与 L_BOTH_OK（第 4 行，不交叠）、L_CONFLICT（第 2 行，交叠）。
    _update_document(
        db, version_id=draft_theirs.id, lineage_id="L_THEIRS", lines=["theirs1-theirs", "theirs2"]
    )
    _update_document(
        db,
        version_id=draft_theirs.id,
        lineage_id="L_BOTH_OK",
        lines=["line1", "line2", "line3", "line4-theirs", "line5"],
    )
    _update_document(
        db, version_id=draft_theirs.id, lineage_id="L_CONFLICT", lines=["alpha", "beta-theirs", "gamma"]
    )
    db.commit()

    published_theirs = SharedKnowledgeVersionService(db).publish_draft(
        tenant_id="tenant_demo",
        knowledge_base_id=base.id,
        draft_version_id=draft_theirs.id,
        expected_published_version_id=v1.id,
        actor_type="user",
        actor_id="user_admin",
        source_team_id="team_content",
        change_reason="发布 theirs 分支",
    )
    db.commit()
    db.refresh(base)
    db.refresh(draft_ours)
    return base, draft_ours, published_theirs


def _update_document(db: Session, *, version_id: str, lineage_id: str, lines: list[str]) -> None:
    row = db.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == "tenant_demo",
            KnowledgeDocument.knowledge_base_version_id == version_id,
        )
    ).all()
    target = next(
        doc for doc in row if (doc.metadata_json or {}).get("lineage_id") == lineage_id
    )
    metadata = dict(target.metadata_json or {})
    metadata["raw_text"] = "\n".join(lines)
    target.metadata_json = metadata
    db.add(target)


# ---------------------------------------------------------------------------
# 路由：A3 变基预览/执行——有冲突 → 返回预览不落库；非 stale 草稿 → NOT_READY
# ---------------------------------------------------------------------------


def test_rebase_route_returns_preview_with_conflicts_and_persists_nothing() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_stale_ours_draft_and_published_theirs(db)
        version_count_before = len(db.exec(select(KnowledgeBaseVersion)).all())

        response = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="尝试变基"
            ),
            db=db,
            current_user=_admin_user(),
        )

        assert response.status == "conflicts"
        assert response.draft_version_id == draft_ours.id
        assert response.from_base_version_id == "kbver_v1"
        assert response.to_base_version_id == published_theirs.id

        auto_merged_by_lineage = {item.lineage_id: item.source for item in response.auto_merged}
        assert auto_merged_by_lineage["L_OURS"] == "ours"
        assert auto_merged_by_lineage["L_THEIRS"] == "theirs"
        assert auto_merged_by_lineage["L_BOTH_OK"] == "merged"
        assert "L_SAME" not in auto_merged_by_lineage

        assert len(response.conflicts) == 1
        conflict = response.conflicts[0]
        assert conflict.lineage_id == "L_CONFLICT"
        assert len(conflict.blocks) == 1
        assert conflict.blocks[0].ours_lines == ["beta-ours"]
        assert conflict.blocks[0].theirs_lines == ["beta-theirs"]

        # 有冲突时不落库：草稿数不变，draft_ours 仍是可写草稿。
        assert len(db.exec(select(KnowledgeBaseVersion)).all()) == version_count_before
        db.refresh(draft_ours)
        assert draft_ours.publication_state == "draft"
        assert draft_ours.status == "active"


def test_rebase_route_rejects_non_stale_draft() -> None:
    with _test_session() as db:
        base, v1 = _seed_rebase_fixture(db)
        fresh_draft = _create_draft(db, expected_published_version_id=v1.id, reason="非过期草稿")
        db.commit()

        with pytest.raises(HTTPException) as not_ready:
            rebase_knowledge_admin_draft(
                base.id,
                fresh_draft.id,
                KnowledgeRebaseRequest(
                    tenant_id="tenant_demo", team_id="team_content", change_reason="尝试变基"
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert not_ready.value.status_code == 409
        assert not_ready.value.detail["code"] == KNOWLEDGE_VERSION_NOT_READY


def _build_conflict_free_stale_draft(
    db: Session,
) -> tuple[KnowledgeBase, KnowledgeBaseVersion, KnowledgeBaseVersion]:
    """构造无冲突、可直接落库的变基场景：ours 只改 L_OURS，theirs 只改 L_THEIRS。"""
    base, v1 = _seed_rebase_fixture(db)
    draft_ours = _create_draft(db, expected_published_version_id=v1.id, reason="ours 编辑")
    db.commit()
    _update_document(db, version_id=draft_ours.id, lineage_id="L_OURS", lines=["only1-ours", "only2"])
    db.commit()

    draft_theirs = _create_draft(db, expected_published_version_id=v1.id, reason="theirs 编辑")
    db.commit()
    _update_document(
        db, version_id=draft_theirs.id, lineage_id="L_THEIRS", lines=["theirs1-theirs", "theirs2"]
    )
    db.commit()
    published_theirs = SharedKnowledgeVersionService(db).publish_draft(
        tenant_id="tenant_demo",
        knowledge_base_id=base.id,
        draft_version_id=draft_theirs.id,
        expected_published_version_id=v1.id,
        actor_type="user",
        actor_id="user_admin",
        source_team_id="team_content",
        change_reason="发布 theirs",
    )
    db.commit()
    db.refresh(base)
    db.refresh(draft_ours)
    return base, draft_ours, published_theirs


def test_rebase_route_team_owner_succeeds_and_non_owner_is_denied() -> None:
    with _test_session() as db:
        base, v1 = _seed_rebase_fixture(db)
        # 只让 L_OURS 变化（仅 ours），确保无冲突可直接落库验证 team 路径成功。
        draft_ours = _create_draft(db, expected_published_version_id=v1.id, reason="ours 编辑")
        db.commit()
        _update_document(db, version_id=draft_ours.id, lineage_id="L_OURS", lines=["only1-ours", "only2"])
        db.commit()

        draft_theirs = _create_draft(db, expected_published_version_id=v1.id, reason="theirs 编辑")
        db.commit()
        _update_document(
            db, version_id=draft_theirs.id, lineage_id="L_THEIRS", lines=["theirs1-theirs", "theirs2"]
        )
        db.commit()
        SharedKnowledgeVersionService(db).publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft_theirs.id,
            expected_published_version_id=v1.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="发布 theirs",
        )
        db.commit()
        db.refresh(draft_ours)

        with pytest.raises(HTTPException) as denied:
            rebase_knowledge_admin_draft(
                base.id,
                draft_ours.id,
                KnowledgeRebaseRequest(
                    tenant_id="tenant_demo", team_id="team_content", change_reason="非 owner 尝试变基"
                ),
                db=db,
                current_user=_member_user(),
            )
        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == KNOWLEDGE_GRANT_REQUIRED

        original_draft_name = draft_ours.version
        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="owner 变基"
            ),
            db=db,
            current_user=_owner_user(),
        )
        db.commit()

        assert result.status == "applied"
        assert result.new_version.draft_name == original_draft_name
        assert result.new_version.parent_version_id != "kbver_v1"
        assert result.superseded_version_id == draft_ours.id

        db.refresh(draft_ours)
        assert draft_ours.status == "archived"
        assert draft_ours.metadata_json["superseded_by"] == result.new_version.id

        rebased_event = db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_rebased",
            )
        ).one()
        assert rebased_event.team_id == "team_content"
        assert rebased_event.details_json["auto_merged_count"] >= 1
        assert rebased_event.details_json["resolved_conflict_count"] == 0

        product_event = db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.draft.rebased")
        ).one()
        assert product_event.payload_json["params"]["knowledge_base_id"] == base.id
        assert product_event.payload_json["params"]["draft_name"] == original_draft_name


# ---------------------------------------------------------------------------
# 路由：A4 resolve——缺解决方案/残留标记/正式版已变/成功落库
# ---------------------------------------------------------------------------


def _conflict_preview_context(db: Session):
    base, draft_ours, published_theirs = _build_stale_ours_draft_and_published_theirs(db)
    preview = rebase_knowledge_admin_draft(
        base.id,
        draft_ours.id,
        KnowledgeRebaseRequest(
            tenant_id="tenant_demo", team_id="team_content", change_reason="预览冲突"
        ),
        db=db,
        current_user=_admin_user(),
    )
    return base, draft_ours, published_theirs, preview


def test_resolve_route_rejects_missing_resolution_as_lineage_mismatch() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs, preview = _conflict_preview_context(db)
        assert preview.status == "conflicts"

        with pytest.raises(HTTPException) as mismatch:
            resolve_knowledge_admin_rebase(
                base.id,
                draft_ours.id,
                KnowledgeRebaseResolveRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    change_reason="缺少解决方案",
                    to_base_version_id=published_theirs.id,
                    resolutions=[],
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert mismatch.value.status_code == 409
        assert mismatch.value.detail["code"] == KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH


def test_resolve_route_rejects_leftover_conflict_markers() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs, _preview = _conflict_preview_context(db)

        with pytest.raises(HTTPException) as unresolved:
            resolve_knowledge_admin_rebase(
                base.id,
                draft_ours.id,
                KnowledgeRebaseResolveRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    change_reason="残留标记",
                    to_base_version_id=published_theirs.id,
                    resolutions=[
                        KnowledgeRebaseResolutionInput(
                            lineage_id="L_CONFLICT",
                            content_md="alpha\n<<<<<<< ours\nbeta-ours\n=======\nbeta-theirs\n>>>>>>> theirs\ngamma",
                        )
                    ],
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert unresolved.value.status_code == 409
        assert unresolved.value.detail["code"] == KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED


def test_resolve_route_rejects_when_published_version_moved_again() -> None:
    with _test_session() as db:
        base, draft_ours, _published_theirs, _preview = _conflict_preview_context(db)

        with pytest.raises(HTTPException) as conflict:
            resolve_knowledge_admin_rebase(
                base.id,
                draft_ours.id,
                KnowledgeRebaseResolveRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    change_reason="基线已过期",
                    to_base_version_id="kbver_v1",  # 早已不是当前正式版
                    resolutions=[
                        KnowledgeRebaseResolutionInput(
                            lineage_id="L_CONFLICT", content_md="alpha\nbeta-merged\ngamma"
                        )
                    ],
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == KNOWLEDGE_PUBLISH_CONFLICT


def test_resolve_route_succeeds_and_creates_new_snapshot() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs, _preview = _conflict_preview_context(db)
        previous_draft_name = draft_ours.version

        result = resolve_knowledge_admin_rebase(
            base.id,
            draft_ours.id,
            KnowledgeRebaseResolveRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="解决冲突并完成变基",
                to_base_version_id=published_theirs.id,
                resolutions=[
                    KnowledgeRebaseResolutionInput(
                        lineage_id="L_CONFLICT", content_md="alpha\nbeta-merged\ngamma"
                    )
                ],
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        assert result.status == "applied"
        new_version = result.new_version
        assert new_version.draft_name == previous_draft_name
        assert new_version.version == previous_draft_name  # 草稿名（分支名）保持不变
        assert new_version.parent_version_id == published_theirs.id
        assert new_version.publication_state == "draft"
        assert result.superseded_version_id == draft_ours.id

        db.refresh(draft_ours)
        assert draft_ours.status == "archived"
        assert draft_ours.metadata_json["superseded_by"] == new_version.id

        merged_doc = next(
            doc
            for doc in db.exec(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.knowledge_base_version_id == new_version.id
                )
            ).all()
            if (doc.metadata_json or {}).get("lineage_id") == "L_CONFLICT"
        )
        assert merged_doc.metadata_json["raw_text"] == "alpha\nbeta-merged\ngamma"

        ours_doc = next(
            doc
            for doc in db.exec(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.knowledge_base_version_id == new_version.id
                )
            ).all()
            if (doc.metadata_json or {}).get("lineage_id") == "L_OURS"
        )
        assert ours_doc.metadata_json["raw_text"] == "only1-ours\nonly2"

        rebased_event = db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_rebased",
            )
        ).one()
        assert rebased_event.details_json["resolved_conflict_count"] == 1
        assert rebased_event.details_json["auto_merged_count"] == 3  # L_OURS/L_THEIRS/L_BOTH_OK


# ---------------------------------------------------------------------------
# 发布端：基线过期校验（stale guard）与 force_overwrite + knowledge.version.published 事件
# ---------------------------------------------------------------------------


def test_publish_stale_draft_without_force_is_rejected_with_conflict_count() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_stale_ours_draft_and_published_theirs(db)

        with pytest.raises(KnowledgeError) as stale:
            SharedKnowledgeVersionService(db).publish_draft(
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                draft_version_id=draft_ours.id,
                expected_published_version_id=published_theirs.id,
                actor_type="user",
                actor_id="user_admin",
                source_team_id="team_content",
                change_reason="尝试发布过期草稿",
            )

        assert stale.value.code == KNOWLEDGE_BASELINE_STALE
        assert stale.value.details["base_version"] == "1.0.0"
        assert stale.value.details["published_version"] == published_theirs.version
        assert stale.value.details["conflict_count"] == 1  # 仅 L_CONFLICT 交叠

        db.refresh(base)
        assert base.published_version_id == published_theirs.id  # 未被覆盖


def test_publish_stale_draft_with_force_overwrite_succeeds_and_audits() -> None:
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_stale_ours_draft_and_published_theirs(db)

        published = SharedKnowledgeVersionService(db).publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft_ours.id,
            expected_published_version_id=published_theirs.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="强制覆盖发布",
            force_overwrite=True,
        )
        db.commit()
        db.refresh(base)

        assert published.publication_state == "released"
        assert base.published_version_id == published.id

        publish_event = db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "version_published",
                KnowledgeBaseAuditEvent.knowledge_base_version_id == published.id,
            )
        ).one()
        assert publish_event.details_json["forced_overwrite"] is True

        product_event = db.exec(
            select(AgentEvent).where(
                AgentEvent.event_type == "knowledge.version.published",
                AgentEvent.session_id == published.id,
            )
        ).one()
        assert product_event.payload_json["params"]["knowledge_base_id"] == base.id
        assert product_event.payload_json["params"]["version"] == published.version
        assert isinstance(product_event.payload_json["params"]["stale_draft_count"], int)


# ---------------------------------------------------------------------------
# 修复轮次 1：路由必须自行 db.commit()——`get_session` 不自动提交，`apply_rebase`
# 只 flush。之前的路由/服务层测试都在同一个长生命周期会话内自行 commit，掩盖了这个
# 问题；这里改用真实 HTTP 请求 + 独立验证会话证明写回跨请求持久化。
# ---------------------------------------------------------------------------


def _http_client_for(engine) -> TestClient:
    app = FastAPI()
    app.include_router(knowledge_admin_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def test_rebase_route_persists_across_session_boundary_via_http() -> None:
    """A3 无冲突直接落库路径：路由处理请求的会话不由测试提交，仍必须跨请求持久化。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as seed_db:
        base, draft_ours, published_theirs = _build_conflict_free_stale_draft(seed_db)
        kb_id = base.id
        draft_id = draft_ours.id
        published_theirs_id = published_theirs.id

    client = _http_client_for(engine)
    response = client.post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{kb_id}/versions/{draft_id}/rebase",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "HTTP 变基持久化验证",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "applied"
    new_version_id = body["new_version"]["id"]

    # 独立新会话读取（既不是处理请求的会话，也未由本测试提交），证明数据已跨请求持久化。
    with Session(engine) as verify_db:
        new_version = verify_db.get(KnowledgeBaseVersion, new_version_id)
        assert new_version is not None
        assert new_version.publication_state == "draft"
        assert new_version.parent_version_id == published_theirs_id

        archived_draft = verify_db.get(KnowledgeBaseVersion, draft_id)
        assert archived_draft is not None
        assert archived_draft.status == "archived"
        assert archived_draft.metadata_json["superseded_by"] == new_version_id

        audit_row = verify_db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_rebased",
            )
        ).one()
        assert audit_row.knowledge_base_version_id == new_version_id

        product_event = verify_db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.draft.rebased")
        ).one()
        assert product_event.payload_json["params"]["knowledge_base_id"] == kb_id


def test_resolve_route_persists_across_session_boundary_via_http() -> None:
    """A4 提交冲突解决路径：同样必须自行提交，写回才会跨请求持久化。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as seed_db:
        base, draft_ours, published_theirs = _build_stale_ours_draft_and_published_theirs(seed_db)
        kb_id = base.id
        draft_id = draft_ours.id
        to_base_version_id = published_theirs.id

    client = _http_client_for(engine)
    response = client.post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{kb_id}/versions/{draft_id}/rebase/resolve",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "HTTP resolve 持久化验证",
            "to_base_version_id": to_base_version_id,
            "resolutions": [{"lineage_id": "L_CONFLICT", "content_md": "alpha\nbeta-merged\ngamma"}],
        },
    )
    assert response.status_code == 200, response.text
    new_version_id = response.json()["new_version"]["id"]

    with Session(engine) as verify_db:
        new_version = verify_db.get(KnowledgeBaseVersion, new_version_id)
        assert new_version is not None
        merged_doc = next(
            doc
            for doc in verify_db.exec(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.knowledge_base_version_id == new_version_id
                )
            ).all()
            if (doc.metadata_json or {}).get("lineage_id") == "L_CONFLICT"
        )
        assert merged_doc.metadata_json["raw_text"] == "alpha\nbeta-merged\ngamma"

        archived_draft = verify_db.get(KnowledgeBaseVersion, draft_id)
        assert archived_draft is not None
        assert archived_draft.status == "archived"


# ---------------------------------------------------------------------------
# 修复轮次 1：新快照必须继承旧草稿的原始 metadata（provenance/draft_change_reason 等），
# 而不是只剩 draft_name/rebased_from。
# ---------------------------------------------------------------------------


def test_apply_rebase_preserves_original_draft_metadata_provenance() -> None:
    with _test_session() as db:
        base, draft_ours, _published_theirs = _build_conflict_free_stale_draft(db)
        original_provenance = dict(draft_ours.metadata_json.get("provenance") or {})
        original_draft_change_reason = draft_ours.metadata_json.get("draft_change_reason")
        assert original_draft_change_reason == "ours 编辑"

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基保留来源"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        assert result.status == "applied"
        assert result.new_version.metadata["provenance"] == original_provenance
        assert result.new_version.metadata["draft_change_reason"] == original_draft_change_reason
        # change_reason 列本身是这次变基自己的原因，不是继承自旧草稿。
        assert result.new_version.change_reason == "变基保留来源"


# ---------------------------------------------------------------------------
# 修复轮次 1：多步写入必须整体回滚——撞唯一约束时不留半途状态，并映射为可重试的
# KNOWLEDGE_PUBLISH_CONFLICT。
# ---------------------------------------------------------------------------


def test_apply_rebase_rolls_back_and_maps_integrity_error_to_publish_conflict() -> None:
    """预占旧草稿即将改写成的 superseded 标签，模拟并发写入撞唯一约束。

    两个并发的 `apply_rebase` 调用作用于同一个 stale 草稿时，都会为旧快照计算出
    完全相同的 `-superseded-<id 后缀>` 标签（该标签只由草稿自身 id/version 决定）；
    这里预先插入一行占用该标签，复现"写入序列中途撞约束"的场景，验证整个多步写入
    会通过 SAVEPOINT 整体回滚——旧草稿保持未改写、没有新草稿/审计半途落库——而不是
    把部分写入残留在数据库里。
    """
    with _test_session() as db:
        base, draft_ours, _published_theirs = _build_conflict_free_stale_draft(db)
        original_version = draft_ours.version
        version_count_before = len(db.exec(select(KnowledgeBaseVersion)).all())

        collision_label = f"{draft_ours.version}-superseded-{draft_ours.id.rsplit('_', 1)[-1][-8:]}"
        db.add(
            KnowledgeBaseVersion(
                id="kbver_collision",
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                version=collision_label,
                name="占位冲突行",
                publication_state="rejected",
            )
        )
        db.commit()

        with pytest.raises(HTTPException) as conflict:
            rebase_knowledge_admin_draft(
                base.id,
                draft_ours.id,
                KnowledgeRebaseRequest(
                    tenant_id="tenant_demo", team_id="team_content", change_reason="并发撞车"
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == KNOWLEDGE_PUBLISH_CONFLICT

        db.refresh(draft_ours)
        assert draft_ours.status == "active"
        assert draft_ours.publication_state == "draft"
        assert draft_ours.version == original_version  # 未被半途改写为 superseded 标签

        # 版本表只多了我们主动插入的占位行，没有半途落地的新草稿。
        assert len(db.exec(select(KnowledgeBaseVersion)).all()) == version_count_before + 1
        assert (
            db.exec(
                select(KnowledgeBaseAuditEvent).where(
                    KnowledgeBaseAuditEvent.action == "draft_rebased"
                )
            ).first()
            is None
        )

        # 撞车行清理后，正常变基仍应成功——证明会话在失败后依然可用、未被留在坏事务里。
        db.delete(db.get(KnowledgeBaseVersion, "kbver_collision"))
        db.commit()
        retry_result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="撞车解除后重试"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()
        assert retry_result.status == "applied"


# ---------------------------------------------------------------------------
# 修复轮次 C2：变基落库必须重建派生层（document_card/section_tree/buckets/chunks），
# 删除动作必须软归档并清理该版本内的派生行，而不是硬删文档留下孤儿 chunk。
# ---------------------------------------------------------------------------


def _seed_derived_assets(db: Session, *, version_id: str, lineage_id: str) -> str:
    """给某版本内的一篇文档补上 bucket/chunk（模拟真实摄取产物，克隆时会一并带入新草稿）。"""
    document = next(
        row
        for row in db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == version_id
            )
        ).all()
        if (row.metadata_json or {}).get("lineage_id") == lineage_id
    )
    bucket = KnowledgeBucket(
        tenant_id=document.tenant_id,
        knowledge_base_id=document.knowledge_base_id,
        knowledge_base_version_id=version_id,
        document_id=document.id,
        bucket_key="bucket_1",
        title="旧主题",
        summary="旧摘要",
        token_estimate=1,
        metadata_json={"content": "seeded"},
    )
    db.add(bucket)
    db.flush()
    db.add(
        KnowledgeChunk(
            tenant_id=document.tenant_id,
            knowledge_base_id=document.knowledge_base_id,
            knowledge_base_version_id=version_id,
            document_id=document.id,
            bucket_id=bucket.id,
            chunk_index=0,
            content="旧正文片段",
            summary="旧摘要",
            source_ref="seed",
        )
    )
    document.bucket_count = 1
    document.chunk_count = 1
    db.add(document)
    db.commit()
    return document.id


def _document_in_version(db: Session, *, version_id: str, lineage_id: str) -> KnowledgeDocument:
    return next(
        row
        for row in db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == version_id
            )
        ).all()
        if (row.metadata_json or {}).get("lineage_id") == lineage_id
    )


def test_rebase_update_rebuilds_document_chunks_from_merged_content() -> None:
    """自动合并的 update：新快照里的文档必须重建 chunk，内容与合并后的 raw_text 一致。"""
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_conflict_free_stale_draft(db)
        _seed_derived_assets(db, version_id=published_theirs.id, lineage_id="L_OURS")

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基并重建派生层"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()
        new_version_id = result.new_version.id

        merged = _document_in_version(db, version_id=new_version_id, lineage_id="L_OURS")
        assert (merged.metadata_json or {})["raw_text"] == "only1-ours\nonly2"
        assert merged.chunk_count > 0
        assert merged.bucket_count > 0
        assert (merged.metadata_json or {}).get("document_card"), "必须重建 document_card"
        assert (merged.metadata_json or {}).get("section_tree") is not None

        chunks = db.exec(
            select(KnowledgeChunk).where(KnowledgeChunk.document_id == merged.id)
        ).all()
        assert chunks, "合并后的文档必须有 chunk，否则检索侧看不到这次修改"
        assert any("only1-ours" in chunk.content for chunk in chunks)
        assert all(chunk.knowledge_base_version_id == new_version_id for chunk in chunks)
        assert all("旧正文片段" != chunk.content for chunk in chunks), "旧 chunk 必须被替换"


def test_rebase_add_creates_document_with_chunks() -> None:
    """ours 新增文档：变基后新建的行必须带 bucket/chunk，否则检索侧完全看不到它。"""
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)
        _add_document(
            db,
            version_id=draft_ours.id,
            lineage_id="L_NEW",
            filename="new.md",
            lines=["新增第一行", "新增第二行"],
        )
        db.commit()

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基并新增文档"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        created = _document_in_version(db, version_id=result.new_version.id, lineage_id="L_NEW")
        assert created.status == "ready"
        assert created.chunk_count > 0
        assert created.bucket_count > 0
        chunks = db.exec(
            select(KnowledgeChunk).where(KnowledgeChunk.document_id == created.id)
        ).all()
        assert any("新增第一行" in chunk.content for chunk in chunks)


def test_rebase_delete_archives_document_and_purges_its_derived_rows() -> None:
    """ours 删除文档：新快照里该行必须是归档态，且该版本内不再有它的 bucket/chunk。"""
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_conflict_free_stale_draft(db)
        _seed_derived_assets(db, version_id=published_theirs.id, lineage_id="L_SAME")
        # ours 在自己的草稿里删除 L_SAME（软删除 = status='archived'）。
        ours_same = _document_in_version(db, version_id=draft_ours.id, lineage_id="L_SAME")
        ours_same.status = "archived"
        db.add(ours_same)
        db.commit()

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基并保留删除"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()
        new_version_id = result.new_version.id

        deleted = _document_in_version(db, version_id=new_version_id, lineage_id="L_SAME")
        assert deleted.status == "archived", "删除是软删除，行必须保留"
        assert deleted.chunk_count == 0
        assert deleted.bucket_count == 0
        assert (
            db.exec(
                select(KnowledgeChunk).where(KnowledgeChunk.document_id == deleted.id)
            ).all()
            == []
        ), "已删除文档不得在该版本内继续被检索到"
        assert (
            db.exec(
                select(KnowledgeBucket).where(KnowledgeBucket.document_id == deleted.id)
            ).all()
            == []
        )
        # 正式版内的原始派生行不受影响（只清理克隆到新草稿里的那份）。
        published_doc = _document_in_version(
            db, version_id=published_theirs.id, lineage_id="L_SAME"
        )
        assert db.exec(
            select(KnowledgeChunk).where(KnowledgeChunk.document_id == published_doc.id)
        ).all()


# ---------------------------------------------------------------------------
# 修复轮次 C1/T024：`_classify_lineage` 的 add/add 与 edit/delete 分支单测
# ---------------------------------------------------------------------------


def test_merge_document_sets_add_add_same_content_is_noop() -> None:
    """base 无、双方各自新增且内容相同：视为已合并，无需再写（克隆已带入 theirs 的行）。"""
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]

    auto_merged, conflicts = merge_document_sets([], ours, theirs)

    assert conflicts == []
    assert len(auto_merged) == 1
    assert auto_merged[0].source == "merged"
    assert auto_merged[0].action == "noop"


def test_merge_document_sets_add_add_different_content_conflicts() -> None:
    """base 无、双方各自新增且内容不同：整篇冲突，`action='add'`，base_lines 为空。"""
    ours = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="Ours", lines=["ours"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="Theirs", lines=["theirs"])]

    auto_merged, conflicts = merge_document_sets([], ours, theirs)

    assert auto_merged == []
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.action == "add"
    assert conflict.title == "Ours"
    assert len(conflict.blocks) == 1
    assert conflict.blocks[0].base_lines == []
    assert conflict.blocks[0].ours_lines == ["ours"]
    assert conflict.blocks[0].theirs_lines == ["theirs"]


def test_merge_document_sets_ours_deleted_theirs_unchanged_is_auto_delete() -> None:
    """ours 删除、theirs 未动：自动采纳删除（`action='delete'`）。"""
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]

    auto_merged, conflicts = merge_document_sets(base, [], theirs)

    assert conflicts == []
    assert len(auto_merged) == 1
    assert auto_merged[0].source == "ours"
    assert auto_merged[0].action == "delete"


def test_merge_document_sets_ours_deleted_theirs_edited_is_conflict() -> None:
    """ours 删除、theirs 修改：delete/edit 冲突，需人工裁决（`ours_lines` 为空表示删除）。"""
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x-theirs"])]

    auto_merged, conflicts = merge_document_sets(base, [], theirs)

    assert auto_merged == []
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.action == "update"
    assert conflict.blocks[0].ours_lines == []
    assert conflict.blocks[0].theirs_lines == ["x-theirs"]
    assert conflict.blocks[0].base_lines == ["x"]


def test_merge_document_sets_archived_ours_row_is_treated_as_deleted() -> None:
    """`_load_version_documents` 已过滤归档行，因此软删除在合并期表现为 ours 缺席。"""
    base = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x"])]
    theirs = [DocumentSnapshot(lineage_id="L1", filename="a.md", title="A", lines=["x-theirs"])]

    _auto_merged, conflicts = merge_document_sets(base, [], theirs)

    assert [conflict.lineage_id for conflict in conflicts] == ["L1"]


# ---------------------------------------------------------------------------
# 修复轮次 I1：被替换（superseded）的草稿快照不可再写、不可再发布、不可再变基
# ---------------------------------------------------------------------------


def test_repeated_rebase_on_superseded_draft_is_rejected_and_creates_no_second_draft() -> None:
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)

        first = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="首次变基"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()
        assert first.status == "applied"
        version_count_after_first = len(db.exec(select(KnowledgeBaseVersion)).all())

        with pytest.raises(HTTPException) as repeated:
            rebase_knowledge_admin_draft(
                base.id,
                draft_ours.id,  # 同一个（已被替换的）版本 id：双击/重试
                KnowledgeRebaseRequest(
                    tenant_id="tenant_demo", team_id="team_content", change_reason="重复变基"
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert repeated.value.status_code == 409
        assert repeated.value.detail["code"] == KNOWLEDGE_VERSION_NOT_READY
        assert len(db.exec(select(KnowledgeBaseVersion)).all()) == version_count_after_first


def test_superseded_draft_is_not_writable() -> None:
    """`require_writable_draft` 必须拒绝被替换的快照，否则过期页签仍能写入已作废的草稿。"""
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)
        rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        with pytest.raises(KnowledgeError) as rejected:
            SharedKnowledgeVersionService(db).require_writable_draft(
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                version_id=draft_ours.id,
            )
        assert rejected.value.code == KNOWLEDGE_MODE_INVALID


def test_rebase_expected_updated_at_mismatch_is_publish_conflict() -> None:
    """A3 可选乐观锁：`expected_updated_at` 与草稿当前值不符时拒绝，且不落库。"""
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)
        version_count_before = len(db.exec(select(KnowledgeBaseVersion)).all())

        with pytest.raises(HTTPException) as conflict:
            rebase_knowledge_admin_draft(
                base.id,
                draft_ours.id,
                KnowledgeRebaseRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    change_reason="并发写入后重试",
                    expected_updated_at="2020-01-01T00:00:00",
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == KNOWLEDGE_PUBLISH_CONFLICT
        assert len(db.exec(select(KnowledgeBaseVersion)).all()) == version_count_before


def test_rebase_expected_updated_at_match_is_accepted() -> None:
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="带乐观锁的变基",
                expected_updated_at=draft_ours.updated_at.isoformat(),
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()
        assert result.status == "applied"


def test_rebased_snapshot_drops_stale_review_block() -> None:
    """A5 的 `review` 统计属于旧快照，克隆到新草稿会显示过期的暂存/待处理数。"""
    with _test_session() as db:
        base, draft_ours, _published = _build_conflict_free_stale_draft(db)
        draft_ours.metadata_json = {
            **dict(draft_ours.metadata_json or {}),
            "review": {"staged": 4, "pending": 2, "reviewed_at": "2026-01-01T00:00:00"},
        }
        db.add(draft_ours)
        db.commit()

        result = rebase_knowledge_admin_draft(
            base.id,
            draft_ours.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo", team_id="team_content", change_reason="变基"
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        new_version = db.get(KnowledgeBaseVersion, result.new_version.id)
        assert "review" not in (new_version.metadata_json or {})
        # 其余来源信息（provenance/draft_name）仍然继承。
        assert (new_version.metadata_json or {}).get("draft_name")


def test_publish_stale_draft_without_parent_reports_string_base_version() -> None:
    """`KNOWLEDGE_BASELINE_STALE` 的 `base_version` 已注册为 string，不能回传 null。"""
    with _test_session() as db:
        base, draft_ours, published_theirs = _build_conflict_free_stale_draft(db)
        draft_ours.parent_version_id = None  # 无基线的历史草稿
        db.add(draft_ours)
        db.commit()

        with pytest.raises(KnowledgeError) as stale:
            SharedKnowledgeVersionService(db).publish_draft(
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                draft_version_id=draft_ours.id,
                expected_published_version_id=published_theirs.id,
                actor_type="user",
                actor_id="user_admin",
                source_team_id="team_content",
                change_reason="尝试发布无基线草稿",
            )

        assert stale.value.code == KNOWLEDGE_BASELINE_STALE
        assert isinstance(stale.value.details["base_version"], str)
        assert stale.value.details["base_version"]

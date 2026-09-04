"""T024：草稿变基（A3/A4）三方合并纯函数与路由测试，覆盖 data-model §5 与契约 A3/A4/B1。

纯函数用例（不接触 DB）覆盖 `merge_document_sets` 的三种分类：仅 ours 变/仅 theirs 变/
双方不交叠自动合并/双方交叠产出冲突。DB + 路由用例覆盖完整变基生命周期：无冲突直接
落库、有冲突两步解决（resolve 缺失解决方案/残留冲突标记/正式版已变）、非 stale 草稿
拒绝、团队 owner 与非 owner 鉴权，以及发布端的基线过期校验（stale guard）与
`force_overwrite`、`knowledge.draft.rebased`/`knowledge.version.published` 事件。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select
from test_teams_api import _test_session

from app.api.knowledge_admin import (
    rebase_knowledge_admin_draft,
    resolve_knowledge_admin_rebase,
)
from app.db.models import (
    AgentEvent,
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
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

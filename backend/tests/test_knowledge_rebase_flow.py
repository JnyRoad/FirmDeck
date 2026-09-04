"""T057：变基端到端流程（HTTP 路由级），覆盖 US3 Independent Test 的完整链路。

草稿 A、B 都基于 v1.0.0；A 只改文档甲并先发布（→ v1.0.1）；B 改文档甲和乙，此时发布
被拒（`KNOWLEDGE_BASELINE_STALE`，`conflict_count == 1`，仅甲交叠）；对 B 调用变基预览
（A3）得到甲冲突、乙自动合并；解决甲的冲突并调用 resolve（A4）完成变基（草稿名不变、
基线更新为 v1.0.1）；再次发布该草稿成功获得 v1.0.2，正式版内容同时包含 A 对甲的改动与
B 保留的改动；全链路审计（`draft_created` x2、`version_published` x2、`draft_rebased`）
与 `knowledge.version.published` 事件完整。

本文件与 `test_knowledge_rebase.py` 的分工：后者逐个覆盖变基/发布各步骤的边界与鉴权
（非 stale 拒绝、残留冲突标记、to_base 又变化、team owner 与非 owner 等），偏单元/集成
颗粒度；本文件只跑一条完整链路，验证各步骤真实串联时的最终产物（发布后的版本号与正式版
文档内容、完整审计链），不重复覆盖前者已验证的边界分支。
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
from app.api.knowledge_bases import (
    create_shared_knowledge_draft,
    publish_shared_knowledge_version,
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
from app.knowledge.errors import KNOWLEDGE_BASELINE_STALE
from app.knowledge.schema import (
    KnowledgeRebaseRequest,
    KnowledgeRebaseResolutionInput,
    KnowledgeRebaseResolveRequest,
    SharedKnowledgeDraftCreateRequest,
    SharedKnowledgePublishRequest,
)


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _seed_base(db: Session) -> tuple[KnowledgeBase, KnowledgeBaseVersion]:
    """v1.0.0（已发布）含文档甲、乙，绑定一个团队。"""
    db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
    v1 = KnowledgeBaseVersion(
        id="kbver_v1",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_rebase_flow",
        version="1.0.0",
        name="共享知识库",
        publication_state="released",
    )
    base = KnowledgeBase(
        id="kb_rebase_flow",
        tenant_id="tenant_demo",
        name="共享知识库",
        mode="shared",
        status="active",
        published_version_id=v1.id,
    )
    db.add(base)
    db.add(v1)
    db.add(
        KnowledgeDocument(
            id="kdoc_v1_jia",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            knowledge_base_version_id=v1.id,
            filename="jia.md",
            file_type="md",
            title="文档甲",
            status="ready",
            metadata_json={"lineage_id": "L_JIA", "raw_text": "原文第一行\n原文第二行"},
        )
    )
    db.add(
        KnowledgeDocument(
            id="kdoc_v1_yi",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            knowledge_base_version_id=v1.id,
            filename="yi.md",
            file_type="md",
            title="文档乙",
            status="ready",
            metadata_json={"lineage_id": "L_YI", "raw_text": "乙原文"},
        )
    )
    db.add(Team(id="team_content", tenant_id="tenant_demo", name="内容团队", owner_user_id="user_admin"))
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


def _set_document_text(db: Session, *, version_id: str, lineage_id: str, text: str) -> None:
    rows = db.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == "tenant_demo",
            KnowledgeDocument.knowledge_base_version_id == version_id,
        )
    ).all()
    target = next(doc for doc in rows if (doc.metadata_json or {}).get("lineage_id") == lineage_id)
    metadata = dict(target.metadata_json or {})
    metadata["raw_text"] = text
    target.metadata_json = metadata
    db.add(target)


def _document_text(db: Session, *, version_id: str, lineage_id: str) -> str:
    rows = db.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == "tenant_demo",
            KnowledgeDocument.knowledge_base_version_id == version_id,
        )
    ).all()
    target = next(doc for doc in rows if (doc.metadata_json or {}).get("lineage_id") == lineage_id)
    return (target.metadata_json or {}).get("raw_text", "")


def test_two_drafts_concurrent_edit_rebase_resolve_and_publish_end_to_end() -> None:
    with _test_session() as db:
        admin = _admin_user()
        base, v1 = _seed_base(db)

        # 草稿 A、B 都基于 v1.0.0。
        draft_a = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="A 分支：改甲",
                expected_published_version_id=v1.id,
            ),
            db=db,
            current_user=admin,
        )
        draft_b = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="B 分支：改甲、乙",
                expected_published_version_id=v1.id,
            ),
            db=db,
            current_user=admin,
        )
        db.commit()
        draft_b_original_name = draft_b.version

        # A 只改文档甲。
        _set_document_text(
            db, version_id=draft_a.id, lineage_id="L_JIA", text="原文第一行-A改\n原文第二行"
        )
        db.commit()

        # A 先发布 → v1.0.1。
        published_a = publish_shared_knowledge_version(
            base.id,
            draft_a.id,
            SharedKnowledgePublishRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                expected_published_version_id=v1.id,
                change_reason="发布 A 分支",
            ),
            db=db,
            current_user=admin,
        )
        db.commit()
        assert published_a.version == "1.0.1"

        # B 改文档甲（与 A 交叠同一行）和乙（B 独占）。
        _set_document_text(
            db, version_id=draft_b.id, lineage_id="L_JIA", text="原文第一行-B改\n原文第二行"
        )
        _set_document_text(db, version_id=draft_b.id, lineage_id="L_YI", text="乙原文-B改")
        db.commit()

        # 此时 B 的基线（v1.0.0）已落后于正式版（v1.0.1）：发布应被拒绝并提示需要变基。
        # 路由函数把领域 `KnowledgeError` 映射为 `HTTPException`（`detail` = 公开错误载荷），
        # 这里在路由这一层断言，而不是绕过路由直接调用 service（那是
        # `test_knowledge_rebase.py` 已覆盖的写法）。
        with pytest.raises(HTTPException) as stale_exc:
            publish_shared_knowledge_version(
                base.id,
                draft_b.id,
                SharedKnowledgePublishRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    expected_published_version_id=published_a.id,
                    change_reason="尝试直接发布 B 分支",
                ),
                db=db,
                current_user=admin,
            )
        assert stale_exc.value.status_code == 409
        detail = stale_exc.value.detail
        assert detail["code"] == KNOWLEDGE_BASELINE_STALE
        assert detail["params"]["base_version"] == "1.0.0"
        assert detail["params"]["published_version"] == "1.0.1"
        assert detail["params"]["conflict_count"] == 1  # 仅甲交叠，乙可自动合并
        db.rollback()

        # A3：变基预览——甲冲突、乙可自动合并；不落库。
        preview = rebase_knowledge_admin_draft(
            base.id,
            draft_b.id,
            KnowledgeRebaseRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="B 变基到 v1.0.1",
            ),
            db=db,
            current_user=admin,
        )
        assert hasattr(preview, "conflicts"), "无冲突时不应直接返回落库结果"
        assert [item.lineage_id for item in preview.conflicts] == ["L_JIA"]
        assert [item.lineage_id for item in preview.auto_merged] == ["L_YI"]
        assert preview.to_base_version_id == published_a.id

        # A4：解决甲的冲突（保留双方改动），完成变基。
        rebase_result = resolve_knowledge_admin_rebase(
            base.id,
            draft_b.id,
            KnowledgeRebaseResolveRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="解决甲冲突并完成变基",
                to_base_version_id=preview.to_base_version_id,
                resolutions=[
                    KnowledgeRebaseResolutionInput(
                        lineage_id="L_JIA",
                        content_md="原文第一行-A改-B改\n原文第二行",
                    )
                ],
            ),
            db=db,
            current_user=admin,
        )
        db.commit()

        rebased_draft = rebase_result.new_version
        assert rebased_draft.draft_name == draft_b_original_name  # 草稿名保留
        assert rebased_draft.parent_version_id == published_a.id  # 基线更新
        assert rebased_draft.publication_state == "draft"
        assert rebase_result.superseded_version_id == draft_b.id

        # 变基后立即发布不应再被 stale 拒绝，并获得下一个版本号 v1.0.2。
        published_b = publish_shared_knowledge_version(
            base.id,
            rebased_draft.id,
            SharedKnowledgePublishRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                expected_published_version_id=published_a.id,
                change_reason="发布变基后的 B 分支",
            ),
            db=db,
            current_user=admin,
        )
        db.commit()
        assert published_b.version == "1.0.2"

        # 正式版内容：甲同时含 A、B 的改动；乙为 B 保留的改动。
        assert _document_text(db, version_id=published_b.id, lineage_id="L_JIA") == (
            "原文第一行-A改-B改\n原文第二行"
        )
        assert _document_text(db, version_id=published_b.id, lineage_id="L_YI") == "乙原文-B改"

        # 审计链完整：两次草稿创建、两次发布、一次变基，且每条都挂在正确的版本上
        # （不依赖时间戳/id 排序——同一事务内多条记录的 created_at 可能相同，用
        # 「事件与目标版本 id 的对应关系」而不是「时间先后」来证明链路完整更稳健）。
        audit_events = db.exec(
            select(KnowledgeBaseAuditEvent).where(KnowledgeBaseAuditEvent.knowledge_base_id == base.id)
        ).all()
        actions = [row.action for row in audit_events]
        assert actions.count("draft_created") == 2
        assert actions.count("version_published") == 2
        assert actions.count("draft_rebased") == 1

        events_by_version: dict[str, list[str]] = {}
        for row in audit_events:
            events_by_version.setdefault(row.knowledge_base_version_id, []).append(row.action)
        # 发布是原地状态迁移（同一行 draft -> released），所以 published_a.id ==
        # draft_a.id、published_b.id == rebased_draft.id；每个版本 id 上应能看到它
        # 依次经历的全部事件。
        assert published_a.id == draft_a.id
        assert published_b.id == rebased_draft.id
        assert events_by_version[draft_a.id] == ["draft_created", "version_published"]
        assert events_by_version[draft_b.id] == ["draft_created"]  # B 的原始草稿被变基替换，未被直接发布
        assert events_by_version[rebased_draft.id] == ["draft_rebased", "version_published"]

        published_events = db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.version.published")
        ).all()
        assert {event.payload_json["params"]["version"] for event in published_events} == {
            "1.0.1",
            "1.0.2",
        }

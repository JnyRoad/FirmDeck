"""T018/T019：租户管理员在无团队上下文下治理共享知识库的旁路行为。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select
from test_teams_api import _test_session

from app.api.knowledge import _shared_writable_asset_version, update_document
from app.api.knowledge_bases import (
    create_shared_knowledge_draft,
    publish_shared_knowledge_version,
    reject_shared_knowledge_version,
    rollback_knowledge_base,
)
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.schema import (
    KnowledgeDocumentUpdateRequest,
    SharedKnowledgeDraftCreateRequest,
    SharedKnowledgePublishRequest,
    SharedKnowledgeRejectRequest,
    SharedKnowledgeRollbackRequest,
)


def _seed_unbound_shared_base(db: Session) -> tuple[KnowledgeBase, KnowledgeBaseVersion]:
    """创建一个没有任何团队绑定的共享知识库正式快照。"""
    db.add(Tenant(id="tenant_demo", name="Demo"))
    released = KnowledgeBaseVersion(
        id="kbver_shared_100",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_shared",
        version="1.0.0",
        name="未绑定共享库",
        publication_state="released",
    )
    base = KnowledgeBase(
        id="kb_shared",
        tenant_id="tenant_demo",
        name="未绑定共享库",
        mode="shared",
        published_version_id=released.id,
    )
    db.add(base)
    db.add(released)
    db.commit()
    return base, released


def _bind_team(db: Session, base: KnowledgeBase) -> Team:
    """为回归对照绑定一个由普通用户拥有的团队。"""
    team = Team(
        id="team_content",
        tenant_id=base.tenant_id,
        name="内容团队",
        owner_user_id="user_owner",
    )
    db.add(team)
    db.add(
        TeamKnowledgeBaseBinding(
            id="teamkb_content",
            tenant_id=base.tenant_id,
            team_id=team.id,
            knowledge_base_id=base.id,
            created_by_user_id="user_admin",
        )
    )
    db.commit()
    return team


def _admin_user() -> User:
    return User(
        id="user_admin",
        tenant_id="tenant_demo",
        username="admin",
        role="admin",
        password_hash="test",
    )


def _member_user() -> User:
    """未拥有任何团队、也未持有任何绑定的普通员工。"""
    return User(
        id="user_member",
        tenant_id="tenant_demo",
        username="member",
        role="member",
        password_hash="test",
    )


def _owner_user() -> User:
    return User(
        id="user_owner",
        tenant_id="tenant_demo",
        username="owner",
        role="member",
        password_hash="test",
    )


def _audit_event(db: Session, action: str, version_id: str) -> KnowledgeBaseAuditEvent:
    return db.exec(
        select(KnowledgeBaseAuditEvent).where(
            KnowledgeBaseAuditEvent.action == action,
            KnowledgeBaseAuditEvent.knowledge_base_version_id == version_id,
        )
    ).one()


def test_admin_without_team_id_can_create_draft_on_unbound_shared_base() -> None:
    """租户管理员不带 team_id 也能为未绑定共享库创建草稿，且审计标注 tenant_admin。"""
    with _test_session() as db:
        base, released = _seed_unbound_shared_base(db)

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id=None,
                change_reason="管理员直接维护未绑定共享库",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=_admin_user(),
        )

        assert draft.publication_state == "draft"
        assert draft.source_team_id is None

        event = _audit_event(db, "draft_created", draft.id)
        assert event.team_id is None
        assert event.details_json["actor_context"] == "tenant_admin"


def test_non_admin_without_team_id_is_denied_grant_required() -> None:
    """非管理员不带 team_id 必须被拒绝，且映射为 KNOWLEDGE_GRANT_REQUIRED。"""
    with _test_session() as db:
        base, released = _seed_unbound_shared_base(db)

        with pytest.raises(HTTPException) as denied:
            create_shared_knowledge_draft(
                base.id,
                SharedKnowledgeDraftCreateRequest(
                    tenant_id="tenant_demo",
                    team_id=None,
                    change_reason="普通员工尝试越权",
                    expected_published_version_id=released.id,
                ),
                db=db,
                current_user=_member_user(),
            )

        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "KNOWLEDGE_GRANT_REQUIRED"
        assert (
            db.exec(
                select(KnowledgeBaseVersion).where(
                    KnowledgeBaseVersion.publication_state == "draft"
                )
            ).first()
            is None
        )


def test_admin_without_team_id_can_publish_reject_and_rollback_unbound_shared_base() -> None:
    """管理员旁路覆盖 drafts/publish/reject/rollback 全生命周期，审计全程 team_id=None。"""
    with _test_session() as db:
        base, original = _seed_unbound_shared_base(db)
        admin = _admin_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id=None,
                change_reason="准备第二版",
                expected_published_version_id=original.id,
            ),
            db=db,
            current_user=admin,
        )

        published = publish_shared_knowledge_version(
            base.id,
            draft.id,
            SharedKnowledgePublishRequest(
                tenant_id="tenant_demo",
                team_id=None,
                expected_published_version_id=original.id,
                change_reason="发布第二版",
            ),
            db=db,
            current_user=admin,
        )
        assert published.publication_state == "released"
        publish_event = _audit_event(db, "version_published", published.id)
        assert publish_event.team_id is None
        assert publish_event.details_json["actor_context"] == "tenant_admin"

        rejected_draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id=None,
                change_reason="未完成第三版",
                expected_published_version_id=published.id,
            ),
            db=db,
            current_user=admin,
        )
        rejected = reject_shared_knowledge_version(
            base.id,
            rejected_draft.id,
            SharedKnowledgeRejectRequest(
                tenant_id="tenant_demo",
                team_id=None,
                change_reason="暂不采用",
            ),
            db=db,
            current_user=admin,
        )
        assert rejected.publication_state == "rejected"
        reject_event = _audit_event(db, "draft_rejected", rejected.id)
        assert reject_event.team_id is None
        assert reject_event.details_json["actor_context"] == "tenant_admin"

        rolled_back = rollback_knowledge_base(
            base.id,
            SharedKnowledgeRollbackRequest(
                tenant_id="tenant_demo",
                team_id=None,
                target_version_id=original.id,
                expected_published_version_id=published.id,
                change_reason="恢复初始版本",
            ),
            db=db,
            current_user=admin,
        )
        assert rolled_back["target_version_id"] == original.id
        rollback_event = _audit_event(db, "version_rolled_back", original.id)
        assert rollback_event.team_id is None
        assert rollback_event.details_json["actor_context"] == "tenant_admin"


def test_team_path_still_records_actor_context_team() -> None:
    """回归：携带真实 team_id 的既有团队路径行为不变，审计标注 team。"""
    with _test_session() as db:
        base, original = _seed_unbound_shared_base(db)
        _bind_team(db, base)
        owner = _owner_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="团队路径草稿",
                expected_published_version_id=original.id,
            ),
            db=db,
            current_user=owner,
        )
        assert draft.source_team_id == "team_content"
        event = _audit_event(db, "draft_created", draft.id)
        assert event.team_id == "team_content"
        assert event.details_json["actor_context"] == "team"


def test_admin_without_team_id_can_write_shared_draft_document() -> None:
    """管理员无 team_id 时仍可对自己创建的草稿版本上传/更新文档。"""
    with _test_session() as db:
        base, original = _seed_unbound_shared_base(db)
        admin = _admin_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id=None,
                change_reason="管理员准备补充资料",
                expected_published_version_id=original.id,
            ),
            db=db,
            current_user=admin,
        )

        writable = _shared_writable_asset_version(
            db,
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version_id=draft.id,
            current_user=admin,
        )
        assert writable is not None
        assert writable.id == draft.id

        with pytest.raises(HTTPException) as denied:
            _shared_writable_asset_version(
                db,
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                version_id=draft.id,
                current_user=_member_user(),
            )
        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "KNOWLEDGE_GRANT_REQUIRED"

        document = KnowledgeDocument(
            id="kdoc_admin_draft",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            knowledge_base_version_id=draft.id,
            filename="备注.md",
            file_type="md",
            title="备注",
            status="ready",
            metadata_json={"source": "manual"},
        )
        db.add(document)
        db.commit()

        updated = update_document(
            document.id,
            KnowledgeDocumentUpdateRequest(
                tenant_id="tenant_demo",
                title="管理员更新的标题",
            ),
            db=db,
            current_user=admin,
            agent_id=None,
        )
        assert updated.title == "管理员更新的标题"

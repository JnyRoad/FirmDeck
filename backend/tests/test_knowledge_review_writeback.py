"""T026：草稿审阅状态写回（A5）路由测试，覆盖 data-model 与契约 A5。

覆盖：写入 `metadata.review` 全部字段（staged/pending/documents_adjusted/reviewed_at/
reviewed_by_user_id）；`expected_updated_at` 不匹配 → `KNOWLEDGE_PUBLISH_CONFLICT`
（含对 `Z` 后缀的容忍解析）；非草稿版本 → `KNOWLEDGE_VERSION_NOT_READY`；admin 与团队
manager 两条鉴权路径均可写入，非 owner 非 admin 拒绝；审计 `draft_reviewed` 与事件
`knowledge.draft.reviewed` 均落库；响应为 `KnowledgeBaseVersionRead` 且可见 `metadata.review`。
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from test_teams_api import _test_session

from app.api.knowledge_admin import review_knowledge_admin_draft
from app.api.knowledge_admin import router as knowledge_admin_router
from app.db import get_session
from app.db.models import (
    AgentEvent,
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.errors import (
    KNOWLEDGE_GRANT_REQUIRED,
    KNOWLEDGE_PUBLISH_CONFLICT,
    KNOWLEDGE_VERSION_NOT_READY,
)
from app.knowledge.schema import KnowledgeDraftReviewRequest
from app.knowledge.versioning import SharedKnowledgeVersionService
from app.security.auth import get_current_user


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


def _seed_review_fixture(db: Session) -> tuple[KnowledgeBase, KnowledgeBaseVersion]:
    """v1(released) 绑定 team_content，供 admin/team manager 两条鉴权路径共用。"""
    db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
    v1 = KnowledgeBaseVersion(
        id="kbver_v1",
        tenant_id="tenant_demo",
        knowledge_base_id="kb_shared_review",
        version="1.0.0",
        name="共享知识库",
        publication_state="released",
    )
    base = KnowledgeBase(
        id="kb_shared_review",
        tenant_id="tenant_demo",
        name="共享知识库",
        mode="shared",
        status="active",
        published_version_id=v1.id,
    )
    db.add(base)
    db.add(v1)
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
    draft = SharedKnowledgeVersionService(db).create_draft(
        tenant_id="tenant_demo",
        knowledge_base_id="kb_shared_review",
        source_team_id="team_content",
        actor_type="user",
        actor_id="user_admin",
        change_reason=reason,
        expected_published_version_id=expected_published_version_id,
    )
    db.commit()
    db.refresh(draft)
    return draft


# ---------------------------------------------------------------------------
# 成功路径：admin 写入 metadata.review 全部字段，审计与事件均落库
# ---------------------------------------------------------------------------


def test_review_route_admin_writes_metadata_review_with_audit_and_event() -> None:
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)
        draft = _create_draft(db, expected_published_version_id=v1.id, reason="待审阅草稿")

        response = review_knowledge_admin_draft(
            base.id,
            draft.id,
            KnowledgeDraftReviewRequest(
                tenant_id="tenant_demo",
                staged=4,
                pending=0,
                documents_adjusted=2,
                expected_updated_at=draft.updated_at.isoformat(),
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        assert response.id == draft.id
        review = response.metadata["review"]
        assert review["staged"] == 4
        assert review["pending"] == 0
        assert review["documents_adjusted"] == 2
        assert review["reviewed_by_user_id"] == "user_admin"
        assert isinstance(review["reviewed_at"], str) and review["reviewed_at"]

        db.refresh(draft)
        assert draft.metadata_json["review"]["staged"] == 4
        assert draft.metadata_json["review"]["pending"] == 0
        assert draft.metadata_json["review"]["documents_adjusted"] == 2

        audit_row = db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_reviewed",
            )
        ).one()
        assert audit_row.knowledge_base_version_id == draft.id
        assert audit_row.details_json["staged"] == 4
        assert audit_row.details_json["pending"] == 0
        assert audit_row.details_json["documents_adjusted"] == 2

        product_event = db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.draft.reviewed")
        ).one()
        params = product_event.payload_json["params"]
        assert params["knowledge_base_id"] == base.id
        assert params["draft_name"] == draft.version
        assert params["staged"] == 4
        assert params["pending"] == 0


def test_review_route_tolerates_z_suffix_in_expected_updated_at() -> None:
    """`expected_updated_at` 允许带 `Z` 后缀，仍需与 naive UTC `updated_at` 判为相等。"""
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)
        draft = _create_draft(db, expected_published_version_id=v1.id, reason="待审阅草稿")

        response = review_knowledge_admin_draft(
            base.id,
            draft.id,
            KnowledgeDraftReviewRequest(
                tenant_id="tenant_demo",
                staged=1,
                pending=1,
                documents_adjusted=1,
                expected_updated_at=draft.updated_at.isoformat() + "Z",
            ),
            db=db,
            current_user=_admin_user(),
        )
        db.commit()

        assert response.metadata["review"]["staged"] == 1


# ---------------------------------------------------------------------------
# 失败路径：expected_updated_at 不匹配 → PUBLISH_CONFLICT；非草稿 → VERSION_NOT_READY
# ---------------------------------------------------------------------------


def test_review_route_rejects_stale_expected_updated_at() -> None:
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)
        draft = _create_draft(db, expected_published_version_id=v1.id, reason="待审阅草稿")
        stale_timestamp = (draft.updated_at + timedelta(seconds=30)).isoformat()

        with pytest.raises(HTTPException) as conflict:
            review_knowledge_admin_draft(
                base.id,
                draft.id,
                KnowledgeDraftReviewRequest(
                    tenant_id="tenant_demo",
                    staged=1,
                    pending=0,
                    documents_adjusted=1,
                    expected_updated_at=stale_timestamp,
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == KNOWLEDGE_PUBLISH_CONFLICT

        # 冲突时不写入：草稿 metadata 未被污染。
        db.refresh(draft)
        assert "review" not in (draft.metadata_json or {})


def test_review_route_rejects_non_draft_version() -> None:
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)

        with pytest.raises(HTTPException) as not_ready:
            review_knowledge_admin_draft(
                base.id,
                v1.id,
                KnowledgeDraftReviewRequest(
                    tenant_id="tenant_demo",
                    staged=1,
                    pending=0,
                    documents_adjusted=1,
                    expected_updated_at=v1.updated_at.isoformat(),
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert not_ready.value.status_code == 409
        assert not_ready.value.detail["code"] == KNOWLEDGE_VERSION_NOT_READY


# ---------------------------------------------------------------------------
# 鉴权：admin 与团队 manager 均可写入；非 owner 非 admin 拒绝
# ---------------------------------------------------------------------------


def test_review_route_team_owner_succeeds_and_non_owner_is_denied() -> None:
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)
        draft = _create_draft(db, expected_published_version_id=v1.id, reason="待审阅草稿")

        with pytest.raises(HTTPException) as denied:
            review_knowledge_admin_draft(
                base.id,
                draft.id,
                KnowledgeDraftReviewRequest(
                    tenant_id="tenant_demo",
                    team_id="team_content",
                    staged=2,
                    pending=0,
                    documents_adjusted=1,
                    expected_updated_at=draft.updated_at.isoformat(),
                ),
                db=db,
                current_user=_member_user(),
            )
        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == KNOWLEDGE_GRANT_REQUIRED

        response = review_knowledge_admin_draft(
            base.id,
            draft.id,
            KnowledgeDraftReviewRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                staged=3,
                pending=1,
                documents_adjusted=2,
                expected_updated_at=draft.updated_at.isoformat(),
            ),
            db=db,
            current_user=_owner_user(),
        )
        db.commit()

        assert response.metadata["review"]["staged"] == 3
        assert response.metadata["review"]["reviewed_by_user_id"] == "user_owner"

        audit_row = db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_reviewed",
            )
        ).one()
        assert audit_row.team_id == "team_content"


# ---------------------------------------------------------------------------
# 持久化：路由必须自行 db.commit()——`get_session` 不自动提交，只 flush 的写入会在
# 请求结束、会话关闭时被丢弃。这里用真实 HTTP 请求 + 独立验证会话证明写回跨请求持久化，
# 测试本身不对处理请求的会话调用 commit。
# ---------------------------------------------------------------------------


def test_review_route_persists_across_session_boundary_via_http() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as seed_db:
        base, v1 = _seed_review_fixture(seed_db)
        draft = _create_draft(seed_db, expected_published_version_id=v1.id, reason="待审阅草稿")
        kb_id = base.id
        draft_id = draft.id
        expected_updated_at = draft.updated_at.isoformat()

    app = FastAPI()
    app.include_router(knowledge_admin_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    client = TestClient(app)

    response = client.post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{kb_id}/versions/{draft_id}/review",
        json={
            "tenant_id": "tenant_demo",
            "staged": 5,
            "pending": 2,
            "documents_adjusted": 3,
            "expected_updated_at": expected_updated_at,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["metadata"]["review"]["staged"] == 5

    # 独立新会话读取（既不是处理请求的会话，也未由本测试提交），证明数据已跨请求持久化。
    with Session(engine) as verify_db:
        persisted = verify_db.get(KnowledgeBaseVersion, draft_id)
        assert persisted is not None
        assert persisted.metadata_json["review"]["staged"] == 5
        assert persisted.metadata_json["review"]["pending"] == 2
        assert persisted.metadata_json["review"]["documents_adjusted"] == 3

        audit_row = verify_db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.action == "draft_reviewed",
            )
        ).one()
        assert audit_row.knowledge_base_version_id == draft_id

        product_event = verify_db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.draft.reviewed")
        ).one()
        assert product_event.payload_json["params"]["staged"] == 5

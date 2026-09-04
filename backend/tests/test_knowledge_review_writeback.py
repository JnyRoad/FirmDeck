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

from app.api.knowledge import router as knowledge_router
from app.api.knowledge_admin import review_knowledge_admin_draft
from app.api.knowledge_admin import router as knowledge_admin_router
from app.api.knowledge_bases import router as knowledge_bases_router
from app.db import get_session
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


def test_review_route_rejects_superseded_draft_snapshot() -> None:
    """已被变基替换的草稿快照（data-model §2：`status='archived'` + `metadata.superseded_by`）
    仍是 `publication_state='draft'`；过期页签继续写审阅统计必须被拒绝，口径与 A3/A4
    （`rebase._draft_version`）一致，同样折叠为 `KNOWLEDGE_VERSION_NOT_READY`。"""
    with _test_session() as db:
        base, v1 = _seed_review_fixture(db)
        draft = _create_draft(db, expected_published_version_id=v1.id, reason="待审阅草稿")
        superseding_draft = _create_draft(
            db, expected_published_version_id=v1.id, reason="变基后的新草稿"
        )
        draft.status = "archived"
        draft.metadata_json = {
            **(draft.metadata_json or {}),
            "superseded_by": superseding_draft.id,
        }
        db.add(draft)
        db.commit()
        db.refresh(draft)

        with pytest.raises(HTTPException) as not_ready:
            review_knowledge_admin_draft(
                base.id,
                draft.id,
                KnowledgeDraftReviewRequest(
                    tenant_id="tenant_demo",
                    staged=1,
                    pending=0,
                    documents_adjusted=1,
                    expected_updated_at=draft.updated_at.isoformat(),
                ),
                db=db,
                current_user=_admin_user(),
            )

        assert not_ready.value.status_code == 409
        assert not_ready.value.detail["code"] == KNOWLEDGE_VERSION_NOT_READY

        # 拒绝时不写入：草稿 metadata 未被污染（superseded_by 标记保持不变）。
        db.refresh(draft)
        assert "review" not in (draft.metadata_json or {})
        assert draft.metadata_json["superseded_by"] == superseding_draft.id


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


# ---------------------------------------------------------------------------
# 回归：前端"应用审阅"完整顺序（更新草稿文档 → A5 recordReview → 发布）必须把 *文档行*
# 的 `updated_at` 当写文档的乐观锁 token，而不是 *版本* 的 `updated_at`——旧前端把两者
# 搞混，用版本时间戳去更新文档，导致合法编辑被 `KNOWLEDGE_DOCUMENT_CONFLICT` 拒绝（frontend
# `getAdminKnowledgeBase`/`ContentTab` 修复轮次发现的缺陷）。这里串联真实的三个 HTTP 路由
# （员工侧 `PUT /knowledge/documents/{id}`、admin `POST .../review`、`POST .../publish`），
# 钉住"实体-时间戳"契约，而不是只测 A5 一个端点。
# ---------------------------------------------------------------------------


def test_apply_review_sequence_uses_document_updated_at_not_version_updated_at_over_http() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as seed_db:
        base, v1 = _seed_review_fixture(seed_db)
        seed_db.add(
            KnowledgeDocument(
                id="kdoc_v1_a",
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                knowledge_base_version_id=v1.id,
                filename="a.md",
                file_type="md",
                title="文档A",
                status="ready",
                metadata_json={"raw_text": "# 文档A\n\n原文。"},
            )
        )
        seed_db.commit()

        draft = _create_draft(seed_db, expected_published_version_id=v1.id, reason="待审阅草稿")
        kb_id = base.id
        draft_id = draft.id
        draft_updated_at = draft.updated_at.isoformat()
        published_version_id = v1.id

        draft_document = seed_db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.tenant_id == "tenant_demo",
                KnowledgeDocument.knowledge_base_version_id == draft_id,
            )
        ).one()
        document_id = draft_document.id
        document_updated_at = draft_document.updated_at.isoformat()

    # 草稿创建（克隆文档）在版本落库之后才写入文档行，两者的 updated_at 必然不同——
    # 这正是缺陷的根源：两个实体各自的时间戳不可互换。
    assert document_updated_at != draft_updated_at

    app = FastAPI()
    app.include_router(knowledge_admin_router)
    app.include_router(knowledge_router)
    app.include_router(knowledge_bases_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    client = TestClient(app)

    # 1. 旧前端的错误行为：用*版本*的 updated_at 当文档写入的乐观锁 token → 必须 409。
    wrong_response = client.put(
        f"/api/enterprise/knowledge/documents/{document_id}",
        json={
            "tenant_id": "tenant_demo",
            "content_md": "# 文档A\n\n审阅修改。",
            "expected_updated_at": draft_updated_at,
        },
    )
    assert wrong_response.status_code == 409, wrong_response.text
    assert wrong_response.json()["detail"]["code"] == "KNOWLEDGE_DOCUMENT_CONFLICT"

    # 2. 正确契约：用*文档行自身*的 updated_at → 必须成功。
    ok_response = client.put(
        f"/api/enterprise/knowledge/documents/{document_id}",
        json={
            "tenant_id": "tenant_demo",
            "content_md": "# 文档A\n\n审阅修改。",
            "expected_updated_at": document_updated_at,
        },
    )
    assert ok_response.status_code == 200, ok_response.text
    assert "审阅修改" in ok_response.json()["metadata"]["raw_text"]

    # 3. A5 记录审阅：上一步只改了文档行，草稿版本本身的 updated_at 未被触碰，原始值仍然有效。
    review_response = client.post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{kb_id}/versions/{draft_id}/review",
        json={
            "tenant_id": "tenant_demo",
            "staged": 1,
            "pending": 0,
            "documents_adjusted": 1,
            "expected_updated_at": draft_updated_at,
        },
    )
    assert review_response.status_code == 200, review_response.text
    assert review_response.json()["metadata"]["review"]["staged"] == 1

    # 4. 发布：整条"应用审阅"链路收尾。
    publish_response = client.post(
        f"/api/enterprise/knowledge-bases/{kb_id}/versions/{draft_id}/publish",
        json={
            "tenant_id": "tenant_demo",
            "expected_published_version_id": published_version_id,
            "change_reason": "应用审阅后发布",
        },
    )
    assert publish_response.status_code == 200, publish_response.text
    assert publish_response.json()["publication_state"] == "released"

    with Session(engine) as verify_db:
        published_document = verify_db.get(KnowledgeDocument, document_id)
        assert published_document is not None
        assert "审阅修改" in (published_document.metadata_json or {}).get("raw_text", "")

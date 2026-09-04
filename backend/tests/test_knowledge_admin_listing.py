"""T020：租户级知识库列表（A1）与可绑定群组候选（A6）。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlmodel import Session
from test_teams_api import _test_session

from app.api.knowledge_admin import (
    list_knowledge_admin_bases,
    list_knowledge_admin_bindable_teams,
)
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    TeamMember,
    Tenant,
    User,
)


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _member_user() -> User:
    return User(
        id="user_member",
        tenant_id="tenant_demo",
        username="member",
        role="member",
        password_hash="x",
    )


def _seed_tenant(db: Session) -> dict[str, str]:
    """构造 2 个共享库（含 1 个未绑定）+ 3 个专用库（跨 2 名员工），覆盖 A1/A6 全部字段。"""
    db.add(Tenant(id="tenant_demo", name="Demo"))
    db.add(AgentProfile(id="agent_lin", tenant_id="tenant_demo", name="林晓"))
    db.add(AgentProfile(id="agent_wang", tenant_id="tenant_demo", name="王芳"))

    team_service = Team(
        id="team_service", tenant_id="tenant_demo", name="客服一组", owner_user_id="user_owner"
    )
    team_sales = Team(
        id="team_sales", tenant_id="tenant_demo", name="销售组", owner_user_id="user_owner"
    )
    team_ops = Team(id="team_ops", tenant_id="tenant_demo", name="运营组", owner_user_id="user_owner")
    db.add(team_service)
    db.add(team_sales)
    db.add(team_ops)
    db.add(TeamMember(id="tm_1", team_id="team_service", agent_id="agent_lin", role="leader"))
    db.add(TeamMember(id="tm_2", team_id="team_service", agent_id="agent_wang", role="member"))

    # 共享库 1：绑定两个团队（其一为团队默认库），一个正式版 + 一个进行中草稿。
    faq = KnowledgeBase(
        id="kb_shared_faq",
        tenant_id="tenant_demo",
        name="产品 FAQ 共享库",
        mode="shared",
        status="active",
        published_version_id="kbver_faq_110",
    )
    db.add(faq)
    db.add(
        KnowledgeBaseVersion(
            id="kbver_faq_110",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_faq",
            version="1.1.0",
            name="产品 FAQ 共享库",
            publication_state="released",
        )
    )
    db.add(
        KnowledgeBaseVersion(
            id="kbver_faq_120",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_faq",
            version="1.2.0",
            name="产品 FAQ 共享库",
            publication_state="draft",
            parent_version_id="kbver_faq_110",
        )
    )
    for i in range(4):
        db.add(
            KnowledgeDocument(
                id=f"kdoc_faq_released_{i}",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_shared_faq",
                knowledge_base_version_id="kbver_faq_110",
                filename=f"faq_{i}.md",
                file_type="md",
                status="ready",
            )
        )
    db.add(
        KnowledgeDocument(
            id="kdoc_faq_draft_0",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_faq",
            knowledge_base_version_id="kbver_faq_120",
            filename="faq_draft.md",
            file_type="md",
            status="ready",
        )
    )
    team_service.default_knowledge_base_id = "kb_shared_faq"
    db.add(team_service)
    db.add(
        TeamKnowledgeBaseBinding(
            id="teamkb_service_faq",
            tenant_id="tenant_demo",
            team_id="team_service",
            knowledge_base_id="kb_shared_faq",
            status="active",
            created_by_user_id="user_admin",
        )
    )
    db.add(
        TeamKnowledgeBaseBinding(
            id="teamkb_sales_faq",
            tenant_id="tenant_demo",
            team_id="team_sales",
            knowledge_base_id="kb_shared_faq",
            status="active",
            created_by_user_id="user_admin",
        )
    )

    # 共享库 2：未绑定任何团队。
    unbound = KnowledgeBase(
        id="kb_shared_unbound",
        tenant_id="tenant_demo",
        name="未绑定共享库",
        mode="shared",
        status="active",
        published_version_id="kbver_unbound_100",
    )
    db.add(unbound)
    db.add(
        KnowledgeBaseVersion(
            id="kbver_unbound_100",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_shared_unbound",
            version="1.0.0",
            name="未绑定共享库",
            publication_state="released",
        )
    )
    for i in range(2):
        db.add(
            KnowledgeDocument(
                id=f"kdoc_unbound_{i}",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_shared_unbound",
                knowledge_base_version_id="kbver_unbound_100",
                filename=f"unbound_{i}.md",
                file_type="md",
                status="ready",
            )
        )

    # 专用库 1（林晓）：分支已分叉，头版本 2 篇文档，基线版本 1 篇文档（不计入 document_count）。
    lin_base = KnowledgeBase(
        id="kb_dedicated_lin",
        tenant_id="tenant_demo",
        name="林晓的客服话术库",
        mode="dedicated",
        status="active",
        metadata_json={"owner_agent_id": "agent_lin"},
    )
    db.add(lin_base)
    db.add(
        KnowledgeBaseVersion(
            id="kbver_lin_3",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_lin",
            version="3",
            name="林晓的客服话术库",
            publication_state="released",
        )
    )
    db.add(
        KnowledgeBaseVersion(
            id="kbver_lin_5",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_lin",
            version="5",
            name="林晓的客服话术库",
            publication_state="released",
        )
    )
    db.add(
        AgentKnowledgeBranch(
            id="agentkb_lin",
            tenant_id="tenant_demo",
            agent_id="agent_lin",
            knowledge_base_id="kb_dedicated_lin",
            base_version="3",
            head_version="5",
            sync_state="diverged",
        )
    )
    db.add(
        KnowledgeDocument(
            id="kdoc_lin_base_0",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_lin",
            knowledge_base_version_id="kbver_lin_3",
            filename="base_only.md",
            file_type="md",
            status="ready",
        )
    )
    for i in range(2):
        db.add(
            KnowledgeDocument(
                id=f"kdoc_lin_head_{i}",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_dedicated_lin",
                knowledge_base_version_id="kbver_lin_5",
                filename=f"head_{i}.md",
                file_type="md",
                status="ready",
            )
        )

    # 专用库 2（王芳）：已归档，用于 status 过滤。
    wang_base = KnowledgeBase(
        id="kb_dedicated_wang",
        tenant_id="tenant_demo",
        name="王芳的销售话术库",
        mode="dedicated",
        status="archived",
        metadata_json={"owner_agent_id": "agent_wang"},
    )
    db.add(wang_base)
    db.add(
        KnowledgeBaseVersion(
            id="kbver_wang_1",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_wang",
            version="1",
            name="王芳的销售话术库",
            publication_state="released",
        )
    )
    db.add(
        AgentKnowledgeBranch(
            id="agentkb_wang",
            tenant_id="tenant_demo",
            agent_id="agent_wang",
            knowledge_base_id="kb_dedicated_wang",
            base_version="1",
            head_version="1",
            sync_state="synced",
        )
    )
    db.add(
        KnowledgeDocument(
            id="kdoc_wang_0",
            tenant_id="tenant_demo",
            knowledge_base_id="kb_dedicated_wang",
            knowledge_base_version_id="kbver_wang_1",
            filename="wang_0.md",
            file_type="md",
            status="ready",
        )
    )

    # 专用库 3（林晓，第二个）：owner 尚未产生分支，验证 branch=None 且 document_count=0。
    lin_new_base = KnowledgeBase(
        id="kb_dedicated_lin_new",
        tenant_id="tenant_demo",
        name="林晓的新知识库",
        mode="dedicated",
        status="active",
        metadata_json={"owner_agent_id": "agent_lin"},
    )
    db.add(lin_new_base)

    db.commit()
    return {
        "faq": "kb_shared_faq",
        "unbound": "kb_shared_unbound",
        "lin": "kb_dedicated_lin",
        "wang": "kb_dedicated_wang",
        "lin_new": "kb_dedicated_lin_new",
    }


def _call_list(
    db: Session,
    current_user: User,
    *,
    mode: str | None = None,
    status: str | None = None,
    owner_agent_id: str | None = None,
    team_id: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 20,
):
    return list_knowledge_admin_bases(
        tenant_id="tenant_demo",
        mode=mode,
        status=status,
        owner_agent_id=owner_agent_id,
        team_id=team_id,
        q=q,
        offset=offset,
        limit=limit,
        db=db,
        current_user=current_user,
    )


def test_lists_all_bases_with_summary_and_pagination() -> None:
    """无过滤时返回全部 5 个知识库，summary 反映全租户统计，且分页字段正确。"""
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        result = _call_list(db, admin)

        assert result.total == 5
        assert result.offset == 0
        assert result.limit == 20
        assert result.has_more is False
        assert len(result.items) == 5

        assert result.summary.total == 5
        assert result.summary.shared == 2
        assert result.summary.dedicated == 3
        assert result.summary.documents == 4 + 2 + 2 + 1 + 0  # faq + unbound + lin + wang + lin_new


def test_shared_base_summary_fields() -> None:
    """共享库：正式版本号、草稿数、绑定团队（含 is_default）、正式版文档数（排除草稿文档）。"""
    with _test_session() as db:
        _seed_tenant(db)
        result = _call_list(db, _admin_user())
        by_id = {item.id: item for item in result.items}

        faq = by_id["kb_shared_faq"]
        assert faq.mode == "shared"
        assert faq.status == "active"
        assert faq.published_version == "1.1.0"
        assert faq.published_version_id == "kbver_faq_110"
        assert faq.draft_count == 1
        assert faq.document_count == 4
        assert faq.owner_agent is None
        assert faq.branch is None
        bound = {team.id: team.is_default for team in faq.bound_teams}
        assert bound == {"team_service": True, "team_sales": False}

        unbound = by_id["kb_shared_unbound"]
        assert unbound.bound_teams == []
        assert unbound.draft_count == 0
        assert unbound.document_count == 2
        assert unbound.published_version == "1.0.0"


def test_dedicated_base_owner_and_branch_fields() -> None:
    """专用库：owner_agent 来自 metadata_json.owner_agent_id，branch 取 owner 分支头版本文档数。"""
    with _test_session() as db:
        _seed_tenant(db)
        result = _call_list(db, _admin_user())
        by_id = {item.id: item for item in result.items}

        lin = by_id["kb_dedicated_lin"]
        assert lin.mode == "dedicated"
        assert lin.owner_agent is not None
        assert lin.owner_agent.id == "agent_lin"
        assert lin.owner_agent.name == "林晓"
        assert lin.branch is not None
        assert lin.branch.base_version == "3"
        assert lin.branch.head_version == "5"
        assert lin.branch.sync_state == "diverged"
        # 头版本 2 篇文档，基线版本 1 篇文档不计入。
        assert lin.document_count == 2
        assert lin.published_version is None
        assert lin.published_version_id is None
        assert lin.bound_teams == []

        lin_new = by_id["kb_dedicated_lin_new"]
        assert lin_new.owner_agent is not None
        assert lin_new.owner_agent.id == "agent_lin"
        assert lin_new.branch is None
        assert lin_new.document_count == 0


def test_archived_and_deleted_owner_branches_are_excluded() -> None:
    """回归：owner 分支 status 为 archived/deleted 时视同无分支，branch=None 且不计入 document_count。

    未加 status=='active' 过滤时，_seed_tenant 之外的一个陈旧（已归档/已转共享删除）分支会
    被当作在用分支，展示过期的 base/head/sync_state 并从其旧头版本统计文档数。
    """
    with _test_session() as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(AgentProfile(id="agent_stale", tenant_id="tenant_demo", name="旧分支员工"))

        archived_base = KnowledgeBase(
            id="kb_dedicated_archived_branch",
            tenant_id="tenant_demo",
            name="已归档分支的专用库",
            mode="dedicated",
            status="active",
            metadata_json={"owner_agent_id": "agent_stale"},
        )
        db.add(archived_base)
        db.add(
            KnowledgeBaseVersion(
                id="kbver_archived_2",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_dedicated_archived_branch",
                version="2",
                name="已归档分支的专用库",
                publication_state="released",
            )
        )
        db.add(
            AgentKnowledgeBranch(
                id="agentkb_archived",
                tenant_id="tenant_demo",
                agent_id="agent_stale",
                knowledge_base_id="kb_dedicated_archived_branch",
                base_version="1",
                head_version="2",
                sync_state="diverged",
                status="archived",
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_archived_head_0",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_dedicated_archived_branch",
                knowledge_base_version_id="kbver_archived_2",
                filename="stale_head.md",
                file_type="md",
                status="ready",
            )
        )

        deleted_base = KnowledgeBase(
            id="kb_dedicated_deleted_branch",
            tenant_id="tenant_demo",
            name="已删除分支的专用库",
            mode="dedicated",
            status="active",
            metadata_json={"owner_agent_id": "agent_stale"},
        )
        db.add(deleted_base)
        db.add(
            KnowledgeBaseVersion(
                id="kbver_deleted_1",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_dedicated_deleted_branch",
                version="1",
                name="已删除分支的专用库",
                publication_state="released",
            )
        )
        db.add(
            AgentKnowledgeBranch(
                id="agentkb_deleted",
                tenant_id="tenant_demo",
                agent_id="agent_stale",
                knowledge_base_id="kb_dedicated_deleted_branch",
                base_version="1",
                head_version="1",
                sync_state="synced",
                status="deleted",
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_deleted_head_0",
                tenant_id="tenant_demo",
                knowledge_base_id="kb_dedicated_deleted_branch",
                knowledge_base_version_id="kbver_deleted_1",
                filename="stale_head.md",
                file_type="md",
                status="ready",
            )
        )
        db.commit()

        result = _call_list(db, _admin_user())
        by_id = {item.id: item for item in result.items}

        archived_item = by_id["kb_dedicated_archived_branch"]
        assert archived_item.owner_agent is not None  # 归属员工独立于分支状态，仍然解析
        assert archived_item.branch is None
        assert archived_item.document_count == 0

        deleted_item = by_id["kb_dedicated_deleted_branch"]
        assert deleted_item.owner_agent is not None
        assert deleted_item.branch is None
        assert deleted_item.document_count == 0


def test_filter_by_mode() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        shared_result = _call_list(db, admin, mode="shared")
        assert shared_result.total == 2
        assert {item.id for item in shared_result.items} == {"kb_shared_faq", "kb_shared_unbound"}
        # summary 不受过滤影响
        assert shared_result.summary.total == 5

        dedicated_result = _call_list(db, admin, mode="dedicated")
        assert dedicated_result.total == 3
        assert {item.id for item in dedicated_result.items} == {
            "kb_dedicated_lin",
            "kb_dedicated_wang",
            "kb_dedicated_lin_new",
        }


def test_filter_by_status() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        archived_result = _call_list(db, admin, status="archived")
        assert archived_result.total == 1
        assert archived_result.items[0].id == "kb_dedicated_wang"

        active_result = _call_list(db, admin, status="active")
        assert active_result.total == 4
        assert "kb_dedicated_wang" not in {item.id for item in active_result.items}


def test_filter_by_owner_agent_id() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        result = _call_list(db, _admin_user(), owner_agent_id="agent_lin")
        assert result.total == 2
        assert {item.id for item in result.items} == {"kb_dedicated_lin", "kb_dedicated_lin_new"}


def test_filter_by_team_id() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        result = _call_list(db, _admin_user(), team_id="team_sales")
        assert result.total == 1
        assert result.items[0].id == "kb_shared_faq"


def test_filter_by_q_is_case_insensitive() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        upper = _call_list(db, admin, q="FAQ")
        lower = _call_list(db, admin, q="faq")
        assert upper.total == 1
        assert lower.total == 1
        assert upper.items[0].id == lower.items[0].id == "kb_shared_faq"


def test_pagination_offset_limit_has_more() -> None:
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        first_page = _call_list(db, admin, offset=0, limit=2)
        assert len(first_page.items) == 2
        assert first_page.has_more is True
        assert first_page.total == 5

        seen_ids = {item.id for item in first_page.items}
        second_page = _call_list(db, admin, offset=2, limit=2)
        assert len(second_page.items) == 2
        assert second_page.has_more is True
        seen_ids |= {item.id for item in second_page.items}

        last_page = _call_list(db, admin, offset=4, limit=2)
        assert len(last_page.items) == 1
        assert last_page.has_more is False
        seen_ids |= {item.id for item in last_page.items}

        assert seen_ids == {
            "kb_shared_faq",
            "kb_shared_unbound",
            "kb_dedicated_lin",
            "kb_dedicated_wang",
            "kb_dedicated_lin_new",
        }


def test_non_admin_is_forbidden() -> None:
    with _test_session() as db:
        _seed_tenant(db)

        with pytest.raises(HTTPException) as denied:
            _call_list(db, _member_user())

        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "PERMISSION_TENANT_ADMIN_REQUIRED"


def test_bindable_teams_candidates_and_exclude_bound_to() -> None:
    """A6：默认返回全部活跃团队及成员数；exclude_bound_to 排除已对该库有效绑定的团队。"""
    with _test_session() as db:
        _seed_tenant(db)
        admin = _admin_user()

        all_teams = list_knowledge_admin_bindable_teams(
            tenant_id="tenant_demo",
            exclude_bound_to=None,
            db=db,
            current_user=admin,
        )
        by_id = {team.id: team for team in all_teams}
        assert set(by_id) == {"team_service", "team_sales", "team_ops"}
        assert by_id["team_service"].member_count == 2
        assert by_id["team_ops"].member_count == 0

        candidates = list_knowledge_admin_bindable_teams(
            tenant_id="tenant_demo",
            exclude_bound_to="kb_shared_faq",
            db=db,
            current_user=admin,
        )
        assert {team.id for team in candidates} == {"team_ops"}


def test_bindable_teams_non_admin_is_forbidden() -> None:
    with _test_session() as db:
        _seed_tenant(db)

        with pytest.raises(HTTPException) as denied:
            list_knowledge_admin_bindable_teams(
                tenant_id="tenant_demo",
                exclude_bound_to=None,
                db=db,
                current_user=_member_user(),
            )

        assert denied.value.status_code == 403
        assert denied.value.detail["code"] == "PERMISSION_TENANT_ADMIN_REQUIRED"

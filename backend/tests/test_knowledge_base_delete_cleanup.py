"""租户 admin 硬删知识库时的团队关联清理契约。

覆盖 DELETE /api/enterprise/knowledge-bases/{kb_id} 不带 agent_id 的硬删分支：
删除共享库必须在同一事务里清掉 TeamKnowledgeBaseBinding、TeamKnowledgeBaseGrant，
并重置指向该库的 Team.default_knowledge_base_id，且清理严格限定当前租户。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlmodel import select
from test_teams_api import _admin_user, _seed_agents, _test_session
from test_teams_knowledge import _add_shared_base

from app.api.knowledge_bases import delete_knowledge_base
from app.db.models import (
    KnowledgeBase,
    Team,
    TeamKnowledgeBaseBinding,
    TeamKnowledgeBaseGrant,
)
from app.teams.schema import TeamKnowledgeSelection
from app.teams.service import (
    add_member,
    bind_team_knowledge_base,
    create_team,
    replace_team_knowledge_grants,
    set_team_default_knowledge_base,
)


def _bind_with_grant(db, *, team, base, agent_id: str) -> None:
    """把共享库绑定到团队并授予一名成员 editor 权限，走真实服务链路。"""
    binding = bind_team_knowledge_base(
        db,
        team=team,
        selection=TeamKnowledgeSelection(existing_knowledge_base_id=base.id),
        actor_user_id="user_admin",
    )
    replace_team_knowledge_grants(
        db,
        team=team,
        knowledge_base_id=base.id,
        expected_revision=binding.revision,
        grants={agent_id: "editor"},
        actor_user_id="user_admin",
    )


def test_admin_hard_delete_cleans_team_bindings_grants_and_default_target() -> None:
    """硬删共享库后不留团队绑定、授权和默认写入目标，其他库的关联不受影响。"""
    with _test_session() as db:
        _seed_agents(db)
        doomed = _add_shared_base(db, base_id="kb_doomed", name="待删共享库")
        kept = _add_shared_base(db, base_id="kb_kept", name="保留共享库")
        team_primary = create_team(
            db,
            tenant_id="tenant_demo",
            name="主团队",
            description=None,
            owner_user_id="user_admin",
        )
        team_secondary = create_team(
            db,
            tenant_id="tenant_demo",
            name="副团队",
            description=None,
            owner_user_id="user_admin",
        )
        add_member(db, team_primary, agent_id="agent_worker")
        add_member(db, team_secondary, agent_id="agent_worker2")
        _bind_with_grant(db, team=team_primary, base=doomed, agent_id="agent_worker")
        _bind_with_grant(db, team=team_primary, base=kept, agent_id="agent_worker")
        _bind_with_grant(db, team=team_secondary, base=doomed, agent_id="agent_worker2")
        _bind_with_grant(db, team=team_secondary, base=kept, agent_id="agent_worker2")
        set_team_default_knowledge_base(
            db,
            team=team_primary,
            knowledge_base_id=doomed.id,
            is_default=True,
            expected_revision=2,
            actor_user_id="user_admin",
        )
        set_team_default_knowledge_base(
            db,
            team=team_secondary,
            knowledge_base_id=kept.id,
            is_default=True,
            expected_revision=2,
            actor_user_id="user_admin",
        )
        db.commit()

        result = delete_knowledge_base(
            "kb_doomed",
            tenant_id="tenant_demo",
            agent_id=None,
            db=db,
            current_user=_admin_user(),
        )

        assert result == {"status": "deleted"}
        assert db.get(KnowledgeBase, "kb_doomed") is None
        doomed_bindings = db.exec(
            select(TeamKnowledgeBaseBinding).where(
                TeamKnowledgeBaseBinding.knowledge_base_id == "kb_doomed"
            )
        ).all()
        doomed_grants = db.exec(
            select(TeamKnowledgeBaseGrant).where(
                TeamKnowledgeBaseGrant.knowledge_base_id == "kb_doomed"
            )
        ).all()
        assert doomed_bindings == []
        assert doomed_grants == []
        db.refresh(team_primary)
        db.refresh(team_secondary)
        assert team_primary.default_knowledge_base_id is None
        assert team_secondary.default_knowledge_base_id == kept.id
        kept_bindings = db.exec(
            select(TeamKnowledgeBaseBinding).where(
                TeamKnowledgeBaseBinding.knowledge_base_id == kept.id
            )
        ).all()
        kept_grants = db.exec(
            select(TeamKnowledgeBaseGrant).where(
                TeamKnowledgeBaseGrant.knowledge_base_id == kept.id
            )
        ).all()
        assert {row.team_id for row in kept_bindings} == {team_primary.id, team_secondary.id}
        assert {row.team_id for row in kept_grants} == {team_primary.id, team_secondary.id}


def test_admin_hard_delete_cleanup_is_scoped_to_current_tenant() -> None:
    """清理只作用于当前租户：其他租户引用同名库 ID 的团队数据保持不变。"""
    with _test_session() as db:
        _seed_agents(db)
        _add_shared_base(db, base_id="kb_doomed", name="待删共享库")
        demo_team = Team(
            id="team_demo",
            tenant_id="tenant_demo",
            name="本租户团队",
            owner_user_id="user_admin",
            default_knowledge_base_id="kb_doomed",
        )
        other_team = Team(
            id="team_other",
            tenant_id="tenant_other",
            name="其他租户团队",
            owner_user_id="user_other",
            default_knowledge_base_id="kb_doomed",
        )
        db.add(demo_team)
        db.add(other_team)
        for tenant_id, team_id, agent_id, creator in (
            ("tenant_demo", "team_demo", "agent_worker", "user_admin"),
            ("tenant_other", "team_other", "agent_outside", "user_other"),
        ):
            db.add(
                TeamKnowledgeBaseBinding(
                    tenant_id=tenant_id,
                    team_id=team_id,
                    knowledge_base_id="kb_doomed",
                    created_by_user_id=creator,
                )
            )
            db.add(
                TeamKnowledgeBaseGrant(
                    tenant_id=tenant_id,
                    team_id=team_id,
                    knowledge_base_id="kb_doomed",
                    agent_id=agent_id,
                    permission="reader",
                    created_by_user_id=creator,
                )
            )
        db.commit()

        delete_knowledge_base(
            "kb_doomed",
            tenant_id="tenant_demo",
            agent_id=None,
            db=db,
            current_user=_admin_user(),
        )

        remaining_bindings = db.exec(select(TeamKnowledgeBaseBinding)).all()
        remaining_grants = db.exec(select(TeamKnowledgeBaseGrant)).all()
        assert [row.tenant_id for row in remaining_bindings] == ["tenant_other"]
        assert [row.tenant_id for row in remaining_grants] == ["tenant_other"]
        db.refresh(demo_team)
        db.refresh(other_team)
        assert demo_team.default_knowledge_base_id is None
        assert other_team.default_knowledge_base_id == "kb_doomed"


def test_admin_cannot_hard_delete_other_tenant_knowledge_base() -> None:
    """跨租户删除按错误契约返回稳定的 KNOWLEDGE_BASE_NOT_FOUND，而不是泄漏存在性。"""
    with _test_session() as db:
        _seed_agents(db)
        _add_shared_base(
            db,
            base_id="kb_foreign",
            name="其他租户共享库",
            tenant_id="tenant_other",
        )
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            delete_knowledge_base(
                "kb_foreign",
                tenant_id="tenant_demo",
                agent_id=None,
                db=db,
                current_user=_admin_user(),
            )

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail["code"] == "KNOWLEDGE_BASE_NOT_FOUND"
        assert db.get(KnowledgeBase, "kb_foreign") is not None

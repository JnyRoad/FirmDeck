"""共享知识库的人类管理上下文校验。"""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from app.db.models import (
    KnowledgeBase,
    Team,
    TeamKnowledgeBaseBinding,
    User,
)
from app.knowledge.errors import (
    KNOWLEDGE_CONTEXT_MISMATCH,
    KNOWLEDGE_GRANT_REQUIRED,
    KNOWLEDGE_MODE_INVALID,
    knowledge_error,
)
from app.security.permissions import is_admin_user


@dataclass(frozen=True)
class SharedKnowledgeManagementContext:
    """已校验的人类团队、共享知识库及绑定组合；管理员旁路下 team/binding 均为空。"""

    team: Team | None
    knowledge_base: KnowledgeBase
    binding: TeamKnowledgeBaseBinding | None


def _require_shared_base(
    db: Session, *, tenant_id: str, knowledge_base_id: str
) -> KnowledgeBase:
    """校验共享知识库存在、属于该租户且处于活跃可写状态。"""
    base = db.get(KnowledgeBase, knowledge_base_id)
    if base is None or base.tenant_id != tenant_id or base.status != "active":
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    if base.mode != "shared":
        raise knowledge_error(KNOWLEDGE_MODE_INVALID)
    return base


def require_team_knowledge_manager(
    db: Session,
    *,
    tenant_id: str,
    team_id: str | None,
    knowledge_base_id: str,
    current_user: User,
) -> SharedKnowledgeManagementContext:
    """要求同租户团队所有者/管理员通过活动绑定管理共享知识；

    未传 team_id 时，仅租户管理员可直接治理未绑定任何团队的共享库
    （管理员本就是团队所有者权限的超集，见 management.py 内 is_admin_user 用法）。
    """
    if current_user.tenant_id != tenant_id:
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)

    if team_id is None:
        if not is_admin_user(current_user):
            raise knowledge_error(
                KNOWLEDGE_GRANT_REQUIRED,
                message="未指定团队时，只有租户管理员可以管理共享知识库。",
            )
        base = _require_shared_base(
            db, tenant_id=tenant_id, knowledge_base_id=knowledge_base_id
        )
        return SharedKnowledgeManagementContext(
            team=None,
            knowledge_base=base,
            binding=None,
        )

    team = db.get(Team, team_id)
    if team is None or team.tenant_id != tenant_id or team.status != "active":
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    if team.owner_user_id != current_user.id and not is_admin_user(current_user):
        raise knowledge_error(
            KNOWLEDGE_GRANT_REQUIRED,
            message="只有团队所有者或管理员可以维护团队共享知识库。",
        )
    base = _require_shared_base(db, tenant_id=tenant_id, knowledge_base_id=knowledge_base_id)
    binding = db.exec(
        select(TeamKnowledgeBaseBinding).where(
            TeamKnowledgeBaseBinding.tenant_id == tenant_id,
            TeamKnowledgeBaseBinding.team_id == team_id,
            TeamKnowledgeBaseBinding.knowledge_base_id == knowledge_base_id,
            TeamKnowledgeBaseBinding.status == "active",
        )
    ).first()
    if binding is None:
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    return SharedKnowledgeManagementContext(
        team=team,
        knowledge_base=base,
        binding=binding,
    )


def require_shared_knowledge_history_viewer(
    db: Session,
    *,
    tenant_id: str,
    knowledge_base_id: str,
    current_user: User,
) -> KnowledgeBase:
    """允许租户管理员或任一活动绑定团队的所有者查看共享历史。"""
    if current_user.tenant_id != tenant_id:
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    base = db.get(KnowledgeBase, knowledge_base_id)
    if base is None or base.tenant_id != tenant_id or base.status != "active":
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    if base.mode != "shared":
        raise knowledge_error(KNOWLEDGE_MODE_INVALID)
    if is_admin_user(current_user):
        return base

    owned_team_ids = db.exec(
        select(Team.id).where(
            Team.tenant_id == tenant_id,
            Team.owner_user_id == current_user.id,
            Team.status == "active",
        )
    ).all()
    if owned_team_ids:
        binding = db.exec(
            select(TeamKnowledgeBaseBinding.id).where(
                TeamKnowledgeBaseBinding.tenant_id == tenant_id,
                TeamKnowledgeBaseBinding.team_id.in_(owned_team_ids),
                TeamKnowledgeBaseBinding.knowledge_base_id == knowledge_base_id,
                TeamKnowledgeBaseBinding.status == "active",
            )
        ).first()
        if binding:
            return base
    raise knowledge_error(KNOWLEDGE_GRANT_REQUIRED)

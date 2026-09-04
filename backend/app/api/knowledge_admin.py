"""知识库管理端（knowledge-base-admin）租户级只读端点：A1 列表、A6 可绑定群组候选。

仅负责鉴权（`ensure_tenant_admin`）、参数校验与把 `app.knowledge.listing` 的纯查询
结果投影为响应模型；聚合与过滤逻辑一律留在 listing.py，本文件不直接操作 ORM。
后续任务（草稿/对比/变基/审阅）继续往这个 router 追加路由。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from app.db import get_session
from app.db.models import User
from app.knowledge.listing import list_bindable_teams, list_tenant_knowledge_bases
from app.knowledge.schema import (
    KnowledgeAdminBoundTeamRead,
    KnowledgeAdminBranchRead,
    KnowledgeAdminListItem,
    KnowledgeAdminListResponse,
    KnowledgeAdminListSummary,
    KnowledgeAdminOwnerAgentRead,
    KnowledgeAdminTeamOption,
    KnowledgeBaseMode,
)
from app.security.auth import get_current_user
from app.security.permissions import ensure_tenant_admin
from app.security.tenant import ensure_tenant

router = APIRouter(
    prefix="/api/enterprise/knowledge-admin",
    tags=["enterprise:knowledge-admin"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/knowledge-bases", response_model=KnowledgeAdminListResponse)
def list_knowledge_admin_bases(
    tenant_id: str = Query(...),
    mode: KnowledgeBaseMode | None = Query(None),
    status: Literal["active", "archived"] | None = Query(None),
    owner_agent_id: str | None = Query(None),
    team_id: str | None = Query(None),
    q: str | None = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> KnowledgeAdminListResponse:
    """A1：租户级全量知识库列表（管理员），支持过滤与分页，summary 不受过滤影响。"""
    ensure_tenant_admin(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    result = list_tenant_knowledge_bases(
        db,
        tenant_id=tenant_id,
        mode=mode,
        status=status,
        owner_agent_id=owner_agent_id,
        team_id=team_id,
        q=q,
        offset=offset,
        limit=limit,
    )
    return KnowledgeAdminListResponse(
        items=[
            KnowledgeAdminListItem(
                id=item.id,
                name=item.name,
                description=item.description,
                mode=item.mode,
                status=item.status,
                capability_scope=item.capability_scope,
                published_version=item.published_version,
                published_version_id=item.published_version_id,
                draft_count=item.draft_count,
                document_count=item.document_count,
                owner_agent=(
                    KnowledgeAdminOwnerAgentRead(id=item.owner_agent.id, name=item.owner_agent.name)
                    if item.owner_agent
                    else None
                ),
                bound_teams=[
                    KnowledgeAdminBoundTeamRead(id=team.id, name=team.name, is_default=team.is_default)
                    for team in item.bound_teams
                ],
                branch=(
                    KnowledgeAdminBranchRead(
                        base_version=item.branch.base_version,
                        head_version=item.branch.head_version,
                        sync_state=item.branch.sync_state,
                    )
                    if item.branch
                    else None
                ),
                updated_at=item.updated_at.isoformat(),
            )
            for item in result.items
        ],
        summary=KnowledgeAdminListSummary(
            total=result.summary.total,
            shared=result.summary.shared,
            dedicated=result.summary.dedicated,
            documents=result.summary.documents,
        ),
        total=result.total,
        offset=result.offset,
        limit=result.limit,
        has_more=result.has_more,
    )


@router.get("/teams", response_model=list[KnowledgeAdminTeamOption])
def list_knowledge_admin_bindable_teams(
    tenant_id: str = Query(...),
    exclude_bound_to: str | None = Query(None),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[KnowledgeAdminTeamOption]:
    """A6：可绑定群组候选，供"绑定新群组"下拉；exclude_bound_to 排除已绑定该库的团队。"""
    ensure_tenant_admin(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    options = list_bindable_teams(db, tenant_id=tenant_id, exclude_bound_to=exclude_bound_to)
    return [
        KnowledgeAdminTeamOption(id=option.id, name=option.name, member_count=option.member_count)
        for option in options
    ]

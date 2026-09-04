"""租户级知识库列表与可绑定群组候选：纯查询/聚合服务，不含鉴权与 HTTP 关注点。

供 backend/app/api/knowledge_admin.py 调用；输入 session/tenant/过滤/分页参数，
输出 dataclass 列表项，由路由层负责投影为响应模型。全部聚合统计（文档数、草稿数、
绑定团队、归属员工、专用分支）均使用按 tenant 分组的批量查询完成，避免逐库循环
产生 N+1 查询。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func
from sqlmodel import Session, select

from app.capability_scope import normalize_capability_scope
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    TeamMember,
)


@dataclass(frozen=True)
class OwnerAgentInfo:
    """私有库归属员工（metadata_json.owner_agent_id → AgentProfile 名称）。"""

    id: str
    name: str


@dataclass(frozen=True)
class BoundTeamInfo:
    """共享库的一条活跃团队绑定，is_default 取自 Team.default_knowledge_base_id。"""

    id: str
    name: str
    is_default: bool


@dataclass(frozen=True)
class BranchInfo:
    """私有库 owner 员工的分支基线/头版本与同步状态。"""

    base_version: str
    head_version: str
    sync_state: str


@dataclass(frozen=True)
class ListedKnowledgeBase:
    """租户级列表单条知识库投影，字段与契约 A1 的 items[] 元素一一对应。"""

    id: str
    name: str
    description: str | None
    mode: str
    status: str
    capability_scope: str
    published_version: str | None
    published_version_id: str | None
    draft_count: int
    document_count: int
    owner_agent: OwnerAgentInfo | None
    bound_teams: list[BoundTeamInfo]
    branch: BranchInfo | None
    updated_at: datetime


@dataclass(frozen=True)
class KnowledgeBaseListSummary:
    """全租户统计，不受过滤参数影响。"""

    total: int
    shared: int
    dedicated: int
    documents: int


@dataclass(frozen=True)
class KnowledgeBaseListResult:
    items: list[ListedKnowledgeBase]
    summary: KnowledgeBaseListSummary
    total: int
    offset: int
    limit: int
    has_more: bool


@dataclass(frozen=True)
class BindableTeamOption:
    """A6 候选团队：供"绑定新群组"下拉使用。"""

    id: str
    name: str
    member_count: int


def _owner_agent_id(base: KnowledgeBase) -> str | None:
    owner_id = (base.metadata_json or {}).get("owner_agent_id")
    return owner_id if isinstance(owner_id, str) and owner_id else None


def list_tenant_knowledge_bases(
    db: Session,
    *,
    tenant_id: str,
    mode: str | None = None,
    status: str | None = None,
    owner_agent_id: str | None = None,
    team_id: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 20,
) -> KnowledgeBaseListResult:
    """取全租户知识库并批量聚合统计，过滤/排序/分页在内存中完成。"""
    bases = db.exec(select(KnowledgeBase).where(KnowledgeBase.tenant_id == tenant_id)).all()
    if not bases:
        return KnowledgeBaseListResult(
            items=[],
            summary=KnowledgeBaseListSummary(total=0, shared=0, dedicated=0, documents=0),
            total=0,
            offset=offset,
            limit=limit,
            has_more=False,
        )

    base_ids = [base.id for base in bases]
    shared_bases = [base for base in bases if base.mode == "shared"]
    dedicated_bases = [base for base in bases if base.mode != "shared"]

    published_version_ids = {
        base.published_version_id for base in shared_bases if base.published_version_id
    }
    owner_agent_ids = {
        owner_id for base in dedicated_bases if (owner_id := _owner_agent_id(base)) is not None
    }

    # 专用库：owner 分支（一次分组查询取全部候选分支，再按 (kb_id, agent_id) 精确匹配）。
    owner_branch_by_base: dict[str, AgentKnowledgeBranch] = {}
    if dedicated_bases:
        dedicated_ids = [base.id for base in dedicated_bases]
        branch_rows = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.tenant_id == tenant_id,
                AgentKnowledgeBranch.knowledge_base_id.in_(dedicated_ids),
            )
        ).all()
        branch_by_key = {(row.knowledge_base_id, row.agent_id): row for row in branch_rows}
        for base in dedicated_bases:
            owner_id = _owner_agent_id(base)
            if owner_id is None:
                continue
            branch = branch_by_key.get((base.id, owner_id))
            if branch is not None:
                owner_branch_by_base[base.id] = branch

    # 专用库头版本 id 解析：(knowledge_base_id, version 标签) → 版本行 id。
    head_version_id_by_base: dict[str, str] = {}
    if owner_branch_by_base:
        lookup_base_ids = list(owner_branch_by_base)
        version_rows = db.exec(
            select(
                KnowledgeBaseVersion.knowledge_base_id,
                KnowledgeBaseVersion.version,
                KnowledgeBaseVersion.id,
            ).where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.knowledge_base_id.in_(lookup_base_ids),
            )
        ).all()
        version_id_by_label = {
            (kb_id, version_label): version_id for kb_id, version_label, version_id in version_rows
        }
        for base_id, branch in owner_branch_by_base.items():
            version_id = version_id_by_label.get((base_id, branch.head_version))
            if version_id:
                head_version_id_by_base[base_id] = version_id

    # 共享库正式版本号标签。
    published_version_label_by_id: dict[str, str] = {}
    if published_version_ids:
        rows = db.exec(
            select(KnowledgeBaseVersion.id, KnowledgeBaseVersion.version).where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.id.in_(published_version_ids),
            )
        ).all()
        published_version_label_by_id = dict(rows)

    # 文档数：共享库取正式版本、专用库取 owner 分支头版本，合并成一次分组查询。
    relevant_version_ids = set(published_version_ids) | set(head_version_id_by_base.values())
    document_count_by_version: dict[str, int] = {}
    if relevant_version_ids:
        rows = db.exec(
            select(
                KnowledgeDocument.knowledge_base_version_id,
                func.count(KnowledgeDocument.id),
            )
            .where(
                KnowledgeDocument.tenant_id == tenant_id,
                KnowledgeDocument.knowledge_base_version_id.in_(relevant_version_ids),
            )
            .group_by(KnowledgeDocument.knowledge_base_version_id)
        ).all()
        document_count_by_version = {version_id: int(count or 0) for version_id, count in rows}

    # 草稿数：全部知识库一次分组查询（publication_state='draft' 且未归档）。
    draft_count_by_base: dict[str, int] = dict(
        db.exec(
            select(
                KnowledgeBaseVersion.knowledge_base_id,
                func.count(KnowledgeBaseVersion.id),
            )
            .where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.knowledge_base_id.in_(base_ids),
                KnowledgeBaseVersion.publication_state == "draft",
                KnowledgeBaseVersion.status != "archived",
            )
            .group_by(KnowledgeBaseVersion.knowledge_base_id)
        ).all()
    )
    draft_count_by_base = {kb_id: int(count) for kb_id, count in draft_count_by_base.items()}

    # 绑定群组：一次 join 查询，附带团队名称与租户默认库标记。
    bound_teams_by_base: dict[str, list[BoundTeamInfo]] = {}
    binding_rows = db.exec(
        select(
            TeamKnowledgeBaseBinding.knowledge_base_id,
            Team.id,
            Team.name,
            Team.default_knowledge_base_id,
        )
        .join(Team, Team.id == TeamKnowledgeBaseBinding.team_id)
        .where(
            TeamKnowledgeBaseBinding.tenant_id == tenant_id,
            TeamKnowledgeBaseBinding.status == "active",
            TeamKnowledgeBaseBinding.knowledge_base_id.in_(base_ids),
        )
    ).all()
    for kb_id, team_id_row, team_name, default_kb_id in binding_rows:
        bound_teams_by_base.setdefault(kb_id, []).append(
            BoundTeamInfo(id=team_id_row, name=team_name, is_default=default_kb_id == kb_id)
        )

    # 归属员工：专用库 owner_agent_id → AgentProfile 名称，一次查询。
    owner_name_by_id: dict[str, str] = {}
    if owner_agent_ids:
        rows = db.exec(
            select(AgentProfile.id, AgentProfile.name).where(
                AgentProfile.tenant_id == tenant_id,
                AgentProfile.id.in_(owner_agent_ids),
            )
        ).all()
        owner_name_by_id = dict(rows)

    items: list[ListedKnowledgeBase] = []
    for base in bases:
        is_shared = base.mode == "shared"
        owner_agent: OwnerAgentInfo | None = None
        branch_info: BranchInfo | None = None
        published_version: str | None = None
        published_version_id: str | None = None
        document_count = 0

        if is_shared:
            published_version_id = base.published_version_id
            if published_version_id:
                published_version = published_version_label_by_id.get(published_version_id)
                document_count = document_count_by_version.get(published_version_id, 0)
        else:
            owner_id = _owner_agent_id(base)
            if owner_id is not None:
                owner_name = owner_name_by_id.get(owner_id)
                if owner_name:
                    owner_agent = OwnerAgentInfo(id=owner_id, name=owner_name)
                branch = owner_branch_by_base.get(base.id)
                if branch is not None:
                    branch_info = BranchInfo(
                        base_version=branch.base_version,
                        head_version=branch.head_version,
                        sync_state=branch.sync_state,
                    )
                    version_id = head_version_id_by_base.get(base.id)
                    if version_id:
                        document_count = document_count_by_version.get(version_id, 0)

        items.append(
            ListedKnowledgeBase(
                id=base.id,
                name=base.name,
                description=base.description,
                mode=base.mode,
                status=base.status,
                capability_scope=normalize_capability_scope(base.capability_scope),
                published_version=published_version,
                published_version_id=published_version_id,
                draft_count=draft_count_by_base.get(base.id, 0),
                document_count=document_count,
                owner_agent=owner_agent,
                bound_teams=bound_teams_by_base.get(base.id, []),
                branch=branch_info,
                updated_at=base.updated_at,
            )
        )

    summary = KnowledgeBaseListSummary(
        total=len(items),
        shared=sum(1 for item in items if item.mode == "shared"),
        dedicated=sum(1 for item in items if item.mode != "shared"),
        documents=sum(item.document_count for item in items),
    )

    filtered = items
    if mode:
        filtered = [item for item in filtered if item.mode == mode]
    if status:
        filtered = [item for item in filtered if item.status == status]
    if owner_agent_id:
        filtered = [
            item for item in filtered if item.owner_agent and item.owner_agent.id == owner_agent_id
        ]
    if team_id:
        filtered = [
            item for item in filtered if any(team.id == team_id for team in item.bound_teams)
        ]
    if q:
        needle = q.strip().lower()
        if needle:
            filtered = [item for item in filtered if needle in item.name.lower()]

    filtered = sorted(filtered, key=lambda item: (-item.updated_at.timestamp(), item.id))

    total_filtered = len(filtered)
    page = filtered[offset : offset + limit]
    has_more = offset + limit < total_filtered

    return KnowledgeBaseListResult(
        items=page,
        summary=summary,
        total=total_filtered,
        offset=offset,
        limit=limit,
        has_more=has_more,
    )


def list_bindable_teams(
    db: Session,
    *,
    tenant_id: str,
    exclude_bound_to: str | None = None,
) -> list[BindableTeamOption]:
    """列出可绑定的活跃团队；exclude_bound_to 时排除已对该库有活跃绑定的团队。"""
    excluded_team_ids: set[str] = set()
    if exclude_bound_to:
        excluded_team_ids = set(
            db.exec(
                select(TeamKnowledgeBaseBinding.team_id).where(
                    TeamKnowledgeBaseBinding.tenant_id == tenant_id,
                    TeamKnowledgeBaseBinding.knowledge_base_id == exclude_bound_to,
                    TeamKnowledgeBaseBinding.status == "active",
                )
            ).all()
        )

    teams = db.exec(
        select(Team)
        .where(Team.tenant_id == tenant_id, Team.status == "active")
        .order_by(Team.name.asc())
    ).all()
    candidate_teams = [team for team in teams if team.id not in excluded_team_ids]

    member_counts: dict[str, int] = {}
    if candidate_teams:
        candidate_ids = [team.id for team in candidate_teams]
        member_counts = dict(
            db.exec(
                select(TeamMember.team_id, func.count(TeamMember.id))
                .where(TeamMember.team_id.in_(candidate_ids))
                .group_by(TeamMember.team_id)
            ).all()
        )
        member_counts = {team_id: int(count) for team_id, count in member_counts.items()}

    return [
        BindableTeamOption(id=team.id, name=team.name, member_count=member_counts.get(team.id, 0))
        for team in candidate_teams
    ]

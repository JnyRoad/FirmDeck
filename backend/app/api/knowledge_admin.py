"""知识库管理端（knowledge-base-admin）租户级只读端点：A1 列表、A6 可绑定群组候选。

仅负责鉴权（`ensure_tenant_admin`）、参数校验与把 `app.knowledge.listing` 的纯查询
结果投影为响应模型；聚合与过滤逻辑一律留在 listing.py，本文件不直接操作 ORM。
后续任务（草稿/对比/变基/审阅）继续往这个 router 追加路由。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.api.knowledge_bases import _shared_version_lookup, _shared_version_read
from app.contracts.domain_http import domain_http_error
from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.db import get_session
from app.db.models import KnowledgeBase, KnowledgeBaseVersion, KnowledgeDocument, User
from app.knowledge.diff import DEFAULT_MAX_LINES, diff_versions, document_lineage_id
from app.knowledge.errors import KnowledgeError
from app.knowledge.listing import (
    ListedKnowledgeBase,
    active_document_status_filter,
    get_tenant_knowledge_base,
    list_bindable_teams,
    list_tenant_knowledge_bases,
)
from app.knowledge.management import (
    require_shared_knowledge_history_viewer,
    require_team_knowledge_manager,
)
from app.knowledge.rebase import RebasePreview, RebaseResult, apply_rebase, preview_rebase
from app.knowledge.schema import (
    DiffDocumentRead,
    DiffHunkRead,
    KnowledgeAdminBoundTeamRead,
    KnowledgeAdminBranchRead,
    KnowledgeAdminListItem,
    KnowledgeAdminListResponse,
    KnowledgeAdminListSummary,
    KnowledgeAdminOwnerAgentRead,
    KnowledgeAdminTeamOption,
    KnowledgeBaseMode,
    KnowledgeBaseVersionRead,
    KnowledgeDraftReviewRequest,
    KnowledgeRebaseAutoMergedRead,
    KnowledgeRebaseConflictBlockRead,
    KnowledgeRebaseConflictRead,
    KnowledgeRebasePreviewRead,
    KnowledgeRebaseRequest,
    KnowledgeRebaseResolveRequest,
    KnowledgeRebaseResultRead,
    VersionDiffRead,
    VersionDiffSummary,
    VersionDocumentRead,
)
from app.knowledge.versioning import SharedKnowledgeVersionService
from app.security.auth import get_current_user
from app.security.permissions import ensure_tenant_admin, is_admin_user
from app.security.tenant import ensure_tenant

router = APIRouter(
    prefix="/api/enterprise/knowledge-admin",
    tags=["enterprise:knowledge-admin"],
    dependencies=[Depends(get_current_user)],
)


def _project_knowledge_admin_list_item(item: ListedKnowledgeBase) -> KnowledgeAdminListItem:
    """把 `listing.py` 的聚合结果投影为 A1/A1b 共用的响应模型。

    抽成独立函数供 A1（列表）与 A1b（单库详情）复用，保证两个端点返回同一套字段与
    聚合口径（draft_count/document_count/owner_agent/bound_teams/branch），不会因为
    各自维护一份投影逻辑而漂移。
    """
    return KnowledgeAdminListItem(
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
        items=[_project_knowledge_admin_list_item(item) for item in result.items],
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


@router.get("/knowledge-bases/{kb_id}", response_model=KnowledgeAdminListItem)
def get_knowledge_admin_base(
    kb_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> KnowledgeAdminListItem:
    """A1b：admin-first 单库详情，返回形状与 A1 列表项完全一致（含专用库 `branch`）。

    修复缺陷 1（`.superpowers/sdd/tasks/task-T077-report.md` Defect 1）：详情页此前
    复用员工侧 `GET /knowledge-bases/{kb_id}`，缺 `agent_id` 时该端点只对 open-gallery
    库放行，导致管理员打开任意共享/专用库详情一律 404。这里不要求 `agent_id`，管理员
    对租户内全部知识库可见，鉴权与存在性口径与 A1 完全一致（`ensure_tenant_admin` +
    tenant-scoped 查找，跨租户/不存在一律 404 `KNOWLEDGE_BASE_NOT_FOUND`，不做区分）。
    """
    ensure_tenant_admin(tenant_id, current_user)
    ensure_tenant(db, tenant_id)
    item = get_tenant_knowledge_base(db, tenant_id=tenant_id, knowledge_base_id=kb_id)
    if item is None:
        raise domain_http_error(
            "KNOWLEDGE_BASE_NOT_FOUND", source="knowledge_admin", status_code=404
        )
    return _project_knowledge_admin_list_item(item)


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


def _knowledge_error_to_http(exc: KnowledgeError) -> HTTPException:
    """把共享知识库领域错误（如 KNOWLEDGE_GRANT_REQUIRED）映射为稳定 HTTP 载荷；

    未注册或非公开的 code 一律 fail-closed 到 INTERNAL_ERROR（复用 teams.py 里
    `_knowledge_http_error` 的既有转换模式，保证 code 在静态检查下可追溯到注册表）。
    """
    entry = ERROR_REGISTRY.get(exc.code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        params: dict[str, object] = {}
    else:
        params = dict(exc.to_descriptor().params)
    return domain_http_error(
        entry.code,
        source="knowledge_admin",
        status_code=exc.status_code,
        params=params,
        cause=exc,
    )


def _load_admin_diff_base(
    db: Session, *, tenant_id: str, knowledge_base_id: str
) -> KnowledgeBase:
    """租户管理员旁路：只校验知识库存在且属于该租户，不限制 mode（专用库也可对比）。

    `require_shared_knowledge_history_viewer` 会先校验 `mode == "shared"` 才判定 admin/
    owner 权限，导致 dedicated 库上连管理员都被 409 拒绝；A2 契约要求"admin 或该库
    history viewer"两者任一放行，因此 admin 分支必须绕开共享库专属的 mode 校验。

    错误口径与 `_load_admin_diff_version` 统一（I3 修复轮次）：资源压根不存在→404
    `KNOWLEDGE_BASE_NOT_FOUND`；存在但跨租户/跨库→403 `KNOWLEDGE_CONTEXT_MISMATCH`。
    此前知识库缺失返回 403、版本缺失返回 404，前端无法一致映射同一类"找不到"。
    """
    base = db.get(KnowledgeBase, knowledge_base_id)
    if base is None:
        raise domain_http_error(
            "KNOWLEDGE_BASE_NOT_FOUND", source="knowledge_admin", status_code=404
        )
    if base.tenant_id != tenant_id:
        raise domain_http_error(
            "KNOWLEDGE_CONTEXT_MISMATCH", source="knowledge_admin", status_code=403
        )
    return base


def _load_admin_diff_version(
    db: Session, *, tenant_id: str, knowledge_base_id: str, version_id: str
) -> KnowledgeBaseVersion:
    """按契约 A2 解析对比版本：不存在→KNOWLEDGE_BASE_NOT_FOUND（404），跨租户/跨库→
    KNOWLEDGE_CONTEXT_MISMATCH（403）；与 `_load_admin_diff_base` 同一套存在性策略。"""
    version = db.get(KnowledgeBaseVersion, version_id)
    if version is None:
        raise domain_http_error("KNOWLEDGE_BASE_NOT_FOUND", source="knowledge_admin", status_code=404)
    if version.tenant_id != tenant_id or version.knowledge_base_id != knowledge_base_id:
        raise domain_http_error(
            "KNOWLEDGE_CONTEXT_MISMATCH", source="knowledge_admin", status_code=403
        )
    return version


@router.get(
    "/knowledge-bases/{kb_id}/versions/{version_id}/diff",
    response_model=VersionDiffRead,
)
def get_knowledge_admin_version_diff(
    kb_id: str,
    version_id: str,
    tenant_id: str = Query(...),
    against: Literal["base", "published"] = Query("base"),
    max_lines: int = Query(DEFAULT_MAX_LINES, ge=1, le=50_000),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> VersionDiffRead:
    """A2：版本对比，租户管理员或该库的 history viewer（共享库的团队所有者）均可访问。

    管理员走 `_load_admin_diff_base` 旁路（只校验存在且同租户，不限制 mode），因此专用库
    对管理员同样可用；非管理员一律走 `require_shared_knowledge_history_viewer`（仅共享库、
    仅 admin 或活跃绑定团队所有者放行，专用库对非管理员维持 409 拒绝）。

    `against=base`（默认）对比目标版本的 `parent_version_id`；`against=published` 对比
    知识库当前正式版本 `published_version_id`；两者缺失时视为空文档集合，目标版本的
    全部文档都判定为新增。鉴权、参数校验之外的聚合逻辑一律留在 `app.knowledge.diff`。

    错误口径：知识库或版本不存在→404 `KNOWLEDGE_BASE_NOT_FOUND`；存在但跨租户/跨库→
    403 `KNOWLEDGE_CONTEXT_MISMATCH`。`status='archived'` 的文档按 data-model §3 视为
    该版本内已删除，会被判定为 `deleted` 而不是原样比对。
    """
    ensure_tenant(db, tenant_id)
    if current_user.tenant_id == tenant_id and is_admin_user(current_user):
        knowledge_base = _load_admin_diff_base(db, tenant_id=tenant_id, knowledge_base_id=kb_id)
    else:
        try:
            knowledge_base = require_shared_knowledge_history_viewer(
                db, tenant_id=tenant_id, knowledge_base_id=kb_id, current_user=current_user
            )
        except KnowledgeError as exc:
            raise _knowledge_error_to_http(exc) from exc

    target_version = _load_admin_diff_version(
        db, tenant_id=tenant_id, knowledge_base_id=kb_id, version_id=version_id
    )

    if against == "published":
        base_version_id = knowledge_base.published_version_id
    else:
        base_version_id = target_version.parent_version_id
    if base_version_id:
        _load_admin_diff_version(
            db, tenant_id=tenant_id, knowledge_base_id=kb_id, version_id=base_version_id
        )

    result = diff_versions(
        db,
        tenant_id=tenant_id,
        base_version_id=base_version_id,
        target_version_id=version_id,
        max_lines=max_lines,
    )
    return VersionDiffRead(
        base_version_id=result.base_version_id,
        target_version_id=result.target_version_id,
        pairing=result.pairing,
        summary=VersionDiffSummary(
            added=result.summary.added,
            modified=result.summary.modified,
            deleted=result.summary.deleted,
        ),
        documents=[
            DiffDocumentRead(
                lineage_id=document.lineage_id,
                title=document.title,
                kind=document.kind,
                truncated=document.truncated,
                base_document_id=document.base_document_id,
                target_document_id=document.target_document_id,
                base_updated_at=document.base_updated_at,
                target_updated_at=document.target_updated_at,
                hunks=[
                    DiffHunkRead(
                        type=hunk.type,
                        base_start=hunk.base_start,
                        base_lines=hunk.base_lines,
                        target_start=hunk.target_start,
                        target_lines=hunk.target_lines,
                        pairs=[list(pair) for pair in hunk.pairs],
                    )
                    for hunk in document.hunks
                ],
            )
            for document in result.documents
        ],
    )


@router.get(
    "/knowledge-bases/{kb_id}/versions/{version_id}/documents",
    response_model=list[VersionDocumentRead],
)
def list_knowledge_admin_version_documents(
    kb_id: str,
    version_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[VersionDocumentRead]:
    """A2b：该版本全部文档（含未改动），供 US2-b 写回按真实行 `id` 定位，而不是误用
    只在指向源文档时才准确的 `lineage_id`（草稿文档是克隆行）。

    鉴权与错误语义与 A2 完全一致：租户管理员走 `_load_admin_diff_base` 旁路（不限制
    mode），非管理员一律走 `require_shared_knowledge_history_viewer`；知识库或版本不存在→
    `KNOWLEDGE_BASE_NOT_FOUND`，跨租户/跨库→`KNOWLEDGE_CONTEXT_MISMATCH`。结果按
    `title` 再 `id` 稳定排序，与插入顺序、id 生成顺序无关。

    `status='archived'` 的文档按 data-model §3 表示"草稿内已删除"，与 A2 对比口径一致地
    排除在列表之外（行本身保留，仅对消费方不可见）。
    """
    ensure_tenant(db, tenant_id)
    if current_user.tenant_id == tenant_id and is_admin_user(current_user):
        _load_admin_diff_base(db, tenant_id=tenant_id, knowledge_base_id=kb_id)
    else:
        try:
            require_shared_knowledge_history_viewer(
                db, tenant_id=tenant_id, knowledge_base_id=kb_id, current_user=current_user
            )
        except KnowledgeError as exc:
            raise _knowledge_error_to_http(exc) from exc

    _load_admin_diff_version(
        db, tenant_id=tenant_id, knowledge_base_id=kb_id, version_id=version_id
    )

    rows = db.exec(
        select(KnowledgeDocument)
        .where(
            KnowledgeDocument.tenant_id == tenant_id,
            KnowledgeDocument.knowledge_base_version_id == version_id,
            active_document_status_filter(),
        )
        .order_by(KnowledgeDocument.title, KnowledgeDocument.id)
    ).all()
    return [
        VersionDocumentRead(
            id=row.id,
            lineage_id=document_lineage_id(row),
            title=row.title or row.filename,
            filename=row.filename,
            status=row.status,
            bucket_count=row.bucket_count,
            chunk_count=row.chunk_count,
            updated_at=row.updated_at.isoformat(),
        )
        for row in rows
    ]


def _rebase_conflict_block_read(block: object) -> KnowledgeRebaseConflictBlockRead:
    """投影一个交叠冲突块（`app.knowledge.rebase.ConflictBlock`）为响应模型。"""
    return KnowledgeRebaseConflictBlockRead(
        base_lines=list(block.base_lines),
        ours_lines=list(block.ours_lines),
        theirs_lines=list(block.theirs_lines),
        context_before=list(block.context_before),
        context_after=list(block.context_after),
    )


def _rebase_preview_read(preview: RebasePreview) -> KnowledgeRebasePreviewRead:
    """投影变基预览（有冲突、未落库）为 A3 响应模型。"""
    return KnowledgeRebasePreviewRead(
        draft_version_id=preview.draft_version_id,
        from_base_version_id=preview.from_base_version_id,
        to_base_version_id=preview.to_base_version_id,
        auto_merged=[
            KnowledgeRebaseAutoMergedRead(
                lineage_id=item.lineage_id, title=item.title, source=item.source
            )
            for item in preview.auto_merged
        ],
        conflicts=[
            KnowledgeRebaseConflictRead(
                lineage_id=conflict.lineage_id,
                title=conflict.title,
                blocks=[_rebase_conflict_block_read(block) for block in conflict.blocks],
                merged_text=conflict.merged_text,
            )
            for conflict in preview.conflicts
        ],
    )


def _rebase_result_read(
    db: Session, *, tenant_id: str, knowledge_base_id: str, result: RebaseResult
) -> KnowledgeRebaseResultRead:
    """投影落库结果（新草稿快照 + 被替换旧快照 id）为 A3/A4 共用响应模型。"""
    kb = db.get(KnowledgeBase, knowledge_base_id)
    label_by_id, released_labels, all_labels = _shared_version_lookup(
        db, tenant_id=tenant_id, knowledge_base_id=knowledge_base_id
    )
    new_version_read = _shared_version_read(
        result.new_version,
        published_version_id=kb.published_version_id if kb else None,
        version_label_by_id=label_by_id,
        released_labels=released_labels,
        all_labels=all_labels,
    )
    return KnowledgeRebaseResultRead(
        new_version=new_version_read,
        superseded_version_id=result.superseded_version_id,
    )


@router.post(
    "/knowledge-bases/{kb_id}/versions/{version_id}/rebase",
    response_model=KnowledgeRebasePreviewRead | KnowledgeRebaseResultRead,
)
def rebase_knowledge_admin_draft(
    kb_id: str,
    version_id: str,
    request: KnowledgeRebaseRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> KnowledgeRebasePreviewRead | KnowledgeRebaseResultRead:
    """A3：admin 或团队 manager 计算三方合并；无冲突直接落库返回 RebaseResult，
    有冲突原样返回 RebasePreview（不落库），前端需逐块解决后调用 A4 resolve。
    """
    ensure_tenant(db, request.tenant_id)
    try:
        context = require_team_knowledge_manager(
            db,
            tenant_id=request.tenant_id,
            team_id=request.team_id,
            knowledge_base_id=kb_id,
            current_user=current_user,
        )
        preview = preview_rebase(
            db,
            tenant_id=request.tenant_id,
            knowledge_base_id=kb_id,
            draft_version_id=version_id,
            expected_updated_at=request.expected_updated_at,
        )
        if preview.conflicts:
            return _rebase_preview_read(preview)
        result = apply_rebase(
            db,
            tenant_id=request.tenant_id,
            knowledge_base_id=kb_id,
            draft_version_id=version_id,
            to_base_version_id=preview.to_base_version_id,
            resolutions={},
            actor_type="user",
            actor_id=current_user.id,
            source_team_id=context.team.id if context.team else None,
            change_reason=request.change_reason,
            expected_updated_at=request.expected_updated_at,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(),
        )
    except KnowledgeError as exc:
        # 与 knowledge_bases.py 的写路由一致：失败时显式回滚，不把半途的 flush 结果
        # 留在会话里等待连接关闭时被动回滚。
        db.rollback()
        raise _knowledge_error_to_http(exc) from exc
    db.commit()
    return _rebase_result_read(
        db, tenant_id=request.tenant_id, knowledge_base_id=kb_id, result=result
    )


@router.post(
    "/knowledge-bases/{kb_id}/versions/{version_id}/rebase/resolve",
    response_model=KnowledgeRebaseResultRead,
)
def resolve_knowledge_admin_rebase(
    kb_id: str,
    version_id: str,
    request: KnowledgeRebaseResolveRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> KnowledgeRebaseResultRead:
    """A4：提交每篇冲突文档的最终合并结果，校验 to_base 未变、解决完整且无残留冲突标记后落库。"""
    ensure_tenant(db, request.tenant_id)
    resolutions = {item.lineage_id: item.content_md for item in request.resolutions}
    try:
        context = require_team_knowledge_manager(
            db,
            tenant_id=request.tenant_id,
            team_id=request.team_id,
            knowledge_base_id=kb_id,
            current_user=current_user,
        )
        result = apply_rebase(
            db,
            tenant_id=request.tenant_id,
            knowledge_base_id=kb_id,
            draft_version_id=version_id,
            to_base_version_id=request.to_base_version_id,
            resolutions=resolutions,
            actor_type="user",
            actor_id=current_user.id,
            source_team_id=context.team.id if context.team else None,
            change_reason=request.change_reason,
            expected_updated_at=request.expected_updated_at,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(),
        )
    except KnowledgeError as exc:
        db.rollback()
        raise _knowledge_error_to_http(exc) from exc
    db.commit()
    return _rebase_result_read(
        db, tenant_id=request.tenant_id, knowledge_base_id=kb_id, result=result
    )


@router.post(
    "/knowledge-bases/{kb_id}/versions/{version_id}/review",
    response_model=KnowledgeBaseVersionRead,
)
def review_knowledge_admin_draft(
    kb_id: str,
    version_id: str,
    request: KnowledgeDraftReviewRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> KnowledgeBaseVersionRead:
    """A5：把审阅编辑器的暂存/待处理统计写入草稿 `metadata_json.review`，admin 或团队 manager 均可。

    鉴权与 A3/A4 一致复用 `require_team_knowledge_manager`；乐观锁校验、审计
    `draft_reviewed` 与事件 `knowledge.draft.reviewed` 都在 `SharedKnowledgeVersionService.
    record_review` 内完成，本路由只负责鉴权与响应投影。
    """
    ensure_tenant(db, request.tenant_id)
    try:
        context = require_team_knowledge_manager(
            db,
            tenant_id=request.tenant_id,
            team_id=request.team_id,
            knowledge_base_id=kb_id,
            current_user=current_user,
        )
        draft = SharedKnowledgeVersionService(db).record_review(
            tenant_id=request.tenant_id,
            knowledge_base_id=kb_id,
            draft_version_id=version_id,
            staged=request.staged,
            pending=request.pending,
            documents_adjusted=request.documents_adjusted,
            expected_updated_at=request.expected_updated_at,
            actor_type="user",
            actor_id=current_user.id,
            source_team_id=context.team.id if context.team else None,
        )
    except KnowledgeError as exc:
        db.rollback()
        raise _knowledge_error_to_http(exc) from exc
    # `get_session` 不自动提交（`with Session(engine) as session: yield session`），
    # 与 knowledge_bases.py 里所有写路由一致：service 层只 flush，路由必须显式提交
    # 才能让审阅写回跨请求持久化，而不是在响应返回后随会话关闭被丢弃。
    db.commit()
    kb = db.get(KnowledgeBase, kb_id)
    label_by_id, released_labels, all_labels = _shared_version_lookup(
        db, tenant_id=request.tenant_id, knowledge_base_id=kb_id
    )
    return _shared_version_read(
        draft,
        published_version_id=kb.published_version_id if kb else None,
        version_label_by_id=label_by_id,
        released_labels=released_labels,
        all_labels=all_labels,
    )

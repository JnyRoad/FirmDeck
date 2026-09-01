from __future__ import annotations

import base64
import json
import logging
import re
import zipfile
from collections.abc import Iterator
from io import BytesIO
from time import sleep
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from app.agents.branching import (
    branch_versions,
    ensure_agent_skill_branch,
    ensure_open_gallery_binding,
    ensure_private_resource_binding,
    get_agent,
    hide_open_gallery_binding,
    is_bound_resource_visible_for_agent,
    is_open_gallery_resource,
    mark_resource_open_gallery,
    project_skill_with_branch,
    require_overall_agent,
    rollback_branch,
    update_branch_skill,
    user_creator_metadata,
    visible_knowledge_base_versions,
    visible_skill_rows,
    visible_tool_rows,
)
from app.async_jobs import enqueue_async_job
from app.contracts.domain_http import domain_http_error
from app.contracts.event_registry import EVENT_REGISTRY
from app.db import engine, get_session
from app.db.models import (
    AgentEvent,
    AgentResourceBinding,
    AgentSkillBranchVersion,
    ChannelBinding,
    ChannelIdentity,
    GeneralSkill,
    ModelConfig,
    Skill,
    SkillFeedback,
    SkillVersion,
    Tool,
    User,
    utc_now,
)
from app.i18n.language_context import LanguageContext
from app.llm import LLMError
from app.llm.model_config_resolver import resolve_model_config_for_runtime
from app.security.auth import ensure_current_user_tenant, get_current_user
from app.security.permissions import (
    ensure_agent_scope_manager,
    ensure_open_gallery_admin,
    require_agent_scope_viewer,
)
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDenied,
    ensure_tenant,
    require_active_tenant,
)
from app.skills import SkillDistiller, SkillEditor
from app.skills.nesting import (
    SopNestingError,
    nested_sop_ids,
    sop_capability_scope,
    validate_sop_nesting,
)
from app.skills.skill_schema import (
    SkillCard,
    SkillCreateRequest,
    SkillDistillRequest,
    SkillDistillResponse,
    SkillFileExtractRequest,
    SkillFileExtractResponse,
    SkillRead,
    SkillRewriteRequest,
    SkillRewriteResponse,
    SkillUpdateRequest,
    SkillVersionRead,
    resolve_skill_language_context,
    skill_card_from_persisted,
)
from app.skills.step_ids import skill_card_with_unique_step_ids
from app.skills.stream_jobs import SkillStreamEvent, SkillStreamJob, stream_jobs

_CHANNEL_LABELS = {"wechat": "微信", "wecom": "企业微信", "feishu": "飞书", "dingtalk": "钉钉"}

router = APIRouter(
    prefix="/api/enterprise/skills",
    tags=["enterprise:skills"],
    dependencies=[Depends(get_current_user)],
)
logger = logging.getLogger(__name__)


def _skill_stream_lifecycle_active(tenant_id: str, correlation_id: str) -> bool:
    """Recheck the authoritative tenant state before a Skill stream emits or persists an event."""
    try:
        with Session(engine) as lifecycle_db:
            require_active_tenant(
                lifecycle_db,
                tenant_id,
                TenantExecutionKind.JOB_CLAIM,
                correlation_id,
            )
    except Exception:  # noqa: BLE001 - lifecycle reads fail closed for any backend failure.
        return False
    return True


def _require_skill_stream_lifecycle(tenant_id: str, correlation_id: str) -> None:
    """Reject a Skill stream before creating a job or exposing its first event."""
    try:
        with Session(engine) as lifecycle_db:
            require_active_tenant(
                lifecycle_db,
                tenant_id,
                TenantExecutionKind.JOB_CLAIM,
                correlation_id,
            )
    except TenantLifecycleDenied as exc:
        if exc.code == "TENANT_SUSPENDED":
            raise _skill_error("TENANT_SUSPENDED", 403) from None
        raise _skill_error("TENANT_LIFECYCLE_CHECK_FAILED", 503) from None
    except Exception:  # noqa: BLE001 - project every lifecycle backend failure to one safe code.
        raise _skill_error("TENANT_LIFECYCLE_CHECK_FAILED", 503) from None


def _skill_error(
    code: str,
    status_code: int,
    *,
    params: dict[str, object] | None = None,
    retryable: bool | None = None,
    cause: BaseException | None = None,
) -> HTTPException:
    """Return a canonical SOP error while keeping raw validation/provider text private."""
    return domain_http_error(
        code,
        source="skills.api",
        status_code=status_code,
        params=params,
        retryable=retryable,
        cause=cause,
    )


def skill_read(
    row: Skill,
    stats: dict[str, dict[str, float | int]] | None = None,
    recent_stats: dict[str, dict[str, object]] | None = None,
) -> SkillRead:
    all_stats = stats or {}
    skill_stats = _stats_for(all_stats, row.skill_id, row.version)
    total_stats = all_stats.get(row.skill_id, {})
    recent_skill_stats = (recent_stats or {}).get(row.skill_id, {})
    content, _warnings = skill_card_with_unique_step_ids(
        skill_card_from_persisted(row.content_json)
    )
    branch_meta = getattr(row, "agent_branch_meta", {}) or {}
    return SkillRead(
        id=row.id,
        tenant_id=row.tenant_id,
        skill_id=row.skill_id,
        version=row.version,
        name=row.name,
        business_domain=row.business_domain,
        description=row.description,
        content=content,
        status=row.status,
        call_count=int(skill_stats.get("call_count", 0)),
        positive_feedback_count=int(skill_stats.get("positive_feedback_count", 0)),
        negative_feedback_count=int(skill_stats.get("negative_feedback_count", 0)),
        positive_rate=float(skill_stats.get("positive_rate", 0.0)),
        negative_rate=float(skill_stats.get("negative_rate", 0.0)),
        total_call_count=int(total_stats.get("call_count", 0)),
        total_positive_feedback_count=int(total_stats.get("positive_feedback_count", 0)),
        total_negative_feedback_count=int(total_stats.get("negative_feedback_count", 0)),
        total_positive_rate=float(total_stats.get("positive_rate", 0.0)),
        total_negative_rate=float(total_stats.get("negative_rate", 0.0)),
        recent_versions=list(recent_skill_stats.get("recent_versions", [])),
        recent_call_count=int(recent_skill_stats.get("call_count", 0)),
        recent_positive_feedback_count=int(recent_skill_stats.get("positive_feedback_count", 0)),
        recent_negative_feedback_count=int(recent_skill_stats.get("negative_feedback_count", 0)),
        recent_positive_rate=float(recent_skill_stats.get("positive_rate", 0.0)),
        recent_negative_rate=float(recent_skill_stats.get("negative_rate", 0.0)),
        agent_id=branch_meta.get("agent_id"),
        branch_status=branch_meta.get("status"),
        branch_sync_state=branch_meta.get("sync_state"),
        branch_base_version=branch_meta.get("base_version"),
        branch_head_version=branch_meta.get("head_version"),
        metadata=dict(branch_meta.get("metadata") or {}),
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


def skill_version_read(
    row: SkillVersion, stats: dict[str, dict[str, float | int]] | None = None
) -> SkillVersionRead:
    skill_stats = _stats_for(stats or {}, row.skill_id, row.version)
    content, _warnings = skill_card_with_unique_step_ids(
        skill_card_from_persisted(row.content_json)
    )
    return SkillVersionRead(
        id=row.id,
        tenant_id=row.tenant_id,
        skill_id=row.skill_id,
        version=row.version,
        name=row.name,
        business_domain=row.business_domain,
        description=row.description,
        content=content,
        status=row.status,
        call_count=int(skill_stats.get("call_count", 0)),
        positive_feedback_count=int(skill_stats.get("positive_feedback_count", 0)),
        negative_feedback_count=int(skill_stats.get("negative_feedback_count", 0)),
        positive_rate=float(skill_stats.get("positive_rate", 0.0)),
        negative_rate=float(skill_stats.get("negative_rate", 0.0)),
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


def _branch_version_read(row: AgentSkillBranchVersion) -> SkillVersionRead:
    content, _warnings = skill_card_with_unique_step_ids(
        skill_card_from_persisted(row.content_json)
    )
    return SkillVersionRead(
        id=row.id,
        tenant_id=row.tenant_id,
        skill_id=row.skill_id,
        version=row.version,
        name=content.name,
        business_domain=content.business_domain,
        description=content.description,
        content=content,
        status=row.status,
        call_count=0,
        positive_feedback_count=0,
        negative_feedback_count=0,
        positive_rate=0.0,
        negative_rate=0.0,
        agent_id=row.agent_id,
        branch_sync_state=row.sync_state,
        branch_base_version=row.base_version,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.get("", response_model=list[SkillRead], dependencies=[Depends(require_agent_scope_viewer)])
def list_skills(
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    agent_id: str | None = None,
) -> list[SkillRead]:
    ensure_tenant(db, tenant_id)
    rows = visible_skill_rows(db, tenant_id, agent_id, include_inactive=True)
    stats = _skill_stats(db, tenant_id)
    recent_stats = _recent_skill_stats(db, tenant_id, stats)
    return [skill_read(row, stats, recent_stats) for row in rows]


def _validate_handoff_assignees(db: Session, content: SkillCard, tenant_id: str) -> None:
    """校验 SOP 人工节点的处理人:必须存在、同租户、source='web'(内部成员)。

    assignee_notify_channel 为 None 时按默认投递(网页收件箱,可达则渠道通知);
    为 "web" 时仅网页端;为具体渠道时要求该渠道支持私聊通知(有可用适配器),
    且该成员在租户内任一该渠道 active 员工绑定的作用域下绑定了非群聊渠道身份
    (scope 级可达,跨企业绑定不互通),否则渠道转接不可达。
    """
    assignee_specs = {
        (node.assignee_user_id.strip(), str(node.assignee_notify_channel or "").strip())
        for node in content.nodes
        if node.assignee_user_id and node.assignee_user_id.strip()
    }
    if not assignee_specs:
        return
    assignee_ids = {user_id for user_id, _ in assignee_specs}
    rows = db.exec(
        select(User).where(
            User.tenant_id == tenant_id,
            User.id.in_(assignee_ids),
        )
    ).all()
    found_ids = {row.id for row in rows}
    internal_ids = {row.id for row in rows if row.source == "web"}
    missing = assignee_ids - found_ids
    if missing:
        raise _skill_error("SKILL_HANDOFF_ASSIGNEE_NOT_FOUND", 400)
    non_internal = assignee_ids - internal_ids
    if non_internal:
        raise _skill_error("SKILL_HANDOFF_ASSIGNEE_EXTERNAL", 400)
    channel_specs = {
        (user_id, channel)
        for user_id, channel in assignee_specs
        if channel and channel != "web"
    }
    if not channel_specs:
        return
    # 渠道转接通知要求渠道支持主动私聊(飞书/企微);钉钉/微信适配器只能回
    # 会话内消息,无法私聊处理人,其余渠道一律拒绝,避免"配置成功但收不到通知"。
    from app.channels.service_outbox import HANDOFF_NOTIFY_CHANNELS

    unsupported = sorted({channel for _, channel in channel_specs if channel not in HANDOFF_NOTIFY_CHANNELS})
    if unsupported:
        raise _skill_error("SKILL_HANDOFF_CHANNEL_UNSUPPORTED", 400)
    channel_user_ids = {user_id for user_id, _ in channel_specs}
    # scope 级可达性:成员身份必须挂在租户内该渠道某个 active 员工绑定的
    # external_account_scope 下(跨企业/跨应用绑定不互通,不能仅按"绑定过该渠道"判断)。
    from app.channels.service_identity import external_account_scope as _binding_scope

    reachable_by_user: dict[str, set[str]] = {}
    for channel in {channel for _, channel in channel_specs}:
        bindings = [
            binding
            for binding in db.exec(
                select(ChannelBinding).where(
                    ChannelBinding.tenant_id == tenant_id,
                    ChannelBinding.channel == channel,
                    ChannelBinding.status == "active",
                )
            ).all()
            if not binding.team_id
        ]
        if not bindings:
            continue
        scopes = {_binding_scope(db, binding) for binding in bindings}
        identities = db.exec(
            select(ChannelIdentity).where(
                ChannelIdentity.tenant_id == tenant_id,
                ChannelIdentity.channel == channel,
                ChannelIdentity.staffdeck_user_id.in_(channel_user_ids),
                ~ChannelIdentity.external_user_id.startswith("group:"),
            )
        ).all()
        for identity in identities:
            if identity.external_account_scope in scopes:
                reachable_by_user.setdefault(identity.staffdeck_user_id, set()).add(channel)
    for user_id, channel in sorted(channel_specs):
        if channel not in reachable_by_user.get(user_id, set()):
            raise _skill_error("SKILL_HANDOFF_ASSIGNEE_UNREACHABLE", 400)


@router.post("", response_model=SkillRead)
def create_skill(
    request: SkillCreateRequest,
    agent_id: str | None = None,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    ensure_tenant(db, request.tenant_id)
    existing = db.exec(
        select(Skill).where(
            Skill.tenant_id == request.tenant_id, Skill.skill_id == request.content.skill_id
        )
    ).first()
    if existing:
        raise _skill_error("SKILL_ID_CONFLICT", 409)
    normalized_content, _warnings = skill_card_with_unique_step_ids(request.content)
    content = normalized_content.model_dump()
    _validate_handoff_assignees(db, normalized_content, request.tenant_id)
    agent = ensure_agent_scope_manager(db, request.tenant_id, agent_id, current_user)
    try:
        validate_sop_nesting(
            normalized_content.skill_id,
            content,
            visible_skill_rows(
                db,
                request.tenant_id,
                agent.id if agent else None,
                include_inactive=True,
            ),
        )
    except SopNestingError as exc:
        raise _skill_error("SKILL_NESTING_INVALID", 400, cause=exc) from exc
    row = Skill(
        tenant_id=request.tenant_id,
        skill_id=normalized_content.skill_id,
        version=normalized_content.version,
        name=normalized_content.name,
        business_domain=normalized_content.business_domain,
        description=normalized_content.description,
        content_json=content,
        status=request.status,
    )
    db.add(row)
    db.flush()
    _sync_skill_tool_bindings(db, request.tenant_id, row.skill_id, row.content_json)
    branch = None
    binding_status = "active" if request.status == "published" else "inactive"
    creator_metadata = user_creator_metadata(current_user)
    if agent and not agent.is_overall:
        ensure_private_resource_binding(
            db,
            request.tenant_id,
            agent.id,
            "skill",
            row.id,
            binding_status,
            metadata_json=creator_metadata,
        )
        branch = ensure_agent_skill_branch(
            db,
            request.tenant_id,
            agent.id,
            row,
            metadata_json=creator_metadata,
        )
    else:
        ensure_open_gallery_admin(request.tenant_id, current_user)
        mark_resource_open_gallery(row, creator_metadata)
        ensure_open_gallery_binding(
            db,
            request.tenant_id,
            "skill",
            row.id,
            binding_status,
            metadata_json=creator_metadata,
        )
    db.commit()
    db.refresh(row)
    _upsert_skill_version(db, row)
    stats = _skill_stats(db, request.tenant_id)
    if branch:
        row = project_skill_with_branch(row, branch, binding_status)
    return skill_read(row, stats, _recent_skill_stats(db, request.tenant_id, stats))


@router.get(
    "/{skill_id}", response_model=SkillRead, dependencies=[Depends(require_agent_scope_viewer)]
)
def get_skill(
    skill_id: str,
    tenant_id: str = Query(...),
    agent_id: str | None = None,
    db: Session = Depends(get_session),
) -> SkillRead:
    row = _get_visible_skill_for_scope(db, tenant_id, skill_id, agent_id)
    stats = _skill_stats(db, tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, tenant_id, stats))


@router.put("/{skill_id}", response_model=SkillRead)
def update_skill(
    skill_id: str,
    request: SkillUpdateRequest,
    agent_id: str | None = None,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    if request.content.skill_id != skill_id:
        raise _skill_error("SKILL_ID_IMMUTABLE", 400)
    row = _get_skill(db, request.tenant_id, skill_id)
    normalized_content, _warnings = skill_card_with_unique_step_ids(request.content)
    _validate_handoff_assignees(db, normalized_content, request.tenant_id)
    agent = ensure_agent_scope_manager(db, request.tenant_id, agent_id, current_user)
    try:
        validate_sop_nesting(
            normalized_content.skill_id,
            normalized_content.model_dump(),
            visible_skill_rows(
                db,
                request.tenant_id,
                agent.id if agent else None,
                include_inactive=True,
            ),
        )
    except SopNestingError as exc:
        raise _skill_error("SKILL_NESTING_INVALID", 400, cause=exc) from exc
    if agent and not agent.is_overall:
        binding = db.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.tenant_id == request.tenant_id,
                AgentResourceBinding.agent_id == agent.id,
                AgentResourceBinding.resource_type == "skill",
                AgentResourceBinding.resource_id == row.id,
                AgentResourceBinding.status != "deleted",
            )
        ).first()
        if not binding:
            raise _skill_error("SKILL_NOT_VISIBLE", 404)
        branch = update_branch_skill(
            db,
            request.tenant_id,
            agent.id,
            row,
            normalized_content.model_dump(),
            "技能分支改写",
        )
        _sync_skill_tool_bindings(
            db,
            request.tenant_id,
            row.skill_id,
            normalized_content.model_dump(),
        )
        db.commit()
        projected = project_skill_with_branch(row, branch, binding.status)
        stats = _skill_stats(db, request.tenant_id)
        return skill_read(projected, stats, _recent_skill_stats(db, request.tenant_id, stats))
    ensure_open_gallery_admin(request.tenant_id, current_user)
    row.version = normalized_content.version
    row.name = normalized_content.name
    row.business_domain = normalized_content.business_domain
    row.description = normalized_content.description
    row.content_json = normalized_content.model_dump()
    _sync_skill_tool_bindings(db, request.tenant_id, row.skill_id, row.content_json)
    if request.status:
        row.status = request.status
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    _upsert_skill_version(db, row)
    stats = _skill_stats(db, request.tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, request.tenant_id, stats))


@router.post("/{skill_id}/publish", response_model=SkillRead)
def publish_skill(
    skill_id: str,
    tenant_id: str = Query(...),
    agent_id: str | None = None,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    row = _get_skill(db, tenant_id, skill_id)
    agent = ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    validation_content = (
        ensure_agent_skill_branch(db, tenant_id, agent.id, row).content_json
        if agent and not agent.is_overall
        else row.content_json
    )
    try:
        validate_sop_nesting(
            row.skill_id,
            validation_content,
            visible_skill_rows(
                db,
                tenant_id,
                agent.id if agent else None,
                include_inactive=True,
            ),
        )
    except SopNestingError as exc:
        raise _skill_error("SKILL_NESTING_INVALID", 400, cause=exc) from exc
    if agent and not agent.is_overall:
        branch = ensure_agent_skill_branch(db, tenant_id, agent.id, row)
        branch.status = "active"
        branch.updated_at = utc_now()
        db.add(branch)
        _sync_skill_tool_bindings(db, tenant_id, row.skill_id, branch.content_json)
        ensure_private_resource_binding(db, tenant_id, agent.id, "skill", row.id, "active")
        db.commit()
        projected = project_skill_with_branch(row, branch, "active")
        stats = _skill_stats(db, tenant_id)
        return skill_read(projected, stats, _recent_skill_stats(db, tenant_id, stats))
    ensure_open_gallery_admin(tenant_id, current_user)
    row.status = "published"
    _sync_skill_tool_bindings(db, tenant_id, row.skill_id, row.content_json)
    mark_resource_open_gallery(row)
    row.updated_at = utc_now()
    db.add(row)
    db.flush()
    ensure_open_gallery_binding(db, tenant_id, "skill", row.id, "active")
    db.commit()
    db.refresh(row)
    _upsert_skill_version(db, row)
    stats = _skill_stats(db, tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, tenant_id, stats))


@router.post("/{skill_id}/archive", response_model=SkillRead)
def archive_skill(
    skill_id: str,
    tenant_id: str = Query(...),
    agent_id: str | None = None,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    row = _get_skill(db, tenant_id, skill_id)
    agent = ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    if agent and not agent.is_overall:
        branch = ensure_agent_skill_branch(db, tenant_id, agent.id, row)
        branch.status = "inactive"
        branch.updated_at = utc_now()
        db.add(branch)
        ensure_private_resource_binding(db, tenant_id, agent.id, "skill", row.id, "inactive")
        db.commit()
        projected = project_skill_with_branch(row, branch, "inactive")
        stats = _skill_stats(db, tenant_id)
        return skill_read(projected, stats, _recent_skill_stats(db, tenant_id, stats))
    ensure_open_gallery_admin(tenant_id, current_user)
    row.status = "archived"
    row.updated_at = utc_now()
    db.add(row)
    db.flush()
    ensure_open_gallery_binding(db, tenant_id, "skill", row.id, "inactive")
    db.commit()
    db.refresh(row)
    _upsert_skill_version(db, row)
    stats = _skill_stats(db, tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, tenant_id, stats))


@router.post("/{skill_id}/draft", response_model=SkillRead)
def draft_skill(
    skill_id: str,
    tenant_id: str = Query(...),
    agent_id: str | None = None,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    row = _get_skill(db, tenant_id, skill_id)
    agent = ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    if agent and not agent.is_overall:
        raise _skill_error("SKILL_ONLY_OVERALL_DRAFT", 403)
    ensure_open_gallery_admin(tenant_id, current_user)
    row.status = "draft"
    row.updated_at = utc_now()
    db.add(row)
    db.flush()
    ensure_open_gallery_binding(db, tenant_id, "skill", row.id, "inactive")
    db.commit()
    db.refresh(row)
    _upsert_skill_version(db, row)
    stats = _skill_stats(db, tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, tenant_id, stats))


@router.delete("/{skill_id}")
def delete_skill(
    skill_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    agent_id: str | None = None,
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    row = _get_skill(db, tenant_id, skill_id)
    agent = ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    if agent and not agent.is_overall:
        binding = db.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.tenant_id == tenant_id,
                AgentResourceBinding.agent_id == agent.id,
                AgentResourceBinding.resource_type == "skill",
                AgentResourceBinding.resource_id == row.id,
            )
        ).first()
        if not binding:
            binding = AgentResourceBinding(
                tenant_id=tenant_id,
                agent_id=agent.id,
                resource_type="skill",
                resource_id=row.id,
                status="deleted",
            )
        else:
            binding.status = "deleted"
            binding.updated_at = utc_now()
        branch = ensure_agent_skill_branch(db, tenant_id, agent.id, row)
        branch.status = "deleted"
        branch.updated_at = utc_now()
        db.add(binding)
        db.add(branch)
        db.commit()
        return {"status": "hidden"}
    if agent and agent.is_overall:
        if not is_open_gallery_resource(db, tenant_id, "skill", row):
            raise _skill_error("SKILL_GALLERY_NOT_VISIBLE", 404)
        ensure_open_gallery_admin(tenant_id, current_user)
        hide_open_gallery_binding(db, tenant_id, "skill", row.id)
        db.commit()
        return {"status": "hidden"}

    require_overall_agent(db, tenant_id, agent_id)
    ensure_open_gallery_admin(tenant_id, current_user)
    feedback_rows = db.exec(
        select(SkillFeedback).where(
            SkillFeedback.tenant_id == tenant_id,
            SkillFeedback.skill_id == skill_id,
        )
    ).all()
    for feedback in feedback_rows:
        db.delete(feedback)
    version_rows = db.exec(
        select(SkillVersion).where(
            SkillVersion.tenant_id == tenant_id, SkillVersion.skill_id == skill_id
        )
    ).all()
    for version_row in version_rows:
        db.delete(version_row)
    db.delete(row)
    db.commit()
    return {"status": "deleted"}


@router.get(
    "/{skill_id}/versions",
    response_model=list[SkillVersionRead],
    dependencies=[Depends(require_agent_scope_viewer)],
)
def list_skill_versions(
    skill_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    agent_id: str | None = None,
) -> list[SkillVersionRead]:
    row = _get_visible_skill_for_scope(db, tenant_id, skill_id, agent_id)
    agent = get_agent(db, tenant_id, agent_id)
    if agent and not agent.is_overall:
        rows = branch_versions(db, tenant_id, agent.id, skill_id)
        return [_branch_version_read(row) for row in rows]
    current_snapshot = db.exec(
        select(SkillVersion).where(
            SkillVersion.tenant_id == tenant_id,
            SkillVersion.skill_id == skill_id,
            SkillVersion.version == row.version,
        )
    ).first()
    if not current_snapshot:
        _upsert_skill_version(db, row)
    rows = db.exec(
        select(SkillVersion)
        .where(SkillVersion.tenant_id == tenant_id, SkillVersion.skill_id == skill_id)
        .order_by(SkillVersion.created_at.desc())
    ).all()
    stats = _skill_stats(db, tenant_id)
    return [skill_version_read(version_row, stats) for version_row in rows]


@router.get(
    "/{skill_id}/versions/{version}",
    response_model=SkillVersionRead,
    dependencies=[Depends(require_agent_scope_viewer)],
)
def get_skill_version(
    skill_id: str,
    version: str,
    tenant_id: str = Query(...),
    agent_id: str | None = None,
    db: Session = Depends(get_session),
) -> SkillVersionRead:
    _get_visible_skill_for_scope(db, tenant_id, skill_id, agent_id)
    agent = get_agent(db, tenant_id, agent_id)
    if agent and not agent.is_overall:
        row = next(
            (
                item
                for item in branch_versions(db, tenant_id, agent.id, skill_id)
                if item.version == version
            ),
            None,
        )
        if not row:
            raise _skill_error("SKILL_VERSION_NOT_FOUND", 404)
        return _branch_version_read(row)
    row = _get_skill_version(db, tenant_id, skill_id, version)
    return skill_version_read(row, _skill_stats(db, tenant_id))


@router.delete("/{skill_id}/versions/{version}")
def delete_skill_version(
    skill_id: str,
    version: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    skill = _get_skill(db, tenant_id, skill_id)
    ensure_open_gallery_admin(tenant_id, current_user)
    if skill.version == version:
        raise _skill_error("SKILL_ACTIVE_VERSION_DELETE_FORBIDDEN", 409)
    row = _get_skill_version(db, tenant_id, skill_id, version)
    db.delete(row)
    db.commit()
    return {"status": "deleted"}


@router.post("/{skill_id}/versions/{version}/rollback", response_model=SkillRead)
def rollback_skill_version(
    skill_id: str,
    version: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    agent_id: str | None = None,
    current_user: User = Depends(get_current_user),
) -> SkillRead:
    agent = ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    if agent and not agent.is_overall:
        branch = rollback_branch(db, tenant_id, agent.id, skill_id, version)
        db.commit()
        skill = _get_skill(db, tenant_id, skill_id)
        projected = project_skill_with_branch(skill, branch)
        stats = _skill_stats(db, tenant_id)
        return skill_read(projected, stats, _recent_skill_stats(db, tenant_id, stats))
    ensure_open_gallery_admin(tenant_id, current_user)
    row = _get_skill(db, tenant_id, skill_id)
    version_row = _get_skill_version(db, tenant_id, skill_id, version)
    normalized_content, _warnings = skill_card_with_unique_step_ids(
        skill_card_from_persisted(version_row.content_json)
    )
    normalized_content = normalized_content.model_copy(
        update={
            "version": version_row.version,
            "name": version_row.name,
            "business_domain": version_row.business_domain,
            "description": version_row.description or normalized_content.description,
        }
    )
    row.version = version_row.version
    row.name = version_row.name
    row.business_domain = version_row.business_domain
    row.description = version_row.description
    row.content_json = normalized_content.model_dump()
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    stats = _skill_stats(db, tenant_id)
    return skill_read(row, stats, _recent_skill_stats(db, tenant_id, stats))


@router.post("/files/extract", response_model=SkillFileExtractResponse)
def extract_skill_file(request: SkillFileExtractRequest) -> SkillFileExtractResponse:
    try:
        data = base64.b64decode(request.content_base64, validate=True)
    except ValueError as exc:
        raise _skill_error("SKILL_FILE_CONTENT_INVALID", 400, cause=exc) from exc
    if len(data) > 5 * 1024 * 1024:
        raise _skill_error("SKILL_FILE_TOO_LARGE", 413)
    text = _extract_uploaded_skill_file(request.filename, data)
    if not text.strip():
        raise _skill_error("SKILL_FILE_TEXT_MISSING", 400)
    return SkillFileExtractResponse(filename=request.filename, text=text)


@router.post("/distill", response_model=SkillDistillResponse)
def distill_skill(
    request: SkillDistillRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillDistillResponse:
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_distill_agent_scope(db, request, current_user)
    model_config = _get_request_model(db, request.tenant_id, request.model_config_id)
    request = _with_available_context_for_distill(db, request)
    request = _with_skill_language_context(request, current_user)
    try:
        return SkillDistiller().distill(request, model_config)
    except LLMError as exc:
        raise _skill_error("SKILL_UPSTREAM_FAILURE", 502, retryable=True, cause=exc) from exc


@router.post("/distill/stream")
def distill_skill_stream(
    request: SkillDistillRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_distill_agent_scope(db, request, current_user)
    correlation_id = f"skill-stream:{current_user.id}"
    _require_skill_stream_lifecycle(request.tenant_id, correlation_id)
    job_id = _start_distill_stream_job(request, current_user)
    return StreamingResponse(
        _stream_skill_job(
            job_id,
            tenant_id=request.tenant_id,
            correlation_id=correlation_id,
        ),
        media_type="text/event-stream",
    )


@router.post("/{skill_id}/rewrite/stream")
def rewrite_skill_stream(
    skill_id: str,
    request: SkillRewriteRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    if request.current_skill.skill_id != skill_id:
        raise _skill_error("SKILL_PATH_ID_MISMATCH", 400)
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_rewrite_agent_scope(db, request, current_user)
    request = _with_available_context_for_rewrite(db, request)
    correlation_id = f"skill-stream:{current_user.id}"
    _require_skill_stream_lifecycle(request.tenant_id, correlation_id)
    job_id = _start_rewrite_stream_job(skill_id, request, current_user)
    return StreamingResponse(
        _stream_skill_job(
            job_id,
            tenant_id=request.tenant_id,
            correlation_id=correlation_id,
        ),
        media_type="text/event-stream",
    )


@router.post("/distill/jobs")
def create_distill_job(
    request: SkillDistillRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_distill_agent_scope(db, request, current_user)
    return {"job_id": _start_distill_stream_job(request, current_user)}


@router.post("/{skill_id}/rewrite/jobs")
def create_rewrite_job(
    skill_id: str,
    request: SkillRewriteRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    if request.current_skill.skill_id != skill_id:
        raise _skill_error("SKILL_PATH_ID_MISMATCH", 400)
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_rewrite_agent_scope(db, request, current_user)
    request = _with_available_context_for_rewrite(db, request)
    return {"job_id": _start_rewrite_stream_job(skill_id, request, current_user)}


@router.get("/jobs/{job_id}")
def get_skill_stream_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    """Return a private stream snapshot with canonical error/status metadata only."""
    job = _owned_stream_job(job_id, current_user)
    return _skill_job_payload(job)


@router.get("/jobs/{job_id}/stream")
def stream_existing_skill_job(
    job_id: str,
    after_seq: int = Query(0),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    job = _owned_stream_job(job_id, current_user)
    correlation_id = f"skill-stream:{current_user.id}"
    _require_skill_stream_lifecycle(job.tenant_id, correlation_id)
    return StreamingResponse(
        _stream_skill_job(
            job_id,
            after_seq,
            tenant_id=job.tenant_id,
            correlation_id=correlation_id,
        ),
        media_type="text/event-stream",
    )


@router.post("/jobs/{job_id}/cancel")
def cancel_skill_stream_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Request private stream cancellation without publishing a locale-bound sentence."""
    _owned_stream_job(job_id, current_user)
    stream_jobs.cancel(job_id)
    stream_jobs.append(job_id, "status", {})
    return {"status": "cancel_requested", "job_id": job_id}


@router.post("/{skill_id}/rewrite", response_model=SkillRewriteResponse)
def rewrite_skill(
    skill_id: str,
    request: SkillRewriteRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SkillRewriteResponse:
    if request.current_skill.skill_id != skill_id:
        raise _skill_error("SKILL_PATH_ID_MISMATCH", 400)
    ensure_current_user_tenant(request.tenant_id, current_user)
    ensure_tenant(db, request.tenant_id)
    _ensure_rewrite_agent_scope(db, request, current_user)
    model_config = _get_request_model(db, request.tenant_id, request.model_config_id)
    request = _with_available_context_for_rewrite(db, request)
    request = _with_skill_language_context(request, current_user)
    try:
        return SkillEditor().rewrite(request, model_config)
    except (LLMError, ValueError) as exc:
        raise _skill_error("SKILL_UPSTREAM_FAILURE", 502, retryable=True, cause=exc) from exc


def _owned_stream_job(job_id: str, current_user: User) -> SkillStreamJob:
    """Enforce that a stream snapshot belongs to the requesting tenant and user."""
    job = stream_jobs.get(job_id)
    if not job or job.tenant_id != current_user.tenant_id or job.user_id != current_user.id:
        raise _skill_error("SKILL_JOB_NOT_FOUND", 404)
    return job


def _skill_language_context(
    request: SkillDistillRequest | SkillRewriteRequest,
    current_user: User,
) -> LanguageContext:
    """Resolve one immutable Skill snapshot with explicit request fields ahead of preferences."""
    return resolve_skill_language_context(
        request,
        user_ui_locale=getattr(current_user, "ui_locale", None),
        user_agent_reply_locale=getattr(current_user, "agent_reply_locale", None),
    )


def _with_skill_language_context(
    request: SkillDistillRequest | SkillRewriteRequest,
    current_user: User,
) -> SkillDistillRequest | SkillRewriteRequest:
    """Bind the snapshot to private context and durable scalar compatibility fields."""
    context = _skill_language_context(request, current_user)
    return request.model_copy(
        update={
            "language_context": context,
            "ui_locale": context.ui_locale,
            "agent_reply_locale": context.agent_reply_locale,
        }
    )


def _skill_error_payload(job: SkillStreamJob) -> dict[str, object] | None:
    """Serialize only a registry-validated stream error descriptor for API consumers."""
    return job.error.model_dump(mode="json") if job.error is not None else None


def _skill_terminal_event_code(job: SkillStreamJob) -> str:
    """Map a terminal in-memory status to the static Skill lifecycle event code."""
    prefix = "sop.rewrite" if job.name == "skill.rewrite" else "sop.generate"
    suffix = "failed" if job.status == "failed" else "succeeded"
    return f"{prefix}.{suffix}"


def _skill_job_payload(job: SkillStreamJob) -> dict[str, object]:
    """Build the private job read payload without exposing legacy status/error prose."""
    language_context = (
        job.language_context.model_dump(mode="json")
        if job.language_context is not None
        else None
    )
    return {
        "job_id": job.id,
        "name": job.name,
        "status": job.status,
        "error": _skill_error_payload(job),
        "language_context": language_context,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "last_seq": job.events[-1].seq if job.events else 0,
    }


def _skill_job_complete_payload(job: SkillStreamJob) -> dict[str, object]:
    """Build a key-localized terminal payload with canonical failure metadata only."""
    event_code = _skill_terminal_event_code(job)
    entry = EVENT_REGISTRY.get(event_code)
    language_context = (
        job.language_context.model_dump(mode="json")
        if job.language_context is not None
        else None
    )
    return {
        "job_id": job.id,
        "status": job.status,
        "code": event_code,
        "params": {"job_id": job.id},
        "message_key": entry.message_key if entry is not None else None,
        "language_context": language_context,
        "error": _skill_error_payload(job),
    }


def _start_distill_stream_job(request: SkillDistillRequest, current_user: User) -> str:
    """Create and enqueue a distillation stream with an immutable user locale snapshot."""
    request = _with_skill_language_context(request, current_user)
    language_context = request.language_context
    assert language_context is not None
    job = stream_jobs.create(
        "skill.distill",
        request.tenant_id,
        current_user.id,
        language_context=language_context,
    )
    stream_jobs.append(job.id, "job_started", {"job_id": job.id, "name": job.name})
    enqueue_async_job(
        "skill.distill_stream",
        _run_distill_stream_job,
        job.id,
        request.model_dump(mode="json"),
        metadata={
            "tenant_id": request.tenant_id,
            "job_id": job.id,
            "language_context": language_context.model_dump(mode="json"),
        },
    )
    return job.id


def _start_rewrite_stream_job(
    skill_id: str, request: SkillRewriteRequest, current_user: User
) -> str:
    """Create and enqueue a rewrite stream with an immutable user locale snapshot."""
    request = _with_skill_language_context(request, current_user)
    language_context = request.language_context
    assert language_context is not None
    job = stream_jobs.create(
        "skill.rewrite",
        request.tenant_id,
        current_user.id,
        language_context=language_context,
    )
    stream_jobs.append(
        job.id, "job_started", {"job_id": job.id, "name": job.name, "skill_id": skill_id}
    )
    enqueue_async_job(
        "skill.rewrite_stream",
        _run_rewrite_stream_job,
        job.id,
        skill_id,
        request.model_dump(mode="json"),
        metadata={
            "tenant_id": request.tenant_id,
            "job_id": job.id,
            "skill_id": skill_id,
            "language_context": language_context.model_dump(mode="json"),
        },
    )
    return job.id


def _run_distill_stream_job(job_id: str, request_data: dict[str, object]) -> None:
    """Run distillation while canonicalizing statuses and retaining raw successful draft chunks."""
    queued_job = stream_jobs.get(job_id)
    if queued_job is None or not _skill_stream_lifecycle_active(
        queued_job.tenant_id,
        f"skill-stream:{job_id}",
    ):
        return
    stream_jobs.start(job_id)
    try:
        request = SkillDistillRequest.model_validate(request_data)
        request = _bind_skill_request_to_job_locale(job_id, request)
        with Session(get_session_engine()) as db:
            ensure_tenant(db, request.tenant_id)
            model_config = _get_request_model(db, request.tenant_id, request.model_config_id)
            enriched_request = _with_available_context_for_distill(db, request)
            if not _skill_stream_lifecycle_active(request.tenant_id, f"skill-stream:{job_id}"):
                return
            stream_jobs.append(job_id, "status", {})
            for item in SkillDistiller().stream_text(enriched_request, model_config):
                if not _skill_stream_lifecycle_active(
                    request.tenant_id,
                    f"skill-stream:{job_id}",
                ):
                    return
                if stream_jobs.is_cancelled(job_id):
                    stream_jobs.append(job_id, "status", {})
                    stream_jobs.complete(job_id)
                    return
                stream_jobs.append(job_id, str(item["event"]), dict(item["data"]))
        stream_jobs.complete(job_id)
    except Exception as exc:
        logger.exception("skill distill stream failed", extra={"job_id": job_id})
        stream_jobs.fail(job_id, "SKILL_UPSTREAM_FAILURE", raw_context=exc)


def _run_rewrite_stream_job(job_id: str, skill_id: str, request_data: dict[str, object]) -> None:
    """Run rewrite while canonicalizing statuses and retaining raw successful assistant content."""
    queued_job = stream_jobs.get(job_id)
    if queued_job is None or not _skill_stream_lifecycle_active(
        queued_job.tenant_id,
        f"skill-stream:{job_id}",
    ):
        return
    stream_jobs.start(job_id)
    try:
        request = SkillRewriteRequest.model_validate(request_data)
        request = _bind_skill_request_to_job_locale(job_id, request)
        if request.current_skill.skill_id != skill_id:
            raise ValueError("Path skill_id must match current_skill.skill_id")
        with Session(get_session_engine()) as db:
            ensure_tenant(db, request.tenant_id)
            model_config = _get_request_model(db, request.tenant_id, request.model_config_id)
            if not _skill_stream_lifecycle_active(request.tenant_id, f"skill-stream:{job_id}"):
                return
            stream_jobs.append(job_id, "status", {})
            for item in SkillEditor().stream_text(request, model_config):
                if not _skill_stream_lifecycle_active(
                    request.tenant_id,
                    f"skill-stream:{job_id}",
                ):
                    return
                if stream_jobs.is_cancelled(job_id):
                    stream_jobs.append(job_id, "status", {})
                    stream_jobs.complete(job_id)
                    return
                stream_jobs.append(job_id, str(item["event"]), dict(item["data"]))
        stream_jobs.complete(job_id)
    except Exception as exc:
        logger.exception("skill rewrite stream failed", extra={"job_id": job_id})
        stream_jobs.fail(job_id, "SKILL_UPSTREAM_FAILURE", raw_context=exc)


def _bind_skill_request_to_job_locale(
    job_id: str,
    request: SkillDistillRequest | SkillRewriteRequest,
) -> SkillDistillRequest | SkillRewriteRequest:
    """Restore the durable job snapshot before the worker performs any model or reflection call."""
    job = stream_jobs.get(job_id)
    if job is None or job.language_context is None:
        return request
    return request.model_copy(update={"language_context": job.language_context})


def _stream_skill_job(
    job_id: str,
    after_seq: int = 0,
    *,
    tenant_id: str | None = None,
    correlation_id: str | None = None,
) -> Iterator[str]:
    """Yield private Skill SSE items only while the owning tenant remains executable."""
    last_seq = max(0, after_seq)
    initial_job = stream_jobs.get(job_id)
    stream_tenant_id = tenant_id or (initial_job.tenant_id if initial_job is not None else None)
    stream_correlation_id = correlation_id or f"skill-stream:{job_id}"
    if stream_tenant_id and not _skill_stream_lifecycle_active(
        stream_tenant_id,
        stream_correlation_id,
    ):
        return
    yield _sse("job_attached", {"job_id": job_id, "after_seq": after_seq})
    while True:
        if stream_tenant_id and not _skill_stream_lifecycle_active(
            stream_tenant_id,
            stream_correlation_id,
        ):
            return
        job, events = stream_jobs.snapshot(job_id, last_seq)
        if not job:
            yield _sse(
                "error",
                {
                    "code": "SKILL_JOB_NOT_FOUND",
                    "params": {},
                    "retryable": False,
                },
            )
            return
        if stream_tenant_id is None:
            stream_tenant_id = job.tenant_id
        for event in events:
            if not _skill_stream_lifecycle_active(stream_tenant_id, stream_correlation_id):
                return
            last_seq = event.seq
            yield _sse_event(event, job_id)
        if job.status in {"succeeded", "failed"} and not events:
            if not _skill_stream_lifecycle_active(stream_tenant_id, stream_correlation_id):
                return
            yield _sse("job_complete", _skill_job_complete_payload(job))
            return
        sleep(0.15)


def _sse_event(event: SkillStreamEvent, job_id: str) -> str:
    """Serialize one already-canonical stream event without rewriting successful raw content."""
    data = {"job_id": job_id, "seq": event.seq, **event.data}
    return _sse(event.event, data)


def get_session_engine():
    from app.db import engine

    return engine


def _get_default_model(db: Session, tenant_id: str) -> ModelConfig:
    model_config = db.exec(
        select(ModelConfig).where(
            ModelConfig.tenant_id == tenant_id,
            ModelConfig.is_default == True,  # noqa: E712
            ModelConfig.enabled == True,  # noqa: E712
        )
    ).first()
    if not model_config:
        raise _skill_error("MODEL_CONFIG_DEFAULT_MISSING", 400)
    return _model_runtime_config(db, tenant_id, model_config)


def _model_runtime_config(db: Session, tenant_id: str, row: ModelConfig):
    return resolve_model_config_for_runtime(db, tenant_id, row.id)


def _get_request_model(
    db: Session, tenant_id: str, model_config_id: str | None = None
) -> ModelConfig:
    if not model_config_id:
        return _get_default_model(db, tenant_id)
    model_config = db.get(ModelConfig, model_config_id)
    if not model_config or model_config.tenant_id != tenant_id or not model_config.enabled:
        raise _skill_error("MODEL_CONFIG_NOT_FOUND", 404, params={"config_id": model_config_id})
    return _model_runtime_config(db, tenant_id, model_config)


def _sync_skill_tool_bindings(
    db: Session,
    tenant_id: str,
    skill_id: str,
    content: dict[str, object],
) -> None:
    tool_names: set[str] = set()
    for key in ("nodes", "steps"):
        items = content.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            actions = item.get("allowed_actions")
            if not isinstance(actions, list):
                continue
            for action in actions:
                value = str(action or "").strip()
                if not value.startswith("call_tool:"):
                    continue
                tool_name = value.split(":", 1)[1].strip()
                if tool_name:
                    tool_names.add(tool_name)
    if not tool_names:
        return

    rows = db.exec(
        select(Tool).where(
            Tool.tenant_id == tenant_id,
            Tool.name.in_(sorted(tool_names)),
        )
    ).all()
    for row in rows:
        allowed_skills = [
            str(item)
            for item in (row.allowed_skills_json or [])
            if str(item).strip()
        ]
        if skill_id in allowed_skills:
            continue
        row.allowed_skills_json = [*allowed_skills, skill_id]
        row.updated_at = utc_now()
        db.add(row)


def _ensure_distill_agent_scope(
    db: Session,
    request: SkillDistillRequest,
    current_user: User,
) -> None:
    if request.agent_id:
        ensure_agent_scope_manager(db, request.tenant_id, request.agent_id, current_user)


def _visible_general_skill_rows_for_distill(
    db: Session,
    tenant_id: str,
    agent_id: str | None,
) -> list[GeneralSkill]:
    agent = get_agent(db, tenant_id, agent_id)
    rows = db.exec(
        select(GeneralSkill).where(
            GeneralSkill.tenant_id == tenant_id,
            GeneralSkill.status == "published",
        )
    ).all()
    if agent_id and not agent:
        return []
    if not agent or agent.is_overall:
        return [
            row
            for row in rows
            if is_open_gallery_resource(db, tenant_id, "general_skill", row)
        ]
    bindings = db.exec(
        select(AgentResourceBinding).where(
            AgentResourceBinding.tenant_id == tenant_id,
            AgentResourceBinding.agent_id == agent.id,
            AgentResourceBinding.resource_type == "general_skill",
            AgentResourceBinding.status == "active",
        )
    ).all()
    rows_by_id = {row.id: row for row in rows}
    return [
        row
        for binding in bindings
        if (row := rows_by_id.get(binding.resource_id)) is not None
        and is_bound_resource_visible_for_agent(
            db,
            tenant_id,
            "general_skill",
            row,
            binding,
        )
    ]


def _with_available_context_for_distill(
    db: Session,
    request: SkillDistillRequest,
) -> SkillDistillRequest:
    tools = visible_tool_rows(
        db,
        request.tenant_id,
        request.agent_id,
        include_inactive=False,
    )
    available_tools = _dedupe_capability_catalog(
        [
            *request.available_tools,
            *[
                {
                    "id": tool.id,
                    "name": tool.name,
                    "display_name": tool.display_name,
                    "description": tool.description,
                    "bucket": tool.bucket or "未分桶",
                    "method": tool.method,
                    "url": tool.url,
                    "input_schema": tool.input_schema,
                    "output_schema": tool.output_schema,
                }
                for tool in tools
            ],
        ],
        ("id", "name"),
    )
    general_skills = _visible_general_skill_rows_for_distill(
        db,
        request.tenant_id,
        request.agent_id,
    )
    available_general_skills = _dedupe_capability_catalog(
        [
            *request.available_general_skills,
            *[
                {
                    "id": skill.id,
                    "slug": skill.slug,
                    "name": skill.name,
                    "description": skill.description or "",
                    "capability_scope": skill.capability_scope,
                }
                for skill in general_skills
            ],
        ],
        ("id", "slug"),
    )
    visible_knowledge = visible_knowledge_base_versions(
        db,
        request.tenant_id,
        request.agent_id,
        include_inactive=False,
    )
    available_knowledge_bases = _dedupe_capability_catalog(
        [
            *request.available_knowledge_bases,
            *[
                {
                    "id": knowledge_base_id,
                    "name": version.name,
                    "description": version.description or "",
                    "capability_scope": version.capability_scope,
                }
                for knowledge_base_id, version in visible_knowledge.items()
            ],
        ],
        ("id", "name"),
    )
    return request.model_copy(
        update={
            "available_tools": available_tools,
            "available_general_skills": available_general_skills,
            "available_knowledge_bases": available_knowledge_bases,
        }
    )


def _with_available_tools(db: Session, request: SkillDistillRequest) -> SkillDistillRequest:
    """Backward-compatible alias for public API callers."""

    return _with_available_context_for_distill(db, request)


def _with_available_context_for_rewrite(
    db: Session, request: SkillRewriteRequest
) -> SkillRewriteRequest:
    tools = db.exec(
        select(Tool).where(Tool.tenant_id == request.tenant_id, Tool.enabled == True)  # noqa: E712
    ).all()
    available_tools = _dedupe_capability_catalog(
        [
            *request.available_tools,
            *[
                {
                    "id": tool.id,
                    "name": tool.name,
                    "display_name": tool.display_name,
                    "description": tool.description,
                    "bucket": tool.bucket or "未分桶",
                    "method": tool.method,
                    "url": tool.url,
                    "input_schema": tool.input_schema,
                    "output_schema": tool.output_schema,
                }
                for tool in tools
            ],
        ],
        ("id", "name"),
    )
    rows = visible_skill_rows(
        db,
        request.tenant_id,
        request.agent_id,
        include_inactive=True,
    )
    available_sops = [
        {
            "skill_id": row.skill_id,
            "name": row.name,
            "description": row.description or "",
            "capability_scope": sop_capability_scope(row),
            "status": row.status,
            "nested_sop_ids": nested_sop_ids(row.content_json or {}),
            "selectable": row.skill_id != request.current_skill.skill_id
            and row.status in {"published", "active"},
            "unavailable_reason": (
                "不能调用当前 SOP 自身"
                if row.skill_id == request.current_skill.skill_id
                else "SOP 尚未发布"
                if row.status not in {"published", "active"}
                else None
            ),
            "content": {
                "capability_scope": sop_capability_scope(row),
                "nodes": [
                    {
                        "type": "subflow",
                        "sub_sop_id": node.get("sub_sop_id"),
                    }
                    for node in (row.content_json or {}).get("nodes", [])
                    if isinstance(node, dict) and str(node.get("type") or "") == "subflow"
                ],
            },
        }
        for row in rows
    ]
    return request.model_copy(
        update={
            "available_tools": available_tools,
            "available_sops": available_sops,
        }
    )


def _ensure_rewrite_agent_scope(
    db: Session,
    request: SkillRewriteRequest,
    current_user: User,
) -> None:
    if request.agent_id:
        ensure_agent_scope_manager(db, request.tenant_id, request.agent_id, current_user)


def _dedupe_capability_catalog(
    values: list[dict[str, object]],
    keys: tuple[str, ...],
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            continue
        identity = next((str(item.get(key) or "").strip() for key in keys if item.get(key)), "")
        if identity and identity in seen:
            continue
        if identity:
            seen.add(identity)
        result.append(item)
    return result


def _sse(event: object, data: object) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _extract_uploaded_skill_file(filename: str, data: bytes) -> str:
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if suffix in {"md", "txt"}:
        return _decode_text_bytes(data)
    if suffix == "docx":
        return _extract_docx_text(data)
    if suffix == "doc":
        return _decode_legacy_doc_text(data)
    raise _skill_error("SKILL_FILE_TYPE_UNSUPPORTED", 400)


def _decode_text_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def _decode_legacy_doc_text(data: bytes) -> str:
    text = _decode_text_bytes(data)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]+", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def _extract_docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            document_xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise _skill_error("SKILL_DOCX_INVALID", 400, cause=exc) from exc

    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        root = ElementTree.fromstring(document_xml)
    except ElementTree.ParseError as exc:
        raise _skill_error("SKILL_DOCX_XML_INVALID", 400, cause=exc) from exc
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        parts: list[str] = []
        for element in paragraph.iter():
            if element.tag == f"{namespace}t" and element.text:
                parts.append(element.text)
            elif element.tag == f"{namespace}tab":
                parts.append("\t")
            elif element.tag in {f"{namespace}br", f"{namespace}cr"}:
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _skill_stats(db: Session, tenant_id: str) -> dict[str, dict[str, float | int]]:
    stats: dict[str, dict[str, float | int]] = {}
    events = db.exec(
        select(AgentEvent).where(
            AgentEvent.tenant_id == tenant_id,
            AgentEvent.event_type.in_(["skill_started", "skill_resumed"]),  # type: ignore[attr-defined]
        )
    ).all()
    for event in events:
        payload = event.payload_json or {}
        skill_id = str(payload.get("to_skill_id") or "")
        if not skill_id:
            continue
        skill_version = (
            str(payload.get("to_skill_version") or payload.get("skill_version") or "") or None
        )
        _increment_call(stats, skill_id, skill_version)

    feedback_rows = db.exec(select(SkillFeedback).where(SkillFeedback.tenant_id == tenant_id)).all()
    flow_feedback: dict[tuple[str, str | None, str, str], set[str]] = {}
    for feedback in feedback_rows:
        skill_version = feedback.skill_version
        flow_key = (feedback.skill_id, skill_version, feedback.session_id, feedback.user_id)
        flow_feedback.setdefault(flow_key, set()).add(feedback.rating)

    for (skill_id, skill_version, _session_id, _user_id), ratings in flow_feedback.items():
        entries = [stats.setdefault(skill_id, _empty_stats())]
        if skill_version:
            entries.append(stats.setdefault(_stats_key(skill_id, skill_version), _empty_stats()))
        for entry in entries:
            if "down" in ratings:
                entry["negative_feedback_count"] = int(entry["negative_feedback_count"]) + 1
            elif "up" in ratings:
                entry["positive_feedback_count"] = int(entry["positive_feedback_count"]) + 1

    for entry in stats.values():
        positive = int(entry["positive_feedback_count"])
        negative = int(entry["negative_feedback_count"])
        calls = int(entry["call_count"])
        entry["positive_rate"] = round(positive / calls, 4) if calls else 0.0
        entry["negative_rate"] = round(negative / calls, 4) if calls else 0.0
    return stats


def _increment_call(
    stats: dict[str, dict[str, float | int]], skill_id: str, version: str | None
) -> None:
    entries = [stats.setdefault(skill_id, _empty_stats())]
    if version:
        entries.append(stats.setdefault(_stats_key(skill_id, version), _empty_stats()))
    for entry in entries:
        entry["call_count"] = int(entry["call_count"]) + 1


def _stats_key(skill_id: str, version: str) -> str:
    return f"{skill_id}@{version}"


def _stats_for(
    stats: dict[str, dict[str, float | int]], skill_id: str, version: str
) -> dict[str, float | int]:
    return stats.get(_stats_key(skill_id, version), {})


def _recent_skill_stats(
    db: Session,
    tenant_id: str,
    stats: dict[str, dict[str, float | int]],
) -> dict[str, dict[str, object]]:
    recent_versions: dict[str, list[str]] = {}
    version_rows = db.exec(
        select(SkillVersion)
        .where(SkillVersion.tenant_id == tenant_id)
        .order_by(
            SkillVersion.skill_id.asc(), SkillVersion.created_at.desc(), SkillVersion.version.desc()
        )
    ).all()
    for row in version_rows:
        versions = recent_versions.setdefault(row.skill_id, [])
        if len(versions) < 3:
            versions.append(row.version)

    skill_rows = db.exec(select(Skill).where(Skill.tenant_id == tenant_id)).all()
    for row in skill_rows:
        recent_versions.setdefault(row.skill_id, [row.version])

    recent_stats: dict[str, dict[str, object]] = {}
    for skill_id, versions in recent_versions.items():
        entry: dict[str, object] = {
            **_empty_stats(),
            "recent_versions": versions,
        }
        for version in versions:
            version_stats = stats.get(_stats_key(skill_id, version), {})
            entry["call_count"] = int(entry["call_count"]) + int(version_stats.get("call_count", 0))
            entry["positive_feedback_count"] = int(entry["positive_feedback_count"]) + int(
                version_stats.get("positive_feedback_count", 0)
            )
            entry["negative_feedback_count"] = int(entry["negative_feedback_count"]) + int(
                version_stats.get("negative_feedback_count", 0)
            )
        positive = int(entry["positive_feedback_count"])
        negative = int(entry["negative_feedback_count"])
        calls = int(entry["call_count"])
        entry["positive_rate"] = round(positive / calls, 4) if calls else 0.0
        entry["negative_rate"] = round(negative / calls, 4) if calls else 0.0
        recent_stats[skill_id] = entry
    return recent_stats


def _upsert_skill_version(db: Session, row: Skill) -> SkillVersion:
    existing = db.exec(
        select(SkillVersion).where(
            SkillVersion.tenant_id == row.tenant_id,
            SkillVersion.skill_id == row.skill_id,
            SkillVersion.version == row.version,
        )
    ).first()
    if existing:
        existing.name = row.name
        existing.business_domain = row.business_domain
        existing.description = row.description
        existing.content_json = row.content_json
        existing.status = row.status
        existing.updated_at = utc_now()
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing
    version_row = SkillVersion(
        tenant_id=row.tenant_id,
        skill_id=row.skill_id,
        version=row.version,
        name=row.name,
        business_domain=row.business_domain,
        description=row.description,
        content_json=row.content_json,
        status=row.status,
    )
    db.add(version_row)
    db.commit()
    db.refresh(version_row)
    return version_row


def _empty_stats() -> dict[str, float | int]:
    return {
        "call_count": 0,
        "positive_feedback_count": 0,
        "negative_feedback_count": 0,
        "positive_rate": 0.0,
        "negative_rate": 0.0,
    }


def _get_skill(db: Session, tenant_id: str, skill_id: str) -> Skill:
    ensure_tenant(db, tenant_id)
    row = db.exec(
        select(Skill).where(Skill.tenant_id == tenant_id, Skill.skill_id == skill_id)
    ).first()
    if not row:
        raise _skill_error("SKILL_NOT_FOUND", 404)
    return row


def _get_visible_skill_for_scope(
    db: Session,
    tenant_id: str,
    skill_id: str,
    agent_id: str | None,
) -> Skill:
    row = next(
        (
            item
            for item in visible_skill_rows(db, tenant_id, agent_id, include_inactive=True)
            if item.skill_id == skill_id
        ),
        None,
    )
    if not row:
        raise _skill_error("SKILL_NOT_FOUND", 404)
    return row


def _get_skill_version(db: Session, tenant_id: str, skill_id: str, version: str) -> SkillVersion:
    ensure_tenant(db, tenant_id)
    row = db.exec(
        select(SkillVersion).where(
            SkillVersion.tenant_id == tenant_id,
            SkillVersion.skill_id == skill_id,
            SkillVersion.version == version,
        )
    ).first()
    if not row:
        raise _skill_error("SKILL_VERSION_NOT_FOUND", 404)
    return row

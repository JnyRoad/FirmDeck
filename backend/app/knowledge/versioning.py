"""共享知识库版本生命周期：草稿快照、原子发布、驳回与回滚。"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from typing import Any, Literal

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select, update

from app.agents.branching import clone_knowledge_version_assets
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    KnowledgeIngestJob,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_language_context,
)
from app.knowledge.audit import KnowledgeAuditService
from app.knowledge.errors import (
    KNOWLEDGE_BASELINE_STALE,
    KNOWLEDGE_CONTEXT_MISMATCH,
    KNOWLEDGE_MODE_INVALID,
    KNOWLEDGE_PUBLISH_CONFLICT,
    KNOWLEDGE_VERSION_LEVEL_INVALID,
    KNOWLEDGE_VERSION_NOT_READY,
    KnowledgeError,
    knowledge_error,
    parse_expected_updated_at,
)
from app.knowledge.rebase import (
    count_stale_conflicts,
    is_superseded_draft_snapshot,
)
from app.observability.event_log import EventLog
from app.observability.product_events import record_product_event

VersionLevel = Literal["patch", "minor", "major"]
_VERSION_LEVELS: tuple[str, ...] = ("patch", "minor", "major")


def _actor_context(source_team_id: str | None) -> str:
    """审计口径：来源团队为空即为租户管理员旁路，否则为团队路径。"""
    return "team" if source_team_id else "tenant_admin"


def _default_language_context() -> LanguageContext:
    """HTTP 路由未显式提供语言快照时，退回稳定的合规默认值。"""
    return resolve_language_context(LanguageContextInputs())


def _required_reason(value: str | None) -> str:
    """返回非空变更原因，避免无说明的共享知识生命周期变更。"""
    reason = str(value or "").strip()
    if not reason:
        raise knowledge_error(
            KNOWLEDGE_MODE_INVALID,
            message="共享知识库版本操作必须填写变更原因。",
        )
    return reason


def _semantic_version_parts(value: str) -> tuple[int, int, int] | None:
    """只解析三段数字版本，忽略专用分支等非共享版本标签。"""
    parts = value.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    return int(parts[0]), int(parts[1]), int(parts[2])


def _bump_version(parts: tuple[int, int, int], level: str) -> tuple[int, int, int]:
    """按发布级别递进单个 semver 三元组，不做占用检查。"""
    major, minor, patch = parts
    if level == "major":
        return (major + 1, 0, 0)
    if level == "minor":
        return (major, minor + 1, 0)
    return (major, minor, patch + 1)


def _next_shared_version_label(
    released_versions: Sequence[str],
    level: str,
    *,
    occupied_versions: Sequence[str] = (),
) -> str:
    """发布时按 level 从现有最高正式版本递进分配唯一 semver 标签。"""
    if level not in _VERSION_LEVELS:
        raise knowledge_error(
            KNOWLEDGE_VERSION_LEVEL_INVALID,
            details={"level": level},
        )
    parsed = [
        parts for value in released_versions if (parts := _semantic_version_parts(value))
    ]
    if not parsed:
        return "1.0.0"
    candidate = max(parsed)
    occupied = set(occupied_versions)
    while True:
        candidate = _bump_version(candidate, level)
        label = f"{candidate[0]}.{candidate[1]}.{candidate[2]}"
        if label not in occupied:
            return label


def _draft_version_label(version_id: str, existing_labels: Sequence[str]) -> str:
    """从版本 id 末位十六进制生成草稿分支名，与既有标签冲突时依次加长为 6、8 位。"""
    suffix_source = version_id.rsplit("_", 1)[-1]
    occupied = set(existing_labels)
    for length in (4, 6, 8):
        candidate = f"draft-{suffix_source[-length:]}"
        if candidate not in occupied:
            return candidate
    # 极端情况下 8 位仍冲突：退回完整十六进制后缀，唯一约束兜底保证不重复。
    return f"draft-{suffix_source}"


def _required_text(value: str | None, field_name: str) -> str:
    """返回非空工具输入；缺失时用稳定领域错误阻止部分写入。"""
    normalized = str(value or "").strip()
    if not normalized:
        raise knowledge_error(
            KNOWLEDGE_MODE_INVALID,
            message=f"{field_name} 不能为空。",
        )
    return normalized


def _safe_source_filename(value: str | None) -> str:
    """只接受单层来源文件名，拒绝路径穿越和控制字符。"""
    filename = _required_text(value, "filename")
    if (
        filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
        or len(filename) > 255
    ):
        raise knowledge_error(
            KNOWLEDGE_MODE_INVALID,
            message="filename 必须是安全的单层文件名。",
        )
    return filename


class SharedKnowledgeVersionService:
    """在调用方事务内维护共享知识库唯一正式版本指针。"""

    def __init__(self, db: Session) -> None:
        """绑定数据库会话；所有生命周期状态与审计共用该事务。"""
        self.db = db
        self.audit = KnowledgeAuditService(db)

    def create_draft(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        source_team_id: str | None,
        actor_type: str,
        actor_id: str,
        change_reason: str,
        expected_published_version_id: str | None = None,
        source_task_id: str | None = None,
        source_conversation_id: str | None = None,
        source_references: list[dict[str, Any]] | None = None,
        idempotency_key: str | None = None,
        request_payload: Any = None,
    ) -> KnowledgeBaseVersion:
        """从当前正式快照克隆可编辑草稿，并持久化完整来源。"""
        base = self._shared_base(tenant_id, knowledge_base_id)
        parent = self._published_version(base)
        if (
            expected_published_version_id is not None
            and expected_published_version_id != parent.id
        ):
            raise self._publish_conflict(base, expected_published_version_id)

        # 草稿名基于版本 id 末位十六进制生成，语义版本号留到发布时再分配；
        # 唯一约束负责检测并行分配冲突。
        labels = self.db.exec(
            select(KnowledgeBaseVersion.version).where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.knowledge_base_id == knowledge_base_id,
            )
        ).all()
        reason = _required_reason(change_reason)
        provenance = {
            "source_task_id": source_task_id,
            "source_conversation_id": source_conversation_id,
            "source_references": list(source_references or []),
        }
        draft_id = new_id("kbver")
        draft_name = _draft_version_label(draft_id, labels)
        draft = KnowledgeBaseVersion(
            id=draft_id,
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            version=draft_name,
            name=base.name,
            description=base.description,
            status="active",
            parent_version_id=parent.id,
            publication_state="draft",
            source_team_id=source_team_id,
            created_by_agent_id=actor_id if actor_type == "agent" else None,
            created_by_user_id=actor_id if actor_type == "user" else None,
            change_reason=reason,
            capability_scope=base.capability_scope,
            metadata_json={
                **dict(base.metadata_json or {}),
                "draft_change_reason": reason,
                "draft_name": draft_name,
                "provenance": provenance,
            },
        )
        try:
            with self.db.begin_nested():
                self.db.add(draft)
                self.db.flush()
        except IntegrityError as exc:
            raise self._publish_conflict(base, parent.id) from exc
        clone_knowledge_version_assets(
            self.db,
            tenant_id,
            knowledge_base_id,
            parent.id,
            draft.id,
        )
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=draft.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="draft_created",
            reason=reason,
            details={
                "parent_version_id": parent.id,
                "version": draft.version,
                "provenance": provenance,
                "actor_context": _actor_context(source_team_id),
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "draft_version_id": draft.id,
                "parent_published_version_id": parent.id,
                "publication_state": "draft",
            },
        )
        return draft

    def list_versions(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        publication_state: str | None = None,
    ) -> list[KnowledgeBaseVersion]:
        """按创建时间倒序列出共享版本，可选生命周期状态过滤。

        排除 `status='archived'` 的行：变基会把旧草稿快照归档并写入 `superseded_by`
        （data-model §2），它们仍是 `publication_state='draft'`，不过滤就会在版本列表
        顶部堆出一串与活动草稿同名的重复"草稿"，且与 A1 的 `draft_count`
        （`listing.py` 已排除归档）对不上（I2 修复轮次）。
        """
        self._shared_base(tenant_id, knowledge_base_id)
        statement = select(KnowledgeBaseVersion).where(
            KnowledgeBaseVersion.tenant_id == tenant_id,
            KnowledgeBaseVersion.knowledge_base_id == knowledge_base_id,
            KnowledgeBaseVersion.status != "archived",
        )
        if publication_state:
            statement = statement.where(
                KnowledgeBaseVersion.publication_state == publication_state
            )
        return list(
            self.db.exec(
                statement.order_by(KnowledgeBaseVersion.created_at.desc())
            ).all()
        )

    def require_writable_draft(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        version_id: str,
    ) -> KnowledgeBaseVersion:
        """只返回同库的**活动**草稿，正式、已驳回或已被变基替换的快照一律拒绝写入。

        变基会把旧草稿快照置为 `status='archived'` 并写入 `metadata.superseded_by`
        （data-model §2）。这类快照仍然是 `publication_state='draft'`，若不额外判断
        生命周期，过期的浏览器页签就能继续往已作废的草稿里写文档、驳回甚至强制发布
        （I1 修复轮次）。
        """
        self._shared_base(tenant_id, knowledge_base_id)
        version = self._version(tenant_id, knowledge_base_id, version_id)
        if version.publication_state != "draft":
            raise knowledge_error(
                KNOWLEDGE_MODE_INVALID,
                message="共享知识库正式版本或已驳回版本不可修改。",
            )
        if is_superseded_draft_snapshot(version):
            raise knowledge_error(
                KNOWLEDGE_MODE_INVALID,
                message="该草稿已被变基替换，请打开最新的草稿快照。",
            )
        return version

    def ensure_ready(self, version: KnowledgeBaseVersion) -> None:
        """确认草稿内文档全部就绪，且没有未成功的摄取任务。

        `status='archived'` 表示"该草稿内已删除这篇文档"（data-model §3，行保留），
        不是一篇尚未就绪的文档；不排除它会让任何删除过文档的草稿永远卡在
        `KNOWLEDGE_VERSION_NOT_READY`（C1 修复轮次）。
        """
        blocking_document = self.db.exec(
            select(KnowledgeDocument.id).where(
                KnowledgeDocument.tenant_id == version.tenant_id,
                KnowledgeDocument.knowledge_base_id == version.knowledge_base_id,
                KnowledgeDocument.knowledge_base_version_id == version.id,
                KnowledgeDocument.status.not_in(("ready", "archived")),
            )
        ).first()
        blocking_job = self.db.exec(
            select(KnowledgeIngestJob.id).where(
                KnowledgeIngestJob.tenant_id == version.tenant_id,
                KnowledgeIngestJob.knowledge_base_id == version.knowledge_base_id,
                KnowledgeIngestJob.knowledge_base_version_id == version.id,
                KnowledgeIngestJob.status.not_in(("succeeded", "failed", "cancelled")),
            )
        ).first()
        if blocking_document or blocking_job:
            raise knowledge_error(
                KNOWLEDGE_VERSION_NOT_READY,
                details={"knowledge_base_version_id": version.id},
            )

    def queue_draft_update(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        draft_version_id: str,
        actor_id: str,
        source_team_id: str,
        source_task_id: str,
        source_conversation_id: str,
        title: str,
        filename: str,
        content: str,
        source_references: list[dict[str, Any]] | None,
        idempotency_key: str,
        request_payload: Any,
    ) -> KnowledgeIngestJob:
        """为共享草稿创建一个带来源与幂等收据的持久摄取任务。"""
        draft = self.require_writable_draft(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            version_id=draft_version_id,
        )
        resolved_title = _required_text(title, "title")
        resolved_filename = _safe_source_filename(filename)
        resolved_content = _required_text(content, "content")
        provenance = {
            "source_task_id": source_task_id,
            "source_conversation_id": source_conversation_id,
            "source_references": list(source_references or []),
            "created_by_agent_id": actor_id,
            "source_team_id": source_team_id,
        }

        # 摄取任务与审计收据在同一事务内写入，重试不会创建第二个任务。
        job = KnowledgeIngestJob(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            knowledge_base_version_id=draft.id,
            filename=resolved_filename,
            status="queued",
            stage="queued",
            progress=0.0,
            metadata_json={
                "content_base64": base64.b64encode(
                    resolved_content.encode("utf-8")
                ).decode("ascii"),
                "title": resolved_title,
                "metadata": {
                    "provenance": provenance,
                    "source_references": list(source_references or []),
                },
            },
        )
        self.db.add(job)
        self.db.flush()
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=draft.id,
            actor_type="agent",
            actor_id=actor_id,
            action="draft_updated",
            details={
                "ingest_job_id": job.id,
                "filename": resolved_filename,
                "provenance": provenance,
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "draft_version_id": draft.id,
                "document_id": None,
                "ingest_job_id": job.id,
                "processing_state": job.status,
            },
        )
        return job

    def publish_draft(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        draft_version_id: str,
        expected_published_version_id: str,
        actor_type: str,
        actor_id: str,
        source_team_id: str | None,
        change_reason: str,
        level: VersionLevel = "patch",
        force_overwrite: bool = False,
        idempotency_key: str | None = None,
        request_payload: Any = None,
        language_context: LanguageContext | None = None,
    ) -> KnowledgeBaseVersion:
        """校验草稿后按发布级别分配语义版本号，并以 CAS 原子替换全局正式指针。

        草稿基线（`parent_version_id`）落后于知识库当前正式版本时视为 stale：
        默认拒绝发布（`KNOWLEDGE_BASELINE_STALE`，附带按变基预览算出的冲突文档数），
        避免语义覆盖其间已发布的其他修改；调用方明确 `force_overwrite=true` 时放行，
        并在审计详情中留痕 `forced_overwrite`。
        """
        if level not in _VERSION_LEVELS:
            raise knowledge_error(
                KNOWLEDGE_VERSION_LEVEL_INVALID,
                details={"level": level},
            )
        base = self._shared_base(tenant_id, knowledge_base_id)
        draft = self.require_writable_draft(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            version_id=draft_version_id,
        )
        reason = _required_reason(change_reason)
        if expected_published_version_id != base.published_version_id:
            raise self._publish_conflict(base, expected_published_version_id)
        is_stale = draft.parent_version_id != base.published_version_id
        if is_stale and not force_overwrite:
            conflict_count = count_stale_conflicts(
                self.db,
                tenant_id=tenant_id,
                draft=draft,
                published_version_id=base.published_version_id,
            )
            base_version_row = (
                self._version(tenant_id, knowledge_base_id, draft.parent_version_id)
                if draft.parent_version_id
                else None
            )
            published_version_row = self._version(
                tenant_id, knowledge_base_id, base.published_version_id
            )
            raise knowledge_error(
                KNOWLEDGE_BASELINE_STALE,
                details={
                    # 注册表把 base_version 声明为 string，`errors.knowledge.baselineStale`
                    # 也会直接插值它；草稿没有父基线（历史数据）时回退为草稿自身标签，
                    # 绝不回传 null 让目录消息渲染出空洞的占位符。
                    "base_version": (
                        base_version_row.version if base_version_row else draft.version
                    ),
                    "published_version": published_version_row.version,
                    "conflict_count": conflict_count,
                },
            )
        self.ensure_ready(draft)

        # 草稿名在发布前即为当前 version 值；语义版本号在发布这一刻按 level 分配，
        # 并跳过历史手工数据已占用的标签，直到找到未使用的组合。
        draft_name = draft.version
        existing_versions = self.db.exec(
            select(
                KnowledgeBaseVersion.version,
                KnowledgeBaseVersion.publication_state,
            ).where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.knowledge_base_id == knowledge_base_id,
            )
        ).all()
        released_labels = [label for label, state in existing_versions if state == "released"]
        occupied_labels = [label for label, _state in existing_versions]
        new_version_label = _next_shared_version_label(
            released_labels,
            level,
            occupied_versions=occupied_labels,
        )

        # 单条条件更新是全局正式版本的并发闸门；失败时不触碰草稿状态。
        now = utc_now()
        result = self.db.exec(
            update(KnowledgeBase)
            .where(
                KnowledgeBase.id == knowledge_base_id,
                KnowledgeBase.tenant_id == tenant_id,
                KnowledgeBase.mode == "shared",
                KnowledgeBase.published_version_id == expected_published_version_id,
            )
            .values(published_version_id=draft.id, updated_at=now)
        )
        if result.rowcount != 1:
            self.db.expire(base)
            raise self._publish_conflict(base, expected_published_version_id)

        draft.publication_state = "released"
        draft.published_at = now
        draft.change_reason = reason
        draft.updated_at = now
        draft.version = new_version_label
        draft.metadata_json = {
            **dict(draft.metadata_json or {}),
            "draft_name": draft_name,
            "published_from_draft": True,
            "version_level": level,
        }
        # 与 create_draft 一致：极端并发下候选标签仍可能撞车，唯一约束兜底，
        # 映射为可重试的发布冲突而不是泄漏原始数据库异常。
        try:
            with self.db.begin_nested():
                self.db.add(draft)
                self.db.flush()
        except IntegrityError as exc:
            raise self._publish_conflict(base, expected_published_version_id) from exc
        self.db.refresh(base)
        base.metadata_json = {
            **dict(base.metadata_json or {}),
            "current_version": draft.version,
        }
        self.db.add(base)
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=draft.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="version_published",
            reason=reason,
            details={
                "previous_published_version_id": expected_published_version_id,
                "published_version_id": draft.id,
                "draft_name": draft_name,
                "version_level": level,
                "actor_context": _actor_context(source_team_id),
                "forced_overwrite": bool(force_overwrite and is_stale),
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "previous_published_version_id": expected_published_version_id,
                "published_version_id": draft.id,
                "publication_state": "released",
                "published_at": now.isoformat(),
                "global_scope_notice": "该版本将供所有已绑定且有权的团队在下一轮使用。",
            },
        )

        # stale_draft_count：新正式版落地后，其余仍以旧正式版为基线的**活动**草稿数
        # （须变基才能再发布）。与 A1 的 draft_count、版本列表同口径排除已被变基替换的
        # 归档快照，避免三处报出不同的草稿数（I2 修复轮次）。
        other_draft_bases = self.db.exec(
            select(KnowledgeBaseVersion.parent_version_id).where(
                KnowledgeBaseVersion.tenant_id == tenant_id,
                KnowledgeBaseVersion.knowledge_base_id == knowledge_base_id,
                KnowledgeBaseVersion.publication_state == "draft",
                KnowledgeBaseVersion.status != "archived",
                KnowledgeBaseVersion.id != draft.id,
            )
        ).all()
        stale_draft_count = sum(1 for parent_id in other_draft_bases if parent_id != draft.id)
        record_product_event(
            EventLog(self.db),
            event_code="knowledge.version.published",
            tenant_id=tenant_id,
            aggregate_type="knowledge_base_version",
            aggregate_id=draft.id,
            params={
                "knowledge_base_id": knowledge_base_id,
                "version": draft.version,
                "stale_draft_count": stale_draft_count,
            },
            language_context=language_context or _default_language_context(),
        )
        return draft

    def reject_draft(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        draft_version_id: str,
        actor_type: str,
        actor_id: str,
        source_team_id: str | None,
        change_reason: str,
        idempotency_key: str | None = None,
        request_payload: Any = None,
    ) -> KnowledgeBaseVersion:
        """驳回草稿但保留其快照、来源和后续审计。"""
        draft = self.require_writable_draft(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            version_id=draft_version_id,
        )
        reason = _required_reason(change_reason)
        draft.publication_state = "rejected"
        draft.change_reason = reason
        draft.updated_at = utc_now()
        self.db.add(draft)
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=draft.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="draft_rejected",
            reason=reason,
            details={
                "draft_version_id": draft.id,
                "actor_context": _actor_context(source_team_id),
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "draft_version_id": draft.id,
                "publication_state": "rejected",
            },
        )
        return draft

    def rollback(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        target_version_id: str,
        expected_published_version_id: str,
        actor_type: str,
        actor_id: str,
        source_team_id: str | None,
        change_reason: str,
        idempotency_key: str | None = None,
        request_payload: Any = None,
    ) -> KnowledgeBaseVersion:
        """以 CAS 将指针恢复到历史正式快照，不删除任何后续版本。"""
        base = self._shared_base(tenant_id, knowledge_base_id)
        target = self._version(tenant_id, knowledge_base_id, target_version_id)
        if target.publication_state != "released":
            raise knowledge_error(
                KNOWLEDGE_MODE_INVALID,
                message="只能回滚到同一共享知识库的正式版本。",
            )
        reason = _required_reason(change_reason)
        now = utc_now()
        result = self.db.exec(
            update(KnowledgeBase)
            .where(
                KnowledgeBase.id == knowledge_base_id,
                KnowledgeBase.tenant_id == tenant_id,
                KnowledgeBase.mode == "shared",
                KnowledgeBase.published_version_id == expected_published_version_id,
            )
            .values(published_version_id=target.id, updated_at=now)
        )
        if result.rowcount != 1:
            self.db.expire(base)
            raise self._publish_conflict(base, expected_published_version_id)

        self.db.flush()
        self.db.refresh(base)
        base.metadata_json = {
            **dict(base.metadata_json or {}),
            "current_version": target.version,
        }
        self.db.add(base)
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=target.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="version_rolled_back",
            reason=reason,
            details={
                "previous_published_version_id": expected_published_version_id,
                "target_version_id": target.id,
                "actor_context": _actor_context(source_team_id),
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "previous_published_version_id": expected_published_version_id,
                "target_version_id": target.id,
                "published_at": now.isoformat(),
            },
        )
        return target

    def record_review(
        self,
        *,
        tenant_id: str,
        knowledge_base_id: str,
        draft_version_id: str,
        staged: int,
        pending: int,
        documents_adjusted: int,
        expected_updated_at: str,
        actor_type: str,
        actor_id: str,
        source_team_id: str | None,
        idempotency_key: str | None = None,
        request_payload: Any = None,
        language_context: LanguageContext | None = None,
    ) -> KnowledgeBaseVersion:
        """把审阅编辑器的暂存/待处理统计写入草稿 `metadata_json.review`（A5）。

        `expected_updated_at` 是审阅编辑器打开草稿时看到的 `updated_at` 快照，与草稿
        当前值不一致（他人并发改动）即拒绝为 `KNOWLEDGE_PUBLISH_CONFLICT`；非草稿状态
        按 A5 契约抛出 `KNOWLEDGE_VERSION_NOT_READY`（不同于 `require_writable_draft`
        默认的 `KNOWLEDGE_MODE_INVALID`，此处需要单独判断以匹配契约错误码）。写入本身
        只整体重新赋值 `metadata_json`（JSON 列需要整体替换才能持久化），并同步推进
        `updated_at`，使该次写入成为下一次审阅写回的新乐观锁基线。
        """
        self._shared_base(tenant_id, knowledge_base_id)
        draft = self._version(tenant_id, knowledge_base_id, draft_version_id)
        if draft.publication_state != "draft":
            raise knowledge_error(
                KNOWLEDGE_VERSION_NOT_READY,
                details={"knowledge_base_version_id": draft.id},
            )
        expected = parse_expected_updated_at(expected_updated_at)
        if expected != draft.updated_at:
            raise knowledge_error(
                KNOWLEDGE_PUBLISH_CONFLICT,
                details={
                    "knowledge_base_version_id": draft.id,
                },
            )
        now = utc_now()
        review = {
            "staged": staged,
            "pending": pending,
            "documents_adjusted": documents_adjusted,
            "reviewed_at": now.isoformat(),
            "reviewed_by_user_id": actor_id,
        }
        draft.metadata_json = {
            **dict(draft.metadata_json or {}),
            "review": review,
        }
        draft.updated_at = now
        self.db.add(draft)
        self.audit.append_event(
            tenant_id=tenant_id,
            knowledge_base_id=knowledge_base_id,
            team_id=source_team_id,
            knowledge_base_version_id=draft.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="draft_reviewed",
            details={
                "staged": staged,
                "pending": pending,
                "documents_adjusted": documents_adjusted,
                "actor_context": _actor_context(source_team_id),
            },
            idempotency_key=idempotency_key,
            request_payload=request_payload,
            durable_result={
                "knowledge_base_id": knowledge_base_id,
                "draft_version_id": draft.id,
                "staged": staged,
                "pending": pending,
            },
        )
        record_product_event(
            EventLog(self.db),
            event_code="knowledge.draft.reviewed",
            tenant_id=tenant_id,
            aggregate_type="knowledge_base_version",
            aggregate_id=draft.id,
            params={
                "knowledge_base_id": knowledge_base_id,
                "draft_name": draft.version,
                "staged": staged,
                "pending": pending,
            },
            language_context=language_context or _default_language_context(),
        )
        return draft

    def _shared_base(self, tenant_id: str, knowledge_base_id: str) -> KnowledgeBase:
        """读取同租户活动共享库，并隐藏跨租户资源存在性。"""
        base = self.db.get(KnowledgeBase, knowledge_base_id)
        if not base or base.tenant_id != tenant_id or base.status != "active":
            raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
        if base.mode != "shared":
            raise knowledge_error(KNOWLEDGE_MODE_INVALID)
        return base

    def _published_version(self, base: KnowledgeBase) -> KnowledgeBaseVersion:
        """校验共享库正式指针指向同库已发布快照。"""
        if not base.published_version_id:
            raise knowledge_error(
                KNOWLEDGE_MODE_INVALID,
                message="共享知识库尚未配置正式版本。",
            )
        version = self._version(base.tenant_id, base.id, base.published_version_id)
        if version.publication_state != "released":
            raise knowledge_error(
                KNOWLEDGE_MODE_INVALID,
                message="共享知识库正式指针无效。",
            )
        return version

    def _version(
        self,
        tenant_id: str,
        knowledge_base_id: str,
        version_id: str,
    ) -> KnowledgeBaseVersion:
        """读取同租户同知识库版本，拒绝跨库或跨租户标识。"""
        version = self.db.get(KnowledgeBaseVersion, version_id)
        if (
            not version
            or version.tenant_id != tenant_id
            or version.knowledge_base_id != knowledge_base_id
        ):
            raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
        return version

    def _publish_conflict(
        self,
        base: KnowledgeBase,
        expected_version_id: str | None,
    ) -> KnowledgeError:
        """构造只暴露版本标识的安全发布冲突。"""
        return knowledge_error(
            KNOWLEDGE_PUBLISH_CONFLICT,
            details={
                "expected_published_version_id": expected_version_id,
                "current_published_version_id": base.published_version_id,
            },
        )

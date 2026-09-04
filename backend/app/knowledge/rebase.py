"""知识库草稿变基（A3/A4）：以 lineage_id 为单位的三方合并、冲突生成与两步落库。

以 `published_version`（知识库当前正式版本）为 theirs、草稿 `parent_version`
（草稿创建时的基线）为 base、草稿自身为 ours。按 lineage 逐篇文档分类：

- 仅一方相对 base 变化 → 直接采用变化一方的内容；
- 双方都变化 → 复用 `app.knowledge.diff` 的行级 hunk 计算（`diff_document_lines`），
  以 base 区间做重叠检测：不交叠的改动块各自套用，交叠块产出冲突
  `{base_lines, ours_lines, theirs_lines, context_before, context_after}`。

`preview_rebase`/`merge_document_sets` 不落库，只读、可独立单测；`apply_rebase`
是唯一落库入口：克隆最新正式版资产为新草稿快照（沿用 `clone_knowledge_version_assets`），
套用合并结果，`parent_version_id` 指向新正式版，草稿名保持不变，旧快照归档并记录
`superseded_by`；随后写审计 `draft_rebased` 并发出 `knowledge.draft.rebased` 事件。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.agents.branching import clone_knowledge_version_assets
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeBucket,
    KnowledgeChunk,
    KnowledgeConcept,
    KnowledgeDiscoverySuggestion,
    KnowledgeDocument,
    new_id,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_language_context,
)
from app.knowledge.audit import KnowledgeAuditService
from app.knowledge.diff import (
    DEFAULT_MAX_LINES,
    DocumentSnapshot,
    _load_version_documents,
    diff_document_lines,
)
from app.knowledge.errors import (
    KNOWLEDGE_CONTEXT_MISMATCH,
    KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH,
    KNOWLEDGE_MODE_INVALID,
    KNOWLEDGE_PUBLISH_CONFLICT,
    KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED,
    KNOWLEDGE_VERSION_NOT_READY,
    knowledge_error,
    parse_expected_updated_at,
)
from app.knowledge.service import KnowledgeService
from app.observability.event_log import EventLog
from app.observability.product_events import record_product_event

MergeSource = Literal["ours", "theirs", "merged"]
DocumentAction = Literal["add", "update", "delete", "noop"]
_CONTEXT_SPAN = 2


@dataclass(frozen=True)
class MergedDocument:
    """一篇自动合并（无需人工介入）成功的文档及其应套用到新草稿的最终内容。"""

    lineage_id: str
    title: str
    filename: str
    source: MergeSource
    action: DocumentAction
    lines: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ConflictBlock:
    """一个交叠冲突块：base/ours/theirs 三方内容与前后各两行上下文。"""

    base_lines: list[str]
    ours_lines: list[str]
    theirs_lines: list[str]
    context_before: list[str] = field(default_factory=list)
    context_after: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DocumentConflict:
    """一篇存在交叠冲突、需要人工解决的文档；`action` 指示解决结果应 add 还是 update。"""

    lineage_id: str
    title: str
    filename: str
    action: Literal["add", "update"]
    blocks: list[ConflictBlock] = field(default_factory=list)


@dataclass(frozen=True)
class RebasePreview:
    """A3 变基预览响应（不落库）：`conflicts` 非空时前端需先解决冲突再调用 resolve。"""

    draft_version_id: str
    from_base_version_id: str | None
    to_base_version_id: str
    auto_merged: list[MergedDocument] = field(default_factory=list)
    conflicts: list[DocumentConflict] = field(default_factory=list)


@dataclass(frozen=True)
class RebaseResult:
    """变基落库结果：新草稿快照（草稿名不变、parent=最新正式版）与被替换的旧快照 id。"""

    new_version: KnowledgeBaseVersion
    superseded_version_id: str


def _apply_side(
    base_lines: list[str],
    hunks: list[Any],
    start: int,
    end: int,
) -> list[str]:
    """把某一方在 `[start, end)` 基线区间内的若干 change hunk 依次套用到该片段上。"""
    result: list[str] = []
    cursor = start
    for hunk in sorted(hunks, key=lambda item: item.base_start):
        result.extend(base_lines[cursor : hunk.base_start])
        result.extend(hunk.target_lines)
        cursor = hunk.base_start + len(hunk.base_lines)
    result.extend(base_lines[cursor:end])
    return result


def _merge_line_ranges(
    base_lines: list[str],
    ours_lines: list[str],
    theirs_lines: list[str],
    *,
    max_lines: int,
) -> tuple[list[str] | None, list[ConflictBlock]]:
    """双方都相对 base 变化时的行级三方合并：不交叠区间各自套用，交叠区间产出冲突块。"""
    ours_hunks, ours_truncated = diff_document_lines(base_lines, ours_lines, max_lines=max_lines)
    theirs_hunks, theirs_truncated = diff_document_lines(
        base_lines, theirs_lines, max_lines=max_lines
    )
    if ours_truncated or theirs_truncated:
        # 文档过大无法逐行比对时，保守地整篇产出冲突而不是悄悄丢弃一方的修改。
        return None, [
            ConflictBlock(
                base_lines=list(base_lines),
                ours_lines=list(ours_lines),
                theirs_lines=list(theirs_lines),
            )
        ]

    events: list[tuple[int, int, str, Any]] = []
    for hunk in ours_hunks:
        if hunk.type == "change":
            events.append((hunk.base_start, hunk.base_start + len(hunk.base_lines), "ours", hunk))
    for hunk in theirs_hunks:
        if hunk.type == "change":
            events.append(
                (hunk.base_start, hunk.base_start + len(hunk.base_lines), "theirs", hunk)
            )
    events.sort(key=lambda item: (item[0], item[1]))

    clusters: list[dict[str, Any]] = []
    for start, end, side, hunk in events:
        if clusters and start < clusters[-1]["end"]:
            cluster = clusters[-1]
            cluster["end"] = max(cluster["end"], end)
            cluster["items"].append((start, end, side, hunk))
        else:
            clusters.append({"start": start, "end": end, "items": [(start, end, side, hunk)]})

    merged_lines: list[str] = []
    conflict_blocks: list[ConflictBlock] = []
    cursor = 0
    has_conflict = False
    for cluster in clusters:
        start, end, items = cluster["start"], cluster["end"], cluster["items"]
        sides = {item[2] for item in items}
        merged_lines.extend(base_lines[cursor:start])
        if sides <= {"ours"} or sides <= {"theirs"}:
            merged_lines.extend(_apply_side(base_lines, [item[3] for item in items], start, end))
        else:
            has_conflict = True
            ours_items = [item[3] for item in items if item[2] == "ours"]
            theirs_items = [item[3] for item in items if item[2] == "theirs"]
            conflict_blocks.append(
                ConflictBlock(
                    base_lines=list(base_lines[start:end]),
                    ours_lines=_apply_side(base_lines, ours_items, start, end),
                    theirs_lines=_apply_side(base_lines, theirs_items, start, end),
                    context_before=list(base_lines[max(0, start - _CONTEXT_SPAN) : start]),
                    context_after=list(base_lines[end : end + _CONTEXT_SPAN]),
                )
            )
        cursor = end
    merged_lines.extend(base_lines[cursor:])

    if has_conflict:
        return None, conflict_blocks
    return merged_lines, []


def _classify_lineage(
    lineage_id: str,
    base_doc: DocumentSnapshot | None,
    ours_doc: DocumentSnapshot | None,
    theirs_doc: DocumentSnapshot | None,
    auto_merged: list[MergedDocument],
    conflicts: list[DocumentConflict],
    *,
    max_lines: int,
) -> None:
    """按 base/ours/theirs 三方是否存在及内容是否变化，把一篇文档归入自动合并或冲突。"""
    if base_doc is None:
        if ours_doc is not None and theirs_doc is None:
            auto_merged.append(
                MergedDocument(
                    lineage_id=lineage_id,
                    title=ours_doc.title,
                    filename=ours_doc.filename,
                    source="ours",
                    action="add",
                    lines=list(ours_doc.lines),
                )
            )
        elif theirs_doc is not None and ours_doc is None:
            # theirs 新增；克隆最新正式版资产时已带入新草稿，无需再写。
            auto_merged.append(
                MergedDocument(
                    lineage_id=lineage_id,
                    title=theirs_doc.title,
                    filename=theirs_doc.filename,
                    source="theirs",
                    action="noop",
                )
            )
        elif ours_doc is not None and theirs_doc is not None:
            if ours_doc.lines == theirs_doc.lines:
                auto_merged.append(
                    MergedDocument(
                        lineage_id=lineage_id,
                        title=theirs_doc.title,
                        filename=theirs_doc.filename,
                        source="merged",
                        action="noop",
                    )
                )
            else:
                conflicts.append(
                    DocumentConflict(
                        lineage_id=lineage_id,
                        title=ours_doc.title or theirs_doc.title,
                        filename=ours_doc.filename or theirs_doc.filename,
                        action="add",
                        blocks=[
                            ConflictBlock(
                                base_lines=[],
                                ours_lines=list(ours_doc.lines),
                                theirs_lines=list(theirs_doc.lines),
                            )
                        ],
                    )
                )
        return

    if ours_doc is None and theirs_doc is None:
        return  # 双方都删除了该文档，新草稿中本就不存在，无需处理。

    if ours_doc is None:
        # ours（草稿）删除了该文档。
        if theirs_doc.lines == base_doc.lines:
            auto_merged.append(
                MergedDocument(
                    lineage_id=lineage_id,
                    title=base_doc.title,
                    filename=base_doc.filename,
                    source="ours",
                    action="delete",
                )
            )
        else:
            conflicts.append(
                DocumentConflict(
                    lineage_id=lineage_id,
                    title=theirs_doc.title,
                    filename=theirs_doc.filename,
                    action="update",
                    blocks=[
                        ConflictBlock(
                            base_lines=list(base_doc.lines),
                            ours_lines=[],
                            theirs_lines=list(theirs_doc.lines),
                        )
                    ],
                )
            )
        return

    if theirs_doc is None:
        # theirs（正式版）删除了该文档；克隆资产时已随之移除。
        if ours_doc.lines == base_doc.lines:
            auto_merged.append(
                MergedDocument(
                    lineage_id=lineage_id,
                    title=ours_doc.title,
                    filename=ours_doc.filename,
                    source="theirs",
                    action="noop",
                )
            )
        else:
            conflicts.append(
                DocumentConflict(
                    lineage_id=lineage_id,
                    title=ours_doc.title,
                    filename=ours_doc.filename,
                    action="add",
                    blocks=[
                        ConflictBlock(
                            base_lines=list(base_doc.lines),
                            ours_lines=list(ours_doc.lines),
                            theirs_lines=[],
                        )
                    ],
                )
            )
        return

    ours_changed = ours_doc.lines != base_doc.lines
    theirs_changed = theirs_doc.lines != base_doc.lines
    if not ours_changed and not theirs_changed:
        return
    if ours_changed and not theirs_changed:
        auto_merged.append(
            MergedDocument(
                lineage_id=lineage_id,
                title=ours_doc.title,
                filename=ours_doc.filename,
                source="ours",
                action="update",
                lines=list(ours_doc.lines),
            )
        )
        return
    if theirs_changed and not ours_changed:
        auto_merged.append(
            MergedDocument(
                lineage_id=lineage_id,
                title=theirs_doc.title,
                filename=theirs_doc.filename,
                source="theirs",
                action="noop",
            )
        )
        return

    merged_lines, blocks = _merge_line_ranges(
        base_doc.lines, ours_doc.lines, theirs_doc.lines, max_lines=max_lines
    )
    if merged_lines is not None:
        auto_merged.append(
            MergedDocument(
                lineage_id=lineage_id,
                title=theirs_doc.title,
                filename=theirs_doc.filename,
                source="merged",
                action="update",
                lines=merged_lines,
            )
        )
    else:
        conflicts.append(
            DocumentConflict(
                lineage_id=lineage_id,
                title=theirs_doc.title,
                filename=theirs_doc.filename,
                action="update",
                blocks=blocks,
            )
        )


def merge_document_sets(
    base_docs: list[DocumentSnapshot],
    ours_docs: list[DocumentSnapshot],
    theirs_docs: list[DocumentSnapshot],
    *,
    max_lines: int = DEFAULT_MAX_LINES,
) -> tuple[list[MergedDocument], list[DocumentConflict]]:
    """纯函数：按 lineage_id 把 base/ours/theirs 三组文档快照三方合并，不接触 DB。

    只处理带 `lineage_id` 的文档——共享库版本资产均由 `clone_knowledge_version_assets`
    克隆而来，历史数据缺失时也会回填 lineage_id（见该函数注释），可视为不变量。
    """
    base_by_lineage = {doc.lineage_id: doc for doc in base_docs if doc.lineage_id}
    ours_by_lineage = {doc.lineage_id: doc for doc in ours_docs if doc.lineage_id}
    theirs_by_lineage = {doc.lineage_id: doc for doc in theirs_docs if doc.lineage_id}
    lineage_ids = sorted(set(base_by_lineage) | set(ours_by_lineage) | set(theirs_by_lineage))

    auto_merged: list[MergedDocument] = []
    conflicts: list[DocumentConflict] = []
    for lineage_id in lineage_ids:
        _classify_lineage(
            lineage_id,
            base_by_lineage.get(lineage_id),
            ours_by_lineage.get(lineage_id),
            theirs_by_lineage.get(lineage_id),
            auto_merged,
            conflicts,
            max_lines=max_lines,
        )
    return auto_merged, conflicts


def _shared_base(db: Session, tenant_id: str, knowledge_base_id: str) -> KnowledgeBase:
    """校验共享知识库存在、属于该租户且处于活跃可写状态。"""
    base = db.get(KnowledgeBase, knowledge_base_id)
    if base is None or base.tenant_id != tenant_id or base.status != "active":
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    if base.mode != "shared":
        raise knowledge_error(KNOWLEDGE_MODE_INVALID)
    return base


def is_superseded_draft_snapshot(version: KnowledgeBaseVersion) -> bool:
    """判断一个草稿快照是否已被变基替换（data-model §2：archived + `superseded_by`）。

    变基不会改写 `publication_state`（仍是 `draft`），只把旧快照 `status` 置为
    `archived` 并写入 `metadata.superseded_by`。只看 `publication_state` 的守卫会把
    这类已作废快照当作可写、可发布、可再次变基的活动草稿（I1 修复轮次），因此
    `rebase` 与 `versioning` 共用这一个判定。
    """
    if version.status != "active":
        return True
    return bool((version.metadata_json or {}).get("superseded_by"))


def _draft_version(
    db: Session, tenant_id: str, knowledge_base_id: str, version_id: str
) -> KnowledgeBaseVersion:
    """读取同租户同知识库的**活动**版本行，跨租户/跨库一律隐藏为上下文不匹配。

    已被变基替换的快照按 A3/A4 契约折叠为 `KNOWLEDGE_VERSION_NOT_READY`，使双击/重试
    同一个 `version_id` 不会再造出第二份草稿。
    """
    version = db.get(KnowledgeBaseVersion, version_id)
    if (
        version is None
        or version.tenant_id != tenant_id
        or version.knowledge_base_id != knowledge_base_id
    ):
        raise knowledge_error(KNOWLEDGE_CONTEXT_MISMATCH)
    if is_superseded_draft_snapshot(version):
        raise knowledge_error(
            KNOWLEDGE_VERSION_NOT_READY,
            details={"knowledge_base_version_id": version.id},
        )
    return version


def _require_stale_draft(draft: KnowledgeBaseVersion, published_version_id: str | None) -> None:
    """变基目标必须是**活动**草稿，且其基线已落后于知识库当前正式版本。"""
    if (
        draft.publication_state != "draft"
        or is_superseded_draft_snapshot(draft)
        or draft.parent_version_id == published_version_id
    ):
        raise knowledge_error(
            KNOWLEDGE_VERSION_NOT_READY,
            details={"knowledge_base_version_id": draft.id},
        )


def _require_expected_updated_at(
    draft: KnowledgeBaseVersion, expected_updated_at: str | None
) -> None:
    """A3/A4 可选乐观锁：调用方原样回传打开草稿时看到的 `updated_at` 才允许变基。

    语义与 A5（`versioning.record_review`）完全一致：按微秒精度精确相等比较，未提供时
    不校验（additive，老客户端不受影响），不匹配或无法解析统一折叠为
    `KNOWLEDGE_PUBLISH_CONFLICT`。
    """
    if expected_updated_at is None:
        return
    if parse_expected_updated_at(expected_updated_at) != draft.updated_at:
        raise knowledge_error(
            KNOWLEDGE_PUBLISH_CONFLICT,
            details={"knowledge_base_version_id": draft.id},
        )


def _compute_merge(
    db: Session,
    *,
    tenant_id: str,
    draft: KnowledgeBaseVersion,
    published_version_id: str,
) -> tuple[list[MergedDocument], list[DocumentConflict]]:
    """薄加载层：读取 base/ours/theirs 三方文档正文快照，交给纯函数完成三方合并。"""
    base_docs = (
        _load_version_documents(db, tenant_id=tenant_id, version_id=draft.parent_version_id)
        if draft.parent_version_id
        else []
    )
    ours_docs = _load_version_documents(db, tenant_id=tenant_id, version_id=draft.id)
    theirs_docs = _load_version_documents(db, tenant_id=tenant_id, version_id=published_version_id)
    return merge_document_sets(base_docs, ours_docs, theirs_docs)


def preview_rebase(
    db: Session,
    *,
    tenant_id: str,
    knowledge_base_id: str,
    draft_version_id: str,
    expected_updated_at: str | None = None,
) -> RebasePreview:
    """A3：校验草稿为活动 stale 草稿（可选乐观锁）后计算三方合并预览（不落库）。"""
    kb = _shared_base(db, tenant_id, knowledge_base_id)
    draft = _draft_version(db, tenant_id, knowledge_base_id, draft_version_id)
    _require_stale_draft(draft, kb.published_version_id)
    _require_expected_updated_at(draft, expected_updated_at)
    auto_merged, conflicts = _compute_merge(
        db, tenant_id=tenant_id, draft=draft, published_version_id=kb.published_version_id
    )
    return RebasePreview(
        draft_version_id=draft.id,
        from_base_version_id=draft.parent_version_id,
        to_base_version_id=kb.published_version_id,
        auto_merged=auto_merged,
        conflicts=conflicts,
    )


def count_stale_conflicts(
    db: Session,
    *,
    tenant_id: str,
    draft: KnowledgeBaseVersion,
    published_version_id: str,
) -> int:
    """供发布基线校验（R4）计算 `conflict_count`；调用方须已确认草稿处于 stale 状态。"""
    _auto_merged, conflicts = _compute_merge(
        db, tenant_id=tenant_id, draft=draft, published_version_id=published_version_id
    )
    return len(conflicts)


def _has_conflict_markers(content: str) -> bool:
    """按行锚定检查残留冲突标记，避免把正文中偶然出现的等号/尖括号行误判为标记。"""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "=======":
            return True
        if stripped == "<<<<<<<" or stripped.startswith("<<<<<<< "):
            return True
        if stripped == ">>>>>>>" or stripped.startswith(">>>>>>> "):
            return True
    return False


def _apply_merge_results(
    db: Session,
    *,
    tenant_id: str,
    knowledge_base_id: str,
    version_id: str,
    auto_merged: list[MergedDocument],
    conflicts_by_lineage: dict[str, DocumentConflict],
    resolutions: Mapping[str, str],
) -> None:
    """把自动合并与人工解决的最终内容套用到已克隆自最新正式版的新草稿快照文档上。"""
    rows = db.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == tenant_id,
            KnowledgeDocument.knowledge_base_id == knowledge_base_id,
            KnowledgeDocument.knowledge_base_version_id == version_id,
        )
    ).all()
    row_by_lineage: dict[str, KnowledgeDocument] = {}
    for row in rows:
        lineage = (row.metadata_json or {}).get("lineage_id")
        if isinstance(lineage, str) and lineage:
            row_by_lineage[lineage] = row

    service = KnowledgeService(db)

    def _purge_derived_rows(document_id: str) -> None:
        """清掉该文档在本版本内的派生行（克隆自正式版的那份），避免孤儿 bucket/chunk。

        与 `KnowledgeService._build_buckets` 重建前的清理集合保持一致；这里的行都是
        `clone_knowledge_version_assets` 复制到新草稿的副本，删除不影响正式版。
        """
        for model in (
            KnowledgeDiscoverySuggestion,
            KnowledgeConcept,
            KnowledgeChunk,
            KnowledgeBucket,
        ):
            db.exec(sa_delete(model).where(model.document_id == document_id))

    def _write(lineage_id: str, filename: str, title: str, content: str, action: str) -> None:
        if action == "noop":
            return
        row = row_by_lineage.get(lineage_id)
        if action == "delete":
            # data-model §3：草稿内删除是软删除——保留行并置为 archived，让对比/列表/
            # 发布统一按"不存在"处理；同时清掉克隆进来的派生行，否则已删除文档的 chunk
            # 会继续在这个版本里被检索到。
            if row is not None:
                _purge_derived_rows(row.id)
                row.status = "archived"
                row.bucket_count = 0
                row.chunk_count = 0
                row.updated_at = utc_now()
                db.add(row)
            return
        if row is None:
            row = KnowledgeDocument(
                tenant_id=tenant_id,
                knowledge_base_id=knowledge_base_id,
                knowledge_base_version_id=version_id,
                filename=filename or f"{lineage_id}.md",
                file_type="md",
                title=title or filename or lineage_id,
                status="ready",
                metadata_json={"lineage_id": lineage_id},
            )
            db.add(row)
            db.flush()
            row_by_lineage[lineage_id] = row
        else:
            metadata = dict(row.metadata_json or {})
            metadata["lineage_id"] = lineage_id
            row.metadata_json = metadata
            db.add(row)
        if not content.strip():
            # 合并结果为空正文：解析器拒绝空文档，退回"只写 raw_text + 清空派生层"，
            # 避免把可恢复的空文档变成 500。
            _purge_derived_rows(row.id)
            metadata = dict(row.metadata_json or {})
            metadata["raw_text"] = content
            row.metadata_json = metadata
            row.status = "ready"
            row.bucket_count = 0
            row.chunk_count = 0
            row.updated_at = utc_now()
            db.add(row)
            db.flush()
            return
        # 与在线编辑（`PUT /knowledge/documents/{id}`）同一条重建路径：正文、document_card、
        # section_tree、buckets/chunks/discovery 与 bucket_count/chunk_count 一并刷新，
        # 只是不提交——变基的多步写入必须整体留在同一个 SAVEPOINT 内。
        service.rebuild_document_content_in_transaction(
            row,
            content,
            title=title or row.title,
            status="ready",
        )

    for merged in auto_merged:
        _write(merged.lineage_id, merged.filename, merged.title, "\n".join(merged.lines), merged.action)
    for lineage_id, conflict in conflicts_by_lineage.items():
        _write(lineage_id, conflict.filename, conflict.title, resolutions[lineage_id], conflict.action)


def _default_language_context() -> LanguageContext:
    return resolve_language_context(LanguageContextInputs())


def apply_rebase(
    db: Session,
    *,
    tenant_id: str,
    knowledge_base_id: str,
    draft_version_id: str,
    to_base_version_id: str,
    resolutions: Mapping[str, str],
    actor_type: str,
    actor_id: str,
    source_team_id: str | None,
    change_reason: str,
    expected_updated_at: str | None = None,
    idempotency_key: str | None = None,
    request_payload: Any = None,
    language_context: LanguageContext | None = None,
) -> RebaseResult:
    """落库入口：重新计算合并结果，校验冲突全部解决后创建新草稿快照并归档旧快照。

    `resolutions` 为空字典表示"预览阶段已无冲突，直接落库"（A3 无冲突路径）；
    非空时表示 A4 提交的每篇冲突文档最终 `content_md`（按 lineage_id 索引）。
    """
    kb = _shared_base(db, tenant_id, knowledge_base_id)
    draft = _draft_version(db, tenant_id, knowledge_base_id, draft_version_id)
    _require_stale_draft(draft, kb.published_version_id)
    _require_expected_updated_at(draft, expected_updated_at)
    if kb.published_version_id != to_base_version_id:
        raise knowledge_error(
            KNOWLEDGE_PUBLISH_CONFLICT,
            details={
                "expected_published_version_id": to_base_version_id,
                "current_published_version_id": kb.published_version_id,
            },
        )

    auto_merged, conflicts = _compute_merge(
        db, tenant_id=tenant_id, draft=draft, published_version_id=kb.published_version_id
    )
    conflict_lineage_ids = {conflict.lineage_id for conflict in conflicts}
    missing = sorted(conflict_lineage_ids - set(resolutions.keys()))
    if missing:
        raise knowledge_error(
            KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH,
            details={"lineage_id": missing[0]},
        )
    for lineage_id in conflict_lineage_ids:
        if _has_conflict_markers(resolutions[lineage_id]):
            raise knowledge_error(
                KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED,
                details={"document_count": len(conflict_lineage_ids)},
            )

    conflicts_by_lineage = {conflict.lineage_id: conflict for conflict in conflicts}
    now = utc_now()
    draft_name = draft.version
    from_base_version_id = draft.parent_version_id
    new_draft_id = new_id("kbver")
    previous_version_id = draft.id
    # 捕获旧草稿的原始 metadata（provenance/draft_change_reason 等）——必须在下面改写
    # draft.metadata_json（打 superseded_by 标记）之前取一次快照，新快照据此继承来源信息，
    # 而不是像归档前那样只剩 draft_name/rebased_from。
    previous_metadata = dict(draft.metadata_json or {})
    # A5 的 `review` 统计只描述旧快照当时的暂存/待处理数量；原样继承会让刚变基出来的
    # 草稿显示过期的审阅进度，因此克隆时丢弃（旧快照自身仍保留该记录）。
    inherited_metadata = {key: value for key, value in previous_metadata.items() if key != "review"}

    try:
        # 落库的多步写入（改写旧快照 → 插入新快照 → 克隆资产 → 套用合并结果 → 审计）
        # 包在同一个 SAVEPOINT 内：任一步撞唯一约束等完整性错误时整体回滚，不留半途状态，
        # 对外统一映射为可重试的 KNOWLEDGE_PUBLISH_CONFLICT（与 versioning.publish_draft
        # 处理并发标签冲突的方式一致）。
        with db.begin_nested():
            # 草稿名（version 唯一约束键）在新旧快照之间只能有一份持有；先把旧快照的
            # version 改写为带 superseded 后缀的历史标签腾出位置，再插入沿用原草稿名的
            # 新快照，避免 (tenant_id, knowledge_base_id, version) 唯一约束冲突。
            draft.status = "archived"
            draft.version = f"{draft_name}-superseded-{previous_version_id.rsplit('_', 1)[-1][-8:]}"
            draft.metadata_json = {**previous_metadata, "superseded_by": new_draft_id}
            draft.updated_at = now
            db.add(draft)
            db.flush()

            new_draft = KnowledgeBaseVersion(
                id=new_draft_id,
                tenant_id=tenant_id,
                knowledge_base_id=knowledge_base_id,
                version=draft_name,
                name=draft.name,
                description=draft.description,
                status="active",
                parent_version_id=kb.published_version_id,
                publication_state="draft",
                source_team_id=draft.source_team_id,
                created_by_agent_id=draft.created_by_agent_id,
                created_by_user_id=draft.created_by_user_id,
                change_reason=change_reason,
                capability_scope=draft.capability_scope,
                metadata_json={
                    **inherited_metadata,
                    "draft_name": draft_name,
                    "rebased_from": {
                        "previous_version_id": previous_version_id,
                        "from_base_version_id": from_base_version_id,
                        "to_base_version_id": kb.published_version_id,
                    },
                },
                created_at=now,
                updated_at=now,
            )
            db.add(new_draft)
            db.flush()

            clone_knowledge_version_assets(
                db, tenant_id, knowledge_base_id, kb.published_version_id, new_draft.id
            )
            _apply_merge_results(
                db,
                tenant_id=tenant_id,
                knowledge_base_id=knowledge_base_id,
                version_id=new_draft.id,
                auto_merged=auto_merged,
                conflicts_by_lineage=conflicts_by_lineage,
                resolutions=resolutions,
            )

            to_base_row = db.get(KnowledgeBaseVersion, kb.published_version_id)
            from_base_row = (
                db.get(KnowledgeBaseVersion, from_base_version_id)
                if from_base_version_id
                else None
            )
            to_base_label = to_base_row.version if to_base_row else kb.published_version_id
            from_base_label = from_base_row.version if from_base_row else None

            audit = KnowledgeAuditService(db)
            audit.append_event(
                tenant_id=tenant_id,
                knowledge_base_id=knowledge_base_id,
                team_id=source_team_id,
                knowledge_base_version_id=new_draft.id,
                actor_type=actor_type,
                actor_id=actor_id,
                action="draft_rebased",
                reason=change_reason,
                details={
                    "from_base_version": from_base_label,
                    "to_base_version": to_base_label,
                    "auto_merged_count": len(auto_merged),
                    "resolved_conflict_count": len(conflict_lineage_ids),
                    "actor_context": "team" if source_team_id else "tenant_admin",
                },
                idempotency_key=idempotency_key,
                request_payload=request_payload,
                durable_result={
                    "knowledge_base_id": knowledge_base_id,
                    "new_draft_version_id": new_draft.id,
                    "superseded_version_id": previous_version_id,
                },
            )
    except IntegrityError as exc:
        raise knowledge_error(
            KNOWLEDGE_PUBLISH_CONFLICT,
            details={
                "expected_published_version_id": to_base_version_id,
                "current_published_version_id": kb.published_version_id,
            },
        ) from exc

    record_product_event(
        EventLog(db),
        event_code="knowledge.draft.rebased",
        tenant_id=tenant_id,
        aggregate_type="knowledge_base_version",
        aggregate_id=new_draft.id,
        params={
            "knowledge_base_id": knowledge_base_id,
            "draft_name": new_draft.version,
            "to_base_version": to_base_label,
        },
        language_context=language_context or _default_language_context(),
    )

    return RebaseResult(new_version=new_draft, superseded_version_id=previous_version_id)

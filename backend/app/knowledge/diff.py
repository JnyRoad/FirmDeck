"""知识库版本对比（A2）：文档级增/改/删清单与行级 hunks，纯函数为主。

文档级用 lineage 集合运算配对：base/target 任一侧存在缺失 `lineage_id` 的文档时，
整篇对比整体回退按 `filename` 配对，并把 `pairing` 标为 "filename"（否则用
`lineage_id`，以便跨版本追踪改名）。行级用 `difflib.SequenceMatcher(autojunk=False)`
产出 opcodes，把相邻的非 equal 块（delete/insert/replace）合并成一个 change hunk；
change 块内按位置顺序对齐，仅保留相似度 `SequenceMatcher.ratio() >= 0.5` 的行配对
（`pairs`），供前端做字符级高亮。

除 `diff_versions`（薄加载层：从会话按版本取文档正文快照）外，其余函数均为纯函数——
只接受已加载好的文本/文档列表，不接触 DB，可独立单测。文档正文取
`metadata_json.raw_text`，与 `PUT /knowledge/documents/{id}` 写回 `content_md` 时的
存储位置同源（见 `KnowledgeService.replace_document_content`）。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher

from sqlmodel import Session, select

from app.db.models import KnowledgeDocument

SIMILARITY_THRESHOLD = 0.5
DEFAULT_MAX_LINES = 5000

HunkType = str  # "equal" | "change"
DocumentKind = str  # "added" | "modified" | "deleted"
Pairing = str  # "lineage" | "filename"


@dataclass(frozen=True)
class DocumentSnapshot:
    """一篇文档在某个版本内的最小对比输入：身份键（lineage/filename）与正文行。

    `document_id`（T080 新增）是该文档在当前版本内的真实行 id——草稿版本里的文档是
    克隆行，`lineage_id` 指向源文档而非当前行，写回（编辑/归档/恢复）必须落到
    `document_id` 才能定位对；默认 `None` 以兼容不关心此字段的既有纯函数测试构造。
    """

    lineage_id: str | None
    filename: str
    title: str
    lines: list[str]
    document_id: str | None = None


@dataclass(frozen=True)
class DiffHunk:
    """行级对比的一个块：equal（未变）或 change（相邻 delete/insert/replace 合并）。"""

    type: HunkType
    base_start: int
    base_lines: list[str]
    target_start: int
    target_lines: list[str]
    pairs: list[tuple[int, int]] = field(default_factory=list)


@dataclass(frozen=True)
class DiffDocument:
    """文档级对比条目；`hunks` 仅在 `kind == "modified"` 且未截断时非空。

    `base_document_id`/`target_document_id`（T080 新增）是该篇文档在 base/target 各自
    版本内的真实行 id；对应侧不存在（added 无 base）时为 `None`。

    `deleted` 的 `target_document_id`（C1 修复轮次）：草稿内的"删除"是软删除，目标版本里
    那一行仍然存在（`status='archived'`），此时返回该归档行的真实 id，供"恢复"写回定位；
    文档在目标版本内根本没有对应行时才为 `None`。
    """

    lineage_id: str
    title: str
    kind: DocumentKind
    truncated: bool = False
    hunks: list[DiffHunk] = field(default_factory=list)
    base_document_id: str | None = None
    target_document_id: str | None = None


@dataclass(frozen=True)
class DiffSummary:
    added: int
    modified: int
    deleted: int


@dataclass(frozen=True)
class VersionDiffResult:
    base_version_id: str | None
    target_version_id: str
    pairing: Pairing
    summary: DiffSummary
    documents: list[DiffDocument]


def _merge_change_opcodes(
    opcodes: list[tuple[str, int, int, int, int]],
) -> list[tuple[str, int, int, int, int]]:
    """把 `get_opcodes()` 里相邻的非 equal 块（delete/insert/replace）合并为一个 change。"""
    merged: list[tuple[str, int, int, int, int]] = []
    index = 0
    total = len(opcodes)
    while index < total:
        tag, i1, i2, j1, j2 = opcodes[index]
        if tag == "equal":
            merged.append(("equal", i1, i2, j1, j2))
            index += 1
            continue
        start_i, start_j = i1, j1
        end_i, end_j = i2, j2
        index += 1
        while index < total and opcodes[index][0] != "equal":
            _, _change_i1, change_i2, _change_j1, change_j2 = opcodes[index]
            end_i, end_j = change_i2, change_j2
            index += 1
        merged.append(("change", start_i, end_i, start_j, end_j))
    return merged


def pair_change_lines(base_lines: list[str], target_lines: list[str]) -> list[tuple[int, int]]:
    """change 块内按位置顺序对齐，仅保留相似度达标（ratio() >= 0.5）的行配对。

    索引相对于传入的 `base_lines`/`target_lines` 本身（即该 change 块内部的局部下标），
    供前端在块内做字符级高亮时定位对应行。
    """
    pairs: list[tuple[int, int]] = []
    for index in range(min(len(base_lines), len(target_lines))):
        ratio = SequenceMatcher(None, base_lines[index], target_lines[index]).ratio()
        if ratio >= SIMILARITY_THRESHOLD:
            pairs.append((index, index))
    return pairs


def diff_document_lines(
    base_lines: list[str],
    target_lines: list[str],
    *,
    max_lines: int = DEFAULT_MAX_LINES,
) -> tuple[list[DiffHunk], bool]:
    """对已加载的两段文本逐行 diff；任一侧超过 `max_lines` 时只返回 `truncated=True`。"""
    if max(len(base_lines), len(target_lines)) > max_lines:
        return [], True

    matcher = SequenceMatcher(None, base_lines, target_lines, autojunk=False)
    hunks: list[DiffHunk] = []
    for tag, i1, i2, j1, j2 in _merge_change_opcodes(matcher.get_opcodes()):
        base_block = base_lines[i1:i2]
        target_block = target_lines[j1:j2]
        pairs = pair_change_lines(base_block, target_block) if tag == "change" else []
        hunks.append(
            DiffHunk(
                type=tag,
                base_start=i1,
                base_lines=base_block,
                target_start=j1,
                target_lines=target_block,
                pairs=pairs,
            )
        )
    return hunks, False


def pair_documents(
    base_docs: list[DocumentSnapshot],
    target_docs: list[DocumentSnapshot],
) -> tuple[Pairing, list[tuple[str, DocumentSnapshot | None, DocumentSnapshot | None]]]:
    """按 `lineage_id` 配对 base/target 文档；任一侧存在缺失 lineage 的文档则整体回退 filename。

    同一配对键在某一侧重复出现时（重复 `lineage_id`，或回退模式下重复 `filename`——
    `KnowledgeDocument.filename` 并无唯一约束），按出现顺序做位置配对（第 i 个配第 i 个），
    数量较多一侧多出的文档各自单独判定为 added/deleted，不会因为用字典去重而被静默丢弃。
    """
    use_lineage = all(doc.lineage_id for doc in base_docs) and all(
        doc.lineage_id for doc in target_docs
    )
    pairing: Pairing = "lineage" if use_lineage else "filename"

    def key_of(doc: DocumentSnapshot) -> str:
        return doc.lineage_id if use_lineage and doc.lineage_id else doc.filename

    base_groups: dict[str, list[DocumentSnapshot]] = {}
    for doc in base_docs:
        base_groups.setdefault(key_of(doc), []).append(doc)
    target_groups: dict[str, list[DocumentSnapshot]] = {}
    for doc in target_docs:
        target_groups.setdefault(key_of(doc), []).append(doc)

    ordered_keys = list(base_groups) + [
        key for key in target_groups if key not in base_groups
    ]

    paired: list[tuple[str, DocumentSnapshot | None, DocumentSnapshot | None]] = []
    for key in ordered_keys:
        base_list = base_groups.get(key, [])
        target_list = target_groups.get(key, [])
        for index in range(max(len(base_list), len(target_list))):
            base_doc = base_list[index] if index < len(base_list) else None
            target_doc = target_list[index] if index < len(target_list) else None
            paired.append((key, base_doc, target_doc))
    return pairing, paired


def diff_document_sets(
    base_docs: list[DocumentSnapshot],
    target_docs: list[DocumentSnapshot],
    *,
    base_version_id: str | None,
    target_version_id: str,
    max_lines: int = DEFAULT_MAX_LINES,
) -> VersionDiffResult:
    """纯函数：对已加载的两组文档快照配对，产出文档级 added/modified/deleted 与行级 hunks。

    双侧都存在但正文相同的文档视为未变，不出现在 `documents[]` 也不计入 summary。
    """
    pairing, paired = pair_documents(base_docs, target_docs)

    documents: list[DiffDocument] = []
    added = modified = deleted = 0
    for key, base_doc, target_doc in paired:
        if base_doc is None and target_doc is not None:
            added += 1
            documents.append(
                DiffDocument(
                    lineage_id=key,
                    title=target_doc.title,
                    kind="added",
                    target_document_id=target_doc.document_id,
                )
            )
        elif base_doc is not None and target_doc is None:
            deleted += 1
            documents.append(
                DiffDocument(
                    lineage_id=key,
                    title=base_doc.title,
                    kind="deleted",
                    base_document_id=base_doc.document_id,
                )
            )
        elif base_doc is not None and target_doc is not None:
            if base_doc.lines == target_doc.lines:
                continue
            hunks, truncated = diff_document_lines(
                base_doc.lines, target_doc.lines, max_lines=max_lines
            )
            modified += 1
            documents.append(
                DiffDocument(
                    lineage_id=key,
                    title=target_doc.title,
                    kind="modified",
                    truncated=truncated,
                    hunks=hunks,
                    base_document_id=base_doc.document_id,
                    target_document_id=target_doc.document_id,
                )
            )

    return VersionDiffResult(
        base_version_id=base_version_id,
        target_version_id=target_version_id,
        pairing=pairing,
        summary=DiffSummary(added=added, modified=modified, deleted=deleted),
        documents=documents,
    )


def _document_text(document: KnowledgeDocument) -> str:
    """取文档正文：与 `PUT /knowledge/documents/{id}` 写回 content_md 同源的 raw_text。"""
    metadata = document.metadata_json or {}
    raw_text = metadata.get("raw_text")
    return raw_text if isinstance(raw_text, str) else ""


def document_lineage_id(document: KnowledgeDocument) -> str | None:
    """从 `metadata_json.lineage_id` 取血缘 id，非字符串或空字符串一律归一为 `None`（fix round）。

    供本文件的 `_load_version_documents`（A2）与
    `app.api.knowledge_admin.list_knowledge_admin_version_documents`（A2b）共用同一套
    容错规则，避免两处各自实现出现不一致（此前 A2b 直接读原始值，`""` 会被当作合法
    lineage_id 而非归一为 `None`）。
    """
    metadata = document.metadata_json or {}
    lineage = metadata.get("lineage_id")
    return lineage if isinstance(lineage, str) and lineage else None


def _load_version_documents(
    db: Session, *, tenant_id: str, version_id: str
) -> list[DocumentSnapshot]:
    """薄加载层：按版本取该租户下全部**未归档**文档正文快照，唯一接触 DB 的入口。

    `order_by(KnowledgeDocument.id)`（T080 新增）让同 key（同 lineage/filename）在
    某一侧重复出现时，`pair_documents` 的按位置配对结果与 id 顺序一致、可复现。

    `status != "archived"`（C1 修复轮次）：data-model §3 把"草稿内删除文档"定义为该草稿
    版本内的行 `status='archived'`、行本身保留。对比与变基必须把归档行视为**不存在**，
    base/ours/theirs 三侧一律套用同一规则——base 侧同样过滤，才能让"草稿里恢复了一篇
    基线中已归档的文档"被正确判定为新增而不是未变。
    """
    rows = db.exec(
        select(KnowledgeDocument)
        .where(
            KnowledgeDocument.tenant_id == tenant_id,
            KnowledgeDocument.knowledge_base_version_id == version_id,
            KnowledgeDocument.status != "archived",
        )
        .order_by(KnowledgeDocument.id)
    ).all()
    snapshots: list[DocumentSnapshot] = []
    for row in rows:
        snapshots.append(
            DocumentSnapshot(
                lineage_id=document_lineage_id(row),
                filename=row.filename,
                title=row.title or row.filename,
                lines=_document_text(row).splitlines(),
                document_id=row.id,
            )
        )
    return snapshots


def _archived_document_ids(
    db: Session, *, tenant_id: str, version_id: str
) -> tuple[dict[str, str], dict[str, str]]:
    """取该版本内已归档（草稿内已删除）文档的真实行 id，分别按 lineage_id 与 filename 索引。

    归档行被 `_load_version_documents` 过滤掉，因此对比结果里这篇文档表现为 `deleted`。
    但"恢复"写回必须落到**目标版本内**那一行（base 侧的 id 属于另一个版本），所以这里把
    它单独取出来回填到 `DiffDocument.target_document_id`。同 key 重复时保留 id 最小的一行，
    与 `_load_version_documents` 的 `order_by(id)` 口径一致、可复现。
    """
    rows = db.exec(
        select(KnowledgeDocument)
        .where(
            KnowledgeDocument.tenant_id == tenant_id,
            KnowledgeDocument.knowledge_base_version_id == version_id,
            KnowledgeDocument.status == "archived",
        )
        .order_by(KnowledgeDocument.id)
    ).all()
    by_lineage: dict[str, str] = {}
    by_filename: dict[str, str] = {}
    for row in rows:
        lineage = document_lineage_id(row)
        if lineage and lineage not in by_lineage:
            by_lineage[lineage] = row.id
        if row.filename not in by_filename:
            by_filename[row.filename] = row.id
    return by_lineage, by_filename


def diff_versions(
    db: Session,
    *,
    tenant_id: str,
    base_version_id: str | None,
    target_version_id: str,
    max_lines: int = DEFAULT_MAX_LINES,
) -> VersionDiffResult:
    """薄加载层：读取 base/target 版本的文档正文快照，交给纯函数完成配对与逐篇 diff。

    `base_version_id` 为空（例如目标版本没有父版本，或知识库尚未发布过）时视为空文档
    集合，target 中的全部文档都会被判定为 added。

    最后一步回填软删除行的 `target_document_id`：目标版本内确有该文档但已归档时，返回那
    一行的真实 id，供调用方定位"恢复"写回的目标；文档在目标版本内根本不存在时仍为 None。
    """
    target_docs = _load_version_documents(db, tenant_id=tenant_id, version_id=target_version_id)
    base_docs = (
        _load_version_documents(db, tenant_id=tenant_id, version_id=base_version_id)
        if base_version_id
        else []
    )
    result = diff_document_sets(
        base_docs,
        target_docs,
        base_version_id=base_version_id,
        target_version_id=target_version_id,
        max_lines=max_lines,
    )
    if not any(document.kind == "deleted" for document in result.documents):
        return result
    by_lineage, by_filename = _archived_document_ids(
        db, tenant_id=tenant_id, version_id=target_version_id
    )
    lookup = by_lineage if result.pairing == "lineage" else by_filename
    documents = [
        (
            replace(document, target_document_id=lookup[document.lineage_id])
            if document.kind == "deleted"
            and document.target_document_id is None
            and document.lineage_id in lookup
            else document
        )
        for document in result.documents
    ]
    return replace(result, documents=documents)

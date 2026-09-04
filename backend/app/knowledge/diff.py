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

from dataclasses import dataclass, field
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
    """一篇文档在某个版本内的最小对比输入：身份键（lineage/filename）与正文行。"""

    lineage_id: str | None
    filename: str
    title: str
    lines: list[str]


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
    """文档级对比条目；`hunks` 仅在 `kind == "modified"` 且未截断时非空。"""

    lineage_id: str
    title: str
    kind: DocumentKind
    truncated: bool = False
    hunks: list[DiffHunk] = field(default_factory=list)


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
    """按 `lineage_id` 配对 base/target 文档；任一侧存在缺失 lineage 的文档则整体回退 filename。"""
    use_lineage = all(doc.lineage_id for doc in base_docs) and all(
        doc.lineage_id for doc in target_docs
    )
    pairing: Pairing = "lineage" if use_lineage else "filename"

    def key_of(doc: DocumentSnapshot) -> str:
        return doc.lineage_id if use_lineage and doc.lineage_id else doc.filename

    base_by_key = {key_of(doc): doc for doc in base_docs}
    target_by_key = {key_of(doc): doc for doc in target_docs}
    ordered_keys = list(base_by_key) + [key for key in target_by_key if key not in base_by_key]

    paired = [(key, base_by_key.get(key), target_by_key.get(key)) for key in ordered_keys]
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
                DiffDocument(lineage_id=key, title=target_doc.title, kind="added")
            )
        elif base_doc is not None and target_doc is None:
            deleted += 1
            documents.append(
                DiffDocument(lineage_id=key, title=base_doc.title, kind="deleted")
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


def _load_version_documents(
    db: Session, *, tenant_id: str, version_id: str
) -> list[DocumentSnapshot]:
    """薄加载层：按版本取该租户下全部文档正文快照，唯一接触 DB 的入口。"""
    rows = db.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == tenant_id,
            KnowledgeDocument.knowledge_base_version_id == version_id,
        )
    ).all()
    snapshots: list[DocumentSnapshot] = []
    for row in rows:
        metadata = row.metadata_json or {}
        lineage = metadata.get("lineage_id")
        snapshots.append(
            DocumentSnapshot(
                lineage_id=lineage if isinstance(lineage, str) and lineage else None,
                filename=row.filename,
                title=row.title or row.filename,
                lines=_document_text(row).splitlines(),
            )
        )
    return snapshots


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
    """
    target_docs = _load_version_documents(db, tenant_id=tenant_id, version_id=target_version_id)
    base_docs = (
        _load_version_documents(db, tenant_id=tenant_id, version_id=base_version_id)
        if base_version_id
        else []
    )
    return diff_document_sets(
        base_docs,
        target_docs,
        base_version_id=base_version_id,
        target_version_id=target_version_id,
        max_lines=max_lines,
    )

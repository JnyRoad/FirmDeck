/**
 * 知识库管理端（knowledge-base-admin）HTTP API 响应类型定义。
 *
 * 仅定义类型，不含运行时代码；与
 * specs/001-knowledge-base-admin/contracts/knowledge-admin-api.md 的 A1–A6、B2
 * 端点响应，以及 specs/001-knowledge-base-admin/data-model.md §4（对比结果）、
 * §5（变基结果）逐一对应。已存在于 `@/types` 的共享类型（`KnowledgeBaseRead`、
 * `KnowledgeBaseVersionRead`、`TeamKnowledgeBindingRead`、`KnowledgePermission`
 * 等）在此按契约需要导入或扩展，不重复定义。
 */
import type { CapabilityScope, KnowledgeBaseVersionRead } from '@/types';

/**
 * A1 列表项：`GET /knowledge-admin/knowledge-bases` 的 `items[]` 元素。
 * 字段与响应示例一一对应（见契约 A1）。
 */
export type KnowledgeAdminListItem = {
  id: string;
  name: string;
  description?: string | null;
  mode: 'shared' | 'dedicated';
  status: 'active' | 'archived';
  capability_scope?: CapabilityScope;
  published_version: string | null;
  published_version_id: string | null;
  draft_count: number;
  document_count: number;
  owner_agent: { id: string; name: string } | null;
  bound_teams: Array<{ id: string; name: string; is_default: boolean }>;
  branch: {
    base_version: string;
    head_version: string;
    sync_state: string;
  } | null;
  updated_at: string;
};

/** A1 列表统计聚合：知识库总数、共享 / 私有拆分与文档总数。 */
export type KnowledgeAdminListSummary = {
  total: number;
  shared: number;
  dedicated: number;
  documents: number;
};

/** A1 分页响应：`GET /knowledge-admin/knowledge-bases`。 */
export type KnowledgeAdminListResponse = {
  items: KnowledgeAdminListItem[];
  summary: KnowledgeAdminListSummary;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
};

/**
 * 扩展后的 `KnowledgeBaseVersionRead`：追加 B2
 * （`GET /knowledge-bases/{kb_id}/versions`）与草稿基线相关的派生字段。
 * `is_stale`/`base_version`/`next_version_preview` 为服务端读时计算的派生字段，
 * `draft_name`/`next_version_preview` 仅草稿存在。
 */
export type KnowledgeAdminVersionRead = KnowledgeBaseVersionRead & {
  /** 草稿基线是否已过期：`publication_state==='draft' && parent_version_id !== 当前正式版`。 */
  is_stale: boolean;
  /** 草稿基线对应的正式版本号（`parent.version`），非草稿或无基线时为 `null`。 */
  base_version: string | null;
  /** 草稿名（`draft-xxxx`），发布后保留以追溯来源；非草稿快照为 `null`。 */
  draft_name: string | null;
  /** 发布后各递进级别对应的候选版本号，仅草稿存在。 */
  next_version_preview: {
    patch: string;
    minor: string;
    major: string;
  } | null;
};

/** DiffHunk 内 `change` 块中一对相似行的字符级配对下标 `[base_idx, target_idx]`。 */
export type DiffHunkPair = [number, number];

/**
 * A2 对比结果单个 hunk：`type==='equal'` 表示未变化区块，
 * `type==='change'` 表示新增 / 修改区块，附带字符级高亮配对。
 */
export type DiffHunk = {
  type: 'equal' | 'change';
  base_start: number;
  base_lines: string[];
  target_start: number;
  target_lines: string[];
  pairs: DiffHunkPair[];
};

/**
 * A2 对比结果单篇文档：按 `lineage_id` 配对基线与目标版本后的差异摘要。
 * `kind==='modified'` 时含 `hunks`；`truncated===true`（超过 `max_lines`）时不含 `hunks`。
 * `base_document_id`/`target_document_id`（T080）是该篇文档在 base/target 各自版本内的
 * 真实行 id，供写回定位当前版本内的克隆行；对应侧不存在时为 `null`。
 *
 * `kind==='deleted'` 的 `target_document_id`（backend commit ab58668 起）不再恒为
 * `null`：草稿内的"删除"是软删除，目标版本里那一行仍然存在（`status='archived'`），
 * 此时该字段回填那个归档行的真实 id，供"恢复已删除文档"写回定位——只有目标版本内
 * 根本没有对应行时才是 `null`。
 *
 * `base_updated_at`/`target_updated_at`（乐观锁字段补全轮次新增）分别是
 * `base_document_id`/`target_document_id` 那一行 `updated_at.isoformat()`，与
 * `PUT /api/enterprise/knowledge/documents/{id}` 的 `expected_updated_at` 同一格式；
 * 对应侧 document_id 为 `null` 时同样为 `null`。用于"恢复已删除文档"等写回场景直接
 * 原样回传做乐观锁——A2b（版本文档全量列表）不返回已归档行，前端拿不到它的
 * `updated_at`，这里补上。
 */
export type DiffDocument = {
  lineage_id: string;
  title: string;
  kind: 'added' | 'modified' | 'deleted';
  truncated: boolean;
  base_document_id: string | null;
  target_document_id: string | null;
  base_updated_at: string | null;
  target_updated_at: string | null;
  hunks?: DiffHunk[];
};

/**
 * A2 响应：`GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/diff`。
 * 对应 data-model.md §4 `VersionDiff`。
 */
export type VersionDiff = {
  base_version_id: string;
  target_version_id: string;
  pairing: 'lineage' | 'filename';
  summary: {
    added: number;
    modified: number;
    deleted: number;
  };
  documents: DiffDocument[];
};

/**
 * A2b 响应元素：`GET .../versions/{version_id}/documents` 返回该版本全部文档
 * （含未改动的，区别于 A2 只返回有变化的），携带真实行 `id`。
 * `lineage_id` 缺失（数据质量问题）时为 `null`。
 */
export type VersionDocument = {
  id: string;
  lineage_id: string | null;
  title: string;
  filename: string;
  status: string;
  bucket_count: number;
  chunk_count: number;
  updated_at: string;
};

/** A3 变基预览中单篇文档的自动合并结果来源：采用草稿 / 采用正式版 / 双方合并。 */
export type RebaseAutoMergedDocument = {
  lineage_id: string;
  title: string;
  source: 'ours' | 'theirs' | 'merged';
};

/** A3/A4 变基冲突单个区块：三方内容与上下文，供两栏合并界面渲染。 */
export type RebaseConflictBlock = {
  base_lines: string[];
  ours_lines: string[];
  theirs_lines: string[];
  context_before: string[];
  context_after: string[];
};

/**
 * A3/A4 变基冲突单篇文档：包含一到多个冲突区块。
 *
 * `merged_text` 是这篇文档的**完整三方合并结果**：无冲突的 hunk 已经就地合并好，
 * 每一处冲突原样保留成一个行锚定的 Git 冲突区（`<<<<<<< ours` / `=======` /
 * `>>>>>>> theirs`，行之间以 `\n` 连接）。第 i 个冲突区与 `blocks[i]` 一一对应。
 * 前端合并界面必须以它为底稿逐区替换（见 `dialogs/MergeDialog.tsx`）——只拼
 * `blocks[]` 的 `context_before`/`context_after` 会丢掉冲突区之外的所有正文。
 */
export type RebaseConflictDocument = {
  lineage_id: string;
  title: string;
  blocks: RebaseConflictBlock[];
  merged_text: string;
};

/**
 * A3 响应（有冲突时）：
 * `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/rebase`。
 * 对应 data-model.md §5 `RebasePreview`；冲突非空时不落库。
 */
export type RebasePreview = {
  draft_version_id: string;
  from_base_version_id: string;
  to_base_version_id: string;
  auto_merged: RebaseAutoMergedDocument[];
  conflicts: RebaseConflictDocument[];
};

/**
 * A3（无冲突）/ A4 响应：变基落库后的结果。
 * 对应 data-model.md §5 `RebaseResult`；`new_version` 草稿名不变，基线更新为最新正式版。
 */
export type RebaseResult = {
  new_version: KnowledgeAdminVersionRead;
  superseded_version_id: string | null;
};

/**
 * A5 写入的审阅状态，落盘于 `KnowledgeBaseVersionRead.metadata.review`
 * （data-model.md §2 `metadata_json.review`）。
 */
export type ReviewState = {
  staged: number;
  pending: number;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
};

/**
 * A6 响应元素：`GET /knowledge-admin/teams` 可绑定群组候选。
 * 供"绑定新群组"下拉使用。
 */
export type KnowledgeAdminTeamOption = {
  id: string;
  name: string;
  member_count: number;
};

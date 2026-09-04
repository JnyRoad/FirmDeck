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
 */
export type DiffDocument = {
  lineage_id: string;
  title: string;
  kind: 'added' | 'modified' | 'deleted';
  truncated: boolean;
  /** 可选：后端总是返回该字段，此处放宽为可选以兼容改动前构造的测试夹具（fix round）。 */
  base_document_id?: string | null;
  target_document_id?: string | null;
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

/** A3/A4 变基冲突单篇文档：包含一到多个冲突区块。 */
export type RebaseConflictDocument = {
  lineage_id: string;
  title: string;
  blocks: RebaseConflictBlock[];
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

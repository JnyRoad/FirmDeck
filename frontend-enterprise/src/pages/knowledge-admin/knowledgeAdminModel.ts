/**
 * 知识库管理端（knowledge-admin）纯函数视图模型。
 *
 * 只做数据投影/筛选/排序/文案键选择，不含 React、网络或 i18n 运行时依赖；
 * `KnowledgeAdminListPage`/`KnowledgeAdminDetailPage` 据此渲染，`MessageId` 的
 * 实际翻译交由调用方的 `useAppIntl().t(...)` 完成。
 */
import { KnowledgeBaseMode, VersionLevel } from '@/enums/knowledge';
import type { MessageId } from '@/i18n/types';
import type { KnowledgeAdminListItem, KnowledgeAdminListSummary } from '@/types/knowledgeAdmin';

/** 列表筛选中「全部」哨兵值；用于类型页签、状态/归属/群组下拉。 */
export const ALL_FILTER_VALUE = 'all' as const;

export type KnowledgeAdminModeFilter = KnowledgeBaseMode | typeof ALL_FILTER_VALUE;
export type KnowledgeAdminStatusFilter = 'active' | 'archived' | typeof ALL_FILTER_VALUE;

/** 列表页当前生效的筛选条件；`ownerAgentId`/`teamId` 为 `'all'` 或具体 id。 */
export type KnowledgeAdminListFilters = {
  mode: KnowledgeAdminModeFilter;
  status: KnowledgeAdminStatusFilter;
  ownerAgentId: string;
  teamId: string;
  q: string;
};

/** 未做任何筛选的初始状态。 */
export function defaultKnowledgeAdminListFilters(): KnowledgeAdminListFilters {
  return { mode: ALL_FILTER_VALUE, status: ALL_FILTER_VALUE, ownerAgentId: ALL_FILTER_VALUE, teamId: ALL_FILTER_VALUE, q: '' };
}

/** 判断一条列表项是否满足当前筛选条件；条件之间为 AND 语义。 */
export function matchesKnowledgeAdminFilters(
  item: KnowledgeAdminListItem,
  filters: KnowledgeAdminListFilters,
): boolean {
  if (filters.mode !== ALL_FILTER_VALUE && item.mode !== filters.mode) return false;
  if (filters.status !== ALL_FILTER_VALUE && item.status !== filters.status) return false;
  if (filters.ownerAgentId !== ALL_FILTER_VALUE && item.owner_agent?.id !== filters.ownerAgentId) return false;
  if (filters.teamId !== ALL_FILTER_VALUE && !item.bound_teams.some((team) => team.id === filters.teamId)) {
    return false;
  }
  const keyword = filters.q.trim().toLowerCase();
  if (keyword && !item.name.toLowerCase().includes(keyword)) return false;
  return true;
}

/** 按更新时间降序排列；非法/相同时间戳按名称兜底，保证结果确定且不改变入参数组。 */
export function sortKnowledgeAdminListItems(items: KnowledgeAdminListItem[]): KnowledgeAdminListItem[] {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.updated_at);
    const bTime = Date.parse(b.updated_at);
    const aValid = !Number.isNaN(aTime);
    const bValid = !Number.isNaN(bTime);
    if (aValid && bValid && aTime !== bTime) return bTime - aTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 汇总总数 / 共享数 / 私有数 / 文档总数；用于统计卡与类型页签计数。 */
export function computeKnowledgeAdminListSummary(items: KnowledgeAdminListItem[]): KnowledgeAdminListSummary {
  return items.reduce<KnowledgeAdminListSummary>(
    (summary, item) => ({
      total: summary.total + 1,
      shared: summary.shared + (item.mode === KnowledgeBaseMode.Shared ? 1 : 0),
      dedicated: summary.dedicated + (item.mode === KnowledgeBaseMode.Dedicated ? 1 : 0),
      documents: summary.documents + item.document_count,
    }),
    { total: 0, shared: 0, dedicated: 0, documents: 0 },
  );
}

/** 未绑定任何群组的共享库需要在列表中提示「未绑定群组」。 */
export function isUnboundSharedKnowledgeBase(item: KnowledgeAdminListItem): boolean {
  return item.mode === KnowledgeBaseMode.Shared && item.bound_teams.length === 0;
}

/** 纯文案选择结果：调用方用 `t(messageId, values)` 渲染，本模块不做任何翻译。 */
export type KnowledgeAdminMessageDescriptor = {
  messageId: MessageId;
  values?: Record<string, string | number>;
};

/** 给版本号加 `v` 前缀；已带前缀保持不变；空值返回空串（由调用方决定占位文案）。 */
export function formatVersion(label: string | null | undefined): string {
  if (!label) return '';
  return label.startsWith('v') ? label : `v${label}`;
}

/** 选择列表行「版本状态」列的文案键：共享看正式版本号 + 草稿数，私有看分支头/基线版本。 */
export function knowledgeAdminVersionBadge(item: KnowledgeAdminListItem): KnowledgeAdminMessageDescriptor {
  if (item.mode === KnowledgeBaseMode.Shared) {
    if (!item.published_version) {
      return { messageId: 'knowledgeAdmin.list.version.sharedNone' };
    }
    return {
      messageId: 'knowledgeAdmin.list.version.shared',
      values: { version: formatVersion(item.published_version), draftCount: item.draft_count },
    };
  }
  if (!item.branch) {
    return { messageId: 'knowledgeAdmin.list.version.none' };
  }
  return {
    messageId: 'knowledgeAdmin.list.version.dedicated',
    values: {
      headVersion: formatVersion(item.branch.head_version),
      baseVersion: formatVersion(item.branch.base_version),
    },
  };
}

const SYNC_STATE_MESSAGE_IDS: Record<string, MessageId> = {
  synced: 'knowledgeAdmin.list.version.syncState.synced',
  diverged: 'knowledgeAdmin.list.version.syncState.diverged',
  converted: 'knowledgeAdmin.list.version.syncState.converted',
};

/** 未识别的分支同步状态兜底文案键；变量名以 `_MESSAGE_ID` 结尾，供 i18n 静态用量扫描识别。 */
const UNKNOWN_SYNC_STATE_MESSAGE_ID: MessageId = 'knowledgeAdmin.list.version.syncState.unknown';

/** 私有库分支同步状态徽章文案键；共享库或无分支时不展示（返回 null）。 */
export function knowledgeAdminSyncStateBadge(item: KnowledgeAdminListItem): KnowledgeAdminMessageDescriptor | null {
  if (item.mode !== KnowledgeBaseMode.Dedicated || !item.branch) return null;
  const messageId = SYNC_STATE_MESSAGE_IDS[item.branch.sync_state] ?? UNKNOWN_SYNC_STATE_MESSAGE_ID;
  return { messageId };
}

/** 解析 `major.minor.patch`（可带 `v` 前缀）；解析失败一律按 `0.0.0` 处理。 */
function parseSemver(value: string | null | undefined): [number, number, number] {
  const clean = (value ?? '').trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(clean);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 按 semver 规则推算发布后的候选版本号（不带 `v` 前缀，供 `formatVersion` 二次处理）。 */
export function nextVersionLabel(current: string | null | undefined, level: VersionLevel): string {
  const [major, minor, patch] = parseSemver(current);
  if (level === VersionLevel.Major) return `${major + 1}.0.0`;
  if (level === VersionLevel.Minor) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

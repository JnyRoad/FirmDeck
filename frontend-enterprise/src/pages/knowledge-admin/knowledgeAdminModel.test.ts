/**
 * knowledgeAdminModel 纯函数测试（T030）。
 *
 * 覆盖范围：排序（按更新时间降序，时间相同或非法时按名称兜底）、统计聚合、
 * 版本状态徽章文案选择（含同步状态）、`formatVersion`、`nextVersionLabel`。
 * 全部为纯函数，不依赖 React/网络。筛选已改为服务端 query 参数（见
 * `KnowledgeAdminListPage.tsx`），不再有客户端筛选谓词可测。
 */
import { describe, expect, it } from 'vitest';

import { VersionLevel } from '@/enums/knowledge';
import type { KnowledgeAdminListItem } from '@/types/knowledgeAdmin';

import {
  computeKnowledgeAdminListSummary,
  formatVersion,
  isUnboundSharedKnowledgeBase,
  knowledgeAdminSyncStateBadge,
  knowledgeAdminVersionBadge,
  nextVersionLabel,
  sortKnowledgeAdminListItems,
} from './knowledgeAdminModel';

function sharedItem(overrides: Partial<KnowledgeAdminListItem> = {}): KnowledgeAdminListItem {
  return {
    id: 'kb_shared_1',
    name: '产品 FAQ 共享库',
    description: '常见问题',
    mode: 'shared',
    status: 'active',
    capability_scope: 'general',
    published_version: '1.1.0',
    published_version_id: 'kbver_1',
    draft_count: 1,
    document_count: 4,
    owner_agent: null,
    bound_teams: [{ id: 'team_1', name: '客服一组', is_default: true }],
    branch: null,
    updated_at: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

function dedicatedItem(overrides: Partial<KnowledgeAdminListItem> = {}): KnowledgeAdminListItem {
  return {
    id: 'kb_dedicated_1',
    name: '客服话术库',
    description: null,
    mode: 'dedicated',
    status: 'active',
    capability_scope: 'general',
    published_version: null,
    published_version_id: null,
    draft_count: 0,
    document_count: 2,
    owner_agent: { id: 'ag_1', name: '林晓' },
    bound_teams: [],
    branch: { base_version: '3', head_version: '5', sync_state: 'diverged' },
    updated_at: '2026-08-18T09:00:00Z',
    ...overrides,
  };
}

describe('sortKnowledgeAdminListItems', () => {
  it('sorts by updated_at descending without mutating the input', () => {
    const older = sharedItem({ id: 'a', updated_at: '2026-08-01T00:00:00Z' });
    const newer = dedicatedItem({ id: 'b', updated_at: '2026-08-20T00:00:00Z' });
    const input = [older, newer];
    const sorted = sortKnowledgeAdminListItems(input);
    expect(sorted.map((item) => item.id)).toEqual(['b', 'a']);
    expect(input.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('falls back to name ordering when timestamps tie or are invalid', () => {
    const a = sharedItem({ id: 'a', name: 'Alpha', updated_at: 'not-a-date' });
    const b = sharedItem({ id: 'b', name: 'Beta', updated_at: 'not-a-date' });
    const sorted = sortKnowledgeAdminListItems([b, a]);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('computeKnowledgeAdminListSummary', () => {
  it('aggregates total/shared/dedicated/document counts', () => {
    const summary = computeKnowledgeAdminListSummary([
      sharedItem({ document_count: 4 }),
      dedicatedItem({ document_count: 2 }),
      dedicatedItem({ id: 'kb_dedicated_2', document_count: 3 }),
    ]);
    expect(summary).toEqual({ total: 3, shared: 1, dedicated: 2, documents: 9 });
  });

  it('returns zeroed summary for an empty list', () => {
    expect(computeKnowledgeAdminListSummary([])).toEqual({ total: 0, shared: 0, dedicated: 0, documents: 0 });
  });
});

describe('isUnboundSharedKnowledgeBase', () => {
  it('flags a shared kb with no bound teams', () => {
    expect(isUnboundSharedKnowledgeBase(sharedItem({ bound_teams: [] }))).toBe(true);
  });

  it('does not flag a shared kb with bound teams', () => {
    expect(isUnboundSharedKnowledgeBase(sharedItem())).toBe(false);
  });

  it('never flags a dedicated kb', () => {
    expect(isUnboundSharedKnowledgeBase(dedicatedItem())).toBe(false);
  });
});

describe('formatVersion', () => {
  it('adds a v prefix', () => {
    expect(formatVersion('1.1.0')).toBe('v1.1.0');
  });

  it('is idempotent when already prefixed', () => {
    expect(formatVersion('v1.1.0')).toBe('v1.1.0');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(formatVersion(null)).toBe('');
    expect(formatVersion(undefined)).toBe('');
    expect(formatVersion('')).toBe('');
  });
});

describe('knowledgeAdminVersionBadge', () => {
  it('selects the shared badge with published version and draft count', () => {
    expect(knowledgeAdminVersionBadge(sharedItem())).toEqual({
      messageId: 'knowledgeAdmin.list.version.shared',
      values: { version: 'v1.1.0', draftCount: 1 },
    });
  });

  it('selects the sharedNone badge when a shared kb has no published version', () => {
    expect(knowledgeAdminVersionBadge(sharedItem({ published_version: null }))).toEqual({
      messageId: 'knowledgeAdmin.list.version.sharedNone',
    });
  });

  it('selects the dedicated badge with head/base version', () => {
    expect(knowledgeAdminVersionBadge(dedicatedItem())).toEqual({
      messageId: 'knowledgeAdmin.list.version.dedicated',
      values: { headVersion: 'v5', baseVersion: 'v3' },
    });
  });

  it('selects the none badge when a dedicated kb has no branch', () => {
    expect(knowledgeAdminVersionBadge(dedicatedItem({ branch: null }))).toEqual({
      messageId: 'knowledgeAdmin.list.version.none',
    });
  });
});

describe('knowledgeAdminSyncStateBadge', () => {
  it.each([
    ['synced', 'knowledgeAdmin.list.version.syncState.synced'],
    ['diverged', 'knowledgeAdmin.list.version.syncState.diverged'],
    ['converted', 'knowledgeAdmin.list.version.syncState.converted'],
    ['some-unmapped-state', 'knowledgeAdmin.list.version.syncState.unknown'],
  ])('maps branch.sync_state=%s to %s', (syncState, messageId) => {
    expect(knowledgeAdminSyncStateBadge(dedicatedItem({ branch: { base_version: '3', head_version: '5', sync_state: syncState } })))
      .toEqual({ messageId });
  });

  it('returns null for shared knowledge bases', () => {
    expect(knowledgeAdminSyncStateBadge(sharedItem())).toBeNull();
  });

  it('returns null when a dedicated kb has no branch', () => {
    expect(knowledgeAdminSyncStateBadge(dedicatedItem({ branch: null }))).toBeNull();
  });
});

describe('nextVersionLabel', () => {
  it('bumps patch', () => {
    expect(nextVersionLabel('1.2.3', VersionLevel.Patch)).toBe('1.2.4');
  });

  it('bumps minor and resets patch', () => {
    expect(nextVersionLabel('1.2.3', VersionLevel.Minor)).toBe('1.3.0');
  });

  it('bumps major and resets minor/patch', () => {
    expect(nextVersionLabel('1.2.3', VersionLevel.Major)).toBe('2.0.0');
  });

  it('accepts a v-prefixed current version', () => {
    expect(nextVersionLabel('v1.2.3', VersionLevel.Patch)).toBe('1.2.4');
  });

  it('treats missing/invalid current version as 0.0.0', () => {
    expect(nextVersionLabel(null, VersionLevel.Patch)).toBe('0.0.1');
    expect(nextVersionLabel('not-a-version', VersionLevel.Minor)).toBe('0.1.0');
  });
});

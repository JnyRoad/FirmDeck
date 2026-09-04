// @vitest-environment jsdom

/**
 * ContentTab / VersionsTab 的 stale（基线过期）提示测试（T056，US3 验收场景 5）。
 *
 * 覆盖：某人发布了新正式版后，其他草稿持有者查看自己的草稿时，能在内容页横幅看到
 * "正式版已更新为 vX，本草稿基于 vY" 的提示（X 取自 `kb.published_version`，Y 取自
 * `currentDraft.base_version`）；版本 Tab 的对应行同步标记同一提示（以 `title` 承载，
 * 不挤占表格行的紧凑布局）。非 stale 草稿不显示该提示。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead, VersionDiff } from '@/types/knowledgeAdmin';

import { ContentTab } from './ContentTab';
import { VersionsTab } from './VersionsTab';

const sharedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  status: 'active',
  mode: 'shared',
  published_version_id: 'kbver_pub_2',
  published_version: '1.0.1',
  document_count: 3,
  bucket_count: 1,
  chunk_count: 3,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function makeDraft(overrides: Partial<KnowledgeAdminVersionRead> = {}): KnowledgeAdminVersionRead {
  return {
    id: 'kbver_draft_1',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_1',
    version: 'draft-7f2c',
    name: 'draft-7f2c',
    status: 'active',
    publication_state: 'draft',
    is_stale: true,
    base_version: '1.0.0',
    draft_name: 'draft-7f2c',
    next_version_preview: { patch: '1.0.2', minor: '1.1.0', major: '2.0.0' },
    source_team_id: null,
    created_by_user_id: 'user_admin',
    change_reason: '补充新版 FAQ',
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

const staleDraft = makeDraft();

const staleDiff: VersionDiff = {
  base_version_id: 'kbver_pub_1',
  target_version_id: 'kbver_draft_1',
  pairing: 'lineage',
  summary: { added: 1, modified: 0, deleted: 0 },
  documents: [
    {
      lineage_id: 'doc_new_1',
      title: '新增文档',
      kind: 'added',
      truncated: false,
      base_document_id: null,
      target_document_id: 'doc_new_1',
    },
  ],
};

function createMockApi(draft: KnowledgeAdminVersionRead) {
  return {
    listVersions: vi.fn().mockResolvedValue([draft]),
    getVersionDiff: vi.fn().mockResolvedValue(staleDiff),
    // Draft workspace source of truth (T081/A2b): mirrors `staleDiff`'s single added
    // document so it still renders once ContentTab merges the two lists.
    listVersionDocuments: vi.fn().mockResolvedValue([
      { id: 'doc_new_1', lineage_id: 'doc_new_1', title: '新增文档', filename: 'doc_new_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-20T00:00:00Z' },
    ]),
    uploadDocument: vi.fn(),
    updateDocument: vi.fn(),
    archiveDocument: vi.fn(),
    createDraft: vi.fn(),
    publishDraft: vi.fn(),
    rejectDraft: vi.fn(),
    recordReview: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContentTab stale banner', () => {
  it('shows "published updated to vX, draft based on vY" when the draft is stale', async () => {
    const api = createMockApi(staleDraft);
    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/kb?view=kbver_draft_1']}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <ContentTab api={api as any} kb={sharedKb} />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    await screen.findByText('新增文档');
    expect(await screen.findByText('正式版已更新为 v1.0.1，本草稿基于 v1.0.0。')).toBeTruthy();
  });

  it('does not show the stale banner for a non-stale draft', async () => {
    const freshDraft = makeDraft({ is_stale: false, base_version: '1.0.1' });
    const api = createMockApi(freshDraft);
    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/kb?view=kbver_draft_1']}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <ContentTab api={api as any} kb={sharedKb} />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    await screen.findByText('新增文档');
    expect(screen.queryByText(/正式版已更新为/)).toBeNull();
  });
});

describe('VersionsTab stale marker', () => {
  it('synchronizes the same stale detail message on the version row', async () => {
    const api = {
      listVersions: vi.fn().mockResolvedValue([staleDraft]),
      rollbackVersion: vi.fn(),
    };
    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/kb']}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <VersionsTab api={api as any} kb={sharedKb} />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(api.listVersions).toHaveBeenCalledWith('kb_1'));
    const badge = await screen.findByText('基线已过期');
    expect(badge.getAttribute('title')).toBe('正式版已更新为 v1.0.1，本草稿基于 v1.0.0。');
  });
});

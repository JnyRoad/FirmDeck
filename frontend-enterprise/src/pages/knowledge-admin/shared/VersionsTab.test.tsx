// @vitest-environment jsdom

/**
 * VersionsTab 测试（T042）。
 * 覆盖：服务端顺序原样展示（不在前端重新排序）；草稿行 查看变更/发布/驳回；
 * released 行（非当前正式版）回滚；当前正式版标记；创建草稿对话框（原因必填、
 * 来源上下文含「管理员直连」）。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

import { ContentTab } from './ContentTab';
import { VersionsTab } from './VersionsTab';

const sharedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  status: 'active',
  mode: 'shared',
  published_version_id: 'kbver_current',
  published_version: '1.1.0',
  document_count: 3,
  bucket_count: 1,
  chunk_count: 3,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function makeVersion(overrides: Partial<KnowledgeAdminVersionRead>): KnowledgeAdminVersionRead {
  return {
    id: 'kbver_x',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_1',
    version: '1.0.0',
    name: '1.0.0',
    status: 'active',
    publication_state: 'released',
    is_stale: false,
    base_version: null,
    draft_name: null,
    next_version_preview: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

// Deliberately NOT already sorted by version number — the server is the source of
// truth for ordering (draft newest-first -> released desc -> rejected); the tab must
// render this exact order without re-sorting on the client.
const serverOrderedVersions: KnowledgeAdminVersionRead[] = [
  makeVersion({ id: 'kbver_draft_2', version: 'draft-bb22', publication_state: 'draft', draft_name: 'draft-bb22', source_team_id: null }),
  makeVersion({ id: 'kbver_draft_1', version: 'draft-aa11', publication_state: 'draft', draft_name: 'draft-aa11', source_team_id: 'team_1' }),
  makeVersion({ id: 'kbver_current', version: '1.1.0', publication_state: 'released', is_published_head: true }),
  makeVersion({ id: 'kbver_old', version: '1.0.0', publication_state: 'released', is_published_head: false }),
  makeVersion({ id: 'kbver_rejected', version: 'draft-cc33', publication_state: 'rejected', draft_name: 'draft-cc33' }),
];

function createMockApi() {
  return {
    listVersions: vi.fn().mockResolvedValue(serverOrderedVersions),
    createDraft: vi.fn().mockResolvedValue({ id: 'kbver_new_draft' }),
    publishDraft: vi.fn(),
    rejectDraft: vi.fn(),
    rollbackVersion: vi.fn().mockResolvedValue({ status: 'ok' }),
    getVersionDiff: vi.fn().mockResolvedValue({
      base_version_id: null,
      target_version_id: 'x',
      pairing: 'lineage',
      summary: { added: 0, modified: 0, deleted: 0 },
      documents: [],
    }),
    // Needed only by ContentTab, mounted for the cross-tab publish/review flow test below.
    uploadDocument: vi.fn(),
    updateDocument: vi.fn(),
    archiveDocument: vi.fn(),
    recordReview: vi.fn().mockResolvedValue({}),
  };
}

function renderVersionsTab(mockApi: ReturnType<typeof createMockApi>) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/kb?tab=versions']}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <VersionsTab api={mockApi as any} kb={sharedKb} />
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

/**
 * Minimal stand-in for the slice of KnowledgeAdminDetailPage that matters here: it renders
 * VersionsTab or ContentTab from the same `?tab=` query param they both read/write, so a
 * cross-tab navigation (Versions -> "去审阅" -> Content) can be exercised without touching
 * KnowledgeAdminDetailPage.tsx itself (owned by another in-flight change).
 */
function DetailPageStub({ api }: { api: ReturnType<typeof createMockApi> }) {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'versions';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tab === 'content' ? <ContentTab api={api as any} kb={sharedKb} /> : <VersionsTab api={api as any} kb={sharedKb} />;
}

function renderDetailPageStub(mockApi: ReturnType<typeof createMockApi>) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/kb?tab=versions']}>
          <DetailPageStub api={mockApi} />
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VersionsTab', () => {
  it('renders rows in the exact server-provided order', async () => {
    const api = createMockApi();
    renderVersionsTab(api);

    await waitFor(() => expect(api.listVersions).toHaveBeenCalledWith('kb_1'));
    const rows = await screen.findAllByRole('row');
    // rows[0] is the header row.
    const bodyRowTexts = rows.slice(1).map((row) => row.textContent || '');
    expect(bodyRowTexts[0]).toContain('draft-bb22');
    expect(bodyRowTexts[1]).toContain('draft-aa11');
    expect(bodyRowTexts[2]).toContain('1.1.0');
    expect(bodyRowTexts[3]).toContain('1.0.0');
    expect(bodyRowTexts[4]).toContain('draft-cc33');
  });

  it('marks the current published version and offers view-changes/publish/reject on draft rows', async () => {
    const api = createMockApi();
    renderVersionsTab(api);

    await screen.findByText('draft-bb22');
    const currentRow = screen.getByText('v1.1.0').closest('tr')!;
    expect(within(currentRow).getByText('当前正式版')).toBeTruthy();

    const draftRow = screen.getByText('draft-bb22').closest('tr')!;
    expect(within(draftRow).getByRole('button', { name: '查看变更' })).toBeTruthy();
    expect(within(draftRow).getByRole('button', { name: '发布' })).toBeTruthy();
    expect(within(draftRow).getByRole('button', { name: '驳回' })).toBeTruthy();
  });

  it('offers rollback only on a released row that is not the current published version', async () => {
    const api = createMockApi();
    renderVersionsTab(api);

    await screen.findByText('draft-bb22');
    const currentRow = screen.getByText('v1.1.0').closest('tr')!;
    expect(within(currentRow).queryByRole('button', { name: '回滚到此版本' })).toBeNull();

    const oldRow = screen.getByText('v1.0.0').closest('tr')!;
    expect(within(oldRow).getByRole('button', { name: '回滚到此版本' })).toBeTruthy();
  });

  it('create-draft dialog requires a reason and shows "管理员直连" as the source context', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderVersionsTab(api);

    await screen.findByText('draft-bb22');
    await user.click(screen.getByRole('button', { name: '创建草稿' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('管理员直连')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '创建' }));
    expect(await within(dialog).findByText('请先填写原因')).toBeTruthy();
    expect(api.createDraft).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('变更原因'), '扩充产品条款');
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(api.createDraft).toHaveBeenCalledWith('kb_1', {
      teamId: null,
      changeReason: '扩充产品条款',
      expectedPublishedVersionId: 'kbver_current',
    }));
  });

  it('returns to the publish dialog for the same draft after applying a review opened from the Versions-tab publish dialog', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderDetailPageStub(api);

    // Open the publish dialog for draft-bb22 from the Versions tab.
    await screen.findByText('draft-bb22');
    const draftRow = screen.getByText('draft-bb22').closest('tr')!;
    await user.click(within(draftRow).getByRole('button', { name: '发布' }));
    expect(await screen.findByRole('heading', { name: /draft-bb22/ })).toBeTruthy();

    // "去审阅" navigates to the Content tab (VersionsTab, and its publishTarget state,
    // unmount here) carrying the publish/review intent in the URL.
    await user.click(screen.getByText('去审阅'));

    // ContentTab picks up the intent and opens the review dialog itself.
    expect(await screen.findByRole('heading', { name: '审阅变更' })).toBeTruthy();
    const applyButton = (await screen.findByRole('button', { name: '应用到草稿' })) as HTMLButtonElement;
    await waitFor(() => expect(applyButton.disabled).toBe(false));
    await user.click(applyButton);

    await waitFor(() => expect(api.recordReview).toHaveBeenCalledWith('kb_1', 'kbver_draft_2', expect.objectContaining({
      staged: 0,
      pending: 0,
    })));

    // Back to a publish dialog, for the same draft, without going through the Versions tab again.
    expect(await screen.findByRole('heading', { name: /draft-bb22/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '审阅变更' })).toBeNull();
  });
});

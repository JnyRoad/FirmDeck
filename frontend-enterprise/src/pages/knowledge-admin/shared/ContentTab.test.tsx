// @vitest-environment jsdom

/**
 * ContentTab 测试（T040）。
 * 覆盖：视图切换器（正式版/草稿）；正式视图只读且隐藏草稿新增/修改/删除标记；
 * 草稿视图展示新增/修改/删除标记，删除标记可恢复（含已删除文档不在 A2b 列表里、
 * 完全靠 diff 并入展示的场景——见 ContentTab.tsx 顶部注释）；横幅信息（创建者、来源、
 * 基线、发布后版本号预览、原因）与按钮；上传请求携带草稿 `knowledge_base_version_id`；
 * 删除/恢复请求以真实行 id 定位文档（未删除文档来自 A2b、已删除文档来自 diff 的
 * `target_document_id`），不是 `lineage_id`。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead, VersionDiff } from '@/types/knowledgeAdmin';

import { ContentTab } from './ContentTab';

const sharedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  status: 'active',
  mode: 'shared',
  published_version_id: 'kbver_pub',
  published_version: '1.0.0',
  document_count: 3,
  bucket_count: 1,
  chunk_count: 3,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const draftVersion: KnowledgeAdminVersionRead = {
  id: 'kbver_draft_1',
  tenant_id: 'tenant_demo',
  knowledge_base_id: 'kb_1',
  version: 'draft-7f2c',
  name: 'draft-7f2c',
  status: 'active',
  publication_state: 'draft',
  is_stale: false,
  base_version: '1.0.0',
  draft_name: 'draft-7f2c',
  next_version_preview: { patch: '1.0.1', minor: '1.1.0', major: '2.0.0' },
  source_team_id: null,
  created_by_user_id: 'user_admin',
  change_reason: '补充新版 FAQ',
  created_at: '2026-08-20T00:00:00Z',
  updated_at: '2026-08-20T00:00:00Z',
};

const pubDiff: VersionDiff = {
  base_version_id: '',
  target_version_id: 'kbver_pub',
  pairing: 'lineage',
  summary: { added: 1, modified: 0, deleted: 0 },
  documents: [
    {
      lineage_id: 'doc_pub_1',
      title: '发布说明',
      kind: 'added',
      truncated: false,
      base_document_id: null,
      target_document_id: 'doc_pub_1',
      base_updated_at: null,
      target_updated_at: null,
    },
  ],
};

const draftDiff: VersionDiff = {
  base_version_id: 'kbver_pub',
  target_version_id: 'kbver_draft_1',
  pairing: 'lineage',
  summary: { added: 1, modified: 1, deleted: 1 },
  documents: [
    {
      lineage_id: 'doc_new_1',
      title: '新增文档',
      kind: 'added',
      truncated: false,
      base_document_id: null,
      target_document_id: 'doc_new_1',
      base_updated_at: null,
      target_updated_at: null,
    },
    {
      lineage_id: 'doc_mod_1',
      title: '修改文档',
      kind: 'modified',
      truncated: false,
      base_document_id: 'doc_mod_1_base',
      target_document_id: 'doc_mod_1',
      base_updated_at: null,
      target_updated_at: null,
      hunks: [
        { type: 'change', base_start: 0, base_lines: ['旧内容'], target_start: 0, target_lines: ['新内容'], pairs: [[0, 0]] },
      ],
    },
    {
      lineage_id: 'doc_del_1',
      title: '删除文档',
      kind: 'deleted',
      truncated: false,
      base_document_id: 'doc_del_1',
      // backend commit ab58668: for a deleted entry this is the draft's own archived
      // row id (not null anymore) — deliberately distinct from any A2b row id below so
      // a test asserting on this value can't pass by accident via `documentRowByLineage`.
      target_document_id: 'doc_del_1_archived',
      base_updated_at: null,
      // Optimistic-lock field completion round: the archived row's own `updated_at`,
      // deliberately distinct from every A2b row timestamp below so a test asserting on
      // this value can't pass by accident via `documentRowByLineage`.
      target_updated_at: '2026-08-21T04:00:00Z',
    },
  ],
};

// T081/A2b draft workspace document list for `kbver_draft_1`: real row ids deliberately
// differ from `lineage_id` (`_row` suffix) — mirrors a cross-version clone, where the
// backend assigns a new row id and keeps the original `lineage_id` only in metadata.
// Write-back (delete/restore) must target these real ids, not `lineage_id` (T083).
// 行时间戳刻意与 `draftVersion.updated_at`（版本行）不同：手工删除/恢复带的
// `expectedUpdatedAt` 必须来自文档行本身（C1 统一三处写回的锁口径）。
//
// backend commit ab58668: A2b now excludes `status='archived'` rows entirely, so the
// deleted document (`doc_del_1`) never appears here — only in `draftDiff` above.
const draftVersionDocuments = [
  { id: 'doc_new_1_row', lineage_id: 'doc_new_1', title: '新增文档', filename: 'doc_new_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-21T01:00:00Z' },
  { id: 'doc_mod_1_row', lineage_id: 'doc_mod_1', title: '修改文档', filename: 'doc_mod_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-21T02:00:00Z' },
];

// T077 rerun Defect B regression fixture: `kbver_pub`'s full A2b document list. `doc_pub_1`
// ("发布说明") matches `pubDiff`'s one `added` entry (by `lineage_id`) and must get the
// release-context badge; `doc_pub_2` ("未变更文档") is NOT in `pubDiff` at all — it's a
// document that has been live and unchanged since before the prior release — and must
// still render (with no badge). Before the fix, the published view was driven entirely by
// `pubDiff.documents`, so `doc_pub_2` would have been silently dropped from the list.
const pubVersionDocuments = [
  { id: 'doc_pub_1', lineage_id: 'doc_pub_1', title: '发布说明', filename: 'doc_pub_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-15T00:00:00Z' },
  { id: 'doc_pub_2', lineage_id: 'doc_pub_2', title: '未变更文档', filename: 'doc_pub_2.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-10T00:00:00Z' },
];

function createMockApi() {
  return {
    listVersions: vi.fn().mockResolvedValue([draftVersion]),
    getVersionDiff: vi.fn().mockImplementation((_kbId: string, versionId: string) =>
      Promise.resolve(versionId === 'kbver_draft_1' ? draftDiff : pubDiff),
    ),
    listVersionDocuments: vi.fn().mockImplementation((_kbId: string, versionId: string) =>
      Promise.resolve(versionId === 'kbver_draft_1' ? draftVersionDocuments : pubVersionDocuments),
    ),
    uploadDocument: vi.fn().mockResolvedValue({ id: 'job_1', status: 'pending' }),
    updateDocument: vi.fn().mockResolvedValue({ id: 'doc_1' }),
    archiveDocument: vi.fn().mockResolvedValue({ id: 'doc_1' }),
    createDraft: vi.fn(),
    publishDraft: vi.fn(),
    rejectDraft: vi.fn(),
    recordReview: vi.fn(),
  };
}

// Exposes the router's current `location.search` via a testid, since `MemoryRouter`
// keeps its own in-memory history and never touches `window.location`.
function LocationSearchProbe() {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

function renderContentTab(mockApi: ReturnType<typeof createMockApi>, initialEntry = '/kb') {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <LocationSearchProbe />
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <ContentTab api={mockApi as any} kb={sharedKb} />
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContentTab', () => {
  it('shows the view switcher with the published version and each draft', async () => {
    const api = createMockApi();
    renderContentTab(api);

    await waitFor(() => expect(api.listVersions).toHaveBeenCalledWith('kb_1'));
    const switcher = await screen.findByRole('combobox', { name: '查看版本' });
    expect(within(switcher).getByText('正式版本')).toBeTruthy();
  });

  it('published view is read-only: no draft badges, no upload, no delete controls', async () => {
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('发布说明');
    expect(screen.queryByText('草稿新增')).toBeNull();
    expect(screen.queryByText('草稿修改')).toBeNull();
    expect(screen.queryByText('草稿删除')).toBeNull();
    expect(screen.queryByRole('button', { name: '上传文档' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.getByRole('button', { name: '创建草稿' })).toBeTruthy();
  });

  // T077 rerun Defect B: the published view's document list must come from A2b
  // (`listVersionDocuments`) in full, not be filtered down to only what the diff against
  // the prior release happens to mention. `doc_pub_2` ("未变更文档") is absent from
  // `pubDiff.documents` entirely, yet it's still a live document in `kbver_pub` per A2b and
  // must render; `doc_pub_1` ("发布说明") IS in the diff (kind `added`) and must get a
  // release-context badge — badges decorate, they never filter.
  it('published view lists every A2b document, including ones absent from the diff, and badges the ones the diff covers', async () => {
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('发布说明');
    expect(await screen.findByText('未变更文档')).toBeTruthy();
    expect(api.listVersionDocuments).toHaveBeenCalledWith('kb_1', 'kbver_pub');

    // The changed document gets the release-context badge ("新增", not "草稿新增" — the
    // published view has no draft concept)...
    expect(screen.getByText('新增')).toBeTruthy();
    expect(screen.queryByText('草稿新增')).toBeNull();
    // ...the unchanged document gets no badge at all.
    const unchangedRow = screen.getByText('未变更文档').closest('tr');
    expect(unchangedRow).toBeTruthy();
    expect(within(unchangedRow as HTMLElement).queryByText('新增')).toBeNull();
    expect(within(unchangedRow as HTMLElement).queryByText('修改')).toBeNull();
  });

  // 回归覆盖（backend commit ab58668）：A2b `listVersionDocuments` mock（`draftVersionDocuments`）
  // 完全不含 `doc_del_1`——真实后端现在把 `status='archived'` 的行整个排除在这份列表之外。
  // 「删除文档」这一行必须仍然出现（并带「草稿删除」标记 + 「恢复」按钮），证明它是从
  // `draftDiff` 的 `kind==='deleted'` 条目并入的，而不是继续依赖 A2b 主列表。
  it('draft view shows added/modified/deleted badges with a restore action for deleted rows, even when the deleted row is absent from the A2b list', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('发布说明');
    await user.click(screen.getByRole('combobox', { name: '查看版本' }));
    await user.click(await screen.findByText('草稿 draft-7f2c'));

    await screen.findByText('新增文档');
    expect(screen.getByText('修改文档')).toBeTruthy();
    expect(screen.getByText('删除文档')).toBeTruthy();
    expect(screen.getAllByText('草稿新增').length).toBeGreaterThan(0);
    expect(screen.getAllByText('草稿修改').length).toBeGreaterThan(0);
    expect(screen.getAllByText('草稿删除').length).toBeGreaterThan(0);

    // The deleted row gets "恢复"; added/modified rows get "删除".
    expect(screen.getByRole('button', { name: '恢复' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(2);
  });

  it('shows the draft banner: creator, source, base version, next version preview, reason, and action buttons', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api, '/kb?view=kbver_draft_1');

    await screen.findByText('新增文档');
    expect(screen.getByText(/user_admin/)).toBeTruthy();
    expect(screen.getByText(/管理员直连/)).toBeTruthy();
    expect(screen.getByText(/v1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/v1\.0\.1/)).toBeTruthy();
    expect(screen.getByText(/补充新版 FAQ/)).toBeTruthy();

    expect(screen.getByRole('button', { name: '查看变更' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布此草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '驳回' })).toBeTruthy();
    void user;
  });

  it('uploads a document to the current draft with knowledgeBaseVersionId set', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api, '/kb?view=kbver_draft_1');

    await screen.findByText('新增文档');
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    const input = screen.getByTestId('content-upload-input');
    await user.upload(input, file);

    await waitFor(() => expect(api.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseVersionId: 'kbver_draft_1', filename: 'notes.md' }),
    ));
  });

  it('deletes a document (archives it) and restores a deleted document from the draft workspace', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api, '/kb?view=kbver_draft_1');

    await screen.findByText('新增文档');
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    await user.click(deleteButtons[0]);
    // Real row id (`doc_new_1_row`), not `lineage_id` (`doc_new_1`) — T083 regression
    // coverage: write-back must resolve through `listVersionDocuments`.
    // 同时校验乐观锁：带的是**该文档行**的 `updated_at`（与草稿版本行的不同），
    // 与 applyReview / private/ContentTab 保持同一套口径（C1）。
    await waitFor(() => expect(api.archiveDocument).toHaveBeenCalledWith('doc_new_1_row', { expectedUpdatedAt: '2026-08-21T01:00:00Z' }));
    expect(api.archiveDocument).not.toHaveBeenCalledWith('doc_new_1', expect.anything());

    // Restoring a deleted document: the row never appears in A2b (`listVersionDocuments`
    // hides `status='archived'` rows — backend commit ab58668), so write-back must resolve
    // through the diff's `target_document_id`/`target_updated_at` instead of
    // `listVersionDocuments`/`lineage_id`.
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('doc_del_1_archived', {
      status: 'ready',
      expectedUpdatedAt: '2026-08-21T04:00:00Z',
    }));
    expect(api.updateDocument).not.toHaveBeenCalledWith('doc_del_1', expect.anything());
  });

  it('shows unchanged documents in the draft workspace alongside added/modified/deleted ones', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listVersionDocuments.mockResolvedValue([
      ...draftVersionDocuments,
      { id: 'doc_unchanged_1', lineage_id: 'doc_unchanged_1', title: '未改动文档', filename: 'doc_unchanged_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: draftVersion.updated_at },
    ]);
    renderContentTab(api, '/kb?view=kbver_draft_1');

    await screen.findByText('新增文档');
    const unchangedRow = await screen.findByText('未改动文档');
    expect(unchangedRow).toBeTruthy();
    // No draft badge for an unchanged document...
    expect(screen.queryByText('草稿新增')).not.toBeNull(); // sanity: other badges still render
    // ...but it still gets a delete action, same as added/modified rows.
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(3);
    void user;
  });

  // Regression for the fix-round-1 race: on a fresh mount with `?view=<draftId>` already
  // in the URL (exactly what the Versions-tab publish dialog's "去审阅" link produces),
  // `versions` starts out `[]`, so `targetVersionId` first falls back to
  // `kb.published_version_id` and `loadDiff()` fetches the PUBLISHED diff before
  // `loadVersions()` resolves. The review-intent effect must NOT open the review editor
  // against that stale published diff — it must wait until the loaded `diff` actually
  // belongs to the draft being reviewed.
  it('review-intent deep link waits for the draft diff, not the still-loading published diff (race regression)', async () => {
    const api = createMockApi();
    // Force `listVersions()` to resolve strictly after the (immediate) published-diff
    // fetch, so `currentDraft`/`targetVersionId` only flip to the draft well after
    // `diff` has already settled on the published version's diff — the exact ordering
    // the fix-round-1 race depends on (network timing means either request can win).
    api.listVersions.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([draftVersion]), 30)),
    );
    renderContentTab(api, '/kb?view=kbver_draft_1&publish=kbver_draft_1&review=1');

    const dialog = await screen.findByRole('dialog', { name: '审阅变更' });
    // Must show the draft's own diff documents...
    expect(within(dialog).getByText('新增文档')).toBeTruthy();
    expect(within(dialog).getByText('修改文档')).toBeTruthy();
    // ...never the published version's diff document that was fetched first.
    expect(within(dialog).queryByText('发布说明')).toBeNull();
  });

  it('review-intent deep link strips `publish`/`review` from the URL once consumed', async () => {
    const api = createMockApi();
    renderContentTab(api, '/kb?view=kbver_draft_1&publish=kbver_draft_1&review=1');

    await screen.findByRole('dialog', { name: '审阅变更' });
    await waitFor(() => expect(screen.getByTestId('location-search').textContent || '').not.toContain('review'));
    expect(screen.getByTestId('location-search').textContent || '').not.toContain('publish');
  });

  it('clears a stale review-intent from the URL if loadVersions() fails, without opening review', async () => {
    const api = createMockApi();
    api.listVersions.mockRejectedValueOnce(new Error('network error'));
    renderContentTab(api, '/kb?view=kbver_draft_1&publish=kbver_draft_1&review=1');

    await waitFor(() => expect(screen.getByTestId('location-search').textContent || '').not.toContain('review'));
    expect(screen.getByTestId('location-search').textContent || '').not.toContain('publish');
    expect(screen.queryByRole('dialog', { name: '审阅变更' })).toBeNull();
  });
});

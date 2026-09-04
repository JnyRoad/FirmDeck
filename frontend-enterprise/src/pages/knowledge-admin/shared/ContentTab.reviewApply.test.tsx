// @vitest-environment jsdom

/**
 * ContentTab 审阅应用流程测试（T041）。
 * 覆盖：「应用到草稿」按审阅结果调用 updateDocument（modified，含
 * content_md/expected_updated_at）、archiveDocument（新增被拒绝）、updateDocument
 * status=ready（删除被拒绝=恢复），最后调用 recordReview；成功后 toast 与刷新；
 * 从发布框进入时应用后返回发布框；写回中途遇到 KNOWLEDGE_PUBLISH_CONFLICT 时
 * 提示"草稿已被他人修改，请刷新后重新审阅"且不再提交剩余写回。
 *
 * ReviewEditor 内部的 contenteditable/DOM 编辑行为已由 review/ReviewEditor.test.tsx
 * 单独覆盖；这里 mock ReviewEditor，直接驱动其 `onChange` 输出来聚焦测试
 * ContentTab 自己的写回编排逻辑。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { Toaster } from '@/components/ui';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead, VersionDiff } from '@/types/knowledgeAdmin';
import type { ReviewEditorOutput } from '../review/ReviewEditor';

let latestOnChange: ((output: ReviewEditorOutput) => void) | null = null;

vi.mock('../review/ReviewEditor', () => ({
  ReviewEditor: ({ onChange }: { onChange: (output: ReviewEditorOutput) => void }) => {
    latestOnChange = onChange;
    return <div data-testid="mock-review-editor" />;
  },
}));

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
  updated_at: '2026-08-20T05:00:00Z',
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
    },
    {
      lineage_id: 'doc_mod_1',
      title: '修改文档',
      kind: 'modified',
      truncated: false,
      base_document_id: 'doc_mod_1_base',
      target_document_id: 'doc_mod_1',
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
      target_document_id: null,
    },
  ],
};

const emptyOutput: ReviewEditorOutput = {
  docs: [
    { lineageId: 'doc_new_1', kind: 'added', lines: ['新增文档'], staged: [], restore: false },
    { lineageId: 'doc_mod_1', kind: 'modified', lines: ['新内容'], staged: [{ id: 1, pos: 0, removed: ['旧内容'], added: ['新内容'] }], restore: false },
    { lineageId: 'doc_del_1', kind: 'deleted', lines: [], staged: [], restore: false },
  ],
  pendingCount: 0,
  stagedCount: 1,
  hasWork: true,
};

function createMockApi() {
  return {
    listVersions: vi.fn().mockResolvedValue([draftVersion]),
    getVersionDiff: vi.fn().mockResolvedValue(draftDiff),
    // T081/A2b draft workspace document list: real row ids deliberately differ from
    // `lineage_id` (e.g. a cross-version clone gets a new row id, keeping only the
    // original `lineage_id` in metadata) — this is the exact "known limitation"
    // scenario T083 fixes. `applyReview` must write back with these real ids, not
    // `document.lineageId` from the review output.
    listVersionDocuments: vi.fn().mockResolvedValue([
      { id: 'doc_new_1_row', lineage_id: 'doc_new_1', title: '新增文档', filename: 'doc_new_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: draftVersion.updated_at },
      { id: 'doc_mod_1_row', lineage_id: 'doc_mod_1', title: '修改文档', filename: 'doc_mod_1.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: draftVersion.updated_at },
      { id: 'doc_del_1_row', lineage_id: 'doc_del_1', title: '删除文档', filename: 'doc_del_1.md', status: 'archived', bucket_count: 0, chunk_count: 0, updated_at: draftVersion.updated_at },
    ]),
    uploadDocument: vi.fn(),
    updateDocument: vi.fn().mockResolvedValue({ id: 'doc' }),
    archiveDocument: vi.fn().mockResolvedValue({ id: 'doc' }),
    createDraft: vi.fn(),
    publishDraft: vi.fn(),
    rejectDraft: vi.fn(),
    recordReview: vi.fn().mockResolvedValue({ ...draftVersion }),
  };
}

function renderContentTab(mockApi: ReturnType<typeof createMockApi>, initialEntry = '/kb?view=kbver_draft_1') {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <ContentTab api={mockApi as any} kb={sharedKb} />
        </MemoryRouter>
        <Toaster />
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  latestOnChange = null;
});

describe('ContentTab review-apply flow', () => {
  it('writes back modified content, leaves untouched added/deleted docs alone, then records review and refreshes', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('新增文档');
    await user.click(screen.getByRole('button', { name: '查看变更' }));
    await screen.findByTestId('mock-review-editor');

    act(() => latestOnChange?.(emptyOutput));
    await user.click(screen.getByRole('button', { name: '应用到草稿' }));

    // Real row id (`doc_mod_1_row`), not the review output's `lineageId` (`doc_mod_1`) —
    // proves write-back is resolved through `listVersionDocuments`, not the diff's
    // cross-version `lineage_id` (T083).
    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('doc_mod_1_row', {
      contentMd: '新内容',
      expectedUpdatedAt: draftVersion.updated_at,
    }));
    expect(api.updateDocument).not.toHaveBeenCalledWith('doc_mod_1', expect.anything());
    expect(api.archiveDocument).not.toHaveBeenCalled();
    expect(api.updateDocument).not.toHaveBeenCalledWith('doc_del_1_row', expect.anything());

    await waitFor(() => expect(api.recordReview).toHaveBeenCalledWith('kb_1', 'kbver_draft_1', expect.objectContaining({
      staged: 1,
      pending: 0,
      expectedUpdatedAt: draftVersion.updated_at,
    })));
    await waitFor(() => expect(api.listVersions).toHaveBeenCalledTimes(2));
  });

  it('archives a rejected addition and restores a rejected deletion', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('新增文档');
    await user.click(screen.getByRole('button', { name: '查看变更' }));
    await screen.findByTestId('mock-review-editor');

    act(() => latestOnChange?.({
      ...emptyOutput,
      docs: [
        { lineageId: 'doc_new_1', kind: 'added', lines: [], staged: [], restore: true },
        { lineageId: 'doc_mod_1', kind: 'modified', lines: ['新内容'], staged: [], restore: false },
        { lineageId: 'doc_del_1', kind: 'deleted', lines: ['旧内容'], staged: [], restore: true },
      ],
    }));
    await user.click(screen.getByRole('button', { name: '应用到草稿' }));

    // Both assertions use the real row id (`_row` suffix), not the review output's
    // `lineageId` — same T083 regression coverage as the "modified" case above.
    await waitFor(() => expect(api.archiveDocument).toHaveBeenCalledWith('doc_new_1_row', { expectedUpdatedAt: draftVersion.updated_at }));
    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('doc_del_1_row', {
      status: 'ready',
      expectedUpdatedAt: draftVersion.updated_at,
    }));
  });

  it('shows the conflict message and stops the remaining write-back on KNOWLEDGE_PUBLISH_CONFLICT', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.updateDocument.mockRejectedValueOnce({ code: 'KNOWLEDGE_PUBLISH_CONFLICT' });
    renderContentTab(api);

    await screen.findByText('新增文档');
    await user.click(screen.getByRole('button', { name: '查看变更' }));
    await screen.findByTestId('mock-review-editor');

    act(() => latestOnChange?.(emptyOutput));
    await user.click(screen.getByRole('button', { name: '应用到草稿' }));

    expect(await screen.findByText('草稿已被他人修改，请刷新后重新审阅')).toBeTruthy();
    expect(api.recordReview).not.toHaveBeenCalled();
  });

  it('re-opens the publish dialog after applying review when review was opened from the publish dialog', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderContentTab(api);

    await screen.findByText('新增文档');
    await user.click(screen.getByRole('button', { name: '发布此草稿' }));
    await user.click(await screen.findByText('去审阅'));

    await screen.findByTestId('mock-review-editor');
    act(() => latestOnChange?.(emptyOutput));
    await user.click(screen.getByRole('button', { name: '应用到草稿' }));

    await waitFor(() => expect(api.recordReview).toHaveBeenCalled());
    expect(await screen.findByText(/发布草稿/)).toBeTruthy();
  });
});

// @vitest-environment jsdom

/**
 * 私有库 ContentTab 测试（US5，T066）。
 * 覆盖：横幅展示归属员工、分支头版本号、同步状态；文档表来自
 * `listVersionDocuments(kb.id, headVersionId)`；上传/编辑/删除后分支头版本 +1
 * （`listVersions` 重新拉取返回新的 head）且列表随之刷新，`onChanged` 被调用。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead, VersionDocument } from '@/types/knowledgeAdmin';

import { ContentTab } from './ContentTab';

const dedicatedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '林晓的私有库',
  status: 'active',
  mode: 'dedicated',
  branch_sync_state: 'diverged',
  branch_base_version: '2',
  branch_head_version: '3',
  metadata: { owner_agent_id: 'ag_1' },
  document_count: 1,
  bucket_count: 1,
  chunk_count: 1,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const headVersionV3: KnowledgeAdminVersionRead = {
  id: 'kbver_3',
  tenant_id: 'tenant_demo',
  knowledge_base_id: 'kb_1',
  version: '3',
  name: '3',
  status: 'active',
  is_head: true,
  is_base: false,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
} as KnowledgeAdminVersionRead;

const baseVersionV2: KnowledgeAdminVersionRead = {
  id: 'kbver_2',
  tenant_id: 'tenant_demo',
  knowledge_base_id: 'kb_1',
  version: '2',
  name: '2',
  status: 'active',
  is_head: false,
  is_base: true,
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
} as KnowledgeAdminVersionRead;

const headVersionV4: KnowledgeAdminVersionRead = {
  ...headVersionV3,
  id: 'kbver_4',
  version: '4',
  name: '4',
  updated_at: '2026-08-19T00:00:00Z',
};

const docA: VersionDocument = {
  id: 'doc_a',
  lineage_id: 'doc_a',
  title: '话术文档 A',
  filename: 'a.md',
  status: 'ready',
  bucket_count: 1,
  chunk_count: 2,
  updated_at: '2026-08-18T00:00:00Z',
};

const docB: VersionDocument = {
  id: 'doc_b',
  lineage_id: 'doc_b',
  title: '新上传文档',
  filename: 'b.md',
  status: 'ready',
  bucket_count: 1,
  chunk_count: 1,
  updated_at: '2026-08-19T00:00:00Z',
};

function createMockApi() {
  return {
    listVersions: vi.fn().mockResolvedValue([headVersionV3, baseVersionV2]),
    listVersionDocuments: vi.fn().mockResolvedValue([docA]),
    getDocument: vi.fn().mockResolvedValue({ id: 'doc_a', metadata: {} }),
    uploadDocument: vi.fn().mockResolvedValue({ id: 'job_1', status: 'pending' }),
    updateDocument: vi.fn().mockResolvedValue({ id: 'doc_a' }),
    archiveDocument: vi.fn().mockResolvedValue({ id: 'doc_a' }),
  };
}

function renderTab(mockApi: ReturnType<typeof createMockApi>, onChanged = vi.fn()) {
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ContentTab api={mockApi as any} kb={dedicatedKb} ownerAgentId="ag_1" ownerAgentName="林晓" onChanged={onChanged} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('private ContentTab', () => {
  it('shows a banner with the owner, branch head version, and sync state', async () => {
    const api = createMockApi();
    renderTab(api);

    await waitFor(() => expect(api.listVersions).toHaveBeenCalledWith('kb_1', 'ag_1'));
    expect(await screen.findByText(/当前查看员工 林晓 的分支头版本 v3/)).toBeTruthy();
    expect(screen.getByText('有差异')).toBeTruthy();
  });

  it('lists documents from the branch head version via listVersionDocuments', async () => {
    const api = createMockApi();
    renderTab(api);

    await screen.findByText('话术文档 A');
    expect(api.listVersionDocuments).toHaveBeenCalledWith('kb_1', 'kbver_3');
  });

  it('uploading a document bumps the branch head version and refreshes the list', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByText('话术文档 A');

    api.listVersions.mockResolvedValueOnce([headVersionV4, headVersionV3, baseVersionV2]);
    api.listVersionDocuments.mockResolvedValueOnce([docB, docA]);

    const file = new File(['hello'], 'b.md', { type: 'text/markdown' });
    const input = screen.getByTestId('private-content-upload-input');
    await user.upload(input, file);

    await waitFor(() => expect(api.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: 'kb_1', filename: 'b.md' }),
      'ag_1',
    ));

    await screen.findByText(/分支头版本 v4/);
    expect(screen.getByText('新上传文档')).toBeTruthy();
    expect(api.listVersionDocuments).toHaveBeenLastCalledWith('kb_1', 'kbver_4');
    expect(onChanged).toHaveBeenCalled();
  });

  it('editing a document saves content and bumps the branch head version', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByText('话术文档 A');
    await user.click(screen.getByRole('button', { name: '编辑' }));

    await screen.findByRole('dialog');
    const contentBox = await screen.findByLabelText('正文');
    await user.clear(contentBox);
    await user.type(contentBox, '更新后的正文');

    api.listVersions.mockResolvedValueOnce([headVersionV4, headVersionV3, baseVersionV2]);
    api.listVersionDocuments.mockResolvedValueOnce([docA]);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith(
      'doc_a',
      expect.objectContaining({ title: '话术文档 A', contentMd: '更新后的正文' }),
      'ag_1',
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChanged).toHaveBeenCalled();
  });

  it('deleting a document archives it and refreshes the list', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByText('话术文档 A');
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(api.archiveDocument).toHaveBeenCalledWith(
      'doc_a',
      expect.objectContaining({ expectedUpdatedAt: docA.updated_at }),
      'ag_1',
    ));
    expect(onChanged).toHaveBeenCalled();
  });
});

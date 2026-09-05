// @vitest-environment jsdom

/**
 * ContentTab 过期响应护栏测试（跨任务评审 I1）。
 *
 * 覆盖两条以前完全没有保护的路径：
 * 1. `?view=` 快速切换时先发后到的 `getVersionDiff` 响应不得覆盖新版本的数据
 *    ——这条最危险，因为表格里的删除/恢复按钮会拿着**上一个版本的真实文档 id**
 *    去写回；同时切换目标与请求失败都必须先清空 `diff`/`versionDocuments`，
 *    不能让旧版本的行留在界面上被误当成新版本的内容。
 * 2. 租户代际失效（跨租户/跨登录会话切换）后，旧租户的在途响应不得落到界面上。
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

/** 由每个用例决定 `useTenantSession()` 返回什么（null = 没有 Provider 的组件级单测默认）。 */
let tenantSessionValue: { generation: number; isCurrentGeneration: (g: number) => boolean } | null = null;

vi.mock('@/contexts/TenantSessionContext', () => ({
  useTenantSession: () => tenantSessionValue,
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
  document_count: 2,
  bucket_count: 1,
  chunk_count: 2,
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

function diffFor(versionId: string, title: string): VersionDiff {
  return {
    base_version_id: 'kbver_base',
    target_version_id: versionId,
    pairing: 'lineage',
    summary: { added: 1, modified: 0, deleted: 0 },
    documents: [
      { lineage_id: `${versionId}_lineage`, title, kind: 'added', truncated: false, base_document_id: null, target_document_id: `${versionId}_doc`, base_updated_at: null, target_updated_at: null },
    ],
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderContentTab(api: unknown, initialEntry = '/kb') {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <ContentTab api={api as any} kb={sharedKb} />
        </MemoryRouter>
        <Toaster />
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  tenantSessionValue = null;
});

describe('ContentTab — 视图切换的过期响应护栏', () => {
  it('drops a stale getVersionDiff response that lands after the view already moved on', async () => {
    const user = userEvent.setup();
    const pubDiff = deferred<VersionDiff>();
    const draftDiff = deferred<VersionDiff>();
    const api = {
      listVersions: vi.fn().mockResolvedValue([draftVersion]),
      getVersionDiff: vi.fn((_kbId: string, versionId: string) =>
        versionId === 'kbver_pub' ? pubDiff.promise : draftDiff.promise,
      ),
      listVersionDocuments: vi.fn().mockResolvedValue([
        { id: 'draft_row_1', lineage_id: 'kbver_draft_1_lineage', title: '草稿版本文档', filename: 'a.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-21T00:00:00Z' },
      ]),
      uploadDocument: vi.fn(),
      updateDocument: vi.fn(),
      archiveDocument: vi.fn(),
      createDraft: vi.fn(),
      publishDraft: vi.fn(),
      rejectDraft: vi.fn(),
      recordReview: vi.fn(),
    };
    renderContentTab(api);

    // 正式版视图的对比请求已经发出但还没返回，这时切到草稿视图。
    await waitFor(() => expect(api.getVersionDiff).toHaveBeenCalledWith('kb_1', 'kbver_pub', { against: 'base' }));
    await user.click(screen.getByRole('combobox', { name: '查看版本' }));
    await user.click(await screen.findByText('草稿 draft-7f2c'));
    await waitFor(() => expect(api.getVersionDiff).toHaveBeenCalledWith('kb_1', 'kbver_draft_1', { against: 'base' }));

    await act(async () => {
      draftDiff.resolve(diffFor('kbver_draft_1', '草稿版本文档'));
      await Promise.resolve();
    });
    expect(await screen.findByText('草稿版本文档')).toBeTruthy();

    // 正式版的响应姗姗来迟：必须整个丢弃，否则表格会退回上一个版本的行，
    // 而删除/恢复会拿着那些行的真实 id 写回当前草稿。
    await act(async () => {
      pubDiff.resolve(diffFor('kbver_pub', '正式版本文档'));
      await Promise.resolve();
    });
    expect(screen.queryByText('正式版本文档')).toBeNull();
    expect(screen.getByText('草稿版本文档')).toBeTruthy();
  });

  it('clears the previous version rows when the new view fails to load', async () => {
    const user = userEvent.setup();
    const api = {
      listVersions: vi.fn().mockResolvedValue([draftVersion]),
      getVersionDiff: vi.fn((_kbId: string, versionId: string) =>
        versionId === 'kbver_pub'
          ? Promise.resolve(diffFor('kbver_pub', '正式版本文档'))
          : Promise.reject(new Error('boom')),
      ),
      // A2b is now the published view's row source too (Defect B fix) — the row for
      // `kbver_pub` must come from here, matched to the diff above by `lineage_id`.
      listVersionDocuments: vi.fn((_kbId: string, versionId: string) =>
        Promise.resolve(
          versionId === 'kbver_pub'
            ? [{ id: 'pub_row_1', lineage_id: 'kbver_pub_lineage', title: '正式版本文档', filename: 'a.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-15T00:00:00Z' }]
            : [],
        ),
      ),
      uploadDocument: vi.fn(),
      updateDocument: vi.fn(),
      archiveDocument: vi.fn(),
      createDraft: vi.fn(),
      publishDraft: vi.fn(),
      rejectDraft: vi.fn(),
      recordReview: vi.fn(),
    };
    renderContentTab(api);

    expect(await screen.findByText('正式版本文档')).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: '查看版本' }));
    await user.click(await screen.findByText('草稿 draft-7f2c'));

    // 切换目标 + 加载失败：不能继续显示上一个版本的行。
    await waitFor(() => expect(screen.queryByText('正式版本文档')).toBeNull());
  });
});

describe('ContentTab — 租户代际护栏', () => {
  it('drops a response that arrives after the tenant generation changed', async () => {
    tenantSessionValue = { generation: 7, isCurrentGeneration: () => false };
    const api = {
      listVersions: vi.fn().mockResolvedValue([draftVersion]),
      getVersionDiff: vi.fn().mockResolvedValue(diffFor('kbver_pub', '正式版本文档')),
      // A2b is now the published view's row source too (Defect B fix) — matched to the
      // diff above by `lineage_id`.
      listVersionDocuments: vi.fn().mockResolvedValue([
        { id: 'pub_row_1', lineage_id: 'kbver_pub_lineage', title: '正式版本文档', filename: 'a.md', status: 'ready', bucket_count: 0, chunk_count: 0, updated_at: '2026-08-15T00:00:00Z' },
      ]),
      uploadDocument: vi.fn(),
      updateDocument: vi.fn(),
      archiveDocument: vi.fn(),
      createDraft: vi.fn(),
      publishDraft: vi.fn(),
      rejectDraft: vi.fn(),
      recordReview: vi.fn(),
    };
    renderContentTab(api);

    await waitFor(() => expect(api.getVersionDiff).toHaveBeenCalled());
    // 响应已经 resolve 并被消费完，但代际已失效：旧租户的行绝不能落到界面上。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('正式版本文档')).toBeNull();

    // 对照：同一份响应在代际仍然有效时是会渲染出来的，证明上面的缺席来自护栏而非 mock 失效。
    cleanup();
    tenantSessionValue = { generation: 7, isCurrentGeneration: () => true };
    renderContentTab(api);
    expect(await screen.findByText('正式版本文档')).toBeTruthy();
  });
});

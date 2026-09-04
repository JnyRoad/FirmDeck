// @vitest-environment jsdom

/**
 * 私有库 BranchTab 测试（US5，T067）。
 * 覆盖：分支状态卡（归属员工、广场基线、分支头、同步状态）；
 * 「从广场同步」/「发布到广场为模板」/历史版本「回滚到此版本」都走二次确认，
 * 确认后调用对应 API 并刷新（`onChanged` 被调用）。
 */
import type { ReactElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

// T084：断言迁移后的 toast 出口——已注册错误码要显示契约里的具体本地化文案，
// 而不是 legacy notify 把整句译文当错误码解析失败后退化成的通用兜底文案。
const sonnerSpies = vi.hoisted(() => ({ custom: vi.fn() }));
vi.mock('sonner', () => ({ toast: sonnerSpies }));

import { BranchTab } from './BranchTab';

const dedicatedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '林晓的私有库',
  status: 'active',
  mode: 'dedicated',
  branch_sync_state: 'synced',
  branch_base_version: '3',
  branch_head_version: '3',
  metadata: { owner_agent_id: 'ag_1' },
  document_count: 1,
  bucket_count: 1,
  chunk_count: 1,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const headV3: KnowledgeAdminVersionRead = {
  id: 'kbver_3',
  tenant_id: 'tenant_demo',
  knowledge_base_id: 'kb_1',
  version: '3',
  name: '3',
  status: 'active',
  is_head: true,
  is_base: true,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
} as KnowledgeAdminVersionRead;

const historyV2: KnowledgeAdminVersionRead = {
  id: 'kbver_2',
  tenant_id: 'tenant_demo',
  knowledge_base_id: 'kb_1',
  version: '2',
  name: '2',
  status: 'active',
  is_head: false,
  is_base: false,
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
} as KnowledgeAdminVersionRead;

function createMockApi() {
  return {
    listVersions: vi.fn().mockResolvedValue([headV3, historyV2]),
    syncFromOverall: vi.fn().mockResolvedValue({ status: 'synced', knowledge_base_id: 'kb_1', head_version: '3' }),
    promoteToOverall: vi.fn().mockResolvedValue({ status: 'promoted', knowledge_base_id: 'kb_1', version: '3' }),
    rollbackDedicatedBranch: vi.fn().mockResolvedValue({ status: 'rolled_back', knowledge_base_id: 'kb_1', head_version: '2' }),
  };
}

function renderTab(mockApi: ReturnType<typeof createMockApi>, onChanged = vi.fn()) {
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <BranchTab api={mockApi as any} kb={dedicatedKb} ownerAgentId="ag_1" ownerAgentName="林晓" onChanged={onChanged} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('private BranchTab', () => {
  it('shows the branch status card: owner, baseline, head, sync state', async () => {
    const api = createMockApi();
    renderTab(api);

    await waitFor(() => expect(api.listVersions).toHaveBeenCalledWith('kb_1', 'ag_1'));
    const card = await screen.findByLabelText('分支状态');
    // 归属员工名必须渲染在 RawIdentifier 边界内，不能和产品文案拼在同一个 t() 字符串里。
    const rawOwnerNode = card.querySelector('[data-i18n-raw-kind="identifier"]');
    expect(rawOwnerNode?.textContent).toBe('林晓');
    expect(card.textContent).toContain('v3');
    expect(card.textContent).toContain('已同步');
  });

  it('syncs from the marketplace after confirmation and refreshes', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByLabelText('分支状态');
    await user.click(screen.getByRole('button', { name: '从广场同步' }));
    await user.click(await screen.findByRole('button', { name: '同步' }));

    await waitFor(() => expect(api.syncFromOverall).toHaveBeenCalledWith('kb_1', 'ag_1'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('promotes to the marketplace template after confirmation and refreshes', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByLabelText('分支状态');
    await user.click(screen.getByRole('button', { name: '发布到广场为模板' }));
    await user.click(await screen.findByRole('button', { name: '发布' }));

    await waitFor(() => expect(api.promoteToOverall).toHaveBeenCalledWith('kb_1', 'ag_1'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('rolls back to a historical version after confirmation and refreshes; the head row cannot be rolled back', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const onChanged = vi.fn();
    renderTab(api, onChanged);

    await screen.findByText('v2');
    const rollbackButtons = screen.getAllByRole('button', { name: '回滚到此版本' });
    expect(rollbackButtons).toHaveLength(2);
    expect((rollbackButtons[0] as HTMLButtonElement).disabled).toBe(true); // v3 行是 head，禁用回滚
    expect((rollbackButtons[1] as HTMLButtonElement).disabled).toBe(false);

    await user.click(rollbackButtons[1]);
    await user.click(await screen.findByRole('button', { name: '回滚' }));

    await waitFor(() => expect(api.rollbackDedicatedBranch).toHaveBeenCalledWith('kb_1', { agentId: 'ag_1', version: '2' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the registered error code\'s specific localized text (not the generic fallback) when syncing from the marketplace conflicts', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.syncFromOverall.mockRejectedValue({ code: 'KNOWLEDGE_BINDING_REVISION_CONFLICT' });
    renderTab(api);

    await screen.findByLabelText('分支状态');
    await user.click(screen.getByRole('button', { name: '从广场同步' }));
    await user.click(await screen.findByRole('button', { name: '同步' }));

    await waitFor(() => expect(sonnerSpies.custom).toHaveBeenCalled());
    const renderer = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1]?.[0];
    const { container } = render((renderer as () => ReactElement)());
    expect(container.textContent).toMatch(/权限配置已被其他管理员更新/);
    expect(container.textContent).not.toMatch(/操作失败，请稍后重试/);
  });
});

// @vitest-environment jsdom

/**
 * KnowledgeAdminListPage 测试（T031）。
 * 覆盖：统计卡、类型页签、四类筛选与搜索、未绑定提示、行点击跳转、`⋯` 菜单项按
 * mode 差异、新建对话框（私有未选员工阻止）、下线/删除二次确认（展示 draft_count）。
 * `api/knowledgeAdmin.ts` 整体 mock，不发真实网络请求。
 */
import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeAdminListItem, KnowledgeAdminListResponse } from '@/types/knowledgeAdmin';
import type { AgentProfileRead } from '@/types';

const tenantContextMock = vi.hoisted(() => {
  const controller = new AbortController();
  return {
    context: {
      session: {
        token: 'tenant-demo-token',
        scope: 'tenant' as const,
        tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Tenant Demo' },
        user: {
          id: 'user-1',
          tenant_id: 'tenant_demo',
          username: 'admin',
          display_name: 'Admin',
          role: 'admin' as const,
          must_change_password: false,
          avatar_url: null,
        },
      },
      tenantId: 'tenant_demo',
      tenantSlug: 'tenant-demo',
      userId: 'user-1',
      generation: 1,
      signal: controller.signal,
      isCurrentGeneration: (generation: number) => generation === 1,
    },
  };
});

vi.mock('../../contexts/TenantSessionContext', () => ({
  useTenantSession: () => tenantContextMock.context,
}));

const mockApi = vi.hoisted(() => ({
  listKnowledgeBases: vi.fn(),
  listAgents: vi.fn(),
  listBindableTeams: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  exportOkf: vi.fn(),
  lintOkf: vi.fn(),
  getKnowledgeBase: vi.fn(),
}));

vi.mock('../../api/knowledgeAdmin', () => ({
  createKnowledgeAdminApi: () => mockApi,
}));

vi.mock('@/components/LanguageSwitcher', () => ({
  default: () => null,
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: ComponentProps<'textarea'>) => <textarea {...props} />,
}));

import KnowledgeAdminListPage from './KnowledgeAdminListPage';

const sharedBound: KnowledgeAdminListItem = {
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
};

const sharedUnbound: KnowledgeAdminListItem = {
  id: 'kb_shared_2',
  name: '内部政策库',
  description: null,
  mode: 'shared',
  status: 'active',
  capability_scope: 'general',
  published_version: '1.0.0',
  published_version_id: 'kbver_2',
  draft_count: 0,
  document_count: 1,
  owner_agent: null,
  bound_teams: [],
  branch: null,
  updated_at: '2026-08-19T10:00:00Z',
};

const dedicated: KnowledgeAdminListItem = {
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
};

const agents: AgentProfileRead[] = [
  {
    id: 'ag_1',
    tenant_id: 'tenant_demo',
    name: '林晓',
    is_overall: false,
    status: 'active',
    metadata: {},
    resources: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  },
];

function listResponse(items: KnowledgeAdminListItem[]): KnowledgeAdminListResponse {
  return {
    items,
    summary: {
      total: items.length,
      shared: items.filter((item) => item.mode === 'shared').length,
      dedicated: items.filter((item) => item.mode === 'dedicated').length,
      documents: items.reduce((sum, item) => sum + item.document_count, 0),
    },
    total: items.length,
    offset: 0,
    limit: 20,
    has_more: false,
  };
}

function primeDefaultMocks(items: KnowledgeAdminListItem[] = [sharedBound, sharedUnbound, dedicated]) {
  mockApi.listKnowledgeBases.mockResolvedValue(listResponse(items));
  mockApi.listAgents.mockResolvedValue(agents);
  mockApi.listBindableTeams.mockResolvedValue([{ id: 'team_1', name: '客服一组', member_count: 5 }]);
}

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/enterprise/knowledge-admin']}>
        <Routes>
          <Route path="/enterprise/knowledge-admin" element={<KnowledgeAdminListPage />} />
          <Route path="/enterprise/knowledge-admin/:kbId" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KnowledgeAdminListPage', () => {
  it('shows stat cards and rows for shared and dedicated knowledge bases, with an unbound hint', async () => {
    primeDefaultMocks();
    renderPage();

    await screen.findByText('产品 FAQ 共享库');
    expect(screen.getByText('内部政策库')).toBeTruthy();
    expect(screen.getByText('客服话术库')).toBeTruthy();

    // Stat cards: total 3 / shared 2 / dedicated 1 / documents 7.
    const stats = within(screen.getByLabelText('知识库统计'));
    expect(stats.getByText('3')).toBeTruthy();
    expect(stats.getByText('2')).toBeTruthy();
    expect(stats.getByText('1')).toBeTruthy();
    expect(stats.getByText('7')).toBeTruthy();

    // Unbound shared kb shows the warning hint.
    expect(screen.getByText('未绑定群组')).toBeTruthy();
  });

  it('filters by type tab', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    await user.click(screen.getByRole('tab', { name: /^专用/ }));
    expect(screen.queryByText('产品 FAQ 共享库')).toBeNull();
    expect(screen.getByText('客服话术库')).toBeTruthy();
  });

  it('filters by owner agent', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    const ownerSelect = screen.getByRole('combobox', { name: '归属' });
    await user.click(ownerSelect);
    await user.click(screen.getByRole('option', { name: '林晓' }));

    expect(screen.queryByText('产品 FAQ 共享库')).toBeNull();
    expect(screen.getByText('客服话术库')).toBeTruthy();
  });

  it('filters by bound team', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    const teamSelect = screen.getByRole('combobox', { name: '群组' });
    await user.click(teamSelect);
    await user.click(screen.getByRole('option', { name: '客服一组' }));

    expect(screen.getByText('产品 FAQ 共享库')).toBeTruthy();
    expect(screen.queryByText('内部政策库')).toBeNull();
    expect(screen.queryByText('客服话术库')).toBeNull();
  });

  it('filters by name search', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    await user.type(screen.getByPlaceholderText('按名称搜索'), '话术');
    expect(screen.queryByText('产品 FAQ 共享库')).toBeNull();
    expect(screen.getByText('客服话术库')).toBeTruthy();
  });

  it('navigates to the detail page when a row is clicked', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    await user.click(screen.getByText('产品 FAQ 共享库'));
    expect((await screen.findByTestId('location')).textContent).toBe('/enterprise/knowledge-admin/kb_shared_1');
  });

  it('shows grants for shared rows and convert-to-shared for dedicated rows in the row menu', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    const sharedRow = screen.getByText('产品 FAQ 共享库').closest('tr');
    expect(sharedRow).toBeTruthy();
    await user.click(within(sharedRow as HTMLElement).getByRole('button', { name: '更多操作' }));
    expect(await screen.findByRole('menuitem', { name: '群组与权限' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '转换为共享知识库' })).toBeNull();
    await user.keyboard('{Escape}');

    const dedicatedRow = screen.getByText('客服话术库').closest('tr');
    await user.click(within(dedicatedRow as HTMLElement).getByRole('button', { name: '更多操作' }));
    expect(await screen.findByRole('menuitem', { name: '转换为共享知识库' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '群组与权限' })).toBeNull();
  });

  it('blocks dedicated creation without an owner, then submits successfully once one is chosen', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    mockApi.createKnowledgeBase.mockResolvedValue({ id: 'kb_new_1', mode: 'dedicated' });
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    await user.click(screen.getByRole('button', { name: /新建知识库/ }));
    await user.click(screen.getByRole('combobox', { name: '类型' }));
    await user.click(screen.getByRole('option', { name: '专用' }));
    await user.type(screen.getByPlaceholderText('输入名称'), '新私有库');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByText('请先选择归属员工')).toBeTruthy();
    expect(mockApi.createKnowledgeBase).not.toHaveBeenCalled();

    await user.click(screen.getByRole('combobox', { name: '归属员工' }));
    await user.click(screen.getByRole('option', { name: '林晓' }));
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(mockApi.createKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ name: '新私有库', mode: 'dedicated', agentId: 'ag_1' }),
    ));
    expect((await screen.findByTestId('location')).textContent).toBe('/enterprise/knowledge-admin/kb_new_1');
  });

  it('archives an active shared knowledge base from the row menu', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    mockApi.updateKnowledgeBase.mockResolvedValue({});
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    const sharedRow = screen.getByText('产品 FAQ 共享库').closest('tr');
    await user.click(within(sharedRow as HTMLElement).getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '下线' }));

    await waitFor(() => expect(mockApi.updateKnowledgeBase).toHaveBeenCalledWith(
      'kb_shared_1',
      expect.objectContaining({ status: 'archived' }),
    ));
  });

  it('shows the draft count on delete confirmation and deletes on confirm', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    mockApi.deleteKnowledgeBase.mockResolvedValue({});
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    const sharedRow = screen.getByText('产品 FAQ 共享库').closest('tr');
    await user.click(within(sharedRow as HTMLElement).getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除' }));

    expect(await screen.findByText(/1 个进行中的草稿/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(mockApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb_shared_1'));
  });
});

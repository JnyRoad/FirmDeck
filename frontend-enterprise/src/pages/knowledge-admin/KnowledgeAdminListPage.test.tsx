// @vitest-environment jsdom

/**
 * KnowledgeAdminListPage 测试（T031）。
 * 覆盖：统计卡、类型页签、四类筛选与搜索（均随请求发给服务端，见下方 `mockListKnowledgeBases`
 * 对 `params` 的过滤模拟，而不是客户端过滤已加载的一页数据）、未绑定提示、行点击跳转、
 * `⋯` 菜单项按 mode 差异、新建对话框（私有未选员工阻止）、下线/删除二次确认
 * （展示 draft_count）。`api/knowledgeAdmin.ts` 整体 mock，不发真实网络请求。
 */
import type { ComponentProps, ReactElement } from 'react';
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

// T084：断言迁移后的 toast 出口——已注册错误码要显示契约里的具体本地化文案，
// 而不是 legacy notify 把整句译文当错误码解析失败后退化成的通用兜底文案。
const sonnerSpies = vi.hoisted(() => ({ custom: vi.fn() }));
vi.mock('sonner', () => ({ toast: sonnerSpies }));

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

const ALL_ITEMS: KnowledgeAdminListItem[] = [sharedBound, sharedUnbound, dedicated];

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

/** A1 query params as the page sends them (camelCase, per `ListKnowledgeBasesParams`). */
type MockListParams = {
  mode?: string;
  status?: string;
  ownerAgentId?: string;
  teamId?: string;
  q?: string;
  limit?: number;
};

/** Server-side filter emulation: mirrors what a real A1 implementation would do for each param. */
function matchesParams(item: KnowledgeAdminListItem, params: MockListParams, { includeMode }: { includeMode: boolean }): boolean {
  if (includeMode && params.mode && item.mode !== params.mode) return false;
  if (params.status && item.status !== params.status) return false;
  if (params.ownerAgentId && item.owner_agent?.id !== params.ownerAgentId) return false;
  if (params.teamId && !item.bound_teams.some((team) => team.id === params.teamId)) return false;
  const keyword = (params.q || '').trim().toLowerCase();
  if (keyword && !item.name.toLowerCase().includes(keyword)) return false;
  return true;
}

function summarize(items: KnowledgeAdminListItem[]) {
  return {
    total: items.length,
    shared: items.filter((item) => item.mode === 'shared').length,
    dedicated: items.filter((item) => item.mode === 'dedicated').length,
    documents: items.reduce((sum, item) => sum + item.document_count, 0),
  };
}

/**
 * Mocked A1: `items` obey every param including `mode`; `summary` deliberately ignores `mode`
 * (mirrors the page's `loadSummary()`, which omits `mode` so stat cards and every tab count
 * stay mutually consistent regardless of which type tab is currently selected).
 */
function mockListKnowledgeBases(items: KnowledgeAdminListItem[] = ALL_ITEMS) {
  mockApi.listKnowledgeBases.mockImplementation(async (params: MockListParams = {}) => {
    const rows = items.filter((item) => matchesParams(item, params, { includeMode: true }));
    const summaryScope = items.filter((item) => matchesParams(item, params, { includeMode: false }));
    const response: KnowledgeAdminListResponse = {
      items: rows,
      summary: summarize(summaryScope),
      total: rows.length,
      offset: 0,
      limit: params.limit ?? 20,
      has_more: false,
    };
    return response;
  });
}

/** Externally-resolvable promise; lets a test control exactly when a mocked request settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function primeDefaultMocks(items: KnowledgeAdminListItem[] = ALL_ITEMS) {
  mockListKnowledgeBases(items);
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

  it('requests A1 with the current filters as query params on the initial load', async () => {
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');

    // Table-row request: no mode/status/owner/team filters yet, page-1 limit=20.
    expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ mode: undefined, status: undefined, ownerAgentId: undefined, teamId: undefined, limit: 20 }),
    );
    // Summary request never carries `mode`.
    expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.not.objectContaining({ mode: expect.anything() }),
    );
  });

  it('re-fetches with mode in the query params when a type tab is selected, without disturbing the other tabs\' counts', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');
    mockApi.listKnowledgeBases.mockClear();

    await user.click(screen.getByRole('tab', { name: /^专用/ }));

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dedicated', limit: 20 }),
    ));
    await waitFor(() => expect(screen.queryByText('产品 FAQ 共享库')).toBeNull());
    expect(screen.getByText('客服话术库')).toBeTruthy();

    // Tab counts still read total/shared/dedicated from the server summary (mode-independent),
    // so the "shared" tab keeps showing 2 even while the "dedicated" tab is active.
    expect(screen.getByRole('tab', { name: /^共享/ }).textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /^全部/ }).textContent).toContain('3');
  });

  it('discards a stale loadList response that resolves after a newer one (race protection)', async () => {
    const user = userEvent.setup();
    mockApi.listAgents.mockResolvedValue(agents);
    mockApi.listBindableTeams.mockResolvedValue([{ id: 'team_1', name: '客服一组', member_count: 5 }]);

    const tableCalls: Array<{ params: MockListParams; response: ReturnType<typeof deferred<KnowledgeAdminListResponse>> }> = [];
    mockApi.listKnowledgeBases.mockImplementation(async (params: MockListParams = {}) => {
      // Summary requests (limit=1) are irrelevant to this race and resolve immediately so they
      // never block the assertions below.
      if (params.limit === 1) {
        return {
          items: [],
          summary: summarize(ALL_ITEMS),
          total: 0,
          offset: 0,
          limit: 1,
          has_more: false,
        } satisfies KnowledgeAdminListResponse;
      }
      const entry = { params, response: deferred<KnowledgeAdminListResponse>() };
      tableCalls.push(entry);
      return entry.response.promise;
    });

    renderPage();
    await waitFor(() => expect(tableCalls.length).toBe(1)); // initial mount table request, still pending

    await user.click(screen.getByRole('tab', { name: /^专用/ }));
    await waitFor(() => expect(tableCalls.length).toBe(2)); // tab switch fires a second, newer table request

    // Resolve the NEWER (second) request first, as if the older one is simply slower.
    tableCalls[1].response.resolve({
      items: [dedicated],
      summary: summarize([dedicated]),
      total: 1,
      offset: 0,
      limit: 20,
      has_more: false,
    });
    await waitFor(() => expect(screen.getByText('客服话术库')).toBeTruthy());
    expect(screen.queryByText('产品 FAQ 共享库')).toBeNull();

    // Now resolve the OLDER (first, now-stale) request — without the sequence guard this would
    // silently overwrite the table with the pre-filter (all-modes) rows.
    tableCalls[0].response.resolve({
      items: [sharedBound, sharedUnbound, dedicated],
      summary: summarize([sharedBound, sharedUnbound, dedicated]),
      total: 3,
      offset: 0,
      limit: 20,
      has_more: false,
    });

    // Give the stale resolution a tick to (wrongly) apply if the guard were missing, then assert
    // the dedicated-only view from the newer request is still what's shown.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(screen.queryByText('产品 FAQ 共享库')).toBeNull();
    expect(screen.getByText('客服话术库')).toBeTruthy();
  });

  it('re-fetches with the owner filter in the query params', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');
    mockApi.listKnowledgeBases.mockClear();

    const ownerSelect = screen.getByRole('combobox', { name: '归属' });
    await user.click(ownerSelect);
    await user.click(screen.getByRole('option', { name: '林晓' }));

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgentId: 'ag_1' }),
    ));
    await waitFor(() => expect(screen.queryByText('产品 FAQ 共享库')).toBeNull());
    expect(screen.getByText('客服话术库')).toBeTruthy();
  });

  it('re-fetches with the team filter in the query params', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');
    mockApi.listKnowledgeBases.mockClear();

    const teamSelect = screen.getByRole('combobox', { name: '群组' });
    await user.click(teamSelect);
    await user.click(screen.getByRole('option', { name: '客服一组' }));

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team_1' }),
    ));
    await waitFor(() => expect(screen.queryByText('内部政策库')).toBeNull());
    expect(screen.getByText('产品 FAQ 共享库')).toBeTruthy();
    expect(screen.queryByText('客服话术库')).toBeNull();
  });

  it('debounces the search input ~300ms before re-fetching with q in the query params', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();
    await screen.findByText('产品 FAQ 共享库');
    mockApi.listKnowledgeBases.mockClear();

    await user.type(screen.getByPlaceholderText('按名称搜索'), '话术');

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ q: '话术' }),
    ));
    await waitFor(() => expect(screen.queryByText('产品 FAQ 共享库')).toBeNull());
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

  it('shows the registered error code\'s specific localized text (not the generic fallback) when the list fails to load', async () => {
    mockApi.listKnowledgeBases.mockRejectedValue({ code: 'KNOWLEDGE_BASE_NOT_FOUND' });
    mockApi.listAgents.mockResolvedValue(agents);
    mockApi.listBindableTeams.mockResolvedValue([]);
    renderPage();

    await waitFor(() => expect(sonnerSpies.custom).toHaveBeenCalled());
    const renderer = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1]?.[0];
    const { container } = render((renderer as () => ReactElement)());
    expect(container.textContent).toMatch(/未找到请求的资源/);
    expect(container.textContent).not.toMatch(/操作失败，请稍后重试/);
  });
});

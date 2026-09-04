// @vitest-environment jsdom

/**
 * KnowledgeAdminListPage 服务端分页测试（US5，T069）。
 * 覆盖：首屏按 `offset=0&limit=20` 请求；`Paginator` 切页只改 `offset`，
 * 保留当前全部筛选条件；筛选/类型页签变化时页码回到第 1 页；
 * `total`/`has_more` 驱动分页器的显示与可翻页范围。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  Input: (props: { [key: string]: unknown }) => <input {...props} />,
}));

import KnowledgeAdminListPage from './KnowledgeAdminListPage';

const agents: AgentProfileRead[] = [];

/** 45 条私有库假数据；服务端每页 20 条，共 3 页（20/20/5）。 */
const ALL_ITEMS: KnowledgeAdminListItem[] = Array.from({ length: 45 }, (_, index) => ({
  id: `kb_${index + 1}`,
  name: `知识库 ${String(index + 1).padStart(2, '0')}`,
  description: null,
  mode: 'dedicated',
  status: 'active',
  capability_scope: 'general',
  published_version: null,
  published_version_id: null,
  draft_count: 0,
  document_count: 0,
  owner_agent: null,
  bound_teams: [],
  branch: null,
  updated_at: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T10:00:00Z`,
}));

type MockListParams = {
  mode?: string;
  status?: string;
  ownerAgentId?: string;
  teamId?: string;
  q?: string;
  offset?: number;
  limit?: number;
};

/** 模拟服务端 A1：按 `offset`/`limit` 切片，`q` 过滤，`total`/`has_more` 与切片一致。 */
function mockListKnowledgeBases(items: KnowledgeAdminListItem[] = ALL_ITEMS) {
  mockApi.listKnowledgeBases.mockImplementation(async (params: MockListParams = {}) => {
    const keyword = (params.q || '').trim().toLowerCase();
    const filtered = keyword ? items.filter((item) => item.name.toLowerCase().includes(keyword)) : items;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 20;
    const page = filtered.slice(offset, offset + limit);
    const response: KnowledgeAdminListResponse = {
      items: page,
      summary: { total: filtered.length, shared: 0, dedicated: filtered.length, documents: 0 },
      total: filtered.length,
      offset,
      limit,
      has_more: offset + page.length < filtered.length,
    };
    return response;
  });
}

function primeDefaultMocks() {
  mockListKnowledgeBases();
  mockApi.listAgents.mockResolvedValue(agents);
  mockApi.listBindableTeams.mockResolvedValue([]);
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/enterprise/knowledge-admin']}>
        <KnowledgeAdminListPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KnowledgeAdminListPage pagination', () => {
  it('requests the first page with offset=0 and limit=20 on initial load', async () => {
    primeDefaultMocks();
    renderPage();

    await screen.findByText('知识库 01');
    expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 20 }),
    );
    expect(screen.queryByText('知识库 21')).toBeNull();
  });

  it('shows a paginator sized to the server total and pages without disturbing filters', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();

    await screen.findByText('知识库 01');
    // 45 items / 20 per page = 3 pages: "01", "02", "03" pills.
    const paginationNav = screen.getByRole('navigation', { name: /分页|pagination/i });
    expect(paginationNav.textContent).toContain('01');
    expect(paginationNav.textContent).toContain('02');
    expect(paginationNav.textContent).toContain('03');

    await user.click(screen.getByRole('button', { name: '02' }));

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 20, limit: 20, mode: undefined, status: undefined, ownerAgentId: undefined, teamId: undefined }),
    ));
    await screen.findByText('知识库 21');
    expect(screen.queryByText('知识库 01')).toBeNull();
  });

  it('resets back to page 1 when a filter changes after paging forward', async () => {
    const user = userEvent.setup();
    primeDefaultMocks();
    renderPage();

    await screen.findByText('知识库 01');
    await user.click(screen.getByRole('button', { name: '03' }));
    await screen.findByText('知识库 41');

    mockApi.listKnowledgeBases.mockClear();
    await user.click(screen.getByRole('tab', { name: /^专用/ }));

    await waitFor(() => expect(mockApi.listKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dedicated', offset: 0, limit: 20 }),
    ));
    await screen.findByText('知识库 01');
  });
});

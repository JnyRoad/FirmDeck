// @vitest-environment jsdom

/**
 * KnowledgeAdminDetailPage「转换为共享知识库」入口测试（US5，T068）。
 * 覆盖：私有库详情标题栏显示转换按钮，archived 时禁用；打开既有
 * `SharedKnowledgeConversionDialog`（内部实现不动，走真实 `fetch` stub，
 * 与 `SharedKnowledgeConversionDialog.test.tsx` 同一套 mock 手法）；成功转换后
 * 跳转到新共享库的 `?tab=grants`。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeBaseRead } from '@/types';

const tenantContextMock = vi.hoisted(() => {
  const controller = new AbortController();
  return {
    context: {
      session: {
        token: 'tenant-demo-token',
        scope: 'tenant' as const,
        tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Tenant Demo' },
        user: {
          id: 'user-admin',
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
      userId: 'user-admin',
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
  getKnowledgeBase: vi.fn(),
  listAgents: vi.fn(),
  listVersions: vi.fn(),
  listVersionDocuments: vi.fn(),
}));

vi.mock('../../api/knowledgeAdmin', () => ({
  createKnowledgeAdminApi: () => mockApi,
}));

import KnowledgeAdminDetailPage from './KnowledgeAdminDetailPage';

const privateKb: KnowledgeBaseRead = {
  id: 'kb_dedicated_1',
  tenant_id: 'tenant_demo',
  name: '林晓的私有库',
  description: '',
  capability_scope: 'general',
  status: 'active',
  mode: 'dedicated',
  branch_base_version: '2',
  branch_head_version: '3',
  branch_sync_state: 'synced',
  metadata: { owner_agent_id: 'ag_1' },
  document_count: 2,
  bucket_count: 1,
  chunk_count: 4,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-18T09:00:00Z',
};

const archivedPrivateKb: KnowledgeBaseRead = { ...privateKb, id: 'kb_dedicated_archived', status: 'archived' };

const sourceVersions = [
  {
    id: 'kbver-head',
    tenant_id: 'tenant_demo',
    knowledge_base_id: privateKb.id,
    version: '3',
    name: privateKb.name,
    status: 'active',
    is_head: true,
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
  },
];

const teams: unknown[] = [];

const conversionResponse = {
  source_knowledge_base_id: privateKb.id,
  source_version_id: 'kbver-head',
  new_knowledge_base: {
    ...privateKb,
    id: 'kb_shared_new',
    name: '团队话术库',
    mode: 'shared' as const,
    published_version_id: 'kbver-release',
    published_version: '1.0.0',
  },
  released_version: {
    id: 'kbver-release',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_shared_new',
    version: '1.0.0',
    name: '团队话术库',
    status: 'active',
    publication_state: 'released' as const,
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
  },
  binding_ids: [],
  default_for_team_id: null,
  source_archived: true,
  audit_event_id: 'audit-converted',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderDetail(initialEntry: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          {/* React Router v6 ranks a static segment above a dynamic `:kbId`, so a
              navigation to the literal new-kb id below always lands on this echo
              route instead of re-mounting the detail page for that id. */}
          <Route path="/enterprise/knowledge-admin/kb_shared_new" element={<LocationEcho />} />
          <Route path="/enterprise/knowledge-admin/:kbId" element={<KnowledgeAdminDetailPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeAll(() => {
  // Radix Dialog 在 jsdom 里需要这个。
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  mockApi.listAgents.mockResolvedValue([{ id: 'ag_1', name: '林晓' }]);
  mockApi.listVersions.mockResolvedValue([]);
  mockApi.listVersionDocuments.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('KnowledgeAdminDetailPage conversion entry', () => {
  it('shows the "convert to shared" button on a dedicated kb header', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(privateKb);
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1');

    const button = await screen.findByRole('button', { name: '转换为共享知识库' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the conversion entry when the private kb is archived', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(archivedPrivateKb);
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_archived');

    const button = await screen.findByRole('button', { name: '转换为共享知识库' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('completes a conversion and navigates to the new shared kb\'s grants tab', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(privateKb);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return jsonResponse(conversionResponse);
      if (url.includes('/versions?')) return jsonResponse(sourceVersions);
      if (url.includes('/teams?')) return jsonResponse(teams);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1');

    await user.click(await screen.findByRole('button', { name: '转换为共享知识库' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('转换原因'), '拆分为团队共享库');
    await user.click(within(dialog).getByRole('button', { name: '确认转换' }));

    const locationEcho = await screen.findByTestId('location');
    await waitFor(() => expect(locationEcho.textContent).toBe('/enterprise/knowledge-admin/kb_shared_new?tab=grants'));
  });
});

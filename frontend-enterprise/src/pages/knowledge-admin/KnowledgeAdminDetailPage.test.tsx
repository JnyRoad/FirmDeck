// @vitest-environment jsdom

/**
 * KnowledgeAdminDetailPage 测试（T032）。
 * 覆盖：按 mode 渲染 Tab 集、`?tab=` 与 URL 同步、面包屑返回、设置 Tab 保存
 * 名称/描述/能力范围、上线/下线、删除。`api/knowledgeAdmin.ts` 整体 mock。
 */
import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/i18n';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';
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
  getKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  listVersions: vi.fn(),
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

import KnowledgeAdminDetailPage from './KnowledgeAdminDetailPage';

const sharedKb: KnowledgeBaseRead = {
  id: 'kb_shared_1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  description: '常见问题',
  capability_scope: 'general',
  status: 'active',
  mode: 'shared',
  published_version_id: 'kbver_1',
  published_version: '1.1.0',
  bound_team_count: 1,
  document_count: 4,
  bucket_count: 1,
  chunk_count: 10,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-20T10:00:00Z',
};

const dedicatedKb: KnowledgeBaseRead = {
  id: 'kb_dedicated_1',
  tenant_id: 'tenant_demo',
  name: '客服话术库',
  description: '',
  capability_scope: 'general',
  status: 'active',
  mode: 'dedicated',
  branch_base_version: '3',
  branch_head_version: '5',
  branch_sync_state: 'diverged',
  document_count: 2,
  bucket_count: 1,
  chunk_count: 4,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-18T09:00:00Z',
};

function versionFixture(overrides: Partial<KnowledgeAdminVersionRead> = {}): KnowledgeAdminVersionRead {
  return {
    id: 'kbver_1',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_shared_1',
    version: '1.1.0',
    name: 'v1.1.0',
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

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderDetail(initialEntry: string) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/enterprise/knowledge-admin/:kbId" element={<KnowledgeAdminDetailPage />} />
            <Route path="/enterprise/knowledge-admin" element={<LocationEcho />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  mockApi.listVersions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KnowledgeAdminDetailPage', () => {
  it('renders the shared tab set (content/versions/grants/audit/settings)', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1');

    await screen.findByText('产品 FAQ 共享库');
    expect(screen.getByRole('tab', { name: '内容' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '版本管理' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '群组与权限' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '审计日志' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '设置' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '分支' })).toBeNull();
  });

  it('renders the dedicated tab set (content/branch/settings)', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(dedicatedKb);
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1');

    await screen.findByText('客服话术库');
    expect(screen.getByRole('tab', { name: '内容' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '分支' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '设置' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '版本管理' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '群组与权限' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '审计日志' })).toBeNull();
  });

  it('syncs the active tab with ?tab= and keeps it across a refresh', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    expect(await screen.findByText('基本信息')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '设置' }).getAttribute('aria-selected')).toBe('true');

    await user.click(screen.getByRole('tab', { name: '版本管理' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '版本管理' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('defaults to the first tab when ?tab= is absent or invalid for the mode', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(dedicatedKb);
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1?tab=grants');

    await screen.findByText('客服话术库');
    expect(screen.getByRole('tab', { name: '内容' }).getAttribute('aria-selected')).toBe('true');
  });

  it('navigates back to the list page via the breadcrumb', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1');

    await screen.findByText('产品 FAQ 共享库');
    await user.click(screen.getByRole('button', { name: /返回/ }));
    expect((await screen.findByTestId('location')).textContent).toBe('/enterprise/knowledge-admin');
  });

  it('shows placeholder content for tabs other than settings', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=versions');

    expect(await screen.findByText('该 Tab 暂未实现。')).toBeTruthy();
  });

  it('saves name/description/capability scope from the settings tab', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    mockApi.updateKnowledgeBase.mockResolvedValue({ ...sharedKb, name: '产品 FAQ 共享库 v2' });
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    const nameInput = await screen.findByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, '产品 FAQ 共享库 v2');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockApi.updateKnowledgeBase).toHaveBeenCalledWith(
      'kb_shared_1',
      expect.objectContaining({ name: '产品 FAQ 共享库 v2', capabilityScope: 'general' }),
    ));
    expect(await screen.findByText('产品 FAQ 共享库 v2')).toBeTruthy();
  });

  it('brings the knowledge base online/offline from the settings tab', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    mockApi.updateKnowledgeBase.mockResolvedValue({ ...sharedKb, status: 'archived' });
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    await screen.findByText('基本信息');
    await user.click(screen.getByRole('button', { name: '下线' }));

    await waitFor(() => expect(mockApi.updateKnowledgeBase).toHaveBeenCalledWith(
      'kb_shared_1',
      expect.objectContaining({ status: 'archived' }),
    ));
    expect(await screen.findByRole('button', { name: '上线' })).toBeTruthy();
  });

  it('deletes the knowledge base from the danger zone and navigates back to the list', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    mockApi.deleteKnowledgeBase.mockResolvedValue({});
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    await screen.findByText('危险区');
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => expect(mockApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb_shared_1'));
    expect((await screen.findByTestId('location')).textContent).toBe('/enterprise/knowledge-admin');
  });

  it('shows the draft count on the settings-tab delete confirmation for a shared kb with drafts', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    mockApi.listVersions.mockResolvedValue([
      versionFixture({ id: 'kbver_draft_1', publication_state: 'draft', draft_name: 'draft-1' }),
      versionFixture({ id: 'kbver_draft_2', publication_state: 'draft', draft_name: 'draft-2' }),
      versionFixture({ id: 'kbver_released_1', publication_state: 'released' }),
    ]);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    await screen.findByText('危险区');
    await waitFor(() => expect(mockApi.listVersions).toHaveBeenCalledWith('kb_shared_1'));
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText(/2 个进行中的草稿/)).toBeTruthy();
  });

  it('does not fetch versions or show a draft warning for a dedicated kb', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(dedicatedKb);
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1?tab=settings');

    await screen.findByText('危险区');
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.queryByText(/个进行中的草稿/)).toBeNull();
    expect(mockApi.listVersions).not.toHaveBeenCalled();
  });
});

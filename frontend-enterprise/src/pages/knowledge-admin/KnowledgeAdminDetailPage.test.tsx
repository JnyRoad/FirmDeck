// @vitest-environment jsdom

/**
 * KnowledgeAdminDetailPage 测试（T032）。
 * 覆盖：按 mode 渲染 Tab 集、`?tab=` 与 URL 同步、面包屑返回、设置 Tab 保存
 * 名称/描述/能力范围、上线/下线、删除。`api/knowledgeAdmin.ts` 整体 mock。
 */
import type { ComponentProps, ReactElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/i18n';
import type { KnowledgeAdminListItem, KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';
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
  getAdminKnowledgeBase: vi.fn(),
  getKnowledgeBase: vi.fn(),
  listAgents: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  listVersions: vi.fn(),
  getVersionDiff: vi.fn(),
  uploadDocument: vi.fn(),
  updateDocument: vi.fn(),
  archiveDocument: vi.fn(),
  createDraft: vi.fn(),
  publishDraft: vi.fn(),
  rejectDraft: vi.fn(),
  rollbackVersion: vi.fn(),
  recordReview: vi.fn(),
  listAuditEvents: vi.fn(),
  listBindableTeams: vi.fn(),
  listTeamBindings: vi.fn(),
  bindTeam: vi.fn(),
  unbindTeam: vi.fn(),
  setDefaultBinding: vi.fn(),
  saveGrants: vi.fn(),
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

// Admin-first 详情端点（`getAdminKnowledgeBase`）的响应形状——不需要 `agent_id` 即可读取
// 共享 *和* 专用库，是 load() 现在的主数据源（defect1：员工侧 `getKnowledgeBase` 不带
// `agent_id` 对管理员来说会 404）。字段与上面的 `sharedKb`/`dedicatedKb` 保持一致，供
// 断言复用同一批展示文案。
const sharedAdminItem: KnowledgeAdminListItem = {
  id: 'kb_shared_1',
  name: '产品 FAQ 共享库',
  description: '常见问题',
  mode: 'shared',
  status: 'active',
  capability_scope: 'general',
  published_version: '1.1.0',
  published_version_id: 'kbver_1',
  draft_count: 0,
  document_count: 4,
  owner_agent: null,
  bound_teams: [],
  branch: null,
  updated_at: '2026-08-20T10:00:00Z',
};

const dedicatedAdminItem: KnowledgeAdminListItem = {
  id: 'kb_dedicated_1',
  name: '客服话术库',
  description: '',
  mode: 'dedicated',
  status: 'active',
  capability_scope: 'general',
  published_version: null,
  published_version_id: null,
  draft_count: 0,
  document_count: 2,
  owner_agent: null,
  bound_teams: [],
  branch: { base_version: '3', head_version: '5', sync_state: 'diverged' },
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
  // load() 现在先打 admin-first 端点；默认按 kbId 路由到对应 fixture，个别测试按需覆盖
  // （例如 RED 用例要断言员工侧 `getKnowledgeBase` 404 时页面仍能靠这个端点渲染）。
  mockApi.getAdminKnowledgeBase.mockImplementation((id: string) => {
    if (id === sharedKb.id) return Promise.resolve(sharedAdminItem);
    if (id === dedicatedKb.id) return Promise.resolve(dedicatedAdminItem);
    return Promise.reject(new Error(`unexpected kbId ${id}`));
  });
  mockApi.listAgents.mockResolvedValue([]);
  mockApi.listVersions.mockResolvedValue([]);
  mockApi.getVersionDiff.mockResolvedValue({
    base_version_id: null,
    target_version_id: 'kbver_1',
    pairing: 'lineage',
    summary: { added: 0, modified: 0, deleted: 0 },
    documents: [],
  });
  mockApi.listAuditEvents.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20, has_more: false });
  mockApi.listBindableTeams.mockResolvedValue([]);
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

  it('mounts the real grants tab (US4), not the placeholder, for a shared knowledge base', async () => {
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=grants');

    expect(await screen.findByText('已绑定群组')).toBeTruthy();
    expect(screen.getByText('绑定新群组')).toBeTruthy();
    expect(screen.queryByText('该 Tab 暂未实现。')).toBeNull();
    await waitFor(() => expect(mockApi.listBindableTeams).toHaveBeenCalledWith(
      expect.objectContaining({ excludeBoundTo: 'kb_shared_1' }),
    ));
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

  it('keeps the page usable and shows an "unknown draft count" warning when listVersions fails', async () => {
    const user = userEvent.setup();
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    mockApi.listVersions.mockRejectedValue(new Error('network error'));
    renderDetail('/enterprise/knowledge-admin/kb_shared_1?tab=settings');

    // The page itself still renders fully — a listVersions failure must not look like a
    // whole-page load failure (no generic "failed to load" toast/state takes over).
    await screen.findByText('基本信息');
    await screen.findByText('危险区');
    await waitFor(() => expect(mockApi.listVersions).toHaveBeenCalledWith('kb_shared_1'));

    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText(/未能确认该知识库是否还有进行中的草稿/)).toBeTruthy();
    expect(screen.queryByText(/个进行中的草稿/)).toBeNull();
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

  it('shows the registered error code\'s specific localized text (not the generic fallback) when the detail fails to load', async () => {
    mockApi.getAdminKnowledgeBase.mockRejectedValue({ code: 'KNOWLEDGE_BASE_NOT_FOUND' });
    renderDetail('/enterprise/knowledge-admin/kb_shared_1');

    await waitFor(() => expect(sonnerSpies.custom).toHaveBeenCalled());
    const renderer = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1]?.[0];
    const { container } = render((renderer as () => ReactElement)());
    expect(container.textContent).toMatch(/未找到请求的资源/);
    expect(container.textContent).not.toMatch(/操作失败，请稍后重试/);
  });

  // 回归（I11）：`load()` 失败前，页面在 `!kb` 时无条件渲染「加载中…」，
  // 从不区分"还在等首次响应"与"已经失败"——请求失败后页面永远卡在 Loading，
  // 除了上面已覆盖的 toast 之外没有任何可操作的出口。现在失败且尚无 `kb` 时改渲染
  // 一个带「重试」按钮的错误态，点击后重新调用 `load()`；成功后照常渲染详情页。
  it('shows a retry error block (not an endless loading label) when the detail fails to load, and recovers on retry', async () => {
    const user = userEvent.setup();
    mockApi.getAdminKnowledgeBase.mockRejectedValueOnce({ code: 'KNOWLEDGE_BASE_NOT_FOUND' });
    mockApi.getKnowledgeBase.mockResolvedValue(sharedKb);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
    const retryButton = screen.getByRole('button', { name: '重试' });

    mockApi.getAdminKnowledgeBase.mockResolvedValueOnce(sharedAdminItem);
    await user.click(retryButton);

    await screen.findByText('产品 FAQ 共享库');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockApi.getAdminKnowledgeBase).toHaveBeenCalledTimes(2);
  });

  // 缺陷回归（T077 缺陷 1）：员工侧 `GET /knowledge-bases/{id}` 不带 `agent_id` 只暴露开放
  // 广场库，管理员打开共享/专用库的详情页此前会 404（`KNOWLEDGE_BASE_VERSION_NOT_VISIBLE`）
  // 卡在 Loading。现在 admin-first 端点是主数据源，即便员工侧调用失败页面也要能渲染。
  it('renders a shared kb even though the employee-side getKnowledgeBase 404s (admin-first fetch)', async () => {
    mockApi.getKnowledgeBase.mockRejectedValue({ code: 'KNOWLEDGE_BASE_VERSION_NOT_VISIBLE' });
    mockApi.getAdminKnowledgeBase.mockResolvedValue(sharedAdminItem);
    renderDetail('/enterprise/knowledge-admin/kb_shared_1');

    await screen.findByText('产品 FAQ 共享库');
    expect(screen.getByRole('tab', { name: '内容' })).toBeTruthy();
    // 共享库详情不该再走员工侧端点。
    expect(mockApi.getKnowledgeBase).not.toHaveBeenCalled();
  });

  it('renders a dedicated kb even though the owner-scoped getKnowledgeBase 404s (admin-first fetch)', async () => {
    mockApi.getKnowledgeBase.mockRejectedValue({ code: 'KNOWLEDGE_BASE_VERSION_NOT_VISIBLE' });
    mockApi.getAdminKnowledgeBase.mockResolvedValue({
      ...dedicatedAdminItem,
      owner_agent: { id: 'ag_1', name: '林晓' },
    });
    renderDetail('/enterprise/knowledge-admin/kb_dedicated_1');

    await screen.findByText('客服话术库');
    expect(screen.getByRole('tab', { name: '分支' })).toBeTruthy();
    // 专用库仍尝试按归属员工补一次员工侧详情（拿 branch/bucket/chunk 真实字段），
    // 该次调用失败也不应让整页停在 Loading。
    expect(mockApi.getKnowledgeBase).toHaveBeenCalledWith('kb_dedicated_1', 'ag_1');
  });
});

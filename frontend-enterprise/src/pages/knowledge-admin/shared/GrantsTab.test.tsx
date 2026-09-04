// @vitest-environment jsdom

/**
 * GrantsTab 测试（US4 T063）。
 * 覆盖：绑定新群组候选来自 `listBindableTeams(exclude_bound_to)`；绑定后新群组卡片
 * 成员默认未授权；设为默认写入调用 `setDefaultBinding`；解绑二次确认（对话框先展示
 * 撤销授权说明，确认后才调用 `unbindTeam`）；保存权限矩阵携带 `expected_revision`；
 * `KNOWLEDGE_BINDING_REVISION_CONFLICT` 时提示刷新并重新加载绑定。
 */
import type { ReactElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeBaseRead, TeamKnowledgeBindingRead, TeamRead } from '@/types';
import type { KnowledgeAdminTeamOption } from '@/types/knowledgeAdmin';

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
          username: 'demo',
          display_name: 'Demo',
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

vi.mock('@/contexts/TenantSessionContext', () => ({
  useTenantSession: () => tenantContextMock.context,
}));

const sonnerSpies = vi.hoisted(() => ({ custom: vi.fn() }));
vi.mock('sonner', () => ({ toast: sonnerSpies }));

import { GrantsTab } from './GrantsTab';

const kb: KnowledgeBaseRead = {
  id: 'kb-1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  status: 'active',
  mode: 'shared',
  published_version_id: 'kbver-1',
  published_version: '1.0.0',
  document_count: 2,
  bucket_count: 1,
  chunk_count: 2,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const boundTeamOption: KnowledgeAdminTeamOption = { id: 'team-1', name: '客服一组', member_count: 2 };
const candidateTeamOption: KnowledgeAdminTeamOption = { id: 'team-2', name: '销售二组', member_count: 1 };

const boundTeamMembers: TeamRead = {
  id: 'team-1',
  tenant_id: 'tenant_demo',
  name: '客服一组',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [
    { id: 'member-1', team_id: 'team-1', agent_id: 'agent-1', role: 'leader', agent_name: '小艾', created_at: '2026-08-01T00:00:00Z' },
    { id: 'member-2', team_id: 'team-1', agent_id: 'agent-2', role: 'member', agent_name: '小北', created_at: '2026-08-01T00:00:00Z' },
  ],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function makeBinding(overrides: Partial<TeamKnowledgeBindingRead> = {}): TeamKnowledgeBindingRead {
  return {
    id: 'teamkb-1',
    team_id: 'team-1',
    knowledge_base_id: 'kb-1',
    knowledge_base_name: '产品 FAQ 共享库',
    status: 'active',
    revision: 2,
    is_default: false,
    published_version_id: 'kbver-1',
    published_version: '1.0.0',
    grants: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

/** 构造 GrantsTab 依赖的 api mock；默认场景：team-1 已绑定本库，team-2 是候选。 */
function createMockApi(overrides: Partial<KnowledgeAdminApi> = {}): KnowledgeAdminApi {
  const base = {
    listBindableTeams: vi.fn().mockImplementation((params: { excludeBoundTo?: string } = {}) => (
      params.excludeBoundTo ? Promise.resolve([candidateTeamOption]) : Promise.resolve([boundTeamOption, candidateTeamOption])
    )),
    listTeamBindings: vi.fn().mockImplementation((teamId: string) => (
      teamId === 'team-1' ? Promise.resolve([makeBinding()]) : Promise.resolve([])
    )),
    bindTeam: vi.fn().mockResolvedValue(makeBinding({ id: 'teamkb-2', team_id: 'team-2' })),
    unbindTeam: vi.fn().mockResolvedValue({}),
    setDefaultBinding: vi.fn().mockResolvedValue(makeBinding({ is_default: true })),
    saveGrants: vi.fn().mockResolvedValue(makeBinding()),
  };
  return { ...base, ...overrides } as unknown as KnowledgeAdminApi;
}

/** GrantsTab 用团队详情端点（既有 `GET /teams/{team_id}`，非 knowledgeAdmin 契约）拿成员名册；这里 stub 全局 fetch。 */
function stubTeamMembersFetch() {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/enterprise/teams/team-1') {
      return Promise.resolve(new Response(JSON.stringify(boundTeamMembers), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderGrantsTab(api: KnowledgeAdminApi) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <GrantsTab api={api} kb={kb} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('GrantsTab', () => {
  it('derives the bound-team set from listBindableTeams({}) minus listBindableTeams({excludeBoundTo}) and shows unauthorized-by-default members', async () => {
    stubTeamMembersFetch();
    const api = createMockApi();
    renderGrantsTab(api);

    await waitFor(() => expect(api.listBindableTeams).toHaveBeenCalledWith({}));
    await waitFor(() => expect(api.listBindableTeams).toHaveBeenCalledWith({ excludeBoundTo: 'kb-1' }));

    const card = await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    expect(within(card).getByText('小艾')).toBeTruthy();
    expect(within(card).getByText('小北')).toBeTruthy();
    // Binding has an empty grants[] array -> both members default to "no access".
    expect((within(card).getByLabelText('小艾 在 产品 FAQ 共享库 的权限') as HTMLSelectElement).value).toBe('none');
    expect((within(card).getByLabelText('小北 在 产品 FAQ 共享库 的权限') as HTMLSelectElement).value).toBe('none');

    // The candidate (not-yet-bound) team must not get a card of its own.
    expect(screen.queryByRole('region', { name: '销售二组 的知识库绑定' })).toBeNull();
    expect(screen.getByRole('option', { name: '销售二组' })).toBeTruthy();
  });

  it('binds a new team from the bindable candidates, leaving its members unauthorized', async () => {
    const user = userEvent.setup();
    stubTeamMembersFetch();
    const api = createMockApi();
    renderGrantsTab(api);

    await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    await user.selectOptions(screen.getByLabelText('选择群组'), 'team-2');
    await user.click(screen.getByRole('button', { name: '绑定' }));

    await waitFor(() => expect(api.bindTeam).toHaveBeenCalledWith('team-2', { existingKnowledgeBaseId: 'kb-1' }));
  });

  it('sets a bound team as the default write target', async () => {
    const user = userEvent.setup();
    stubTeamMembersFetch();
    const api = createMockApi();
    renderGrantsTab(api);

    const card = await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    await user.click(within(card).getByRole('button', { name: '设为默认 产品 FAQ 共享库' }));

    await waitFor(() => expect(api.setDefaultBinding).toHaveBeenCalledWith('team-1', 'kb-1', { expectedRevision: 2 }));
  });

  it('requires a second confirmation explaining grant revocation before unbinding a team', async () => {
    const user = userEvent.setup();
    stubTeamMembersFetch();
    const api = createMockApi();
    renderGrantsTab(api);

    const card = await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    await user.click(within(card).getByRole('button', { name: '移除共享知识库 产品 FAQ 共享库' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(api.unbindTeam).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/撤销|失去/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '解绑' }));
    await waitFor(() => expect(api.unbindTeam).toHaveBeenCalledWith('team-1', 'kb-1', { expectedRevision: 2 }));
  });

  it('bulk-sets a bound team to reader and saves the complete matrix with expected_revision', async () => {
    const user = userEvent.setup();
    stubTeamMembersFetch();
    const api = createMockApi();
    renderGrantsTab(api);

    const card = await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    await user.click(within(card).getByRole('button', { name: '全部设为可读取' }));
    await user.click(within(card).getByRole('button', { name: '保存 产品 FAQ 共享库 权限' }));

    await waitFor(() => expect(api.saveGrants).toHaveBeenCalledWith('team-1', 'kb-1', {
      expectedRevision: 2,
      grants: [
        { agent_id: 'agent-1', permission: 'reader' },
        { agent_id: 'agent-2', permission: 'reader' },
      ],
    }));
  });

  it('shows a refresh prompt and reloads bindings on a save revision conflict', async () => {
    const user = userEvent.setup();
    stubTeamMembersFetch();
    const api = createMockApi({
      saveGrants: vi.fn().mockRejectedValue({ code: 'KNOWLEDGE_BINDING_REVISION_CONFLICT' }),
    });
    renderGrantsTab(api);

    const card = await screen.findByRole('region', { name: '客服一组 的知识库绑定' });
    const listBindableTeamsCallsBefore = (api.listBindableTeams as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(within(card).getByRole('button', { name: '保存 产品 FAQ 共享库 权限' }));

    await waitFor(() => expect(sonnerSpies.custom).toHaveBeenCalled());
    const renderer = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1]?.[0];
    const { container } = render((renderer as () => ReactElement)());
    expect(container.textContent).toMatch(/刷新/);

    await waitFor(() => expect(
      (api.listBindableTeams as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(listBindableTeamsCallsBefore));
  });
});

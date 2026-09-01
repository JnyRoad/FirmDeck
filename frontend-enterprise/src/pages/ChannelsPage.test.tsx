// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { EnterpriseAuthUser } from '@/auth';
import type {
  AgentProfileRead,
  ChannelBindingRead,
  ChannelMetaRead,
  TeamRead,
} from '@/types';

import ChannelsPage from './ChannelsPage';

vi.mock('../contexts/TenantSessionContext', () => {
  const context = {
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'user-1',
    generation: 1,
    signal: new AbortController().signal,
    session: { token: 'test-token' },
    isCurrentGeneration: () => true,
  };
  return { useTenantSession: () => context };
});

const adminUser: EnterpriseAuthUser = {
  id: 'user-1',
  tenant_id: 'tenant_demo',
  username: 'admin',
  role: 'admin',
};

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const team: TeamRead = {
  id: 'team-1',
  tenant_id: 'tenant_demo',
  name: '增长团队',
  description: '负责增长实验',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [
    {
      id: 'member-1',
      team_id: 'team-1',
      agent_id: 'agent-1',
      role: 'leader',
      agent_name: '小艾',
      created_at: '2026-08-01T00:00:00Z',
    },
    {
      id: 'member-2',
      team_id: 'team-1',
      agent_id: 'agent-2',
      role: 'member',
      agent_name: '小北',
      created_at: '2026-08-01T00:00:00Z',
    },
  ],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const channelMetas: ChannelMetaRead[] = [
  { channel: 'wechat', name: '微信', setup: 'qrcode', capabilities: [] },
];

const teamBinding: ChannelBindingRead = {
  id: 'binding-1',
  tenant_id: 'tenant_demo',
  agent_id: '',
  channel: 'wechat',
  status: 'active',
  connected: true,
  agents: [],
  team_id: 'team-1',
  team_name: '增长团队',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeFetchMock(overrides: {
  bindings?: unknown;
  teams?: unknown;
  agents?: unknown;
  metas?: unknown;
} = {}) {
  const bindings = overrides.bindings ?? [];
  const teams = overrides.teams ?? [team];
  const agents = overrides.agents ?? [agent];
  const metas = overrides.metas ?? channelMetas;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (method === 'POST' && url.includes('/api/enterprise/channels')) {
      return jsonResponse({ ...teamBinding, id: 'binding-new' });
    }
    if (method === 'PUT' && /\/api\/enterprise\/channels\/[^/?]+/.test(url)) {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      const base = Array.isArray(bindings) && bindings[0] ? bindings[0] : teamBinding;
      return jsonResponse({ ...base, ...(body.name !== undefined ? { name: body.name } : {}) });
    }
    if (url.includes('/channels/meta')) return jsonResponse(metas);
    if (url.includes('/my-identity-bindings')) return jsonResponse([]);
    if (url.includes('/deliveries/days')) {
      return jsonResponse({ days: [], total_days: 0, offset: 0, limit: 7 });
    }
    if (url.includes('/conversations')) {
      return jsonResponse({ items: [], total: 0, offset: 0, limit: 20 });
    }
    if (url.includes('/api/enterprise/agents')) return jsonResponse(agents);
    if (url.includes('/api/enterprise/teams')) return jsonResponse(teams);
    if (url.includes('/api/enterprise/channels')) return jsonResponse(bindings);
    if (url.includes('/api/auth/users')) return jsonResponse([]);
    return jsonResponse({});
  });
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ChannelsPage currentUser={adminUser} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: /接入渠道/ })[0]);
  await user.click(await screen.findByRole('button', { name: /微信/ }));
  // 命名步骤:默认名已预填,直接进入下一步
  await screen.findByText('命名接入');
  await user.click(screen.getByRole('button', { name: '下一步' }));
  await screen.findByText('选择绑定对象');
}

function createPostBody(fetchMock: ReturnType<typeof makeFetchMock>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => init?.method === 'POST' && String(input).includes('/api/enterprise/channels'),
  );
  expect(call).toBeTruthy();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChannelsPage', () => {
  it('routes WeChat Customer Service to its dedicated setup instead of WeChat QR setup', async () => {
    const user = userEvent.setup();
    const wechatKfBinding: ChannelBindingRead = {
      ...teamBinding,
      id: 'binding-kf',
      channel: 'wechat_kf',
      name: 'Service Desk',
      status: 'pending',
      connected: false,
      team_id: null,
      team_name: null,
      my_role: 'owner',
    };
    const fetchMock = makeFetchMock({
      bindings: [wechatKfBinding],
      metas: [{
        channel: 'wechat_kf',
        name: '微信客服',
        setup: 'wechat_kf',
        capabilities: ['text', 'callback'],
      }],
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Service Desk/ }));

    expect(await screen.findByRole('heading', { name: '微信客服设置' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '扫码接入' })).toBeNull();
  });

  it('creates a binding with agent_id when the agent target is selected', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await user.click(screen.getAllByRole('button', { name: /接入渠道/ })[0]);
    await user.click(await screen.findByRole('button', { name: /微信/ }));
    // 命名步骤预填默认名:渠道名 + YYYYMMDDHHMM
    const nameInput = (await screen.findByLabelText('接入名称')) as HTMLInputElement;
    expect(nameInput.value).toMatch(/^微信\d{12}$/);
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByText('选择绑定对象');

    await screen.findByText('小艾');
    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: '创建微信接入' }));

    await waitFor(() => {
      const body = createPostBody(fetchMock);
      expect(body.agent_id).toBe('agent-1');
      expect(body).not.toHaveProperty('team_id');
      expect(body.name).toMatch(/^微信\d{12}$/);
    });
  });

  it('sends the edited binding name when creating', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await user.click(screen.getAllByRole('button', { name: /接入渠道/ })[0]);
    await user.click(await screen.findByRole('button', { name: /微信/ }));
    const nameInput = (await screen.findByLabelText('接入名称')) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, '客服微信');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByText('选择绑定对象');

    await screen.findByText('小艾');
    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: '创建微信接入' }));

    await waitFor(() => {
      const body = createPostBody(fetchMock);
      expect(body.name).toBe('客服微信');
    });
  });

  it('renames a binding from the detail view', async () => {
    const user = userEvent.setup();
    const namedBinding: ChannelBindingRead = {
      ...teamBinding,
      id: 'binding-1',
      channel: 'feishu',
      name: '飞书客服',
      team_id: null,
      team_name: null,
      my_role: 'owner',
      agents: [{ agent_id: 'agent-1', name: '小艾', is_default: true, sort_order: 0 }],
    };
    const fetchMock = makeFetchMock({ bindings: [namedBinding] });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    // 列表卡片展示自定义名称
    expect(await screen.findByText('飞书客服')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /飞书客服/ }));

    await user.click(await screen.findByRole('button', { name: '重命名' }));
    const input = (await screen.findByLabelText('接入名称')) as HTMLInputElement;
    // 预填当前名称
    expect(input.value).toBe('飞书客服');
    await user.clear(input);
    await user.type(input, '售前飞书群');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([requestUrl, init]) =>
          init?.method === 'PUT' &&
          String(requestUrl).includes('/api/enterprise/channels/binding-1'),
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        tenant_id: 'tenant_demo',
        name: '售前飞书群',
      });
    });
    // 详情标题同步更新为新名称
    expect(await screen.findByText('售前飞书群')).toBeTruthy();
  });

  it('renames a binding directly from the list card without entering the detail view', async () => {
    const user = userEvent.setup();
    const namedBinding: ChannelBindingRead = {
      ...teamBinding,
      id: 'binding-1',
      channel: 'feishu',
      name: '飞书客服',
      team_id: null,
      team_name: null,
      my_role: 'owner',
      agents: [{ agent_id: 'agent-1', name: '小艾', is_default: true, sort_order: 0 }],
    };
    const fetchMock = makeFetchMock({ bindings: [namedBinding] });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(await screen.findByText('飞书客服')).toBeTruthy();
    // 列表卡片上的重命名按钮
    await user.click(screen.getByRole('button', { name: '重命名' }));
    const input = (await screen.findByLabelText('接入名称')) as HTMLInputElement;
    expect(input.value).toBe('飞书客服');
    await user.clear(input);
    await user.type(input, '售后飞书群');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([requestUrl, init]) =>
          init?.method === 'PUT' &&
          String(requestUrl).includes('/api/enterprise/channels/binding-1'),
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        tenant_id: 'tenant_demo',
        name: '售后飞书群',
      });
    });
    // 仍停留在列表页,卡片标题已更新
    expect(await screen.findByText('售后飞书群')).toBeTruthy();
    expect(screen.queryByText('选择绑定对象')).toBeNull();
  });

  it('creates a binding with team_id when the team target is selected', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await openCreateDialog(user);

    await user.click(screen.getByRole('button', { name: '团队' }));
    await screen.findByText('增长团队');
    expect(screen.getByText('项目领导：小艾')).toBeTruthy();
    expect(screen.getByText('2 名成员')).toBeTruthy();
    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: '创建微信接入' }));

    await waitFor(() => {
      const body = createPostBody(fetchMock);
      expect(body.team_id).toBe('team-1');
      expect(body).not.toHaveProperty('agent_id');
    });
  });

  it('shows the team as read-only in the detail of a team binding', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({ bindings: [teamBinding] });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(await screen.findByText('团队 · 增长团队')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /团队 · 增长团队/ }));

    const section = await screen.findByRole('region', { name: '可调度员工' });
    expect(await within(section).findByText('团队：增长团队（项目领导：小艾）')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: '编辑' })).toBeNull();
    expect(within(section).queryByRole('radio')).toBeNull();
  });

  it('shows an empty state with a create-team link when no team exists', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({ teams: [] });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await openCreateDialog(user);

    await user.click(screen.getByRole('button', { name: '团队' }));
    expect(await screen.findByText('暂无可用团队')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去创建团队' })).toBeTruthy();
  });

  it('keeps the new binding loading while an old binding request settles', async () => {
    const user = userEvent.setup();
    const bindingA: ChannelBindingRead = {
      ...teamBinding,
      id: 'binding-a',
      name: '渠道 A',
      team_id: null,
      team_name: null,
      my_role: 'owner',
    };
    const bindingB: ChannelBindingRead = {
      ...teamBinding,
      id: 'binding-b',
      name: '渠道 B',
      team_id: null,
      team_name: null,
      my_role: 'owner',
    };
    const baseFetch = makeFetchMock({ bindings: [bindingA, bindingB] });
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/binding-a/conversations')) return requestA.promise;
      if (url.includes('/binding-b/conversations')) return requestB.promise;
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await user.click(await screen.findByText('渠道 A'));
    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(await screen.findByText('渠道 B'));

    expect(screen.getByText(/加载中/)).toBeTruthy();
    await act(async () => {
      requestA.resolve(jsonResponse({ items: [], total: 0, offset: 0, limit: 20 }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(screen.getByText(/加载中/)).toBeTruthy();
    requestB.resolve(jsonResponse({ items: [], total: 0, offset: 0, limit: 20 }));
  });
});

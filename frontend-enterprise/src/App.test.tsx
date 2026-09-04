// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  persistSharedAgentScope,
} from '@/lib/agent-scope-storage';
import { I18nProvider } from '@/i18n';
import { tenantUserStorageKey } from '@/lib/tenant-storage';
import type { AgentProfileRead, TeamRead } from '@/types';

import App from './App';

const AUTH_STORAGE_KEY = 'ultrarag_auth';

const authSession = {
  token: 'token-1',
  scope: 'tenant' as const,
  tenant: {
    id: 'tenant_demo',
    slug: 'demo-lab',
    display_name: 'Demo Lab',
  },
  user: {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'demo',
    display_name: 'Demo Operator',
    role: 'admin' as const,
    must_change_password: false,
    avatar_url: null,
  },
};

const authUser = authSession.user;

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
  description: '',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tenantAuthSession(tenantId: string, userId = `user-${tenantId}`) {
  return {
    token: `token-${tenantId}`,
    scope: 'tenant' as const,
    tenant: {
      id: tenantId,
      slug: `${tenantId}-slug`,
      display_name: tenantId,
    },
    user: {
      id: userId,
      tenant_id: tenantId,
      username: 'admin',
      display_name: null,
      role: 'admin' as const,
      must_change_password: false,
      avatar_url: null,
    },
  };
}

// 提供一个可用模型配置，避免聊天页弹出模型配置引导（jsdom 下其内部数据为空会报错）。
const modelConfig = {
  id: 'model-1',
  tenant_id: 'tenant_demo',
  name: '默认模型',
  provider: 'openai',
  api_protocol: 'openai_chat_completions',
  api_key_masked: 'sk-***',
  model: 'gpt-test',
  temperature: 0.7,
  max_output_tokens: 1024,
  extra_body: {},
  protocol_options: {},
  legacy_unmapped_options: {},
  trust_status: 'verified',
  verification_attempt_status: 'idle',
  config_revision: 1,
  security_revision: 1,
  is_default: true,
  enabled: true,
};

function stubAppFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/tl/session')) {
      return jsonResponse({ session_id: 'session-tl-1' });
    }
    if (url.includes('/api/auth/me')) return jsonResponse(authUser);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
    if (/\/api\/enterprise\/teams\/team-1\/(tasks|blackboard|events)/.test(url)) {
      return jsonResponse([]);
    }
    if (url.includes('/api/enterprise/teams/team-1')) return jsonResponse(team);
    if (url.includes('/api/enterprise/teams')) return jsonResponse([team]);
    if (url.includes('/api/enterprise/model-configs')) return jsonResponse([modelConfig]);
    if (url.includes('/api/chat/')) return jsonResponse([]);
    if (url.includes('/api/enterprise/')) return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubBrowserApis() {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

beforeEach(() => {
  stubBrowserApis();
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authSession));
  window.localStorage.setItem('staffdeck_onboarding_guide_seen', '1');
  window.localStorage.setItem('staffdeck_quick_start_guide_seen', '1');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('App team scope selection', () => {
  it('opens the team group in the chat app when a team is selected', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAppFetch();
    persistSharedAgentScope('agent-1', 'tenant_demo', 'user-1');
    window.history.pushState({}, '', '/enterprise/agents');
    render(<I18nProvider><App /></I18nProvider>);

    const switcher = await screen.findByLabelText('切换当前员工');
    await user.click(switcher);
    const menu = await screen.findByRole('menu');
    const teamItem = within(menu)
      .getAllByRole('menuitem')
      .find((item) => item.textContent?.includes('增长团队'));
    expect(teamItem).toBeTruthy();
    await user.click(teamItem!);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/workspace/chat/session-tl-1');
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => (
      (init?.method || '').toUpperCase() === 'POST'
    ));
    expect(String(postCall?.[0])).toContain('/api/enterprise/teams/team-1/tl/session');
    expect(window.localStorage.getItem(
      tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
    )).toBe('team:team-1');
  });

  it('keeps a preset team scope instead of resetting it to an employee on agents load', async () => {
    stubAppFetch();
    persistSharedAgentScope('team:team-1', 'tenant_demo', 'user-1');
    window.history.pushState({}, '', '/enterprise/agents');
    render(<I18nProvider><App /></I18nProvider>);

    const switcher = await screen.findByLabelText('切换当前员工');
    await waitFor(() => {
      expect(switcher.textContent).toContain('当前团队');
      expect(switcher.textContent).toContain('增长团队');
    });
    expect(window.localStorage.getItem(
      tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
    )).toBe('team:team-1');
  });
});

describe('App knowledge base admin routes', () => {
  it('lets an enterprise admin open the knowledge base admin list route', async () => {
    stubAppFetch();
    window.history.pushState({}, '', '/enterprise/knowledge-admin');

    render(<I18nProvider><App /></I18nProvider>);

    expect((await screen.findAllByText('知识库管理')).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe('/enterprise/knowledge-admin');
  });

  it('lets an enterprise admin open a knowledge base admin detail route with the kbId param', async () => {
    stubAppFetch();
    window.history.pushState({}, '', '/enterprise/knowledge-admin/kb-test-1');

    render(<I18nProvider><App /></I18nProvider>);

    expect(await screen.findByRole('tab', { name: '设置' })).toBeTruthy();
    expect(window.location.pathname).toBe('/enterprise/knowledge-admin/kb-test-1');
  });

  it('redirects a non-admin user away from the knowledge base admin list to Gallery', async () => {
    const memberUser = { ...authUser, role: 'member' as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/tl/session')) return jsonResponse({ session_id: 'session-tl-1' });
      if (url.includes('/api/auth/me')) return jsonResponse(memberUser);
      if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
      if (url.includes('/api/enterprise/model-configs')) return jsonResponse([modelConfig]);
      if (url.includes('/api/chat/')) return jsonResponse([]);
      if (url.includes('/api/enterprise/')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/enterprise/knowledge-admin');

    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/workspace/gallery');
    });
  });

  it('redirects a non-admin user away from a knowledge base admin detail route to Gallery', async () => {
    const memberUser = { ...authUser, role: 'member' as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/tl/session')) return jsonResponse({ session_id: 'session-tl-1' });
      if (url.includes('/api/auth/me')) return jsonResponse(memberUser);
      if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
      if (url.includes('/api/enterprise/model-configs')) return jsonResponse([modelConfig]);
      if (url.includes('/api/chat/')) return jsonResponse([]);
      if (url.includes('/api/enterprise/')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/enterprise/knowledge-admin/kb-test-1');

    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/workspace/gallery');
    });
  });
});

const SYSTEM_AUTH_MODULE_PATH = './system-auth';

async function seedSystemSession() {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_AUTH_MODULE_PATH) as {
      setSystemAuthSession(session: unknown): void;
    };
    module.setSystemAuthSession({
      token: 'system-token',
      scope: 'system',
      system_admin: {
        id: 'sysadmin-root',
        username: 'root',
        display_name: 'System Operator',
        status: 'active',
        must_change_password: false,
        last_login_at: null,
        created_at: '2026-08-31T00:00:00Z',
      },
    });
  } catch (error) {
    throw new Error(`T022 must implement ${SYSTEM_AUTH_MODULE_PATH}: ${String(error)}`);
  }
}

describe('App system route boundary', () => {
  it('guards an unauthenticated system tenant deep link with the system login only', async () => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/system/tenants');
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    render(<I18nProvider><App /></I18nProvider>);

    expect(await screen.findByRole('heading', { name: '系统管理员登录' })).toBeTruthy();
    expect(window.location.pathname).toBe('/system/login');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('我们来做什么？')).toBeNull();
  });

  it('does not treat a tenant session as authorization for the system console', async () => {
    window.history.pushState({}, '', '/system/tenants');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/me')) {
        return {
          ...jsonResponse({ detail: { code: 'AUTH_TOKEN_INVALID' } }),
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response;
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<I18nProvider><App /></I18nProvider>);

    expect(await screen.findByRole('heading', { name: '系统管理员登录' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/auth/me'))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/system/tenants')))
      .toBe(false);
  });

  it('restores a persisted system deep link using only the system verification endpoint', async () => {
    window.localStorage.clear();
    await seedSystemSession();
    window.history.pushState({}, '', '/system/tenants');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system/auth/me')) {
        return jsonResponse({
          id: 'sysadmin-root',
          username: 'root',
          display_name: 'System Operator',
          status: 'active',
          must_change_password: false,
          last_login_at: null,
          created_at: '2026-08-31T00:00:00Z',
        });
      }
      if (url.includes('/api/system/tenants')) return jsonResponse({ items: [], next_cursor: null });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<I18nProvider><App /></I18nProvider>);

    expect(await screen.findByRole('heading', { name: '租户管理' })).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/system/auth/me')))
        .toBe(true);
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/auth/me'))).toBe(false);
    expect(screen.queryByLabelText('切换当前员工')).toBeNull();
  });

  it('does not adopt a system-only session as a tenant workspace session', async () => {
    window.localStorage.clear();
    await seedSystemSession();
    window.history.pushState({}, '', '/enterprise/dashboard');
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    render(<I18nProvider><App /></I18nProvider>);

    expect(await screen.findByText('我们来做什么？')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('切换当前员工')).toBeNull();
  });
});

describe('App tenant session lifecycle RED contracts', () => {
  it('keeps a tenant session on transient verification failure and lets the user retry', async () => {
    const user = userEvent.setup();
    let verificationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) {
        verificationAttempts += 1;
        if (verificationAttempts === 1) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => ({}),
            text: async () => '',
          } as Response;
        }
        return jsonResponse(authUser);
      }
      if (url.includes('/api/enterprise/model-configs')) return jsonResponse([modelConfig]);
      if (url.includes('/api/enterprise/') || url.includes('/api/chat/')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/workspace/gallery');

    render(<I18nProvider><App /></I18nProvider>);

    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法验证当前会话');
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
    await user.click(screen.getByRole('button', { name: '重新验证' }));

    await waitFor(() => expect(verificationAttempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('does not mount a tenant business subtree on a direct deep link before session verification', async () => {
    const verification = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/me')) return verification.promise;
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/workspace/chat/session-direct');

    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/auth/me'))).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([input]) => /\/api\/(chat|enterprise)\//.test(String(input))))
      .toBe(false);
    expect(screen.queryByLabelText('切换当前员工')).toBeNull();

    verification.resolve(jsonResponse({ ...authUser, must_change_password: false }));
  });

  it('keeps a verified tenant direct deep link and mounts only its requested session route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) return jsonResponse({ ...authUser, must_change_password: false });
      if (url.includes('/api/chat/sessions/session-direct?')) {
        return jsonResponse({
          id: 'session-direct',
          tenant_id: 'tenant_demo',
          user_id: 'user-1',
          agent_id: 'agent-1',
          status: 'active',
          updated_at: '2026-08-31T00:00:00Z',
        });
      }
      if (url.includes('/api/chat/sessions?')) return jsonResponse([]);
      if (url.includes('/api/chat/agents?')) return jsonResponse([agent]);
      if (url.includes('/api/enterprise/model-configs?')) return jsonResponse([modelConfig]);
      if (url.includes('/api/chat/')) return jsonResponse([]);
      if (url.includes('/api/enterprise/')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/workspace/chat/session-direct');

    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/workspace/chat/session-direct');
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/chat/sessions/session-direct?')))
        .toBe(true);
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/system/'))).toBe(false);
  });

  it('redirects a verified temporary-password session before mounting tenant business routes', async () => {
    const forcedUser = { ...authUser, must_change_password: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) return jsonResponse(forcedUser);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      ...tenantAuthSession('tenant_demo', 'user-1'),
      user: forcedUser,
    }));
    window.history.pushState({}, '', '/workspace/gallery');

    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => expect(window.location.pathname).toBe('/change-password'));
    expect(fetchMock.mock.calls.some(([input]) => /\/api\/(chat|enterprise)\//.test(String(input))))
      .toBe(false);
  });

  it('leaves the forced-change route after the server returns a normal replacement session', async () => {
    const user = userEvent.setup();
    const forcedUser = { ...authUser, must_change_password: true };
    const forcedSession = {
      ...tenantAuthSession('tenant_demo', 'user-1'),
      user: forcedUser,
    };
    const replacementSession = {
      ...forcedSession,
      token: 'replacement-token',
      user: { ...forcedUser, must_change_password: false },
    };
    let passwordChanged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/change-password')) {
        expect((init?.method || 'GET').toUpperCase()).toBe('POST');
        passwordChanged = true;
        return jsonResponse(replacementSession);
      }
      if (url.includes('/api/auth/password-policy')) {
        return jsonResponse({
          min_length: 8,
          max_length: 20,
          complexity_enabled: false,
          require_uppercase: false,
          require_lowercase: false,
          require_digit: false,
          require_special: false,
        });
      }
      if (url.includes('/api/auth/me')) {
        return jsonResponse(passwordChanged ? replacementSession.user : forcedUser);
      }
      if (url.includes('/api/enterprise/model-configs')) return jsonResponse([modelConfig]);
      if (url.includes('/api/enterprise/') || url.includes('/api/chat/')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(forcedSession));
    window.history.pushState({}, '', '/change-password');

    render(<I18nProvider><App /></I18nProvider>);

    await user.type(await screen.findByLabelText('当前密码'), 'Current-password-2026');
    await user.type(screen.getByLabelText('新密码'), 'Replacement-2026');
    await user.type(screen.getByLabelText('确认新密码'), 'Replacement-2026');
    await user.click(screen.getByRole('button', { name: '更新密码' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/gallery'));
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || '{}')).toMatchObject({
      token: 'replacement-token',
      user: { must_change_password: false },
    });
  });

  it('aborts tenant A verification and prevents its late response from replacing tenant B', async () => {
    const verificationA = deferred<Response>();
    const verificationCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) {
        verificationCalls.push([input, init]);
        if (verificationCalls.length === 1) return verificationA.promise;
        return Promise.resolve(jsonResponse({ ...authUser, tenant_id: 'tenant-b', id: 'user-b' }));
      }
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantAuthSession('tenant-a')));
    window.history.pushState({}, '', '/workspace/gallery');
    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => expect(verificationCalls).toHaveLength(1));
    const firstSignal = verificationCalls[0]?.[1]?.signal as AbortSignal | undefined;

    cleanup();
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantAuthSession('tenant-b', 'user-b')));
    window.history.pushState({}, '', '/workspace/gallery');
    render(<I18nProvider><App /></I18nProvider>);

    await waitFor(() => expect(verificationCalls).toHaveLength(2));
    verificationA.resolve(jsonResponse({ ...authUser, tenant_id: 'tenant-a', id: 'user-tenant-a' }));
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || '{}').user.tenant_id)
        .toBe('tenant-b');
    });
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(true);
  });
});

// @vitest-environment jsdom

import { createElement, type ComponentType, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentProfileRead, ToolRead } from '@/types';

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));

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

vi.mock('../contexts/TenantSessionContext', () => ({
  useTenantSession: () => tenantContextMock.context,
}));

/** Capture the localized toast text emitted by OAuth callback recovery handling. */
vi.mock('@/components/ui/app-toast', () => ({
  createToastNotifier: (translator: { t: (id: string) => string }) => ({
    success: (descriptor: { id: string }) => toastSpies.success(translator.t(descriptor.id)),
    error: (descriptor: { id: string }) => toastSpies.error(translator.t(descriptor.id)),
    warning: (descriptor: { id: string }) => toastSpies.warning(translator.t(descriptor.id)),
    info: (descriptor: { id: string }) => toastSpies.info(translator.t(descriptor.id)),
    loading: (descriptor: { id: string }) => toastSpies.loading(translator.t(descriptor.id)),
    dismiss: toastSpies.dismiss,
  }),
}));

/** 隔离仍使用 legacy locale 的全局页头，使本文件只验证语义 Provider 下的工具页。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    createElement('header', { 'data-testid': 'semantic-test-header' }, title ?? left)
  ),
}));

import { parseMcpArgs } from './ToolsPage';
import ToolsPage, { McpServerEditPage, ToolNewPage, ToolTestPage } from './ToolsPage';

const overallAgent: AgentProfileRead = {
  id: 'agent-overall',
  tenant_id: 'tenant_demo',
  name: 'FirmDeck overall',
  is_overall: true,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const rawTool: ToolRead = {
  id: 'tool-raw-1',
  tenant_id: 'tenant_demo',
  name: 'order_lookup_v2',
  display_name: 'Order lookup source label',
  description: 'Raw tool description from the API',
  bucket: 'commerce',
  tool_type: 'http',
  method: 'POST',
  url: 'https://tools.example.test/order_lookup_v2',
  headers: {},
  auth: {},
  mcp_config: {},
  input_schema: {},
  output_schema: {},
  allowed_skills: [],
  enabled: true,
  metadata: {},
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticToolsCopy = {
  'zh-CN': {
    title: '工具广场',
    total: '工具总数',
    enabled: '已启用',
    list: '工具列表',
    searchLabel: '搜索工具',
    refresh: '刷新',
    action: '工具操作',
    edit: '编辑',
  },
  'en-US': {
    title: 'Tool Marketplace',
    total: 'Total tools',
    enabled: 'Enabled',
    list: 'Tool list',
    searchLabel: 'Search tools',
    refresh: 'Refresh',
    action: 'Tool actions',
    edit: 'Edit',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 构造不会触发真实网络的工具页 JSON 响应，并保留原始工具标识符。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** Return the public, secret-free server policy shared by OAuth editor tests. */
function oauthServerResponse(): Record<string, unknown> {
  return {
    id: 'server-oauth',
    tenant_id: 'tenant_demo',
    name: 'protected',
    display_name: 'Protected MCP',
    description: '',
    bucket: 'MCP tools',
    connection: {
      transport: 'streamable_http',
      url: 'https://mcp.example/mcp',
      headers: {},
      command: null,
      args: [],
      env: {},
      cwd: null,
    },
    apps_mode: 'disabled',
    auth_mode: 'oauth_personal',
    oauth_client_id: 'firmdeck-public',
    oauth_client_metadata_url: null,
    oauth_redirect_uri: 'https://firmdeck.example/api/enterprise/mcp-servers/oauth/callback',
    apps_negotiated: false,
    negotiated_capabilities: {},
    capability_scope: 'general',
    enabled: true,
    last_synced_at: null,
    tool_count: 0,
    created_at: '2026-08-31T12:00:00Z',
    updated_at: '2026-08-31T12:00:00Z',
  };
}

/** 为工具页的作用域、工具列表和 MCP 服务器请求提供确定性的 API 数据。 */
function stubToolsFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([overallAgent]);
    if (url.includes('/api/enterprise/tools')) return jsonResponse([rawTool]);
    if (url.includes('/api/enterprise/mcp-servers')) return jsonResponse([]);
    return jsonResponse([]);
  }));
}

/** 补齐 Radix 数据表/下拉菜单在 jsdom 中需要的浏览器能力。 */
function stubBrowserApis(): void {
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
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}

/** 在不挂载 legacy Provider 或 observer 的前提下渲染工具页。 */
function renderSemanticTools(
  locale: AppLocale,
  role: 'admin' | 'member' = 'admin',
  initialEntry = '/workspace/tools',
): void {
  type SemanticToolsProps = NonNullable<Parameters<typeof ToolsPage>[0]>;
  const SemanticToolsPage = ToolsPage as ComponentType<SemanticToolsProps>;
  const page = createElement(SemanticToolsPage, {
    currentUser: { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role },
  });
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(MemoryRouter, { initialEntries: [initialEntry], children: page }),
    }),
  );
}

/** 渲染真实新建工具表单，验证原生 datalist 的本地化展示与空业务值边界。 */
function renderSemanticToolEditor(locale: AppLocale, toolType: 'http' | 'a2a' = 'http'): void {
  const SemanticToolNewPage = ToolNewPage as ComponentType<NonNullable<Parameters<typeof ToolNewPage>[0]>>;
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(TooltipProvider, {
        children: createElement(MemoryRouter, {
          initialEntries: [`/enterprise/tools/new?type=${toolType}`],
          children: createElement(SemanticToolNewPage, {
            currentUser: { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' },
          }),
        }),
      }),
    }),
  );
}

/** 渲染带真实路由参数的 MCP 编辑页，覆盖个人 OAuth 生命周期交互。 */
function renderSemanticMcpEditor(locale: AppLocale): void {
  const SemanticMcpServerEditPage = McpServerEditPage as ComponentType<
    NonNullable<Parameters<typeof McpServerEditPage>[0]>
  >;
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(TooltipProvider, {
        children: createElement(MemoryRouter, {
          initialEntries: ['/enterprise/tools/mcp/server-oauth/edit'],
          children: createElement(Routes, {
            children: createElement(Route, {
              path: '/enterprise/tools/mcp/:serverId/edit',
              element: createElement(SemanticMcpServerEditPage, {
                currentUser: {
                  id: 'user-1',
                  tenant_id: 'tenant_demo',
                  username: 'demo',
                  role: 'admin',
                },
              }),
            }),
          }),
        }),
      }),
    }),
  );
}

/** 渲染已保存的 A2A 工具测试页，覆盖租户连接状态与安全摘要边界。 */
function renderSemanticToolTest(locale: AppLocale, toolId: string): void {
  const SemanticToolTestPage = ToolTestPage as ComponentType<NonNullable<Parameters<typeof ToolTestPage>[0]>>;
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(TooltipProvider, {
        children: createElement(MemoryRouter, {
          initialEntries: [`/enterprise/tools/${toolId}/test`],
          children: createElement(Routes, {
            children: createElement(Route, {
              path: '/enterprise/tools/:toolId/test',
              element: createElement(SemanticToolTestPage, {
                currentUser: { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' },
              }),
            }),
          }),
        }),
      }),
    }),
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubToolsFetch();
  Object.values(toastSpies).forEach((spy) => spy.mockClear());
  tenantContextMock.context.isCurrentGeneration = (generation: number) => generation === 1;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('parseMcpArgs', () => {
  it('preserves spaces inside one argument', () => {
    expect(parseMcpArgs('C:\\Program Files\\mcp server\\index.js')).toEqual([
      'C:\\Program Files\\mcp server\\index.js',
    ]);
  });

  it('uses one non-empty line per argument', () => {
    expect(parseMcpArgs('-m\nmy_mcp.server\n\n--label=customer support')).toEqual([
      '-m',
      'my_mcp.server',
      '--label=customer support',
    ]);
  });
});

describe('ToolsPage stale requests', () => {
  it('does not toast or clear saving state when a tool save rejects after a tenant switch', async () => {
    const user = userEvent.setup();
    let rejectSave!: (reason?: unknown) => void;
    const pendingSave = new Promise<Response>((_resolve, reject) => {
      rejectSave = reject;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/api/enterprise/tools')) return pendingSave;
      return jsonResponse([]);
    }));

    renderSemanticToolEditor('zh-CN');
    await user.type(await screen.findByLabelText('工具名称'), 'stale_tool');
    await user.type(screen.getByLabelText('URL'), 'https://tools.example.test/stale');
    const saveButton = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    await user.click(saveButton);
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    tenantContextMock.context.isCurrentGeneration = (_generation: number): _generation is 1 => false;
    rejectSave(new Error('stale tool save rejection'));
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    expect(toastSpies.error).not.toHaveBeenCalled();
  });
});

describe('Codex A2A adapter availability contract', () => {
  it('shows an available adapter and enables the connection action using only the new contract', async () => {
    const adapter = {
      available: true,
      endpoint_url: 'https://codex.example.test/a2a',
      agent_card_url: 'https://codex.example.test/.well-known/agent-card.json',
      timeout_seconds: 60,
      // These legacy fields must not control or leak into the tenant connector UI.
      enabled: false,
      command: 'SECRET_CODEX_COMMAND',
      token_configured: true,
      workspace_root: 'SECRET_CODEX_WORKSPACE',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/enterprise/tools/a2a/codex-adapter')) return jsonResponse(adapter);
      if (url.includes('/api/enterprise/tools')) return jsonResponse([]);
      return jsonResponse([]);
    }));

    const user = userEvent.setup();
    renderSemanticToolEditor('en-US', 'a2a');

    await user.click(screen.getByRole('button', { name: /A2A Agent/ }));
    const connectButton = await screen.findByRole('button', { name: 'Connect local Codex' }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(false);
    expect(screen.queryByText('SECRET_CODEX_COMMAND')).toBeNull();
    expect(screen.queryByText('SECRET_CODEX_WORKSPACE')).toBeNull();
  });

  it('shows an unavailable adapter and disables the connection action using available=false', async () => {
    const adapter = {
      available: false,
      endpoint_url: 'https://codex.example.test/a2a',
      agent_card_url: 'https://codex.example.test/.well-known/agent-card.json',
      timeout_seconds: 60,
      // A stale enabled=true value must not re-enable the action.
      enabled: true,
      command: 'SECRET_CODEX_COMMAND',
      token_configured: true,
      workspace_root: 'SECRET_CODEX_WORKSPACE',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/enterprise/tools/a2a/codex-adapter')) return jsonResponse(adapter);
      if (url.includes('/api/enterprise/tools')) return jsonResponse([]);
      return jsonResponse([]);
    }));

    const user = userEvent.setup();
    renderSemanticToolEditor('en-US', 'a2a');

    await user.click(screen.getByRole('button', { name: /A2A Agent/ }));
    const disabledButton = await screen.findByRole('button', { name: 'Codex Adapter not enabled' }) as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    expect(screen.queryByText('SECRET_CODEX_COMMAND')).toBeNull();
    expect(screen.queryByText('SECRET_CODEX_WORKSPACE')).toBeNull();
  });

  it('keeps adapter command, credential, and workspace metadata out of saved A2A UI', async () => {
    const a2aTool: ToolRead = {
      ...rawTool,
      id: 'a2a-tool-1',
      tool_type: 'a2a',
      url: new URL('/api/a2a/codex', window.location.origin).toString(),
    };
    const adapter = {
      available: true,
      endpoint_url: '/api/a2a/codex',
      agent_card_url: '/.well-known/agent-card.json',
      timeout_seconds: 60,
      command: 'SECRET_CODEX_COMMAND',
      token_configured: true,
      workspace_root: 'SECRET_CODEX_WORKSPACE',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/a2a-runs')) return jsonResponse([]);
      if (url.includes('/api/enterprise/tools/a2a/codex-adapter')) return jsonResponse(adapter);
      if (url.includes('/api/enterprise/tools/a2a-tool-1')) return jsonResponse(a2aTool);
      if (url.includes('/api/enterprise/tools')) return jsonResponse([]);
      return jsonResponse([]);
    }));

    renderSemanticToolTest('en-US', a2aTool.id);

    expect(await screen.findByText('Persistent A2A tasks')).toBeTruthy();
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByText('SECRET_CODEX_COMMAND')).toBeNull();
    expect(screen.queryByText('SECRET_CODEX_WORKSPACE')).toBeNull();
    expect(screen.queryByText('Credentials configured')).toBeNull();
  });
});

describe('ToolsPage semantic locale matrix', () => {
  it.each([
    ['zh-CN', '未分桶'],
    ['en-US', 'Unbucketed'],
  ] as const)('localizes the empty bucket suggestion in %s without persisting translated prose', async (locale, label) => {
    const unbucketedTool = { ...rawTool, id: 'tool-unbucketed', bucket: '' };
    const legacyUnbucketedTool = { ...rawTool, id: 'tool-legacy-unbucketed', bucket: '未分桶' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/enterprise/tools')) return jsonResponse([unbucketedTool, legacyUnbucketedTool, rawTool]);
      return jsonResponse([]);
    }));

    renderSemanticToolEditor(locale);

    await waitFor(() => {
      expect(document.querySelectorAll('#tool-bucket-options option').length).toBe(2);
    });
    const emptyOption = document.querySelector('#tool-bucket-options option[value=""]') as HTMLOptionElement | null;
    expect(emptyOption?.label).toBe(label);
    expect(emptyOption?.value).toBe('');
    expect(document.querySelector('#tool-bucket-options option[value="未分桶"]')).toBeNull();
    expect((screen.getByLabelText(locale === 'en-US' ? 'Bucket' : '分桶') as HTMLInputElement).value).toBe('');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'renders product labels, states, and raw tool values in %s',
    async (locale) => {
      const copy = semanticToolsCopy[locale];
      renderSemanticTools(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect((await screen.findAllByText(rawTool.name)).length).toBeGreaterThan(0);
      expect(screen.getByText(copy.title)).toBeTruthy();
      expect(screen.getByText(copy.total)).toBeTruthy();
      expect(screen.getAllByText(copy.enabled).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: copy.refresh })).toBeTruthy();
      expect(screen.getAllByText(rawTool.name).length).toBeGreaterThan(0);
      expect(screen.getAllByText(rawTool.display_name || '').length).toBeGreaterThan(0);
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'exposes localized table, search, and action ARIA names in %s',
    async (locale) => {
      const copy = semanticToolsCopy[locale];
      renderSemanticTools(locale);

      await waitFor(() => expect(screen.getAllByText(rawTool.name).length).toBeGreaterThan(0));
      expect(screen.getByRole('table', { name: copy.list })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.searchLabel })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: copy.action }).length).toBeGreaterThan(0);
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps management actions available to admins and labels them in %s',
    async (locale) => {
      const copy = semanticToolsCopy[locale];
      const user = userEvent.setup();
      renderSemanticTools(locale, 'admin');

      await waitFor(() => expect(screen.getAllByText(rawTool.name).length).toBeGreaterThan(0));
      await user.click(screen.getAllByRole('button', { name: copy.action })[0]);
      expect(screen.getByRole('menuitem', { name: copy.edit })).toBeTruthy();
    },
  );

  it('does not expose admin-only create actions to a member scope', async () => {
    renderSemanticTools('en-US', 'member');

    await waitFor(() => expect(screen.getAllByText(rawTool.name).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});

describe('MCP personal OAuth lifecycle', () => {
  it.each([
    ['zh-CN', 'completed', 'success', 'MCP 账户授权完成'],
    ['en-US', 'denied', 'error', 'MCP authorization was denied. Start it again when ready.'],
    ['zh-CN', 'expired', 'error', 'MCP 授权已过期，请重新发起连接。'],
    ['en-US', 'failed', 'error', 'MCP authorization failed. Start the connection again.'],
  ] as const)(
    'shows a localized recoverable %s callback outcome in %s',
    async (locale, outcome, variant, message) => {
      renderSemanticTools(locale, 'admin', `/enterprise/tools?mcp_oauth=${outcome}`);

      await waitFor(() => {
        expect(toastSpies[variant]).toHaveBeenCalledWith(message);
      });
    },
  );

  it.each([
    ['en-US', 'connected', 'Connected', 'Disconnect account'],
    ['zh-CN', 'reconnect_required', '需要重新连接', '重新连接账户'],
  ] as const)(
    'renders the current-user %s status and recovery action in %s',
    async (locale, state, statusLabel, actionLabel) => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth/status')) {
          return jsonResponse({
            server_id: 'server-oauth',
            auth_mode: 'oauth_personal',
            state,
            expires_at: null,
            scopes: [],
            error_code: state === 'reconnect_required' ? 'MCP_TOKEN_REFRESH_FAILED' : null,
          });
        }
        if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
          return jsonResponse(oauthServerResponse());
        }
        return jsonResponse([]);
      }));

      renderSemanticMcpEditor(locale);

      expect(await screen.findByText(statusLabel)).toBeTruthy();
      expect(await screen.findByRole('button', { name: actionLabel })).toBeTruthy();
    },
  );

  it('disconnects only the current account and refreshes to a reconnectable state', async () => {
    let disconnected = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/status')) {
        return jsonResponse({
          server_id: 'server-oauth',
          auth_mode: 'oauth_personal',
          state: disconnected ? 'disconnected' : 'connected',
          expires_at: null,
          scopes: [],
          error_code: null,
        });
      }
      if (url.includes('/oauth?') && init?.method === 'DELETE') {
        disconnected = true;
        return jsonResponse(null);
      }
      if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
        return jsonResponse(oauthServerResponse());
      }
      return jsonResponse([]);
    }));

    const user = userEvent.setup();
    renderSemanticMcpEditor('en-US');

    await user.click(await screen.findByRole('button', { name: 'Disconnect account' }));
    expect(await screen.findByRole('button', { name: 'Connect personal account' })).toBeTruthy();
  });

  it('prevents authorization from starting with unsaved OAuth configuration', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth/status')) {
        return jsonResponse({
          server_id: 'server-oauth',
          auth_mode: 'oauth_personal',
          state: 'disconnected',
          expires_at: null,
          scopes: [],
          error_code: null,
        });
      }
      if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
        return jsonResponse(oauthServerResponse());
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderSemanticMcpEditor('en-US');

    const clientId = await screen.findByLabelText('Public client ID');
    await user.clear(clientId);
    await user.type(clientId, 'unsaved-client');

    const connect = await screen.findByRole('button', { name: 'Connect personal account' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/oauth/start'))).toBe(false);
  });

  it('prevents authorization after editing the saved server URL or static headers', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth/status')) {
        return jsonResponse({
          server_id: 'server-oauth',
          auth_mode: 'oauth_personal',
          state: 'disconnected',
          expires_at: null,
          scopes: [],
          error_code: null,
        });
      }
      if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
        return jsonResponse(oauthServerResponse());
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderSemanticMcpEditor('en-US');

    const serverUrl = await screen.findByLabelText('Server URL');
    await user.clear(serverUrl);
    await user.type(serverUrl, 'https://new-target.example/mcp');

    const connect = await screen.findByRole('button', { name: 'Connect personal account' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/oauth/start'))).toBe(false);
  });

  it('offers disconnect recovery while authorization is still pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth/status')) {
        return jsonResponse({
          server_id: 'server-oauth',
          auth_mode: 'oauth_personal',
          state: 'authorizing',
          expires_at: null,
          scopes: [],
          error_code: null,
        });
      }
      if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
        return jsonResponse(oauthServerResponse());
      }
      return jsonResponse([]);
    }));

    renderSemanticMcpEditor('en-US');

    const disconnect = await screen.findByRole('button', { name: 'Disconnect account' });
    expect((disconnect as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['zh-CN', '连接个人账户', '个人 OAuth 授权'],
    ['en-US', 'Connect personal account', 'Personal OAuth authorization'],
  ] as const)('loads current-user status and navigates the current tab for authorization in %s', async (
    locale,
    connectLabel,
    sectionLabel,
  ) => {
    const authorizationUrl = 'https://auth.example/authorize?state=opaque';
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/status')) {
        return jsonResponse({
          server_id: 'server-oauth',
          auth_mode: 'oauth_personal',
          state: 'disconnected',
          expires_at: null,
          scopes: [],
          error_code: null,
        });
      }
      if (url.includes('/oauth/start') && init?.method === 'POST') {
        return jsonResponse({
          authorization_url: authorizationUrl,
          flow_id: 'flow-1',
          expires_at: '2026-08-31T13:00:00Z',
        });
      }
      if (url.includes('/api/enterprise/mcp-servers/server-oauth')) {
        return jsonResponse({
          id: 'server-oauth',
          tenant_id: 'tenant_demo',
          name: 'protected',
          display_name: 'Protected MCP',
          description: '',
          bucket: 'MCP tools',
          connection: {
            transport: 'streamable_http',
            url: 'https://mcp.example/mcp',
            headers: {},
            command: null,
            args: [],
            env: {},
            cwd: null,
          },
          apps_mode: 'disabled',
          auth_mode: 'oauth_personal',
          oauth_client_id: 'firmdeck-public',
          oauth_client_metadata_url: null,
          oauth_redirect_uri: 'https://firmdeck.example/api/enterprise/mcp-servers/oauth/callback',
          apps_negotiated: false,
          negotiated_capabilities: {},
          capability_scope: 'general',
          enabled: true,
          last_synced_at: null,
          tool_count: 0,
          created_at: '2026-08-31T12:00:00Z',
          updated_at: '2026-08-31T12:00:00Z',
        });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderSemanticMcpEditor(locale);

    expect(await screen.findByText(sectionLabel)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: connectLabel }));
    await waitFor(() => {
      expect(openWindow).toHaveBeenCalledWith(authorizationUrl, '_self');
    });
    const startCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes('/oauth/start') && init?.method === 'POST'
    ));
    expect(startCall?.[1]).toEqual(expect.objectContaining({ credentials: 'include' }));
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });
});

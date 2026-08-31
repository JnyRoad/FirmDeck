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
import ToolsPage, { McpServerEditPage, ToolNewPage } from './ToolsPage';

const overallAgent: AgentProfileRead = {
  id: 'agent-overall',
  tenant_id: 'tenant_demo',
  name: 'StaffDeck overall',
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
    oauth_client_id: 'staffdeck-public',
    oauth_client_metadata_url: null,
    oauth_redirect_uri: 'https://staffdeck.example/api/enterprise/mcp-servers/oauth/callback',
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
function renderSemanticToolEditor(locale: AppLocale): void {
  const SemanticToolNewPage = ToolNewPage as ComponentType<NonNullable<Parameters<typeof ToolNewPage>[0]>>;
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(TooltipProvider, {
        children: createElement(MemoryRouter, {
          initialEntries: ['/enterprise/tools/new?type=http'],
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

beforeEach(() => {
  stubBrowserApis();
  stubToolsFetch();
  Object.values(toastSpies).forEach((spy) => spy.mockClear());
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
          oauth_client_id: 'staffdeck-public',
          oauth_client_metadata_url: null,
          oauth_redirect_uri: 'https://staffdeck.example/api/enterprise/mcp-servers/oauth/callback',
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
    }));

    const user = userEvent.setup();
    renderSemanticMcpEditor(locale);

    expect(await screen.findByText(sectionLabel)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: connectLabel }));
    await waitFor(() => {
      expect(openWindow).toHaveBeenCalledWith(authorizationUrl, '_self');
    });
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });
});

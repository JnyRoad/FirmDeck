// @vitest-environment jsdom

import { createElement, type ComponentType, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentProfileRead, ToolRead } from '@/types';

/** 隔离仍使用 legacy locale 的全局页头，使本文件只验证语义 Provider 下的工具页。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    createElement('header', { 'data-testid': 'semantic-test-header' }, title ?? left)
  ),
}));

import { parseMcpArgs } from './ToolsPage';
import ToolsPage, { ToolNewPage } from './ToolsPage';

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
function renderSemanticTools(locale: AppLocale, role: 'admin' | 'member' = 'admin'): void {
  type SemanticToolsProps = NonNullable<Parameters<typeof ToolsPage>[0]>;
  const SemanticToolsPage = ToolsPage as ComponentType<SemanticToolsProps>;
  const page = createElement(SemanticToolsPage, {
    currentUser: { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role },
  });
  render(
    createElement(AppIntlProvider, {
      initialLocale: locale,
      children: createElement(MemoryRouter, { children: page }),
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

beforeEach(() => {
  stubBrowserApis();
  stubToolsFetch();
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

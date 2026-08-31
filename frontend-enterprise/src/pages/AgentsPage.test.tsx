// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ENTERPRISE_AGENT_STORAGE_KEY } from '@/lib/agent-scope-storage';
import type { AgentProfileRead } from '@/types';

/** 隔离仍使用 legacy locale 的全局页头，使语义矩阵不依赖 DOM observer。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">{title ?? left}</header>
  ),
}));

import AgentsPage from './AgentsPage';

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

const semanticAgent: AgentProfileRead = {
  id: 'agent-aurora',
  tenant_id: 'tenant_demo',
  name: 'Agent Aurora',
  description: 'Raw employee description',
  is_overall: false,
  status: 'active',
  metadata: {
    owner_user_id: 'user-1',
    role_name: 'Support role source',
    work_styles: ['Raw work style'],
  },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticAgentsCopy = {
  'zh-CN': {
    search: '搜索员工',
    stats: '数字员工统计',
    categories: '数字员工分类',
    create: '创建新员工',
    all: '全部员工',
    online: '在线员工',
    offline: '下线员工',
    action: '员工操作',
    chat: '发起对话',
    status: '在线',
    edit: '编辑资料',
    empty: '没有匹配的数字员工',
  },
  'en-US': {
    search: 'Search employees',
    stats: 'Employee statistics',
    categories: 'Employee categories',
    create: 'Create new employee',
    all: 'All employees',
    online: 'Online employees',
    offline: 'Offline employees',
    action: 'Employee actions',
    chat: 'Start conversation',
    status: 'Online',
    edit: 'Edit profile',
    empty: 'No matching digital employees',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

/** 为语义员工页提供最小员工列表响应，不改变员工名称、角色和描述等原始业务数据。 */
function stubSemanticAgentsFetch(rows: AgentProfileRead[] = [semanticAgent]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/enterprise/agents')) return jsonResponse(rows);
    return jsonResponse([]);
  }));
}

/** 在不挂载 legacy Provider 的前提下渲染员工页，保留实际权限判定与卡片 DOM。 */
function renderSemanticAgents(
  locale: AppLocale,
  currentUser: { id: string; tenant_id: string; username: string; role: 'admin' | 'member' } = {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'demo',
    role: 'admin',
  },
): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <AgentsPage currentUser={currentUser} />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('AgentsPage team scope compatibility', () => {
  it('renders gracefully when the stored scope is a team', async () => {
    window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, 'team:team-1');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
      return jsonResponse([]);
    }));

    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter>
            <AgentsPage
              currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' }}
            />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    // 团队作用域匹配不到任何员工：不高亮、不报错，员工列表照常渲染。
    expect((await screen.findByText('小艾')).textContent).toBeTruthy();
  });
});

describe('AgentsPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders product labels, states, accessibility names, and raw employee values in %s',
    async (locale) => {
      const copy = semanticAgentsCopy[locale];
      stubSemanticAgentsFetch();
      renderSemanticAgents(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByText(new RegExp(semanticAgent.name))).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.search })).toBeTruthy();
      expect(screen.getByLabelText(copy.stats)).toBeTruthy();
      expect(screen.getByRole('tablist', { name: copy.categories })).toBeTruthy();
      expect(screen.getByRole('button', { name: new RegExp(copy.create) })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.all })).toBeTruthy();
      expect(screen.getByText(copy.status)).toBeTruthy();
      expect(screen.getByText('Support role source')).toBeTruthy();
      expect(screen.getByText('Raw employee description')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps admin action affordances and localizes their accessible names in %s',
    async (locale) => {
      const copy = semanticAgentsCopy[locale];
      const user = userEvent.setup();
      stubSemanticAgentsFetch();
      renderSemanticAgents(locale);

      await screen.findByText(new RegExp(semanticAgent.name));
      expect(screen.getByRole('button', { name: copy.chat })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: copy.action }));
      expect(screen.getByRole('menuitem', { name: copy.edit })).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'renders a localized permission empty state for a non-owner member in %s',
    async (locale) => {
      const copy = semanticAgentsCopy[locale];
      stubSemanticAgentsFetch();
      renderSemanticAgents(locale, {
        id: 'user-2',
        tenant_id: 'tenant_demo',
        username: 'member',
        role: 'member',
      });

      expect(await screen.findByText(copy.empty)).toBeTruthy();
      expect(screen.queryByText(new RegExp(semanticAgent.name))).toBeNull();
      expect(screen.queryByRole('button', { name: copy.action })).toBeNull();
    },
  );
});

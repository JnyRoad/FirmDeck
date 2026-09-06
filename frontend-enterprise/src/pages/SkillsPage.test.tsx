// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import type { AgentProfileRead, SkillRead } from '@/types';

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

/** 隔离 legacy 页头，让矩阵只验证语义 locale shell。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">{title ?? left}</header>
  ),
}));

import SkillsPage from './SkillsPage';

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

const rawSkill: SkillRead = {
  id: 'skill-1',
  tenant_id: 'tenant_demo',
  skill_id: 'order_fulfillment',
  name: 'Order fulfillment',
  description: 'Raw SOP description',
  business_domain: 'Source domain',
  version: '1.0.0',
  status: 'published',
  branch_sync_state: 'synced',
  call_count: 4,
  total_call_count: 12,
  positive_rate: 0.75,
  negative_rate: 0.25,
  positive_feedback_count: 3,
  negative_feedback_count: 1,
  total_positive_rate: 0.8,
  total_negative_rate: 0.2,
  total_positive_feedback_count: 8,
  total_negative_feedback_count: 2,
  recent_versions: ['1.0.0'],
  recent_call_count: 4,
  recent_positive_feedback_count: 3,
  recent_negative_feedback_count: 1,
  recent_positive_rate: 0.75,
  recent_negative_rate: 0.25,
  metadata: { creator_name: 'Source creator' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  content: {
    skill_id: 'order_fulfillment',
    name: 'Order fulfillment',
    version: '1.0.0',
    description: 'Raw SOP description',
    capability_scope: 'general',
    trigger_intents: [],
    user_utterance_examples: [],
    goal: [],
    required_info: [],
    nodes: [],
    edges: [],
    start_node_id: 'start',
    terminal_node_ids: [],
    interruption_policy: {},
    response_rules: [],
  },
};

const semanticSkillsCopy = {
  'zh-CN': {
    title: 'SOP',
    list: 'SOP 列表',
    search: '搜索 SOP',
    action: 'SOP 操作',
    edit: '编辑',
    calls: '调用排行',
    positive: '好评 SOP',
  },
  'en-US': {
    title: 'SOP',
    list: 'SOP list',
    search: 'Search SOPs',
    action: 'SOP actions',
    edit: 'Edit',
    calls: 'Call ranking',
    positive: 'Top-rated SOPs',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 构造不会访问真实后端的 JSON 响应。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 为 SOP 页提供稳定的员工与 SOP 列表响应。 */
function stubSkillsFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([overallAgent]);
    if (url.includes('/api/enterprise/skills')) return jsonResponse([rawSkill]);
    return jsonResponse([]);
  }));
}

/** 补齐 jsdom 下 Radix 和滚动相关的浏览器能力。 */
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

/** 在不挂载 legacy Provider 的前提下渲染 SOP 页。 */
function renderSemanticSkills(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <SkillsPage currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' }} />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubSkillsFetch();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('SkillsPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes shell labels, ranking cards, and ARIA while preserving raw SOP values in %s',
    async (locale) => {
      const copy = semanticSkillsCopy[locale];
      const user = userEvent.setup();
      renderSemanticSkills(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect((await screen.findAllByText(rawSkill.name)).length).toBeGreaterThan(0);
      expect(screen.getByText(copy.title)).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.search })).toBeTruthy();
      expect(screen.getByRole('table', { name: copy.list })).toBeTruthy();
      expect(screen.getByText(copy.calls)).toBeTruthy();
      expect(screen.getByText(copy.positive)).toBeTruthy();
      await user.click(screen.getAllByRole('button', { name: copy.action })[0]);
      expect(screen.getByRole('menuitem', { name: copy.edit })).toBeTruthy();
      expect(screen.getAllByText(rawSkill.skill_id).length).toBeGreaterThan(0);
      expect(screen.getAllByText(rawSkill.business_domain || '').length).toBeGreaterThan(0);
    },
  );
});

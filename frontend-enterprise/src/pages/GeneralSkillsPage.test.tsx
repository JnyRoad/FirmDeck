// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import type { AgentProfileRead, GeneralSkillRead } from '@/types';

/** 隔离 legacy 页头，让矩阵只验证 AppIntlProvider 下的产品文案与 raw 边界。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">{title ?? left}</header>
  ),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/components/ui/app-toast', () => ({
  notify: toastMocks,
}));

import GeneralSkillsPage from './GeneralSkillsPage';

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

const rawSkill: GeneralSkillRead = {
  id: 'general-skill-1',
  tenant_id: 'tenant_demo',
  slug: 'order_lookup',
  name: 'Order lookup',
  description: 'Raw skill description',
  capability_scope: 'general',
  status: 'published',
  skill_markdown: '# Raw content',
  skill_files: [{ path: 'SKILL.md', content: '# Raw content' }],
  permissions: {},
  runtime_config: {},
  metadata: { creator_name: 'Source creator' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticGeneralSkillsCopy = {
  'zh-CN': {
    title: '技能广场',
    total: '技能总数',
    enabled: '已启用',
    search: '搜索技能',
    list: '技能列表',
    action: '技能操作',
    edit: '编辑',
    create: '新增',
  },
  'en-US': {
    title: 'Skills Marketplace',
    total: 'Total skills',
    enabled: 'Enabled',
    search: 'Search skills',
    list: 'Skill list',
    action: 'Skill actions',
    edit: 'Edit',
    create: 'Add',
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

/** 为技能广场页提供固定的员工与技能数据。 */
function stubGeneralSkillsFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([overallAgent]);
    if (url.includes('/api/enterprise/general-skills')) return jsonResponse([rawSkill]);
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

/** 在不挂载 legacy Provider 的前提下渲染技能广场页。 */
function renderSemanticGeneralSkills(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <GeneralSkillsPage currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' }} />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubGeneralSkillsFetch();
  toastMocks.error.mockReset();
  toastMocks.info.mockReset();
  toastMocks.success.mockReset();
  toastMocks.warning.mockReset();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('GeneralSkillsPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes product labels, actions, and ARIA while preserving raw skill values in %s',
    async (locale) => {
      const copy = semanticGeneralSkillsCopy[locale];
      const user = userEvent.setup();
      renderSemanticGeneralSkills(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect((await screen.findAllByText(rawSkill.name)).length).toBeGreaterThan(0);
      expect(screen.getByText(copy.title)).toBeTruthy();
      expect(screen.getByText(copy.total)).toBeTruthy();
      expect(screen.getAllByText(copy.enabled).length).toBeGreaterThan(0);
      expect(screen.getByRole('textbox', { name: copy.search })).toBeTruthy();
      expect(screen.getByRole('table', { name: copy.list })).toBeTruthy();
      await user.click(screen.getAllByRole('button', { name: copy.action })[0]);
      expect(screen.getByRole('menuitem', { name: copy.edit })).toBeTruthy();
      expect(screen.getAllByText(rawSkill.slug).length).toBeGreaterThan(0);
      expect(screen.getAllByText(rawSkill.description || '').length).toBeGreaterThan(0);
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps create affordances localized for admin users in %s',
    async (locale) => {
      const copy = semanticGeneralSkillsCopy[locale];
      renderSemanticGeneralSkills(locale);

      await waitFor(() => expect(screen.getAllByText(rawSkill.name).length).toBeGreaterThan(0));
      expect(screen.getByRole('button', { name: new RegExp(copy.create) })).toBeTruthy();
    },
  );

  it.each([
    ['zh-CN', '加载失败'],
    ['en-US', 'Failed to load skills'],
  ] as const)(
    'projects load failures to a safe localized toast in %s',
    async (locale, expectedToast) => {
      const rawError = 'provider secret: connection refused at 10.0.0.8';
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/enterprise/general-skills')) throw new Error(rawError);
        if (url.includes('/api/enterprise/agents')) return jsonResponse([overallAgent]);
        return jsonResponse([]);
      }));

      renderSemanticGeneralSkills(locale);

      await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(expectedToast));
      expect(toastMocks.error).not.toHaveBeenCalledWith(rawError);
    },
  );
});

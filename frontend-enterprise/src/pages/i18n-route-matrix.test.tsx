// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import type { AgentProfileRead } from '@/types';

import OpenPlatformPage from './OpenPlatformPage';
import PersonaPage from './PersonaPage';
import TutorialPage from './TutorialPage';

/** 隔离仍使用 legacy locale 的全局页头，使本矩阵只依赖 AppIntlProvider。 */
vi.mock('@/components/AppHeader', () => ({
  default: ({ title, description, left }: { title?: ReactNode; description?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">
      {title}
      {description}
      {left}
    </header>
  ),
}));

const openPlatformAgent: AgentProfileRead = {
  id: 'agent-open-1',
  tenant_id: 'tenant_demo',
  name: 'Raw Open Agent',
  description: 'Raw open-platform description',
  is_overall: false,
  status: 'active',
  metadata: {
    published_to_gallery: true,
    role_name: 'Raw open-platform role',
  },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const routeMatrixCopy = {
  'zh-CN': {
    platformTitle: '开放广场平台',
    platformTabsLabel: '开放广场分类',
    platformAgents: '数字员工广场',
    platformSearch: '搜索员工',
    platformTools: '工具广场',
    unbucketed: '未分桶',
    unpublish: '从广场下线',
    compactUnpublish: '确认下线',
    personaTitle: '岗位人设',
    save: '保存',
    personaName: '名称',
    personaDescription: '描述',
    personaPrompt: '岗位 Prompt',
    personaNamePlaceholder: '数字员工姓名',
    tutorialHero: '企业数字员工运行时，从配置到持续运营',
    tutorialNavigation: 'StaffDeck 单页文档目录',
    quickStart: '快速开始',
  },
  'en-US': {
    platformTitle: 'Open Marketplace Platform',
    platformTabsLabel: 'Marketplace categories',
    platformAgents: 'Employee Marketplace',
    platformSearch: 'Search employees',
    platformTools: 'Tool Marketplace',
    unbucketed: 'Unbucketed',
    unpublish: 'Unpublish from marketplace',
    compactUnpublish: 'Unpublish',
    personaTitle: 'Role Persona',
    save: 'Save',
    personaName: 'Name',
    personaDescription: 'Description',
    personaPrompt: 'Role prompt',
    personaNamePlaceholder: 'Employee name',
    tutorialHero: 'Enterprise digital employee runtime, from configuration to continuous operations',
    tutorialNavigation: 'StaffDeck single-page documentation navigation',
    quickStart: 'Quick start',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 构造页面所需的 JSON 响应，避免矩阵测试连接真实后端。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 为开放平台页返回公开员工和空资源集合，同时保留员工的原始名称、角色和描述。 */
function stubOpenPlatformFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([openPlatformAgent]);
    return jsonResponse([]);
  }));
}

/** 返回一个携带旧版空分桶标记的工具，验证产品状态不会作为原始业务值泄漏。 */
function stubOpenPlatformToolFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([openPlatformAgent]);
    if (url.includes('/api/enterprise/tools')) {
      return jsonResponse([{
        id: 'tool-open-1',
        name: 'raw_tool_name',
        display_name: 'Raw tool display name',
        description: 'Raw tool description',
        bucket: '未分桶',
        tool_type: 'http',
        method: 'POST',
        enabled: true,
      }]);
    }
    return jsonResponse([]);
  }));
}

/** 为岗位人设页提供空作用域和原始 Prompt，验证产品标签与业务内容的边界。 */
function stubPersonaFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([]);
    if (url.includes('/api/enterprise/persona')) {
      return jsonResponse({ system_prompt: 'Raw persona prompt', updated_at: '2026-08-01T00:00:00Z' });
    }
    return jsonResponse([]);
  }));
}

/** 在不挂载 legacy Provider 的前提下渲染开放平台页。 */
function renderSemanticOpenPlatform(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/enterprise/platform']}>
        <OpenPlatformPage isAdmin currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'admin', role: 'admin' }} />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

/** 在不挂载 legacy Provider 的前提下渲染岗位人设页。 */
function renderSemanticPersona(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <PersonaPage />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

/** 在不挂载 legacy Provider 的前提下渲染教程页。 */
function renderSemanticTutorial(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <TutorialPage />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

/** 补齐 Radix 与教程滚动逻辑在 jsdom 中读取的浏览器能力。 */
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

beforeEach(() => {
  stubBrowserApis();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('remaining route semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the open platform shell, roles, states, and ARIA while keeping raw employee data in %s',
    async (locale) => {
      const copy = routeMatrixCopy[locale];
      stubOpenPlatformFetch();
      renderSemanticOpenPlatform(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByText(openPlatformAgent.name)).toBeTruthy();
      expect(screen.getByText(copy.platformTitle)).toBeTruthy();
      expect(screen.getByRole('tablist', { name: copy.platformTabsLabel })).toBeTruthy();
      expect(screen.getByRole('tablist', { name: copy.platformTabsLabel }).className).toContain('flex-nowrap');
      expect(screen.getByRole('tablist', { name: copy.platformTabsLabel }).className).toContain('overflow-x-auto');
      expect(screen.getByRole('tab', { name: copy.platformAgents })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.platformSearch })).toBeTruthy();
      const unpublishButton = screen.getByRole('button', { name: copy.unpublish });
      expect(unpublishButton.textContent).toBe(copy.compactUnpublish);
      expect(screen.getByText('Raw open-platform role')).toBeTruthy();
      expect(screen.getByText('Raw open-platform description')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the legacy unbucketed tool state without translating raw tool data in %s',
    async (locale) => {
      const user = userEvent.setup();
      const copy = routeMatrixCopy[locale];
      stubOpenPlatformToolFetch();
      renderSemanticOpenPlatform(locale);

      await user.click(await screen.findByRole('tab', { name: copy.platformTools }));

      expect(await screen.findByText('Raw tool display name')).toBeTruthy();
      expect(screen.getByText('Raw tool description')).toBeTruthy();
      expect(screen.getByText(`${copy.unbucketed} / HTTP`)).toBeTruthy();
      if (locale === 'en-US') expect(screen.queryByText('未分桶 / HTTP')).toBeNull();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes persona form labels and preserves the user-authored prompt in %s',
    async (locale) => {
      const copy = routeMatrixCopy[locale];
      stubPersonaFetch();
      renderSemanticPersona(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByRole('heading', { name: copy.personaTitle })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.save })).toBeTruthy();
      expect(screen.getByText(copy.personaName)).toBeTruthy();
      expect(screen.getByText(copy.personaDescription)).toBeTruthy();
      expect(screen.getByText(copy.personaPrompt)).toBeTruthy();
      expect(screen.getByPlaceholderText(copy.personaNamePlaceholder)).toBeTruthy();
      expect(await screen.findByDisplayValue('Raw persona prompt')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes tutorial headings, navigation ARIA, and primary action in %s',
    async (locale) => {
      const copy = routeMatrixCopy[locale];
      renderSemanticTutorial(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByRole('heading', { name: copy.tutorialHero })).toBeTruthy();
      expect(screen.getByRole('complementary', { name: copy.tutorialNavigation })).toBeTruthy();
      expect(screen.getAllByRole('link', { name: copy.quickStart }).length).toBeGreaterThan(0);
    },
  );

});

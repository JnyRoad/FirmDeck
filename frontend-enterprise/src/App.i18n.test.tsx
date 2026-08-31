// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';

import App from './App';

const AUTH_STORAGE_KEY = 'ultrarag_auth';

const authUser = {
  id: 'user-i18n',
  tenant_id: 'tenant_demo',
  username: 'admin',
  role: 'admin',
};

const shellCopy = {
  'zh-CN': {
    title: 'StaffDeck 数字员工运营平台',
    navigation: '开放广场平台',
    employeeSwitcher: '切换当前员工',
  },
  'en-US': {
    title: 'StaffDeck Digital Employee Operations Platform',
    navigation: 'Open Marketplace',
    employeeSwitcher: 'Switch current employee',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 隔离不属于 T014 的更新提醒，使本文件只约束应用壳国际化迁移。 */
vi.mock('./components/UpdateReminder', () => ({ default: () => null }));

/** 隔离当前路由页面，使测试只覆盖 App 壳与真实导航，不扩张到后续领域迁移。 */
vi.mock('./pages/AgentsPage', () => ({ default: () => null }));

/** 创建符合 API 客户端读取方式的最小 JSON 响应。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 为认证刷新与应用壳初始化提供确定性响应，未知只读端点统一返回空集合。 */
function stubShellFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/me')) return jsonResponse(authUser);
    if (url.includes('/api/enterprise/agents')) return jsonResponse([]);
    if (url.includes('/api/enterprise/teams')) return jsonResponse([]);
    if (url.includes('/api/enterprise/model-configs')) return jsonResponse([]);
    return jsonResponse([]);
  }));
}

/** 补齐 Radix 与响应式 Hook 在 jsdom 中读取的浏览器能力。 */
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
}

/** 仅用语义 Provider 渲染真实 App，明确排除兼容 Provider 与 DOM observer。 */
function renderSemanticApp(locale: AppLocale) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <App />
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubShellFetch();
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    token: 'token-i18n',
    user: authUser,
  }));
  window.localStorage.setItem('staffdeck_onboarding_guide_seen', '1');
  window.localStorage.setItem('staffdeck_quick_start_guide_seen', '1');
  window.history.pushState({}, '', '/enterprise/agents');
  document.title = '';
  document.documentElement.lang = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
  document.title = '';
  document.documentElement.lang = '';
});

describe('App semantic shell locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the application title, lang, navigation, and ARIA in %s',
    async (locale) => {
      const copy = shellCopy[locale];
      renderSemanticApp(locale);

      expect(await screen.findByText(copy.navigation)).toBeTruthy();
      expect(screen.getByLabelText(copy.employeeSwitcher)).toBeTruthy();
      expect(document.documentElement.lang).toBe(locale);
      expect(document.title).toBe(copy.title);
    },
  );
});

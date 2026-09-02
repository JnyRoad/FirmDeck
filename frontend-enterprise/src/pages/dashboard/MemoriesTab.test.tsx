// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { TenantSessionProvider } from '@/contexts/TenantSessionContext';
import type { AgentProfileRead, MemoryRead } from '@/types';

import MemoriesTab from './MemoriesTab';

const semanticCopy = {
  'zh-CN': {
    section: '记忆查询',
    search: '查询',
    clear: '清空我的记忆',
    table: '员工记忆',
    detail: '员工记忆详情',
    count: '2 条记忆',
    view: '查看',
  },
  'en-US': {
    section: 'Memory search',
    search: 'Search',
    clear: 'Clear my memories',
    table: 'Employee memories',
    detail: 'Employee memory details',
    count: '2 memories',
    view: 'View',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

const agent: AgentProfileRead = {
  id: 'agent-memory-1',
  tenant_id: 'tenant_demo',
  name: 'Memory Agent',
  description: 'Raw agent description',
  is_overall: false,
  status: 'active',
  metadata: { owner_user_id: 'user-1' },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const memories: MemoryRead[] = [
  {
    id: 'memory-1',
    tenant_id: 'tenant_demo',
    user_id: 'user_raw_1',
    username: 'Raw User 1',
    session_id: 'session-1',
    kind: 'profile',
    content: 'Raw memory content one',
    importance: 0.8,
    metadata: { channel: 'wechat' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
  },
  {
    id: 'memory-2',
    tenant_id: 'tenant_demo',
    user_id: 'user_raw_1',
    username: 'Raw User 1',
    session_id: 'session-2',
    kind: 'summary',
    content: 'Raw memory content two',
    importance: 0.4,
    metadata: {},
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
  },
];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

/** Build the fully validated tenant session used by the memories test harness. */
function memoriesSession() {
  return {
    token: 'token-user-1',
    scope: 'tenant' as const,
    tenant: { id: 'tenant_demo', slug: 'demo', display_name: 'Demo tenant' },
    user: {
      id: 'user-1',
      tenant_id: 'tenant_demo',
      username: 'demo',
      display_name: null,
      role: 'admin' as const,
      must_change_password: false,
      avatar_url: null,
    },
  };
}

/** 为记忆页提供确定性的列表数据，避免 locale 测试依赖真实接口状态。 */
function stubMemoryFetch(rows: MemoryRead[] = memories): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        id: 'user-1',
        tenant_id: 'tenant_demo',
        username: 'demo',
        display_name: null,
        role: 'admin',
        must_change_password: false,
        avatar_url: null,
      });
    }
    if (url.includes('/api/enterprise/memories?')) return jsonResponse(rows);
    if (url.includes('/api/enterprise/memories/me?')) return jsonResponse({ deleted: rows.length });
    return jsonResponse([]);
  }));
}

/** 使用语义 i18n Provider 渲染记忆页，验证 chrome 与 raw 内容边界。 */
function renderMemoriesTab(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <TenantSessionProvider session={memoriesSession()}>
        <MemoriesTab
          currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' }}
          agent={agent}
        />
      </TenantSessionProvider>
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MemoriesTab semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders localized memory chrome and preserves raw memory content in %s',
    async (locale) => {
      const copy = semanticCopy[locale];
      stubMemoryFetch();
      renderMemoriesTab(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByText(copy.section)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.search })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.clear })).toBeTruthy();
      expect(screen.getByLabelText(copy.table)).toBeTruthy();
      expect((await screen.findAllByText('Raw User 1')).length).toBeGreaterThan(0);
      expect((await screen.findAllByText(/Raw memory content one/)).length).toBeGreaterThan(0);
      expect((await screen.findAllByText(/Raw memory content two/)).length).toBeGreaterThan(0);

      fireEvent.click(screen.getAllByRole('button', { name: copy.view })[0]);

      expect(await screen.findByText(copy.detail)).toBeTruthy();
      expect(screen.getAllByText(copy.count).length).toBeGreaterThan(0);
      expect(screen.getByText('Raw memory content one')).toBeTruthy();
      expect(screen.getByText('Raw memory content two')).toBeTruthy();
      await waitFor(() => expect(screen.getByText('metadata')).toBeTruthy());
    },
  );
});

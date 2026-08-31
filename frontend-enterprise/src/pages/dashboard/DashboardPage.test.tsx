// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ENTERPRISE_AGENT_STORAGE_KEY } from '@/lib/agent-scope-storage';
import type { AgentProfileRead } from '@/types';

/** 隔离仍使用 legacy locale 的全局页头，使仪表盘矩阵只依赖语义 Provider。 */
vi.mock('../../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">{title ?? left}</header>
  ),
}));

/** 隔离仍依赖 legacy locale 的演进面板，避免 T025 语义矩阵挂载 legacy observer。 */
vi.mock('./EvolutionPanel', () => ({
  default: () => null,
}));

import DashboardPage from './DashboardPage';

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

const dashboardAgent: AgentProfileRead = {
  id: 'agent-dashboard-1',
  tenant_id: 'tenant_demo',
  name: 'Dashboard Agent Aurora',
  description: 'Raw dashboard employee description',
  is_overall: false,
  status: 'active',
  metadata: {
    owner_user_id: 'user-1',
    role_name: 'Raw dashboard role',
    work_styles: ['Raw dashboard style'],
  },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticDashboardCopy = {
  'zh-CN': {
    chat: '去对话',
    edit: '编辑资料',
    status: '在线',
    sections: '个人档案分区',
    work: '工作记录',
    scheduled: '定时任务',
    memories: '记忆',
    logs: '对话日志',
    noEmployee: '还没有数字员工',
  },
  'en-US': {
    chat: 'Open chat',
    edit: 'Edit profile',
    status: 'Online',
    sections: 'Profile sections',
    work: 'Work record',
    scheduled: 'Scheduled tasks',
    memories: 'Memories',
    logs: 'Conversation logs',
    noEmployee: 'No digital employee yet',
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

/** 为仪表盘提供确定性的员工、统计、工作记录和空资源响应。 */
function stubSemanticDashboardFetch(rows: AgentProfileRead[] = [dashboardAgent]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/work-record')) {
      return jsonResponse({ reply_stats: { total: 0, today: 0, by_day: {} }, events: [] });
    }
    if (url.includes('/api/enterprise/agents')) return jsonResponse(rows);
    if (url.includes('/api/enterprise/feedback/summary')) {
      return jsonResponse({ total_feedback: 0, up_count: 0, down_count: 0, bucket_counts: [] });
    }
    return jsonResponse([]);
  }));
}

/** 在不挂载 legacy Provider 的前提下渲染仪表盘，并固定员工作用域避免首屏自动切换。 */
function renderSemanticDashboard(
  locale: AppLocale,
  currentUser: { id: string; tenant_id: string; username: string; role: 'admin' | 'member' } = {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'demo',
    role: 'admin',
  },
): void {
  window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, dashboardAgent.id);
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <DashboardPage currentUser={currentUser} isAdmin={currentUser.role === 'admin'} />
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

describe('DashboardPage team scope compatibility', () => {
  it('never sends the team scope as an agent_id query param', async () => {
    window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, 'team:team-1');
    const fetchedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('/work-record')) {
        return jsonResponse({ reply_stats: { total: 0, today: 0, by_day: {} }, events: [] });
      }
      if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
      if (url.includes('/api/enterprise/feedback/summary')) {
        return jsonResponse({ total_feedback: 0, up_count: 0, down_count: 0, bucket_counts: [] });
      }
      return jsonResponse([]);
    }));

    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter>
            <DashboardPage
              currentUser={{ id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' }}
              isAdmin
            />
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    // 团队作用域视为未选员工：页面回落到可用员工，正常渲染且不报 "Agent not found"。
    expect((await screen.findByText('小艾')).textContent).toBeTruthy();
    await waitFor(() => expect(fetchedUrls.length).toBeGreaterThan(0));
    fetchedUrls.forEach((url) => {
      expect(url).not.toContain('agent_id=team');
      expect(url).not.toContain('team%3A');
      expect(url).not.toContain('/agents/team');
    });
  });
});

describe('DashboardPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders localized dashboard chrome, tabs, status, and raw employee data in %s',
    async (locale) => {
      const copy = semanticDashboardCopy[locale];
      stubSemanticDashboardFetch();
      renderSemanticDashboard(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByText(dashboardAgent.name)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.chat })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.edit })).toBeTruthy();
      expect(screen.getByText(copy.status)).toBeTruthy();
      expect(screen.getByRole('tablist', { name: copy.sections })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.work })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.scheduled })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.memories })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.logs })).toBeTruthy();
      expect(screen.getByText('Raw dashboard role')).toBeTruthy();
      expect(screen.getByText('Raw dashboard employee description')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'renders a localized permission empty state for a member without an accessible employee in %s',
    async (locale) => {
      const copy = semanticDashboardCopy[locale];
      stubSemanticDashboardFetch();
      renderSemanticDashboard(locale, {
        id: 'user-2',
        tenant_id: 'tenant_demo',
        username: 'member',
        role: 'member',
      });

      expect(await screen.findByText(copy.noEmployee)).toBeTruthy();
      expect(screen.queryByText(dashboardAgent.name)).toBeNull();
    },
  );
});

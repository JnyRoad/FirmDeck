// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { I18nProvider } from '@/i18n';
import type { EnterpriseAuthUser } from '@/auth';
import type { AgentProfileRead, TeamRead } from '@/types';

/** 隔离仍使用 legacy locale 的全局页头，使语义矩阵不依赖 DOM observer。 */
vi.mock('../components/AppHeader', () => ({
  default: ({ title, left }: { title?: ReactNode; left?: ReactNode }) => (
    <header data-testid="semantic-test-header">{title ?? left}</header>
  ),
}));

import EmployeeGalleryPage from './EmployeeGalleryPage';

const team: TeamRead = {
  id: 'team-1',
  tenant_id: 'tenant_demo',
  name: '增长团队',
  description: '负责增长实验与内容投放',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [
    { id: 'm-1', team_id: 'team-1', agent_id: 'agent-1', role: 'leader', agent_name: '小艾', created_at: '2026-08-01T00:00:00Z' },
    { id: 'm-2', team_id: 'team-1', agent_id: 'agent-2', role: 'member', agent_name: '小北', created_at: '2026-08-01T00:00:00Z' },
    { id: 'm-3', team_id: 'team-1', agent_id: 'agent-3', role: 'member', agent_name: '小南', created_at: '2026-08-01T00:00:00Z' },
    { id: 'm-4', team_id: 'team-1', agent_id: 'agent-4', role: 'member', agent_name: '小西', created_at: '2026-08-01T00:00:00Z' },
  ],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const galleryAgent: AgentProfileRead = {
  id: 'agent-gallery-1',
  tenant_id: 'tenant_demo',
  name: 'Gallery Agent Aurora',
  description: 'Raw gallery description',
  is_overall: false,
  status: 'active',
  metadata: {
    published_to_gallery: true,
    role_name: 'Raw gallery role',
    work_styles: ['Raw gallery style'],
  },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticGalleryCopy = {
  'zh-CN': {
    search: '搜索数字员工',
    categories: '数字员工分类',
    all: '所有员工',
    mine: '我的数字员工',
    teams: '团队对话',
    gallery: '数字员工广场',
    teamSection: '团队',
    status: '在线',
    chat: '发起对话',
    empty: '暂无数字员工',
  },
  'en-US': {
    search: 'Search digital employees',
    categories: 'Employee categories',
    all: 'All employees',
    mine: 'My digital employees',
    teams: 'Team conversations',
    gallery: 'Employee marketplace',
    teamSection: 'Teams',
    status: 'Online',
    chat: 'Start conversation',
    empty: 'No digital employees yet',
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

function stubGalleryFetch(teams: TeamRead[], agents: AgentProfileRead[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('/tl/session')) {
      return jsonResponse({ session_id: 'session-tl-1' });
    }
    if (url.includes('/api/enterprise/teams')) return jsonResponse(teams);
    if (url.includes('/api/enterprise/agents')) return jsonResponse(agents);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 在不挂载 legacy Provider 的前提下渲染员工广场，保留真实筛选和权限边界。 */
function renderSemanticGallery(locale: AppLocale, currentUser?: EnterpriseAuthUser): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/workspace/gallery']}>
        <Routes>
          <Route path="/workspace/gallery" element={<EmployeeGalleryPage currentUser={currentUser} />} />
          <Route path="/workspace/chat/:sessionId" element={<LocationEcho />} />
          <Route path="/enterprise/teams/:teamId" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderGallery(currentUser?: EnterpriseAuthUser) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/workspace/gallery']}>
        <Routes>
          <Route path="/workspace/gallery" element={<EmployeeGalleryPage currentUser={currentUser} />} />
          <Route path="/workspace/chat/:sessionId" element={<LocationEcho />} />
          <Route path="/enterprise/teams/:teamId" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EmployeeGalleryPage teams tab', () => {
  it('renders team chat cards with member count, project leader and avatar stack', async () => {
    const user = userEvent.setup();
    stubGalleryFetch([team]);
    renderGallery();

    await user.click(await screen.findByRole('tab', { name: '团队对话' }));

    const section = await screen.findByRole('region', { name: '团队' });
    expect(within(section).getByText('增长团队')).toBeTruthy();
    expect(within(section).getByText('负责增长实验与内容投放')).toBeTruthy();
    expect(within(section).getByText('4 名成员')).toBeTruthy();
    expect(
      within(section).getAllByText((_, element) => element?.textContent === '项目领导：小艾').length,
    ).toBeGreaterThan(0);
    // 前 3 个成员头像叠放，其余折叠为 +N
    expect(within(section).getByText('+1')).toBeTruthy();
  });

  it('renders tenant teams even when the current user is not the team owner', async () => {
    const user = userEvent.setup();
    stubGalleryFetch([team]);
    renderGallery({
      id: 'user-2',
      username: 'member',
      tenant_id: 'tenant_demo',
      role: 'member',
    });

    await user.click(await screen.findByRole('tab', { name: '团队对话' }));

    const section = await screen.findByRole('region', { name: '团队' });
    expect(within(section).getByText('增长团队')).toBeTruthy();
  });

  it('retries a failed team request when the teams tab is opened', async () => {
    const user = userEvent.setup();
    let teamRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/enterprise/teams')) {
        teamRequestCount += 1;
        if (teamRequestCount === 1) {
          return {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: async () => 'Bad Gateway',
          } as Response;
        }
        return jsonResponse([team]);
      }
      if (url.includes('/api/enterprise/agents')) return jsonResponse([]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGallery();

    await waitFor(() => expect(teamRequestCount).toBe(1));
    await user.click(await screen.findByRole('tab', { name: '团队对话' }));

    const section = await screen.findByRole('region', { name: '团队' });
    expect(await within(section).findByText('增长团队')).toBeTruthy();
    expect(teamRequestCount).toBe(2);
  });

  it('opens the persistent team group in the chat app', async () => {
    const user = userEvent.setup();
    const fetchMock = stubGalleryFetch([team]);
    renderGallery();

    await user.click(await screen.findByRole('tab', { name: '团队对话' }));
    const section = await screen.findByRole('region', { name: '团队' });
    await user.click(within(section).getByText('增长团队'));

    expect((await screen.findByTestId('location')).textContent).toBe('/workspace/chat/session-tl-1');
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(postCall?.[0])).toContain('/api/enterprise/teams/team-1/tl/session');
  });

  it('does not render the team section on employee tabs', async () => {
    const user = userEvent.setup();
    stubGalleryFetch([team]);
    renderGallery();

    await screen.findByText('暂无数字员工');
    expect(screen.queryByRole('region', { name: '团队' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: '我的数字员工' }));
    expect(screen.queryByRole('region', { name: '团队' })).toBeNull();
  });

  it('shows the teams empty state when there are no teams', async () => {
    const user = userEvent.setup();
    stubGalleryFetch([]);
    renderGallery();

    await user.click(await screen.findByRole('tab', { name: '团队对话' }));

    expect(await screen.findByText('暂无团队')).toBeTruthy();
  });
});

describe('EmployeeGalleryPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders localized product chrome and accessibility names while preserving raw employee data in %s',
    async (locale) => {
      const copy = semanticGalleryCopy[locale];
      stubGalleryFetch([], [galleryAgent]);
      renderSemanticGallery(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(await screen.findByText(galleryAgent.name)).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.search })).toBeTruthy();
      expect(screen.getByRole('tablist', { name: copy.categories })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.all })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.mine })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.teams })).toBeTruthy();
      expect(screen.getByRole('tab', { name: copy.gallery })).toBeTruthy();
      expect(screen.getByText(copy.status)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.chat })).toBeTruthy();
      expect(screen.getByText('Raw gallery role')).toBeTruthy();
      expect(screen.getByText('Raw gallery description')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the team scope region and preserves team source content in %s',
    async (locale) => {
      const copy = semanticGalleryCopy[locale];
      const user = userEvent.setup();
      stubGalleryFetch([team]);
      renderSemanticGallery(locale);

      await user.click(await screen.findByRole('tab', { name: copy.teams }));
      const section = await screen.findByRole('region', { name: copy.teamSection });
      expect(within(section).getByText(team.name)).toBeTruthy();
      expect(within(section).getByText(team.description || '')).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'renders a localized empty state when the user has no visible employees in %s',
    async (locale) => {
      const copy = semanticGalleryCopy[locale];
      stubGalleryFetch([]);
      renderSemanticGallery(locale, {
        id: 'member-1',
        tenant_id: 'tenant_demo',
        username: 'member',
        role: 'member',
      });

      expect(await screen.findByText(copy.empty)).toBeTruthy();
      expect(screen.queryByText(galleryAgent.name)).toBeNull();
    },
  );
});

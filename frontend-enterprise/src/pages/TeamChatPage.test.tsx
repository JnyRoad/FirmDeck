// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

import TeamChatPage from './TeamChatPage';

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

/** Render the compatibility redirect with no legacy locale observer in the tree. */
function renderTeamChatWithAppLocale(
  locale: AppLocale,
  initialEntry: string,
  routePath = '/enterprise/teams/:teamId/chat',
) {
  return render(
    <AppIntlProvider locale={locale}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path={routePath} element={<TeamChatPage />} />
          <Route path="/workspace/chat/:sessionId" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TeamChatPage legacy redirect', () => {
  it('opens the persistent team group in the chat app', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ session_id: 'session-team-1' }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AppIntlProvider locale="zh-CN">
        <MemoryRouter initialEntries={['/enterprise/teams/team-1/chat']}>
          <Routes>
            <Route path="/enterprise/teams/:teamId/chat" element={<TeamChatPage />} />
            <Route path="/workspace/chat/:sessionId" element={<LocationEcho />} />
          </Routes>
        </MemoryRouter>
      </AppIntlProvider>,
    );

    expect((await screen.findByTestId('location')).textContent).toBe(
      '/workspace/chat/session-team-1',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/teams/team-1/tl/session');
  });
});

describe('TeamChatPage semantic locale states', () => {
  it.each([
    { locale: 'zh-CN', loading: '正在进入团队群聊…' },
    { locale: 'en-US', loading: 'Opening the team conversation…' },
  ] as const)('localizes the loading state in $locale', ({ locale, loading }) => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    renderTeamChatWithAppLocale(locale, '/enterprise/teams/team-1/chat');

    expect(screen.getByText(loading)).toBeTruthy();
  });

  it.each([
    { locale: 'zh-CN', error: '团队不存在' },
    { locale: 'en-US', error: 'Team not found' },
  ] as const)('localizes the missing-team error in $locale', async ({ locale, error }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderTeamChatWithAppLocale(locale, '/enterprise/teams/chat', '*');

    expect(await screen.findByText(error)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

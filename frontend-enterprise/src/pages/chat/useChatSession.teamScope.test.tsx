// @vitest-environment jsdom

import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseAuthSession } from '@/auth';
import { TenantSessionProvider } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';
import {
  persistSharedAgentScope,
  sessionFilterStorageKey,
} from '@/lib/agent-scope-storage';
import { tenantUserStorageKey } from '@/lib/tenant-storage';
import type { ChatSession } from '@/types';

import { useChatSession } from './useChatSession';

const AUTH_STORAGE_KEY = 'ultrarag_auth';

const tenantSession: EnterpriseAuthSession = {
  token: 'token-1',
  scope: 'tenant',
  tenant: {
    id: 'tenant_demo',
    slug: 'demo-lab',
    display_name: 'Demo Lab',
  },
  user: {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'demo',
    display_name: 'Demo Operator',
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

const teamSession: ChatSession = {
  id: 'session-team-1',
  tenant_id: 'tenant_demo',
  status: 'active',
  team_id: 'team-1',
  team_name: '增长团队',
  title: '团队 增长团队 · TL 对话',
  session_kind: 'team_tl',
  updated_at: '2026-08-01T00:00:00Z',
};

const employeeSession: ChatSession = {
  id: 'session-emp-1',
  tenant_id: 'tenant_demo',
  agent_id: 'agent-1',
  status: 'active',
  updated_at: '2026-08-01T00:00:00Z',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function stubChatFetch(sessions: ChatSession[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    if (url.includes('/api/auth/me')) return jsonResponse(tenantSession.user);
    if (url.includes('/api/chat/sessions/session-team-1?')) {
      return jsonResponse(sessionById.get('session-team-1') || teamSession);
    }
    if (url.includes('/api/chat/sessions/session-emp-1?')) {
      return jsonResponse(sessionById.get('session-emp-1') || employeeSession);
    }
    if (url.includes('/api/chat/sessions?')) return jsonResponse(sessions);
    if (url.includes('/api/chat/')) return jsonResponse([]);
    if (url.includes('/api/enterprise/')) return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LocationProbe() {
  /** Expose the router path so hook tests can assert redirects without relying on browser globals. */
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderChatSession(
  initialPath: string,
  options: Parameters<typeof useChatSession>[0] = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nProvider>
        <TenantSessionProvider session={tenantSession}>
          <MemoryRouter initialEntries={[initialPath]}>
            <LocationProbe />
            <Routes>
              <Route path="/workspace/chat/:sessionId" element={<>{children}</>} />
              <Route path="/workspace/chat" element={<>{children}</>} />
            </Routes>
          </MemoryRouter>
        </TenantSessionProvider>
      </I18nProvider>
  );
  return renderHook(() => useChatSession(options), { wrapper });
}

beforeEach(() => {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantSession));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useChatSession team scope', () => {
  it('keeps a team TL session in chat based on its stable session kind', async () => {
    const renamedTlSession: ChatSession = {
      ...teamSession,
      title: '与增长团队对话',
      session_kind: 'team_tl',
    };
    stubChatFetch([renamedTlSession, employeeSession]);
    const { result } = renderChatSession('/workspace/chat/session-team-1');

    await waitFor(() => {
      expect(result.current.currentSession?.title).toBe('与增长团队对话');
      expect(screen.getByTestId('location').textContent).toBe('/workspace/chat/session-team-1');
    });
  });

  it('redirects an untyped team session even when its legacy title resembles a TL chat', async () => {
    const untypedTeamSession: ChatSession = {
      ...teamSession,
      session_kind: undefined,
    };
    stubChatFetch([untypedTeamSession, employeeSession]);
    const { result } = renderChatSession('/workspace/chat/session-team-1');

    await waitFor(() => {
      expect(result.current.currentSession?.title).toBe('团队 增长团队 · TL 对话');
      expect(screen.getByTestId('location').textContent).toBe('/enterprise/teams/team-1');
    });
  });

  it('syncs the shared scope for an active team group', async () => {
    persistSharedAgentScope('agent-1', 'tenant_demo', 'user-1');
    stubChatFetch([teamSession, employeeSession]);
    renderChatSession('/workspace/chat/session-team-1');

    await waitFor(() => {
      expect(window.localStorage.getItem(
        tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
      )).toBe('team:team-1');
    });
  });

  it('keeps the employee scope for regular employee sessions', async () => {
    persistSharedAgentScope('agent-1', 'tenant_demo', 'user-1');
    stubChatFetch([teamSession, employeeSession]);
    renderChatSession('/workspace/chat/session-emp-1');

    await waitFor(() => {
      expect(window.localStorage.getItem(
        tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
      )).toBe('agent-1');
    });
    // 给员工会话留足同步窗口，确认不会被误写成团队作用域。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.localStorage.getItem(
      tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
    )).toBe('agent-1');
  });

  it('replaces the previous team scope when opening an employee private chat', async () => {
    persistSharedAgentScope('team:team-1', 'tenant_demo', 'user-1');
    stubChatFetch([teamSession, employeeSession]);
    renderChatSession('/workspace/chat/session-emp-1');

    await waitFor(() => {
      expect(window.localStorage.getItem(
        tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
      )).toBe('agent-1');
    });
  });

  it('keeps a manual session-list filter separate from the active chat scope', async () => {
    persistSharedAgentScope('agent-1', 'tenant_demo', 'user-1');
    stubChatFetch([teamSession, employeeSession]);
    const { result } = renderChatSession('/workspace/chat/session-emp-1');

    await waitFor(() => {
      expect(result.current.auth?.tenant.id).toBe('tenant_demo');
      expect(result.current.sessionsLoading).toBe(false);
    });
    act(() => result.current.setSessionAgentFilter('team:team-1'));

    await waitFor(() => {
      expect(result.current.sessionAgentFilter).toBe('team:team-1');
      expect(window.localStorage.getItem(sessionFilterStorageKey('tenant_demo', 'user-1')))
        .toBe('team:team-1');
    });
    expect(window.localStorage.getItem(
      tenantUserStorageKey('tenant_demo', 'user-1', 'selected-agent'),
    )).toBe('agent-1');
  });

  it('filters the unified session list to a selected team group', async () => {
    persistSharedAgentScope('team:team-1', 'tenant_demo', 'user-1');
    window.localStorage.setItem(sessionFilterStorageKey('tenant_demo', 'user-1'), 'team:team-1');
    stubChatFetch([teamSession, employeeSession]);
    const { result } = renderChatSession('/workspace/chat');

    await waitFor(() => {
      expect(result.current.auth?.tenant.id).toBe('tenant_demo');
      expect(result.current.sessionsLoading).toBe(false);
    });
    expect(result.current.visibleSidebarSessions.map((session) => session.id)).toEqual(['session-team-1']);
  });

  it('keeps polling messages after a team leader turn hands work to members', async () => {
    vi.useFakeTimers();
    const fetchMock = stubChatFetch([teamSession, employeeSession]);
    renderChatSession('/workspace/chat/session-team-1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const messageRequestCount = () => fetchMock.mock.calls.filter(([input]) => (
      String(input).includes('/api/chat/sessions/session-team-1/messages?')
    )).length;
    expect(messageRequestCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(messageRequestCount()).toBeGreaterThan(1);
  });
});

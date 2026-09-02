// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import { TenantSessionProvider } from '@/contexts/TenantSessionContext';
import type { EnterpriseAuthSession } from '@/auth';
import type { AgentProfileRead } from '@/types';

import AgentsPage from './AgentsPage';

const session: EnterpriseAuthSession = {
  token: 'tenant-b-token',
  scope: 'tenant',
  tenant: { id: 'tenant_b', slug: 'tenant-b', display_name: 'Tenant B' },
  user: {
    id: 'user-b',
    tenant_id: 'tenant_b',
    username: 'admin',
    display_name: 'Tenant B admin',
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

const agent: AgentProfileRead = {
  id: 'agent-b',
  tenant_id: 'tenant_b',
  name: 'Tenant B employee',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('tenant-bound account and employee pages', () => {
  it('derives employee requests from the verified tenant instead of the build-time tenant', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) return jsonResponse(session.user);
      if (url.includes('/api/enterprise/agents')) return jsonResponse([agent]);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AppIntlProvider initialLocale="zh-CN">
        <TenantSessionProvider session={session}>
          <MemoryRouter>
            <AgentsPage currentUser={session.user} />
          </MemoryRouter>
        </TenantSessionProvider>
      </AppIntlProvider>,
    );

    expect(await screen.findByText('Tenant B employee')).toBeTruthy();
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/enterprise/agents'));
      expect(request).toBeTruthy();
      expect(String(request?.[0])).toContain('tenant_id=tenant_b');
      expect(String(request?.[0])).not.toContain('tenant_demo');
      expect((request?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-b-token');
    });
  });
});

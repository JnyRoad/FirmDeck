// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import { TenantSessionProvider } from '@/contexts/TenantSessionContext';
import type { EnterpriseAuthSession } from '@/auth';
import type { AgentProfileRead } from '@/types';

import EmployeeAvatarEditor from './EmployeeAvatarEditor';
import EmployeeProfileEditor from './EmployeeProfileEditor';

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

function stubEditorFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/me')) return jsonResponse(session.user);
    if (url.includes('/api/enterprise/agents/agent-b')) return jsonResponse(agent);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderWithVerifiedTenant(children: React.ReactNode) {
  render(
    <AppIntlProvider initialLocale="zh-CN">
      <TenantSessionProvider session={session}>
        {children}
      </TenantSessionProvider>
    </AppIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('tenant-bound employee editors', () => {
  it('saves avatar metadata through the verified tenant client', async () => {
    const user = userEvent.setup();
    const fetchMock = stubEditorFetch();
    renderWithVerifiedTenant(
      <EmployeeAvatarEditor agent={agent} open onClose={vi.fn()} />,
    );

    await user.click(await screen.findByRole('button', { name: '保存头像' }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([input, init]) => (
        String(input).includes('/api/enterprise/agents/agent-b')
        && init?.method === 'PUT'
      ));
      expect(request).toBeTruthy();
      expect(String(request?.[0])).toContain('tenant_id=tenant_b');
      expect(String(request?.[0])).not.toContain('tenant_demo');
      expect((request?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-b-token');
      expect(JSON.parse(String(request?.[1]?.body)).tenant_id).toBe('tenant_b');
    });
  });

  it('saves profile edits through the verified tenant client', async () => {
    const user = userEvent.setup();
    const fetchMock = stubEditorFetch();
    renderWithVerifiedTenant(
      <EmployeeProfileEditor agent={agent} open onClose={vi.fn()} />,
    );

    const nameInput = await screen.findByDisplayValue('Tenant B employee');
    await user.clear(nameInput);
    await user.type(nameInput, 'Tenant B updated');
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([input, init]) => (
        String(input).includes('/api/enterprise/agents/agent-b')
        && init?.method === 'PUT'
      ));
      expect(request).toBeTruthy();
      expect(String(request?.[0])).toContain('tenant_id=tenant_b');
      expect((request?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-b-token');
      const body = JSON.parse(String(request?.[1]?.body));
      expect(body.tenant_id).toBe('tenant_b');
      expect(body.name).toBe('Tenant B updated');
    });
  });
});

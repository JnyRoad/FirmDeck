// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';

import { ScheduledTaskEditPage } from './ScheduledTaskEditorPage';

const scheduledTaskTestState = vi.hoisted(() => ({
  get: vi.fn(),
}));

const context: TenantSessionContextValue = {
  tenantId: 'tenant_demo',
  tenantSlug: 'tenant-demo',
  userId: 'user-1',
  generation: 1,
  signal: new AbortController().signal,
  session: {
    token: 'test-token',
    scope: 'tenant',
    tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Demo tenant' },
    user: { id: 'user-1', tenant_id: 'tenant_demo', username: 'admin', role: 'admin' },
  },
  isCurrentGeneration: () => true,
};

vi.mock('../../contexts/TenantSessionContext', () => ({
  useTenantSession: () => context,
}));

vi.mock('../../api/tenant-client', () => ({
  createTenantClient: () => ({
    get: scheduledTaskTestState.get,
  }),
}));

vi.mock('../../lib/agent-scope-storage', () => ({
  isTeamScope: () => false,
  persistSharedAgentScope: vi.fn(),
  readEmployeeScope: () => 'agent-1',
}));

afterEach(() => {
  cleanup();
  scheduledTaskTestState.get.mockReset();
});

describe('ScheduledTaskEditorPage stale requests', () => {
  it('clears task loading when an employee scope change invalidates the active edit request', async () => {
    scheduledTaskTestState.get.mockImplementation((path: string) => {
      if (path.includes('/scheduled-tasks/task-1')) return new Promise(() => {});
      return Promise.resolve([]);
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/enterprise/scheduled-tasks/task-1/edit']}>
          <Routes>
            <Route path="/enterprise/scheduled-tasks/:taskId/edit" element={<ScheduledTaskEditPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', {
        detail: { agentId: 'agent-2' },
      }));
    });

    expect(screen.getByRole('button', { name: '保存' }).closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
  });
});

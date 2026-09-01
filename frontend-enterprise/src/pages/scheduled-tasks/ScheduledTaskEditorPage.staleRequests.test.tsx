// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';
import type { ScheduledTaskRead } from '@/types';

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
  isCurrentGeneration: (generation: number) => generation === 1,
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
  it('clears the previous tenant task form before the next generation loads', async () => {
    const previousTask: ScheduledTaskRead = {
      id: 'task-1',
      tenant_id: 'tenant_demo',
      agent_id: 'agent-1',
      created_by_user_id: 'user-1',
      title: '旧租户任务',
      prompt: '旧租户提示',
      description: '旧租户备注',
      schedule_type: 'daily',
      schedule: { time: '08:30' },
      timezone: 'UTC',
      status: 'active',
      concurrency_policy: 'forbid',
      misfire_policy: 'coalesce',
      run_count: 0,
      metadata: { sop_id: 'old-sop' },
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    };
    const nextTask = new Promise<ScheduledTaskRead>(() => {});
    let taskRequestCount = 0;
    scheduledTaskTestState.get.mockImplementation((path: string) => {
      if (path.includes('/scheduled-tasks/task-1')) {
        taskRequestCount += 1;
        return taskRequestCount === 1 ? Promise.resolve(previousTask) : nextTask;
      }
      return Promise.resolve([]);
    });
    const view = render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/enterprise/scheduled-tasks/task-1/edit']}>
          <Routes>
            <Route path="/enterprise/scheduled-tasks/:taskId/edit" element={<ScheduledTaskEditPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await screen.findByDisplayValue('旧租户任务');
    expect(screen.getByDisplayValue('旧租户提示')).toBeTruthy();
    expect(screen.getByDisplayValue('旧租户备注')).toBeTruthy();

    context.generation = 2;
    context.isCurrentGeneration = (generation: number) => generation === 2;
    view.rerender(
      <I18nProvider>
        <MemoryRouter initialEntries={['/enterprise/scheduled-tasks/task-1/edit']}>
          <Routes>
            <Route path="/enterprise/scheduled-tasks/:taskId/edit" element={<ScheduledTaskEditPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.queryByDisplayValue('旧租户任务')).toBeNull();
    expect(screen.queryByDisplayValue('旧租户提示')).toBeNull();
    expect(screen.queryByDisplayValue('旧租户备注')).toBeNull();
  });

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

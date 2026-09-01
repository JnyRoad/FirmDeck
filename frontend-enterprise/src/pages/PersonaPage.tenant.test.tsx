// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n';

const tenantContextMock = vi.hoisted(() => {
  const controller = new AbortController();
  return {
    context: {
      session: {
        token: 'tenant-demo-token',
        scope: 'tenant' as const,
        tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Tenant Demo' },
        user: {
          id: 'user-1',
          tenant_id: 'tenant_demo',
          username: 'demo',
          display_name: 'Demo',
          role: 'admin' as const,
          must_change_password: false,
          avatar_url: null,
        },
      },
      tenantId: 'tenant_demo',
      tenantSlug: 'tenant-demo',
      userId: 'user-1',
      generation: 1,
      signal: controller.signal,
      isCurrentGeneration: (generation: number) => generation === 1,
    },
  };
});

const personaMocks = vi.hoisted(() => {
  const overall = {
    id: 'agent-overall',
    tenant_id: 'tenant_demo',
    name: 'Overall A',
    description: 'A overall description',
    persona_prompt: '',
    is_overall: true,
    status: 'active',
    metadata: {},
    resources: [],
    created_at: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-29T00:00:00Z',
  };
  const employee = {
    id: 'agent-b',
    tenant_id: 'tenant_demo',
    name: 'Employee B',
    description: 'B employee description',
    persona_prompt: 'B local persona',
    is_overall: false,
    status: 'active',
    metadata: {},
    resources: [],
    created_at: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-29T00:00:00Z',
  };
  let personaCallCount = 0;
  let resolveStalePersona: ((value: unknown) => void) | null = null;
  let resolveAgentPut: ((value: unknown) => void) | null = null;
  const stalePersona = new Promise<unknown>((resolve) => {
    resolveStalePersona = resolve;
  });
  const agentPut = new Promise<unknown>((resolve) => {
    resolveAgentPut = resolve;
  });
  const client = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/enterprise/agents') return [overall, employee];
      if (path === '/api/enterprise/persona') {
        personaCallCount += 1;
        if (personaCallCount === 1) {
          return { system_prompt: 'Initial persona', updated_at: '2026-08-29T00:00:00Z' };
        }
        return stalePersona;
      }
      return {};
    }),
    put: vi.fn(async (path: string) => {
      if (path.startsWith('/api/enterprise/agents/')) return agentPut;
      return { system_prompt: 'Saved A', updated_at: '2026-08-31T00:00:00Z' };
    }),
  };
  return {
    client,
    getPersonaCallCount: () => personaCallCount,
    resolveStalePersona: (value: unknown) => resolveStalePersona?.(value),
    resolveAgentPut: (value: unknown) => resolveAgentPut?.(value),
  };
});

vi.mock('../contexts/TenantSessionContext', () => ({
  useTenantSession: () => tenantContextMock.context,
}));

vi.mock('../api/tenant-client', () => ({
  createTenantClient: () => personaMocks.client,
}));

import PersonaPage from './PersonaPage';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('PersonaPage tenant scope fencing', () => {
  it('does not publish an overall save response after the employee scope changes', async () => {
    const user = userEvent.setup();
    render(
      <AppIntlProvider locale="zh-CN">
        <PersonaPage />
      </AppIntlProvider>,
    );

    await waitFor(() => expect(personaMocks.getPersonaCallCount()).toBeGreaterThanOrEqual(2));
    personaMocks.resolveStalePersona({
      system_prompt: 'A persona',
      updated_at: '2026-08-30T00:00:00Z',
    });
    await screen.findByDisplayValue('A persona');
    await user.click(screen.getByRole('button', { name: '保存' }));

    window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', {
      detail: { agentId: 'agent-b' },
    }));
    expect(await screen.findByDisplayValue('B local persona')).toBeTruthy();

    personaMocks.resolveAgentPut({
      id: 'agent-overall',
      tenant_id: 'tenant_demo',
      name: 'Overall A',
      description: 'A overall description',
      persona_prompt: 'A persona',
      is_overall: true,
      status: 'active',
      metadata: {},
      resources: [],
      created_at: '2026-08-29T00:00:00Z',
      updated_at: '2026-08-31T00:00:00Z',
    });

    await waitFor(() => expect(screen.getByDisplayValue('B local persona')).toBeTruthy());
    expect(screen.getByDisplayValue('Employee B')).toBeTruthy();
    expect(personaMocks.client.put).toHaveBeenCalledTimes(1);
  });

  it('does not let a previous overall-persona response overwrite the newly selected employee', async () => {
    render(
      <AppIntlProvider locale="zh-CN">
        <PersonaPage />
      </AppIntlProvider>,
    );

    await waitFor(() => expect(personaMocks.getPersonaCallCount()).toBeGreaterThanOrEqual(2));
    window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', {
      detail: { agentId: 'agent-b' },
    }));

    expect(await screen.findByDisplayValue('B local persona')).toBeTruthy();
    personaMocks.resolveStalePersona({
      system_prompt: 'A stale response',
      updated_at: '2026-08-31T00:00:00Z',
    });

    await waitFor(() => expect(screen.getByDisplayValue('B local persona')).toBeTruthy());
    expect(screen.queryByDisplayValue('A stale response')).toBeNull();
    expect(screen.getByDisplayValue('Employee B')).toBeTruthy();
  });
});

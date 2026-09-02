// @vitest-environment jsdom

import type { ReactNode } from 'react';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import type { AgentProfileRead } from '@/types';
import OpenPlatformPage from './OpenPlatformPage';

const openPlatformTestState = vi.hoisted(() => ({
  context: null as TenantSessionContextValue | null,
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('../contexts/TenantSessionContext', () => ({
  useTenantSession: () => openPlatformTestState.context,
}));

vi.mock('../api/tenant-client', () => ({
  createTenantClient: vi.fn(() => ({
    get: openPlatformTestState.get,
    post: openPlatformTestState.post,
    delete: openPlatformTestState.delete,
  })),
}));

vi.mock('@/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui')>('@/components/ui');
  return {
    ...actual,
    notify: {
      error: openPlatformTestState.notifyError,
      warning: openPlatformTestState.notifyWarning,
      success: openPlatformTestState.notifySuccess,
    },
  };
});

vi.mock('@/components/AppHeader', () => ({
  default: () => <header data-testid="open-platform-header" />,
}));

vi.mock('@/components/openPlatform', () => ({
  PlatformCategoryPanel: ({ loading, children }: { loading: boolean; children?: ReactNode }) => (
    <div data-testid="platform-panel" data-loading={String(loading)}>{children}</div>
  ),
  PlatformEmployeeCard: ({ onOpen }: { onOpen?: () => void }) => <button type="button" onClick={onOpen}>open agent</button>,
  PlatformEmployeeDrawer: ({ onUse }: { onUse?: () => void }) => <button type="button" onClick={onUse}>use agent</button>,
  PlatformKindDetailView: () => null,
  PlatformResourceCard: () => null,
  PlatformResourceDrawer: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '员工',
  description: '描述',
  is_overall: false,
  status: 'active',
  metadata: { published_to_gallery: true },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function makeContext(): TenantSessionContextValue {
  return {
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'user-1',
    generation: 1,
    signal: new AbortController().signal,
    session: {
      token: 'test-token',
      scope: 'tenant',
      tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Demo tenant' },
      user: {
        id: 'user-1',
        tenant_id: 'tenant_demo',
        username: 'admin',
        role: 'admin',
      },
    },
    isCurrentGeneration: () => true,
  };
}

afterEach(() => {
  cleanup();
  openPlatformTestState.context = null;
  openPlatformTestState.get.mockReset();
  openPlatformTestState.post.mockReset();
  openPlatformTestState.delete.mockReset();
  openPlatformTestState.notifyError.mockReset();
  openPlatformTestState.notifyWarning.mockReset();
  openPlatformTestState.notifySuccess.mockReset();
});

describe('OpenPlatformPage stale requests', () => {
  it('does not toast or clear loading when the initial request rejects after a tenant switch', async () => {
    const context = makeContext();
    openPlatformTestState.context = context;
    const request = deferred<AgentProfileRead[]>();
    openPlatformTestState.get.mockImplementation((path: string) => {
      if (path === '/api/enterprise/agents') return request.promise;
      return Promise.resolve([]);
    });

    render(
      <I18nProvider>
        <MemoryRouter>
          <OpenPlatformPage isAdmin currentUser={context.session.user} />
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() => expect(openPlatformTestState.get).toHaveBeenCalledWith('/api/enterprise/agents'));
    expect(screen.getByTestId('platform-panel').getAttribute('data-loading')).toBe('true');

    context.isCurrentGeneration = () => false;
    await act(async () => {
      request.reject(new DOMException('tenant changed', 'AbortError'));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(openPlatformTestState.notifyError).not.toHaveBeenCalled();
    expect(screen.getByTestId('platform-panel').getAttribute('data-loading')).toBe('true');

    // Keep the deferred contract explicit so this test cannot accidentally
    // leave an in-flight request if the implementation changes its fence.
    request.resolve([agent]);
  });

  it('uses the request-start generation when an agent use request rejects', async () => {
    const context = makeContext();
    context.isCurrentGeneration = (generation) => generation === context.generation;
    openPlatformTestState.context = context;
    openPlatformTestState.get.mockImplementation((path: string) => (
      path === '/api/enterprise/agents' ? Promise.resolve([agent]) : Promise.resolve([])
    ));
    const request = deferred<AgentProfileRead>();
    openPlatformTestState.post.mockReturnValue(request.promise);
    const user = userEvent.setup();

    render(
      <I18nProvider>
        <MemoryRouter>
          <OpenPlatformPage isAdmin currentUser={context.session.user} />
        </MemoryRouter>
      </I18nProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'open agent' }));
    await user.click(screen.getByRole('button', { name: 'use agent' }));
    context.generation = 2;
    await act(async () => {
      request.reject(new DOMException('tenant changed', 'AbortError'));
    });

    expect(openPlatformTestState.notifyError).not.toHaveBeenCalled();
  });
});

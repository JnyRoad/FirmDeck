// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_BASE } from '../api/client';
import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';

const TENANT_CONTEXT_MODULE_PATH = './TenantSessionContext';

type TenantAuthSessionFixture = {
  token: string;
  scope: 'tenant';
  tenant: {
    id: string;
    slug: string;
    display_name: string;
  };
  user: {
    id: string;
    tenant_id: string;
    username: string;
    display_name: string | null;
    role: 'admin' | 'member';
    must_change_password: boolean;
    avatar_url: string | null;
  };
};

type TenantSessionContextValue = {
  session: TenantAuthSessionFixture;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  generation: number;
  signal: AbortSignal;
  isCurrentGeneration(generation: number): boolean;
};

type TenantSessionVerificationState = {
  status: 'idle' | 'verifying' | 'ready' | 'invalid' | 'error';
  error: 'network' | 'server' | 'malformed-response' | null;
  retry(): void;
};

type TenantSessionContextModule = {
  TenantSessionProvider: (props: {
    session: TenantAuthSessionFixture | null;
    children: ReactNode;
    onInvalidSession?: () => void;
  }) => JSX.Element;
  useTenantSession: () => TenantSessionContextValue | null;
  useTenantSessionVerification: () => TenantSessionVerificationState;
};

const sessionA: TenantAuthSessionFixture = {
  token: 'tenant-token-a',
  scope: 'tenant',
  tenant: {
    id: 'tenant-a',
    slug: 'alpha-lab',
    display_name: 'Alpha Lab',
  },
  user: {
    id: 'tenant-a-admin',
    tenant_id: 'tenant-a',
    username: 'admin',
    display_name: 'Alpha Operator',
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

const sessionB: TenantAuthSessionFixture = {
  token: 'tenant-token-b',
  scope: 'tenant',
  tenant: {
    id: 'tenant-b',
    slug: 'beta-lab',
    display_name: 'Beta Lab',
  },
  user: {
    id: 'tenant-b-admin',
    tenant_id: 'tenant-b',
    username: 'admin',
    display_name: 'Beta Operator',
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadTenantContext(): Promise<TenantSessionContextModule> {
  try {
    const module = await import(/* @vite-ignore */ TENANT_CONTEXT_MODULE_PATH) as unknown as TenantSessionContextModule;
    expect(typeof module.TenantSessionProvider).toBe('function');
    expect(typeof module.useTenantSession).toBe('function');
    expect(typeof module.useTenantSessionVerification).toBe('function');
    return module;
  } catch (error) {
    throw new Error(`T032 must implement ${TENANT_CONTEXT_MODULE_PATH}: ${String(error)}`);
  }
}

function ContextProbe({
  context,
  onValue,
  onVerification,
}: {
  context: TenantSessionContextModule;
  onValue: (value: TenantSessionContextValue | null) => void;
  onVerification?: (value: TenantSessionVerificationState) => void;
}) {
  const value = context.useTenantSession();
  const verification = context.useTenantSessionVerification();
  onValue(value);
  onVerification?.(verification);
  return <output data-testid="tenant-context">{value?.tenantId || 'not-ready'}</output>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('verified tenant session context', () => {
  it('is unavailable and does not probe the server before a tenant session is supplied', async () => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>();
    const observed: Array<TenantSessionContextValue | null> = [];
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={null}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );

    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');
    expect(observed[observed.length - 1]).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes only the server-verified tenant identity and context metadata', async () => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${API_BASE}/api/auth/me`);
      expect(init?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer tenant-token-a',
      }));
      return jsonResponse(sessionA.user);
    });
    const observed: Array<TenantSessionContextValue | null> = [];
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );

    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');
    await waitFor(() => expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-a'));

    const value = observed.find((candidate) => candidate?.tenantId === 'tenant-a');
    expect(value).toMatchObject({
      session: sessionA,
      tenantId: 'tenant-a',
      tenantSlug: 'alpha-lab',
      userId: 'tenant-a-admin',
      generation: expect.any(Number),
    });
    expect(value?.signal).toBeInstanceOf(AbortSignal);
    expect(value?.isCurrentGeneration(value?.generation ?? -1)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the shared configured API base when verifying the bearer', async () => {
    vi.resetModules();
    vi.doMock('../api/client', async () => {
      const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
      return { ...actual, API_BASE: '/configured-api' };
    });
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(sessionA.user));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA}>
        <ContextProbe context={context} onValue={() => {}} />
      </context.TenantSessionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/configured-api/api/auth/me');
    vi.doUnmock('../api/client');
    vi.resetModules();
  });

  it('rejects and clears a persisted session when /me returns a different tenant identity', async () => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      ...sessionA.user,
      tenant_id: 'tenant-b',
    }));
    const observed: Array<TenantSessionContextValue | null> = [];
    const onInvalidSession = vi.fn();
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(sessionA));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA} onInvalidSession={onInvalidSession}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );

    await waitFor(() => expect(onInvalidSession).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');
    expect(observed.some((candidate) => candidate?.tenantId === 'tenant-a')).toBe(false);
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the old root signal and invalidates its generation while a replacement is verified', async () => {
    const context = await loadTenantContext();
    const verificationA = deferred<Response>();
    const verificationB = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(verificationA.promise)
      .mockReturnValueOnce(verificationB.promise);
    const observed: Array<TenantSessionContextValue | null> = [];
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <context.TenantSessionProvider session={sessionA}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );
    verificationA.resolve(jsonResponse(sessionA.user));
    await waitFor(() => expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-a'));
    const oldValue = observed.find((candidate) => candidate?.tenantId === 'tenant-a');
    expect(oldValue).toBeTruthy();

    view.rerender(
      <context.TenantSessionProvider session={sessionB}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );

    expect(oldValue?.signal.aborted).toBe(true);
    expect(oldValue?.isCurrentGeneration(oldValue?.generation ?? -1)).toBe(false);
    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');

    verificationB.resolve(jsonResponse(sessionB.user));
    await waitFor(() => expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-b'));
    const newValue = observed.find((candidate) => candidate?.tenantId === 'tenant-b');
    expect(newValue?.generation).not.toBe(oldValue?.generation);
    expect(newValue?.signal.aborted).toBe(false);
    expect(newValue?.isCurrentGeneration(newValue?.generation ?? -1)).toBe(true);
  });

  it('ignores a late verification response from the replaced tenant generation', async () => {
    const context = await loadTenantContext();
    const verificationA = deferred<Response>();
    const verificationB = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(verificationA.promise)
      .mockReturnValueOnce(verificationB.promise);
    const observed: Array<TenantSessionContextValue | null> = [];
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <context.TenantSessionProvider session={sessionA}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );
    view.rerender(
      <context.TenantSessionProvider session={sessionB}>
        <ContextProbe context={context} onValue={(value) => observed.push(value)} />
      </context.TenantSessionProvider>,
    );

    verificationB.resolve(jsonResponse(sessionB.user));
    await waitFor(() => expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-b'));
    verificationA.resolve(jsonResponse(sessionA.user));

    await waitFor(() => {
      expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-b');
    });
    expect(observed.filter((candidate) => candidate?.tenantId === 'tenant-a')).toHaveLength(0);
    expect(observed[observed.length - 1]?.tenantId).toBe('tenant-b');
  });

  it('preserves the session after a transient network failure and retries explicitly', async () => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(jsonResponse(sessionA.user));
    const onInvalidSession = vi.fn();
    let latestVerification: TenantSessionVerificationState | undefined;
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(sessionA));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA} onInvalidSession={onInvalidSession}>
        <ContextProbe
          context={context}
          onValue={() => {}}
          onVerification={(value) => { latestVerification = value; }}
        />
      </context.TenantSessionProvider>,
    );

    await waitFor(() => expect(latestVerification).toMatchObject({
      status: 'error',
      error: 'network',
    }));
    expect(onInvalidSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).not.toBeNull();
    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');

    latestVerification?.retry();
    await waitFor(() => expect(screen.getByTestId('tenant-context').textContent).toBe('tenant-a'));
    expect(latestVerification).toMatchObject({ status: 'ready', error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onInvalidSession).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'a server failure', response: jsonResponse({ detail: 'busy' }, 503), error: 'server' },
    {
      name: 'a malformed response',
      response: {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => { throw new SyntaxError('invalid json'); },
        text: async () => 'not-json',
      } as unknown as Response,
      error: 'malformed-response',
    },
  ])('does not invalidate the session after $name', async ({ response, error }) => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    const onInvalidSession = vi.fn();
    let latestVerification: TenantSessionVerificationState | undefined;
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(sessionA));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA} onInvalidSession={onInvalidSession}>
        <ContextProbe
          context={context}
          onValue={() => {}}
          onVerification={(value) => { latestVerification = value; }}
        />
      </context.TenantSessionProvider>,
    );

    await waitFor(() => expect(latestVerification).toMatchObject({ status: 'error', error }));
    expect(onInvalidSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).not.toBeNull();
    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');
  });

  it.each([401, 403])('invalidates the session for an authentication response %s', async (status) => {
    const context = await loadTenantContext();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ detail: 'denied' }, status));
    const onInvalidSession = vi.fn();
    let latestVerification: TenantSessionVerificationState | undefined;
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(sessionA));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <context.TenantSessionProvider session={sessionA} onInvalidSession={onInvalidSession}>
        <ContextProbe
          context={context}
          onValue={() => {}}
          onVerification={(value) => { latestVerification = value; }}
        />
      </context.TenantSessionProvider>,
    );

    await waitFor(() => expect(onInvalidSession).toHaveBeenCalledTimes(1));
    expect(latestVerification).toMatchObject({ status: 'invalid', error: null });
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('tenant-context').textContent).toBe('not-ready');
  });
});

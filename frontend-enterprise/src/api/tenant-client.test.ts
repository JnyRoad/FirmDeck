// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const TENANT_CLIENT_MODULE_PATH = './tenant-client';

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

type TenantClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestInit): Promise<T>;
  delete<T>(path: string, body?: unknown, options?: RequestInit): Promise<T>;
};

type TenantClientModule = {
  createTenantClient(context: TenantSessionContextValue | null): TenantClient;
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeContext(
  overrides: Partial<TenantSessionContextValue> = {},
): TenantSessionContextValue {
  const controller = new AbortController();
  return {
    session: sessionA,
    tenantId: 'tenant-a',
    tenantSlug: 'alpha-lab',
    userId: 'tenant-a-admin',
    generation: 7,
    signal: controller.signal,
    isCurrentGeneration: (generation) => generation === 7,
    ...overrides,
  };
}

async function loadTenantClient(): Promise<TenantClientModule> {
  try {
    const module = await import(/* @vite-ignore */ TENANT_CLIENT_MODULE_PATH) as unknown as TenantClientModule;
    expect(typeof module.createTenantClient).toBe('function');
    return module;
  } catch (error) {
    throw new Error(`T032 must implement ${TENANT_CLIENT_MODULE_PATH}: ${String(error)}`);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verified tenant client', () => {
  it('refuses a tenant request before a verified tenant context exists and does not fetch', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(Promise.resolve().then(() => {
      const client = module.createTenantClient(null);
      return client.get('/api/enterprise/agents');
    })).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('injects the verified tenant id and bearer into a context-bound request', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());

    await client.post('/api/enterprise/agents', { name: 'A' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), window.location.origin);
    expect(requestUrl.pathname).toBe('/api/enterprise/agents');
    expect(requestUrl.searchParams.get('tenant_id')).toBe('tenant-a');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer tenant-token-a',
      'Content-Type': 'application/json',
    }));
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'A',
      tenant_id: 'tenant-a',
    });
  });

  it('injects the verified tenant id into a GET query without dropping caller filters', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());

    await client.get('/api/enterprise/agents?status=active');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(input), window.location.origin);
    expect(parsed.pathname).toBe('/api/enterprise/agents');
    expect(parsed.searchParams.get('status')).toBe('active');
    expect(parsed.searchParams.get('tenant_id')).toBe('tenant-a');
    expect(String(input)).not.toContain('tenant_demo');
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer tenant-token-a',
    }));
  });

  it('rejects a caller tenant mismatch before the request is sent', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());

    await expect(client.post('/api/enterprise/agents', {
      name: 'cross-tenant',
      tenant_id: 'tenant-b',
    })).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched tenant_id already present in a GET query before fetch', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());

    await expect(client.get('/api/enterprise/agents?tenant_id=tenant-b&status=active'))
      .rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates tenant query identity for every method and injects it into DELETE requests', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());

    await client.delete('/api/enterprise/agents/agent-a');

    const [input] = fetchMock.mock.calls[0];
    const parsed = new URL(String(input), window.location.origin);
    expect(parsed.searchParams.get('tenant_id')).toBe('tenant-a');

    await expect(client.post('/api/enterprise/agents?tenant_id=tenant-b', { name: 'wrong' }))
      .rejects.toBeTruthy();
    await expect(client.put('/api/enterprise/agents/agent-a?tenant_id=tenant-b', { name: 'wrong' }))
      .rejects.toBeTruthy();
    await expect(client.delete('/api/enterprise/agents/agent-a?tenant_id=tenant-b'))
      .rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('copies FormData before injecting the authoritative tenant id', async () => {
    const module = await loadTenantClient();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext());
    const original = new FormData();
    original.append('files', new File(['tenant A'], 'a.txt', { type: 'text/plain' }));

    await client.post('/api/chat/attachments', original);

    expect(original.get('tenant_id')).toBeNull();
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(requestBody).toBeInstanceOf(FormData);
    expect((requestBody as FormData).get('tenant_id')).toBe('tenant-a');
  });

  it('rejects a response that resolves after the context generation has been replaced', async () => {
    const module = await loadTenantClient();
    const controller = new AbortController();
    let currentGeneration = 7;
    const fetchResponse = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(async () => fetchResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext({
      signal: controller.signal,
      isCurrentGeneration: (generation) => generation === currentGeneration,
    }));
    const pending = client.get<{ tenant_id: string; value: string }>('/api/enterprise/agents');

    currentGeneration = 8;
    controller.abort();
    fetchResponse.resolve(jsonResponse({ tenant_id: 'tenant-a', value: 'stale' }));

    await expect(pending).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a late response when generation changes even if the scope signal is not aborted', async () => {
    const module = await loadTenantClient();
    const controller = new AbortController();
    let currentGeneration = 7;
    const fetchResponse = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(async () => fetchResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    const client = module.createTenantClient(makeContext({
      signal: controller.signal,
      isCurrentGeneration: (generation) => generation === currentGeneration,
    }));
    const pending = client.get<{ tenant_id: string; value: string }>('/api/enterprise/agents');

    currentGeneration = 8;
    fetchResponse.resolve(jsonResponse({ tenant_id: 'tenant-a', value: 'stale-with-live-scope' }));

    await expect(pending).rejects.toBeTruthy();
    expect(controller.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';

const SYSTEM_CLIENT_MODULE_PATH = './system-client';
const SYSTEM_AUTH_MODULE_PATH = '../system-auth';
const systemAdmin = {
  id: 'sysadmin-root',
  username: 'root',
  display_name: 'System Operator',
  status: 'active',
  must_change_password: false,
  last_login_at: null,
  created_at: '2026-08-31T00:00:00Z',
};

type ProvisionInput = {
  slug: string;
  display_name: string;
  initial_admin: {
    username: string;
    display_name?: string | null;
    temporary_password: string;
  };
};

type SystemClient = {
  login(input: { username: string; password: string }): Promise<unknown>;
  me(): Promise<unknown>;
  listTenants(input?: {
    query?: string;
    status?: 'active' | 'suspended';
    cursor?: string;
    limit?: number;
  }): Promise<unknown>;
  getTenant(tenantId: string): Promise<unknown>;
  provisionTenant(input: ProvisionInput): Promise<unknown>;
  renameTenant(tenantId: string, input: { display_name: string }): Promise<unknown>;
  resetInitialAdminPassword(
    tenantId: string,
    input: { temporary_password: string },
  ): Promise<unknown>;
  suspendTenant(tenantId: string, input: { reason: string }): Promise<unknown>;
  reactivateTenant(tenantId: string): Promise<unknown>;
  listTenantAudit(
    tenantId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<unknown>;
  getCodexA2ARuntimeStatus(): Promise<unknown>;
  changePassword(input: { current_password: string; new_password: string }): Promise<unknown>;
  getPasswordPolicies(): Promise<unknown>;
  updatePasswordPolicies(input: unknown): Promise<unknown>;
  getTenantPasswordPolicy(tenantId: string): Promise<unknown>;
  updateTenantPasswordPolicy(tenantId: string, input: unknown): Promise<unknown>;
};

const tenantDetail = {
  id: 'tenant-alpha',
  slug: 'alpha-lab',
  display_name: 'Alpha Lab',
  status: 'active',
  lifecycle_version: 1,
  initial_admin: null,
  suspended_at: null,
  reactivated_at: null,
  suspension_reason: null,
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
};

const auditPage = {
  items: [{
    id: 'audit-1',
    actor_system_admin_id: 'sysadmin-root',
    actor_label: 'root',
    action: 'tenant.rename',
    target_type: 'tenant',
    target_id: 'tenant-alpha',
    result: 'succeeded',
    reason_code: 'SYSTEM_TENANT_RENAMED',
    operator_reason: null,
    status_before: 'active',
    status_after: 'active',
    lifecycle_version: 1,
    request_id: 'request-1',
    trace_id: 'trace-1',
    safe_params: { display_name_changed: true },
    created_at: '2026-08-31T00:01:00Z',
  }],
  next_cursor: null,
};

const runtimeStatus = {
  key: 'codex_a2a',
  enabled: true,
  credential_configured: true,
  command: 'codex',
  workspace_root: '/srv/staffdeck/codex-runtime',
  timeout_seconds: 45,
};

async function loadClient(): Promise<SystemClient> {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_CLIENT_MODULE_PATH) as {
      systemClient?: SystemClient;
    };
    expect(module.systemClient).toBeTruthy();
    return module.systemClient!;
  } catch (error) {
    throw new Error(`T022 must implement ${SYSTEM_CLIENT_MODULE_PATH}: ${String(error)}`);
  }
}

async function seedSystemSession(): Promise<void> {
  const module = await import(/* @vite-ignore */ SYSTEM_AUTH_MODULE_PATH) as {
    setSystemAuthSession(session: unknown): void;
  };
  module.setSystemAuthSession({
    token: 'system-token',
    scope: 'system',
    system_admin: {
      id: 'sysadmin-root',
      username: 'root',
      display_name: 'System Operator',
      status: 'active',
      must_change_password: false,
      last_login_at: null,
      created_at: '2026-08-31T00:00:00Z',
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? 'Conflict' : status === 401 ? 'Unauthorized' : 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('system client HTTP contract', () => {
  it('uses the system bearer for password replacement and policy endpoints only', async () => {
    await seedSystemSession();
    const policies = {
      system: { min_length: 8, max_length: 20, complexity_enabled: true, require_uppercase: true, require_lowercase: true, require_digit: true, require_special: false },
      tenant_default: { min_length: 8, max_length: 20, complexity_enabled: false, require_uppercase: false, require_lowercase: false, require_digit: false, require_special: false },
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('tenant-alpha/password-policy')) return jsonResponse({ mode: 'inherit', custom: null, effective: policies.tenant_default });
      if (url.includes('change-password')) return jsonResponse({ token: 'replacement-token', scope: 'system', system_admin: systemAdmin });
      return jsonResponse(policies);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    await client.changePassword({ current_password: 'Current-2026', new_password: 'New-password-2026' });
    await client.getPasswordPolicies();
    await client.updatePasswordPolicies(policies);
    await client.getTenantPasswordPolicy('tenant-alpha');
    await client.updateTenantPasswordPolicy('tenant-alpha', { mode: 'inherit' });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/system/auth/change-password',
      '/api/system/password-policies',
      '/api/system/password-policies',
      '/api/system/tenants/tenant-alpha/password-policy',
      '/api/system/tenants/tenant-alpha/password-policy',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer system-token' });
      expect(String(init?.body || '')).not.toContain('tenant_id');
    }
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ current_password: 'Current-2026', new_password: 'New-password-2026' }) });
  });
  it('login sends only system credentials without authorization or tenant identity', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'tenant-token',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      token: 'system-token',
      scope: 'system',
      system_admin: systemAdmin,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    await client.login({ username: 'root', password: 'system-secret' });

    expect(fetchMock).toHaveBeenCalledWith('/api/system/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'root', password: 'system-secret' }),
    }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toMatchObject({ Authorization: expect.any(String) });
    expect(init.body).not.toContain('tenant_id');
  });

  it('uses only the system bearer for every protected method when a tenant session also exists', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'tenant-token',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    }));
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/system/auth/me') return jsonResponse(systemAdmin);
      if (url === '/api/system/tenants' && init?.method === 'POST') {
        return jsonResponse(tenantDetail, 201);
      }
      if (url === '/api/system/tenants') {
        return jsonResponse({ items: [tenantDetail], next_cursor: null });
      }
      return jsonResponse(tenantDetail);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    await client.me();
    await client.listTenants();
    await client.getTenant('tenant-alpha');
    await client.provisionTenant({
      slug: 'alpha-lab',
      display_name: 'Alpha Lab',
      initial_admin: { username: 'admin', temporary_password: 'Temporary-secret-2026' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer system-token',
      }));
    }
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('tenant-token');
  });

  it('serializes only supported tenant control filters', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ items: [], next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    await client.listTenants({
      query: 'Alpha & Beta',
      status: 'active',
      cursor: 'cursor/value',
      limit: 50,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    const parsed = new URL(url, 'https://staffdeck.test');
    expect(parsed.pathname).toBe('/api/system/tenants');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      query: 'Alpha & Beta',
      status: 'active',
      cursor: 'cursor/value',
      limit: '50',
    });
    expect(url).not.toContain('tenant_id');

    await client.listTenants({ query: '', cursor: '', limit: 0 });
    await client.listTenants({ query: '   ', cursor: '', limit: 101 });
    await client.listTenants({ limit: Number.NaN });
    for (const [input] of fetchMock.mock.calls.slice(1)) {
      const filtered = new URL(String(input), 'https://staffdeck.test');
      expect([...filtered.searchParams]).toEqual([]);
    }
  });

  it('gets detail and posts the exact OpenAPI provision payload without implicit tenant fields', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(tenantDetail));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();
    const payload: ProvisionInput = {
      slug: 'alpha-lab',
      display_name: 'Alpha Lab',
      initial_admin: {
        username: 'admin',
        display_name: 'Alpha Operator',
        temporary_password: 'Temporary-secret-2026',
      },
    };

    await client.getTenant('tenant alpha/id');
    await client.provisionTenant(payload);

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/system/tenants/tenant%20alpha%2Fid');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/system/tenants');
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(init.body).not.toContain('tenant_id');
  });

  it('fails every protected method closed before fetch when no valid system session exists', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'tenant-token',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    const protectedCalls = [
      () => client.me(),
      () => client.listTenants(),
      () => client.getTenant('tenant-alpha'),
      () => client.provisionTenant({
        slug: 'alpha-lab',
        display_name: 'Alpha Lab',
        initial_admin: { username: 'admin', temporary_password: 'Temporary-secret-2026' },
      }),
    ];
    for (const call of protectedCalls) {
      await expect(call()).rejects.toThrow('System authentication required');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves safe status and code while keeping raw response out of Error.message', async () => {
    await seedSystemSession();
    const raw = 'raw-sql-conflict-secret';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({
      detail: {
        type: 'about:blank',
        title: 'SYSTEM_CONTROL_CONFLICT',
        status: 409,
        code: 'SYSTEM_CONTROL_CONFLICT',
        message_key: 'errors.system.controlConflict',
        params: {},
        retryable: false,
        raw,
      },
    }, 409)));
    const client = await loadClient();

    const error = await client.provisionTenant({
      slug: 'alpha-lab',
      display_name: 'Alpha Lab',
      initial_admin: { username: 'admin', temporary_password: 'Temporary-secret-2026' },
    }).catch((caught: unknown) => caught) as Error & { status?: number; code?: string; body?: string };

    expect(error.status).toBe(409);
    expect(error.code).toBe('SYSTEM_CONTROL_CONFLICT');
    expect(error.message).not.toContain(raw);
    expect(error.message).not.toContain('Temporary-secret-2026');
  });

  it('drops task identifiers and sensitive error params from both params and message', async () => {
    await seedSystemSession();
    const sensitiveParams = {
      task: 'private-task',
      task_id: 'task-123',
      password: 'password-secret',
      secret: 'secret-value',
      token: 'token-secret',
      credential: 'credential-secret',
      hash: 'hash-secret',
      prompt: 'private-prompt',
      conversation: 'private-conversation',
      artifact: 'private-artifact',
      raw: 'raw-upstream-body',
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({
      code: 'SYSTEM_CONTROL_CONFLICT',
      params: {
        safe_reason: 'tenant-is-active',
        retryable: false,
        ...sensitiveParams,
      },
      message: 'upstream details must not cross the system-client boundary',
    }, 409)));
    const client = await loadClient();

    const error = await client.provisionTenant({
      slug: 'alpha-lab',
      display_name: 'Alpha Lab',
      initial_admin: { username: 'admin', temporary_password: 'Temporary-secret-2026' },
    }).catch((caught: unknown) => caught) as Error & {
      status?: number;
      code?: string;
      params?: Record<string, unknown>;
    };

    expect(error.status).toBe(409);
    expect(error.code).toBe('SYSTEM_CONTROL_CONFLICT');
    expect(error.params).toEqual({ safe_reason: 'tenant-is-active', retryable: false });
    for (const [key, value] of Object.entries(sensitiveParams)) {
      expect(error.params).not.toHaveProperty(key);
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain(value);
    }
  });

  it('renames a tenant with an encoded immutable id and exact display-name patch', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(tenantDetail));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    expect(client.renameTenant).toEqual(expect.any(Function));
    await client.renameTenant('tenant alpha/id', { display_name: 'Alpha Renamed' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/tenants/tenant%20alpha%2Fid',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Alpha Renamed' }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init.body).not.toContain('slug');
    expect(init.body).not.toContain('tenant_id');
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer system-token' }));
  });

  it('resets the initial admin temporary password through a non-echo 204 operation', async () => {
    await seedSystemSession();
    const response = {
      ok: true,
      status: 204,
      statusText: 'No Content',
      text: async () => '',
    } as Response;
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();
    const temporaryPassword = 'Reset-secret-2026';

    expect(client.resetInitialAdminPassword).toEqual(expect.any(Function));
    const result = await client.resetInitialAdminPassword(
      'tenant-alpha',
      { temporary_password: temporaryPassword },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/tenants/tenant-alpha/initial-admin/temporary-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ temporary_password: temporaryPassword }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(temporaryPassword);
    expect(JSON.stringify(fetchMock.mock.results)).not.toContain(temporaryPassword);
  });

  it('posts exact suspend and reactivate lifecycle operations without caller tenant identity', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async (input) => jsonResponse({
      ...tenantDetail,
      status: String(input).endsWith('/suspend') ? 'suspended' : 'active',
      lifecycle_version: 2,
      suspension_reason: String(input).endsWith('/suspend') ? 'billing hold' : null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    await client.suspendTenant('tenant alpha/id', { reason: 'billing hold' });
    await client.reactivateTenant('tenant alpha/id');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/system/tenants/tenant%20alpha%2Fid/suspend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'billing hold' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/tenants/tenant%20alpha%2Fid/reactivate',
      expect.objectContaining({ method: 'POST' }),
    );
    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain('tenant_id');
    expect(serialized).not.toContain('tenant-token');
  });

  it('does not coerce an unknown tenant status into active', async () => {
    await seedSystemSession();
    const unknownTenant = { ...tenantDetail, status: 'pending' };
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(unknownTenant));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    const detailOutcome = await client.getTenant('tenant-alpha').then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const detailStatus = detailOutcome.kind === 'value'
      ? (detailOutcome.value as { status?: unknown }).status
      : undefined;
    expect(
      detailOutcome.kind === 'error' || !['active', 'suspended'].includes(String(detailStatus)),
    ).toBe(true);
  });

  it('does not coerce an unknown audit result into succeeded', async () => {
    await seedSystemSession();
    const unknownAudit = { ...auditPage.items[0], result: 'timed_out' };
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      items: [unknownAudit],
      next_cursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    const auditOutcome = await client.listTenantAudit('tenant-alpha').then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const auditResult = auditOutcome.kind === 'value'
      ? (auditOutcome.value as { items?: Array<{ result?: unknown }> }).items?.[0]?.result
      : undefined;
    expect(
      auditOutcome.kind === 'error' || !['succeeded', 'rejected', 'failed'].includes(String(auditResult)),
    ).toBe(true);
  });

  it('lists tenant audit with bounded cursor parameters and no caller tenant query field', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(auditPage));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    expect(client.listTenantAudit).toEqual(expect.any(Function));
    await client.listTenantAudit('tenant alpha/id', { cursor: 'cursor/value', limit: 50 });

    const url = String(fetchMock.mock.calls[0][0]);
    const parsed = new URL(url, 'https://staffdeck.test');
    expect(parsed.pathname).toBe('/api/system/tenants/tenant%20alpha%2Fid/audit');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      cursor: 'cursor/value',
      limit: '50',
    });
    expect(url).not.toContain('tenant_id=');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer system-token' }),
    );
  });

  it('reads system Codex A2A runtime status through a dedicated path without tenant identity', async () => {
    await seedSystemSession();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(runtimeStatus));
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    expect(client.getCodexA2ARuntimeStatus).toEqual(expect.any(Function));
    const status = await client.getCodexA2ARuntimeStatus();

    expect(status).toEqual(runtimeStatus);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/runtimes/codex-a2a',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer system-token' }),
      }),
    );
    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain('tenant_id');
    expect(serialized).not.toContain('tenant-token');
  });

  it('projects detail, audit, and runtime responses to safe control metadata only', async () => {
    await seedSystemSession();
    const forbidden = {
      password: 'password-secret',
      password_hash: 'hash-secret',
      token: 'token-secret',
      credential: 'credential-secret',
      prompt: 'private-prompt',
      conversation: 'private-conversation',
      artifact: 'private-artifact',
      task: 'private-task',
      task_id: 'task-123',
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/audit')) return jsonResponse({
        ...auditPage,
        items: auditPage.items.map((entry) => ({
          ...entry,
          ...forbidden,
          safe_params: {
            ...entry.safe_params,
            safe_label: 'retained',
            task: 'private-task',
            task_id: 'task-123',
            password: 'password-secret',
          },
        })),
      });
      if (url.endsWith('/codex-a2a')) return jsonResponse({ ...runtimeStatus, ...forbidden });
      return jsonResponse({ ...tenantDetail, ...forbidden });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = await loadClient();

    expect(client.listTenantAudit).toEqual(expect.any(Function));
    expect(client.getCodexA2ARuntimeStatus).toEqual(expect.any(Function));
    if (typeof client.listTenantAudit !== 'function'
      || typeof client.getCodexA2ARuntimeStatus !== 'function') return;
    const detail = await client.getTenant('tenant-alpha') as Record<string, unknown>;
    const audit = await client.listTenantAudit('tenant-alpha') as Record<string, unknown>;
    const runtime = await client.getCodexA2ARuntimeStatus() as Record<string, unknown>;
    const auditItems = Array.isArray(audit.items)
      ? audit.items as Record<string, unknown>[]
      : [];
    for (const projection of [detail, audit, runtime, ...auditItems]) {
      for (const key of Object.keys(forbidden)) expect(projection).not.toHaveProperty(key);
    }
    expect(auditItems[0]?.safe_params).toEqual({
      display_name_changed: true,
      safe_label: 'retained',
    });
  });

  it('keeps raw reset response and validation details out of the thrown error', async () => {
    await seedSystemSession();
    const temporaryPassword = 'Reset-secret-2026';
    const raw = `raw-reset-body-${temporaryPassword}`;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({
      detail: {
        code: 'VALIDATION_ERROR',
        params: { error_count: 1 },
        raw,
        temporary_password: temporaryPassword,
      },
    }, 400)));
    const client = await loadClient();

    expect(client.resetInitialAdminPassword).toEqual(expect.any(Function));
    if (typeof client.resetInitialAdminPassword !== 'function') return;
    const error = await client.resetInitialAdminPassword('tenant-alpha', {
      temporary_password: temporaryPassword,
    }).catch((caught: unknown) => caught) as Error & { status?: number; code?: string };
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).not.toContain(raw);
    expect(error.message).not.toContain(temporaryPassword);
  });
});

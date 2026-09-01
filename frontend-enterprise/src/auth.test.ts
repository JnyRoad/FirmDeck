// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  ENTERPRISE_AUTH_STORAGE_KEY,
  clearEnterpriseAuthSession,
  getEnterpriseAuthSession,
  setEnterpriseAuthSession,
} from './auth';

const SYSTEM_AUTH_MODULE_PATH = './system-auth';

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

const tenantSession: TenantAuthSessionFixture = {
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
    must_change_password: true,
    avatar_url: null,
  },
};

const systemSession = {
  token: 'system-token',
  scope: 'system' as const,
  system_admin: {
    id: 'sysadmin-root',
    username: 'root',
    display_name: 'System Operator',
    status: 'active' as const,
    must_change_password: false,
    last_login_at: null,
    created_at: '2026-08-31T00:00:00Z',
  },
};

type SystemAuthModule = {
  SYSTEM_AUTH_STORAGE_KEY: string;
  getSystemAuthSession(): unknown;
  setSystemAuthSession(session: unknown): void;
};

async function loadSystemAuth(): Promise<SystemAuthModule> {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_AUTH_MODULE_PATH) as SystemAuthModule;
    expect(typeof module.SYSTEM_AUTH_STORAGE_KEY).toBe('string');
    expect(typeof module.getSystemAuthSession).toBe('function');
    expect(typeof module.setSystemAuthSession).toBe('function');
    return module;
  } catch (error) {
    throw new Error(`T022 must implement ${SYSTEM_AUTH_MODULE_PATH}: ${String(error)}`);
  }
}

afterEach(() => {
  clearEnterpriseAuthSession();
  window.localStorage.clear();
});

describe('tenant auth session', () => {
  it('persists the complete server-derived tenant session without dropping scope, tenant metadata, or password policy', () => {
    setEnterpriseAuthSession(
      tenantSession as unknown as Parameters<typeof setEnterpriseAuthSession>[0],
    );

    expect(getEnterpriseAuthSession()).toEqual(tenantSession);
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(tenantSession);
  });

  it.each([
    { ...tenantSession, scope: 'system' },
    { ...tenantSession, scope: undefined },
    { ...tenantSession, tenant: undefined },
    { ...tenantSession, tenant: { ...tenantSession.tenant, id: '' } },
    { ...tenantSession, tenant: { ...tenantSession.tenant, slug: '' } },
    { ...tenantSession, tenant: { id: 'tenant-a', slug: 'alpha-lab' } },
    { ...tenantSession, user: { ...tenantSession.user, id: '' } },
    { ...tenantSession, user: { ...tenantSession.user, tenant_id: 'tenant-b' } },
    { ...tenantSession, user: { ...tenantSession.user, role: 'owner' } },
    { ...tenantSession, user: { ...tenantSession.user, must_change_password: 'yes' } },
    { ...tenantSession, token: '' },
  ] as const)('rejects wrong-scope, malformed, or tenant-free stored data %#', (stored) => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(stored));

    expect(getEnterpriseAuthSession()).toBeNull();
  });

  it('clears only the tenant session key', async () => {
    const systemAuth = await loadSystemAuth();
    systemAuth.setSystemAuthSession(systemSession);
    setEnterpriseAuthSession(
      tenantSession as unknown as Parameters<typeof setEnterpriseAuthSession>[0],
    );

    clearEnterpriseAuthSession();

    expect(getEnterpriseAuthSession()).toBeNull();
    expect(systemAuth.getSystemAuthSession()).toEqual(systemSession);
  });

  it('does not adopt an independent system session as a tenant session', async () => {
    const systemAuth = await loadSystemAuth();
    systemAuth.setSystemAuthSession(systemSession);

    expect(getEnterpriseAuthSession()).toBeNull();
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('keeps tenant and system storage independent while both sessions coexist', async () => {
    const systemAuth = await loadSystemAuth();
    systemAuth.setSystemAuthSession(systemSession);
    setEnterpriseAuthSession(
      tenantSession as unknown as Parameters<typeof setEnterpriseAuthSession>[0],
    );

    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).not.toBeNull();
    expect(systemAuth.getSystemAuthSession()).toEqual(systemSession);
    expect(systemAuth.SYSTEM_AUTH_STORAGE_KEY).not.toBe(ENTERPRISE_AUTH_STORAGE_KEY);
    expect(JSON.stringify(systemAuth.getSystemAuthSession())).not.toContain(tenantSession.tenant.id);
  });
});

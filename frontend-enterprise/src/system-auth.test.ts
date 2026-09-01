// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from './auth';

const SYSTEM_AUTH_MODULE_PATH = './system-auth';

type SystemAdminRead = {
  id: string;
  username: string;
  display_name?: string | null;
  status: 'active' | 'disabled';
  must_change_password: boolean;
  last_login_at?: string | null;
  created_at: string;
};

type SystemAuthSession = {
  token: string;
  scope: 'system';
  system_admin: SystemAdminRead;
};

type SystemAuthModule = {
  SYSTEM_AUTH_STORAGE_KEY: string;
  getSystemAuthSession(): SystemAuthSession | null;
  setSystemAuthSession(session: SystemAuthSession): void;
  clearSystemAuthSession(): void;
};

const session: SystemAuthSession = {
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
};

async function loadSystemAuth(): Promise<SystemAuthModule> {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_AUTH_MODULE_PATH) as SystemAuthModule;
    expect(typeof module.SYSTEM_AUTH_STORAGE_KEY).toBe('string');
    expect(typeof module.getSystemAuthSession).toBe('function');
    expect(typeof module.setSystemAuthSession).toBe('function');
    expect(typeof module.clearSystemAuthSession).toBe('function');
    return module;
  } catch (error) {
    throw new Error(`T022 must implement ${SYSTEM_AUTH_MODULE_PATH}: ${String(error)}`);
  }
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('system auth storage isolation', () => {
  it('persists and restores a strictly scoped system session under an independent key', async () => {
    const auth = await loadSystemAuth();

    expect(auth.SYSTEM_AUTH_STORAGE_KEY).not.toBe(ENTERPRISE_AUTH_STORAGE_KEY);
    auth.setSystemAuthSession(session);

    expect(JSON.parse(window.localStorage.getItem(auth.SYSTEM_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(session);
    expect(auth.getSystemAuthSession()).toEqual(session);
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('clears only the system session and preserves an unrelated tenant session', async () => {
    const auth = await loadSystemAuth();
    const tenantSession = {
      token: 'tenant-token',
      user: { id: 'tenant-user', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    };
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(tenantSession));
    auth.setSystemAuthSession(session);

    auth.clearSystemAuthSession();

    expect(auth.getSystemAuthSession()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(tenantSession);
  });

  it.each([
    { token: 'system-token', system_admin: session.system_admin },
    { ...session, scope: 'tenant' },
    { ...session, token: '' },
    { ...session, system_admin: { ...session.system_admin, id: '' } },
    { ...session, system_admin: { ...session.system_admin, username: '' } },
    { ...session, system_admin: { ...session.system_admin, must_change_password: 'false' } },
  ])('ignores malformed or wrong-scope stored data %#', async (stored) => {
    const auth = await loadSystemAuth();
    window.localStorage.setItem(auth.SYSTEM_AUTH_STORAGE_KEY, JSON.stringify(stored));

    expect(auth.getSystemAuthSession()).toBeNull();
  });

  it('never adopts a tenant session copied into the system key', async () => {
    const auth = await loadSystemAuth();
    window.localStorage.setItem(auth.SYSTEM_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'tenant-token',
      scope: 'tenant',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    }));

    expect(auth.getSystemAuthSession()).toBeNull();
  });

  it('does not derive any tenant identity from the tenant storage key', async () => {
    const auth = await loadSystemAuth();
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'tenant-token',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    }));
    auth.setSystemAuthSession(session);

    const restored = auth.getSystemAuthSession();
    expect(restored).toEqual(session);
    expect(restored).not.toHaveProperty('tenant_id');
    expect(restored?.system_admin).not.toHaveProperty('tenant_id');
  });

  it('does not let a storage write failure crash the system login flow', async () => {
    const auth = await loadSystemAuth();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage quota exceeded');
    });

    expect(() => auth.setSystemAuthSession(session)).not.toThrow();
  });
});

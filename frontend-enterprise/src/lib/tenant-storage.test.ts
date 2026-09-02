import { describe, expect, it } from 'vitest';

const TENANT_STORAGE_MODULE_PATH = './tenant-storage';

type TenantStorageModule = {
  tenantUserStorageKey?: (
    tenantId: unknown,
    userId: unknown,
    feature: unknown,
  ) => unknown;
};

/** Keep the RED suite collectible while T034's new module is still absent. */
async function loadTenantStorage(): Promise<TenantStorageModule> {
  try {
    return await import(/* @vite-ignore */ TENANT_STORAGE_MODULE_PATH) as TenantStorageModule;
  } catch (error) {
    throw new Error(`T034 must implement ${TENANT_STORAGE_MODULE_PATH}: ${String(error)}`);
  }
}

function storageKey(module: TenantStorageModule, tenantId: unknown, userId: unknown, feature: unknown): unknown {
  if (typeof module.tenantUserStorageKey !== 'function') {
    throw new Error('T034 must export tenantUserStorageKey');
  }
  try {
    return module.tenantUserStorageKey(tenantId, userId, feature);
  } catch {
    return undefined;
  }
}

describe('tenant/user browser storage namespace', () => {
  it('builds a stable key that changes with tenant, user, and feature identity', async () => {
    const module = await loadTenantStorage();
    const key = storageKey(module, 'tenant-a', 'user-a', 'selected-agent');

    expect(typeof key).toBe('string');
    expect(key).toBe(storageKey(module, 'tenant-a', 'user-a', 'selected-agent'));
    expect(key).not.toBe(storageKey(module, 'tenant-b', 'user-a', 'selected-agent'));
    expect(key).not.toBe(storageKey(module, 'tenant-a', 'user-b', 'selected-agent'));
    expect(key).not.toBe(storageKey(module, 'tenant-a', 'user-a', 'session-filter'));
  });

  it('does not collapse delimiter-bearing identities into a collision', async () => {
    const module = await loadTenantStorage();

    expect(storageKey(module, 'tenant:a', 'user', 'feature'))
      .not.toBe(storageKey(module, 'tenant', 'a:user', 'feature'));
    expect(storageKey(module, 'tenant', 'user:a', 'feature'))
      .not.toBe(storageKey(module, 'tenant', 'user', 'a:feature'));
  });

  it('preserves raw identifier identity instead of applying locale case folding', async () => {
    const module = await loadTenantStorage();
    const rawTenant = 'Tenant-Ä-中文';
    const rawUser = 'User-İ';

    expect(storageKey(module, rawTenant, rawUser, 'draft-cache'))
      .not.toBe(storageKey(module, rawTenant.toLocaleLowerCase('en-US'), rawUser.toLocaleLowerCase('tr-TR'), 'draft-cache'));
  });

  it.each([
    ['', 'user-a', 'selected-agent'],
    ['tenant-a', '', 'selected-agent'],
    ['   ', 'user-a', 'selected-agent'],
    ['tenant-a', '   ', 'selected-agent'],
    ['tenant-a', 'user-a', ''],
    [null, 'user-a', 'selected-agent'],
    ['tenant-a', null, 'selected-agent'],
  ] as const)('fails closed for malformed identity %j', async (tenantId, userId, feature) => {
    const module = await loadTenantStorage();

    expect(typeof storageKey(module, tenantId, userId, feature)).not.toBe('string');
  });

  it('never reuses the old unscoped business keys as a tenant/user key', async () => {
    const module = await loadTenantStorage();
    const scoped = storageKey(module, 'tenant-a', 'user-a', 'selected-agent');

    expect(scoped).not.toBe('ultrarag_enterprise_agent_scope');
    expect(scoped).not.toBe('skill_agent_session_filter:user-a');
    expect(scoped).not.toBe('skill_agent_session_read_at:user-a');
    expect(scoped).not.toBe('skill_agent_selected_model_config');
    expect(scoped).not.toBe('draft:agent-a');
  });

  it('keeps arbitrary user-owned cache entries isolated by the same namespace', async () => {
    const module = await loadTenantStorage();
    const cacheA = storageKey(module, 'tenant-a', 'user-a', 'chat-cache');
    const cacheB = storageKey(module, 'tenant-b', 'user-a', 'chat-cache');
    const cacheForAnotherUser = storageKey(module, 'tenant-a', 'user-b', 'chat-cache');
    const cache = new Map<string, string>();

    expect(typeof cacheA).toBe('string');
    expect(typeof cacheB).toBe('string');
    expect(typeof cacheForAnotherUser).toBe('string');
    cache.set(String(cacheA), 'tenant-a-result');

    expect(cache.get(String(cacheA))).toBe('tenant-a-result');
    expect(cache.get(String(cacheB))).toBeUndefined();
    expect(cache.get(String(cacheForAnotherUser))).toBeUndefined();
  });
});

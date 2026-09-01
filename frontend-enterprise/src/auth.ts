/**
 * Tenant-scoped authentication primitives.  A tenant session is a complete,
 * server-derived envelope; it never borrows identity from the system-admin
 * session or from a deployment-wide tenant constant.
 */
export type TenantSummary = {
  id: string;
  slug: string;
  display_name: string;
};

export type EnterpriseAuthUser = {
  id: string;
  tenant_id: string;
  username: string;
  /** Optional at the legacy component boundary; persisted sessions may store null. */
  display_name?: string | null;
  role: 'admin' | 'member';
  /** Optional at the legacy component boundary; persisted sessions require it. */
  must_change_password?: boolean;
  /** Optional at the legacy component boundary; persisted sessions may store null. */
  avatar_url?: string | null;
};

export type EnterpriseAuthSession = {
  token: string;
  scope: 'tenant';
  tenant: TenantSummary;
  user: EnterpriseAuthUser;
};

export const ENTERPRISE_AUTH_STORAGE_KEY = 'ultrarag_auth';

const TENANT_SUMMARY_KEYS = ['id', 'slug', 'display_name'] as const;
const TENANT_SESSION_KEYS = ['token', 'scope', 'tenant', 'user'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOnlyKnownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Validate and project the safe user fields retained in tenant storage. */
export function parseEnterpriseAuthUser(value: unknown): EnterpriseAuthUser | null {
  // UserRead may carry non-secret display metadata (source/timestamps or
  // channel projections).  Ignore those fields before persistence; only the
  // fields below participate in the authenticated tenant identity.
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.tenant_id)) return null;
  if (!nonEmptyString(value.username)) return null;
  if (!nullableString(value.display_name)) return null;
  if (value.role !== 'admin' && value.role !== 'member') return null;
  if (typeof value.must_change_password !== 'boolean') return null;
  if (!nullableString(value.avatar_url)) return null;

  return {
    id: value.id,
    tenant_id: value.tenant_id,
    username: value.username,
    display_name: value.display_name,
    role: value.role,
    must_change_password: value.must_change_password,
    avatar_url: value.avatar_url,
  };
}

function parseTenantSummary(value: unknown): TenantSummary | null {
  if (!isRecord(value) || !hasOnlyKnownKeys(value, TENANT_SUMMARY_KEYS)) return null;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.slug)) return null;
  if (!nonEmptyString(value.display_name)) return null;
  return { id: value.id, slug: value.slug, display_name: value.display_name };
}

/** Parse the exact persisted tenant session envelope, failing closed. */
export function parseEnterpriseAuthSession(value: unknown): EnterpriseAuthSession | null {
  if (!isRecord(value) || !hasOnlyKnownKeys(value, TENANT_SESSION_KEYS)) return null;
  if (!nonEmptyString(value.token) || value.scope !== 'tenant') return null;

  const tenant = parseTenantSummary(value.tenant);
  const user = parseEnterpriseAuthUser(value.user);
  if (!tenant || !user || user.tenant_id !== tenant.id) return null;

  return { token: value.token, scope: 'tenant', tenant, user };
}

export function isEnterpriseAuthSession(value: unknown): value is EnterpriseAuthSession {
  return parseEnterpriseAuthSession(value) !== null;
}

export function getEnterpriseAuthSession(): EnterpriseAuthSession | null {
  if (typeof window === 'undefined') return null;
  return readStoredSession(ENTERPRISE_AUTH_STORAGE_KEY);
}

export function setEnterpriseAuthSession(session: EnterpriseAuthSession): void {
  const normalized = parseEnterpriseAuthSession(session);
  if (!normalized) throw new TypeError('Invalid tenant authentication session');

  try {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // 头像只是资源指针，空间不足时可安全地降级为无头像会话再试一次。
    try {
      const minimal: EnterpriseAuthSession = {
        ...normalized,
        user: { ...normalized.user, avatar_url: null },
      };
      window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(minimal));
    } catch {
      // 抛出真实原因，避免登录流程把存储故障误报为账号/密码错误。
      throw new Error('浏览器存储空间不足，请清理站点数据后重试');
    }
  }
}

export function clearEnterpriseAuthSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ENTERPRISE_AUTH_STORAGE_KEY);
}

/** Return a bearer only from a valid tenant session, never from system auth. */
export function getEnterpriseAuthToken(): string | null {
  return getEnterpriseAuthSession()?.token || null;
}

function readStoredSession(key: string): EnterpriseAuthSession | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return parseEnterpriseAuthSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function isEnterpriseAdmin(user?: EnterpriseAuthUser | null): boolean {
  return user?.role === 'admin';
}

export function isGalleryEmployee(agent?: { metadata?: Record<string, unknown> } | null): boolean {
  return agent?.metadata?.published_to_gallery === true;
}

export function isEmployeeOwnedBy(
  agent: { metadata?: Record<string, unknown> },
  user?: EnterpriseAuthUser | null,
): boolean {
  if (!user) return false;
  const metadata = agent.metadata || {};
  const ownerUserId = metadata.owner_user_id;
  return ownerUserId === user.id;
}

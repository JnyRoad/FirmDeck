/**
 * Installation-scoped system administrator session.
 *
 * This module intentionally has no dependency on the tenant session module.  A
 * system session is a different security domain: it is stored under its own
 * key, has a different token audience, and never carries a tenant identity.
 */

export type SystemAdminStatus = 'active' | 'disabled';

export type SystemAdminRead = {
  id: string;
  username: string;
  display_name?: string | null;
  status: SystemAdminStatus;
  must_change_password: boolean;
  last_login_at?: string | null;
  created_at: string;
};

export type SystemAuthSession = {
  token: string;
  scope: 'system';
  system_admin: SystemAdminRead;
};

/** Deliberately distinct from the tenant `ultrarag_auth` storage key. */
export const SYSTEM_AUTH_STORAGE_KEY = 'ultrarag_system_auth';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Validate the exact safe shape returned by the system API.
 *
 * In particular, a tenant session copied into either storage key is rejected:
 * it lacks `scope: system` and `system_admin`, and tenant identity is never
 * inferred from another storage key.
 */
export function isSystemAuthSession(value: unknown): value is SystemAuthSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (candidate.scope !== 'system' || !isNonEmptyString(candidate.token)) return false;
  if (!hasOnlyKeys(candidate, ['token', 'scope', 'system_admin'])) return false;

  const admin = candidate.system_admin;
  if (!admin || typeof admin !== 'object' || Array.isArray(admin)) return false;
  const identity = admin as Record<string, unknown>;
  if (!hasOnlyKeys(identity, ['id', 'username', 'display_name', 'status', 'must_change_password', 'last_login_at', 'created_at'])) return false;
  if (!isNonEmptyString(identity.id) || !isNonEmptyString(identity.username)) return false;
  if (identity.status !== 'active' && identity.status !== 'disabled') return false;
  if (typeof identity.must_change_password !== 'boolean') return false;
  if (!isNonEmptyString(identity.created_at)) return false;
  if (!isOptionalNullableString(identity.display_name)) return false;
  if (!isOptionalNullableString(identity.last_login_at)) return false;

  // A system identity is intentionally tenant-free.  Reject accidental
  // cross-domain projections even when the remaining fields look valid.
  if ('tenant_id' in candidate || 'user' in candidate || 'tenant_id' in identity) return false;
  return true;
}

/** Read and strictly validate only the system storage key. */
export function getSystemAuthSession(): SystemAuthSession | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(SYSTEM_AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isSystemAuthSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist only a validated system session; the tenant key is never read or written. */
export function setSystemAuthSession(session: SystemAuthSession): void {
  if (!isSystemAuthSession(session)) {
    throw new TypeError('Invalid system authentication session');
  }
  window.localStorage.setItem(SYSTEM_AUTH_STORAGE_KEY, JSON.stringify(session));
}

/** Clear only the installation-scoped system session. */
export function clearSystemAuthSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SYSTEM_AUTH_STORAGE_KEY);
}

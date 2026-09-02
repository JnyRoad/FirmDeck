/**
 * Transport for the installation-scoped system control plane.
 *
 * This client is deliberately independent from the tenant API client.  It
 * resolves only the system bearer and never adds a tenant query/body field.
 */

import {
  getSystemAuthSession,
  isSystemAuthSession,
  type SystemAdminRead,
  type SystemAuthSession,
} from '../system-auth';
import {
  TENANT_STATUS,
  type TenantDisplayStatus,
  type TenantStatus,
} from '../enums/tenantStatus';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const SYSTEM_AUTH_REQUIRED_MESSAGE = 'System authentication required';
const GENERIC_SYSTEM_ERROR_MESSAGE = 'System control request failed. Please try again later.';
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const MAX_PARAM_KEYS = 24;
const MAX_PARAM_STRING_LENGTH = 256;

export type SystemTenantStatus = TenantDisplayStatus;

export type InitialTenantAdminSummary = {
  id: string;
  username: string;
  display_name?: string | null;
  role: 'admin';
};

export type InitialTenantAdminRead = InitialTenantAdminSummary & {
  must_change_password: boolean;
};

export type SystemTenantSummary = {
  id: string;
  slug: string;
  display_name: string;
  status: SystemTenantStatus;
  lifecycle_version: number;
  initial_admin: InitialTenantAdminSummary | null;
  suspended_at: string | null;
  reactivated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SystemTenantDetail = SystemTenantSummary & {
  suspension_reason: string | null;
};

export type SystemTenantProvisionDetail = Omit<SystemTenantDetail, 'initial_admin'> & {
  initial_admin: InitialTenantAdminRead | null;
};

export type SystemTenantPage = {
  items: SystemTenantSummary[];
  next_cursor: string | null;
};

export type SystemControlAuditResult = 'succeeded' | 'rejected' | 'failed' | 'unknown';

export type SystemControlAudit = {
  id: string;
  actor_system_admin_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: 'system_admin' | 'tenant';
  target_id: string | null;
  result: SystemControlAuditResult;
  reason_code: string;
  operator_reason: string | null;
  status_before: SystemTenantStatus | null;
  status_after: SystemTenantStatus | null;
  lifecycle_version: number | null;
  request_id: string | null;
  trace_id: string | null;
  safe_params: Record<string, string | number | boolean>;
  created_at: string;
};

export type SystemControlAuditPage = {
  items: SystemControlAudit[];
  next_cursor: string | null;
};

export type SystemRuntimeStatus = {
  key: 'codex_a2a';
  enabled: boolean;
  credential_configured: boolean;
  command: string;
  workspace_root: string;
  timeout_seconds: number;
};

export type SystemTenantListInput = {
  query?: string;
  status?: TenantStatus;
  cursor?: string;
  limit?: number;
};

export type SystemTenantRenameInput = {
  display_name: string;
};

export type TemporaryPasswordResetInput = {
  temporary_password: string;
};

export type SystemTenantSuspendInput = {
  reason: string;
};

export type SystemLoginInput = {
  username: string;
  password: string;
};

export type SystemPasswordChangeInput = {
  current_password: string;
  new_password: string;
};

export type PasswordPolicy = {
  min_length: number;
  max_length: number;
  complexity_enabled: boolean;
  require_uppercase: boolean;
  require_lowercase: boolean;
  require_digit: boolean;
  require_special: boolean;
};

export type SystemPasswordPolicies = { system: PasswordPolicy; tenant_default: PasswordPolicy };
export type TenantPasswordPolicy = { mode: 'inherit' | 'custom'; custom: PasswordPolicy | null; effective: PasswordPolicy };
export type TenantPasswordPolicyUpdate = { mode: 'inherit' | 'custom'; custom?: PasswordPolicy | null };

export type SystemTenantProvisionInput = {
  slug: string;
  display_name: string;
  initial_admin: {
    username: string;
    display_name?: string | null;
    temporary_password: string;
  };
};

type SafeErrorParams = Record<string, string | number | boolean>;

/** A machine-readable system API failure without exposing upstream text as the message. */
export class SystemApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly params: SafeErrorParams;

  constructor(status: number, code?: string, params: SafeErrorParams = {}) {
    super(GENERIC_SYSTEM_ERROR_MESSAGE);
    this.name = 'SystemApiError';
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export function isSystemApiError(error: unknown): error is SystemApiError {
  return error instanceof SystemApiError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : undefined;
}

/** Keep only bounded primitive params from the canonical error projection. */
function safeParams(value: unknown): SafeErrorParams {
  if (!isRecord(value)) return {};
  const result: SafeErrorParams = {};
  for (const [key, candidate] of Object.entries(value).slice(0, MAX_PARAM_KEYS)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (/(?:password|secret|token|credential|hash|prompt|conversation|artifact|task|raw)/i.test(key)) continue;
    if (typeof candidate === 'string') {
      if (candidate.length <= MAX_PARAM_STRING_LENGTH) result[key] = candidate;
    } else if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      result[key] = candidate;
    } else if (typeof candidate === 'boolean') {
      result[key] = candidate;
    }
  }
  return result;
}

/** Parse only the stable machine-readable fields; raw response text is discarded. */
function parseErrorProjection(text: string): { code?: string; params: SafeErrorParams } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { params: {} };
    const directCode = safeCode(parsed.code);
    if (directCode) return { code: directCode, params: safeParams(parsed.params) };
    if (isRecord(parsed.detail)) {
      const detailCode = safeCode(parsed.detail.code);
      if (detailCode) return { code: detailCode, params: safeParams(parsed.detail.params) };
    }
    if (typeof parsed.detail === 'string') {
      const detailCode = safeCode(parsed.detail);
      if (detailCode) return { code: detailCode, params: {} };
    }
  } catch {
    // A proxy/HTML error is intentionally represented by the generic error only.
  }
  return { params: {} };
}

function requireSystemToken(): string {
  const session = getSystemAuthSession();
  if (!session?.token) throw new Error(SYSTEM_AUTH_REQUIRED_MESSAGE);
  return session.token;
}

async function readResponse<T>(response: Response): Promise<T> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new SystemApiError(response.status || 502);
  }
  if (!response.ok) {
    const projection = parseErrorProjection(text);
    throw new SystemApiError(response.status, projection.code, projection.params);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SystemApiError(response.status || 502);
  }
}

async function login(input: SystemLoginInput): Promise<SystemAuthSession> {
  // Login is the only unauthenticated request in this client.  Do not inherit
  // a tenant bearer from another browser session.
  const response = await fetch(`${API_BASE}/api/system/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password }),
  });
  const session = await readResponse<SystemAuthSession>(response);
  // Do not allow a malformed or cross-domain login response to enter storage.
  if (!isSystemAuthSession(session)) throw new SystemApiError(502);
  return session;
}

async function protectedRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = requireSystemToken();
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    return readResponse<T>(response);
  } catch (error) {
    if (error instanceof SystemApiError) throw error;
    throw new SystemApiError(502);
  }
}

function listQuery(input: SystemTenantListInput = {}): string {
  const params = new URLSearchParams();
  if (typeof input.query === 'string' && input.query.trim()) {
    params.set('query', input.query.trim());
  }
  if (input.status === 'active' || input.status === 'suspended') {
    params.set('status', input.status);
  }
  if (typeof input.cursor === 'string' && input.cursor.trim()) {
    params.set('cursor', input.cursor.trim());
  }
  if (typeof input.limit === 'number'
    && Number.isInteger(input.limit)
    && Number.isFinite(input.limit)
    && input.limit >= 1
    && input.limit <= 100) {
    params.set('limit', String(input.limit));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function auditQuery(input: { cursor?: string; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (typeof input.cursor === 'string' && input.cursor.trim()) {
    params.set('cursor', input.cursor.trim());
  }
  if (typeof input.limit === 'number'
    && Number.isInteger(input.limit)
    && Number.isFinite(input.limit)
    && input.limit >= 1
    && input.limit <= 100) {
    params.set('limit', String(input.limit));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function safeString(value: unknown, maxLength = 512): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeNullableString(value: unknown, maxLength = 512): string | null {
  if (value == null) return null;
  const text = safeString(value, maxLength);
  return text || null;
}

function safePositiveInteger(value: unknown, fallback = 1): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 1
    ? value
    : fallback;
}

function safePositiveNumber(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeStatus(value: unknown): SystemTenantStatus {
  if (value === TENANT_STATUS.ACTIVE || value === TENANT_STATUS.SUSPENDED) return value;
  return TENANT_STATUS.UNKNOWN;
}

function projectInitialAdmin(value: unknown, includePasswordState: boolean):
  InitialTenantAdminSummary | (InitialTenantAdminRead & { must_change_password: boolean }) | null {
  if (!isRecord(value)) return null;
  const base = {
    id: safeString(value.id, 256),
    username: safeString(value.username, 120),
    ...(value.display_name !== undefined
      ? { display_name: safeNullableString(value.display_name, 120) }
      : {}),
    role: 'admin' as const,
  };
  if (!includePasswordState) return base;
  return {
    ...base,
    must_change_password: value.must_change_password === true,
  };
}

function projectTenantSummary(value: unknown): SystemTenantSummary {
  const candidate = isRecord(value) ? value : {};
  const initialAdmin = projectInitialAdmin(candidate.initial_admin, false) as InitialTenantAdminSummary | null;
  return {
    id: safeString(candidate.id, 256),
    slug: safeString(candidate.slug, 120),
    display_name: safeString(candidate.display_name, 120),
    status: safeStatus(candidate.status),
    lifecycle_version: safePositiveInteger(candidate.lifecycle_version),
    initial_admin: initialAdmin,
    suspended_at: safeNullableString(candidate.suspended_at, 80),
    reactivated_at: safeNullableString(candidate.reactivated_at, 80),
    created_at: safeString(candidate.created_at, 80),
    updated_at: safeString(candidate.updated_at, 80),
  };
}

function projectTenantDetail(value: unknown): SystemTenantDetail {
  const candidate = isRecord(value) ? value : {};
  return {
    ...projectTenantSummary(candidate),
    suspension_reason: safeNullableString(candidate.suspension_reason, 500),
  };
}

function projectTenantProvisionDetail(value: unknown): SystemTenantProvisionDetail {
  const candidate = isRecord(value) ? value : {};
  const summary = projectTenantDetail(candidate);
  const initialAdmin = projectInitialAdmin(candidate.initial_admin, true) as InitialTenantAdminRead | null;
  return { ...summary, initial_admin: initialAdmin };
}

function projectTenantPage(value: unknown): SystemTenantPage {
  const candidate = isRecord(value) ? value : {};
  return {
    items: Array.isArray(candidate.items) ? candidate.items.map(projectTenantSummary) : [],
    next_cursor: safeNullableString(candidate.next_cursor, 512),
  };
}

function projectSafeParams(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, candidate] of Object.entries(value).slice(0, MAX_PARAM_KEYS)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (/(?:password|secret|token|credential|hash|prompt|conversation|artifact|task|raw)/i.test(key)) continue;
    if (typeof candidate === 'string' && candidate.length <= MAX_PARAM_STRING_LENGTH) {
      result[key] = candidate;
    } else if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      result[key] = candidate;
    } else if (typeof candidate === 'boolean') {
      result[key] = candidate;
    }
  }
  return result;
}

function projectAudit(value: unknown): SystemControlAudit {
  const candidate = isRecord(value) ? value : {};
  const targetType = candidate.target_type === 'system_admin' ? 'system_admin' : 'tenant';
  const result: SystemControlAuditResult = candidate.result === 'succeeded'
    || candidate.result === 'rejected'
    || candidate.result === 'failed'
    ? candidate.result
    : 'unknown';
  const lifecycleVersion = candidate.lifecycle_version == null
    ? null
    : safePositiveInteger(candidate.lifecycle_version, 1);
  return {
    id: safeString(candidate.id, 256),
    actor_system_admin_id: safeNullableString(candidate.actor_system_admin_id, 256),
    actor_label: safeNullableString(candidate.actor_label, 120),
    action: safeString(candidate.action, 120),
    target_type: targetType,
    target_id: safeNullableString(candidate.target_id, 256),
    result,
    reason_code: safeString(candidate.reason_code, 120),
    operator_reason: safeNullableString(candidate.operator_reason, 500),
    status_before: candidate.status_before == null ? null : safeStatus(candidate.status_before),
    status_after: candidate.status_after == null ? null : safeStatus(candidate.status_after),
    lifecycle_version: lifecycleVersion,
    request_id: safeNullableString(candidate.request_id, 256),
    trace_id: safeNullableString(candidate.trace_id, 256),
    safe_params: projectSafeParams(candidate.safe_params),
    created_at: safeString(candidate.created_at, 80),
  };
}

function projectAuditPage(value: unknown): SystemControlAuditPage {
  const candidate = isRecord(value) ? value : {};
  return {
    items: Array.isArray(candidate.items) ? candidate.items.map(projectAudit) : [],
    next_cursor: safeNullableString(candidate.next_cursor, 512),
  };
}

function projectRuntimeStatus(value: unknown): SystemRuntimeStatus {
  const candidate = isRecord(value) ? value : {};
  return {
    key: 'codex_a2a',
    enabled: candidate.enabled === true,
    credential_configured: candidate.credential_configured === true,
    command: safeString(candidate.command, 120),
    workspace_root: safeString(candidate.workspace_root, 512),
    timeout_seconds: safePositiveNumber(candidate.timeout_seconds),
  };
}

/** Project a bounded policy object; malformed server fields cannot relax local form constraints. */
function projectPasswordPolicy(value: unknown): PasswordPolicy {
  const candidate = isRecord(value) ? value : {};
  const min = typeof candidate.min_length === 'number' && Number.isInteger(candidate.min_length)
    ? Math.min(20, Math.max(8, candidate.min_length)) : 8;
  const max = typeof candidate.max_length === 'number' && Number.isInteger(candidate.max_length)
    ? Math.min(20, Math.max(min, candidate.max_length)) : 20;
  return {
    min_length: min, max_length: max, complexity_enabled: candidate.complexity_enabled === true,
    require_uppercase: candidate.require_uppercase === true, require_lowercase: candidate.require_lowercase === true,
    require_digit: candidate.require_digit === true, require_special: candidate.require_special === true,
  };
}

/** Project both installation-scoped policies without carrying server extras into UI state. */
function projectSystemPasswordPolicies(value: unknown): SystemPasswordPolicies {
  const candidate = isRecord(value) ? value : {};
  return { system: projectPasswordPolicy(candidate.system), tenant_default: projectPasswordPolicy(candidate.tenant_default) };
}

/** Project the selected tenant's inheritance state and effective safe policy. */
function projectTenantPasswordPolicy(value: unknown): TenantPasswordPolicy {
  const candidate = isRecord(value) ? value : {};
  const custom = candidate.custom == null ? null : projectPasswordPolicy(candidate.custom);
  return { mode: candidate.mode === 'custom' ? 'custom' : 'inherit', custom, effective: projectPasswordPolicy(candidate.effective) };
}

export const systemClient = {
  login,
  me: () => protectedRequest<SystemAdminRead>('/api/system/auth/me'),
  changePassword: (input: SystemPasswordChangeInput): Promise<SystemAuthSession> => protectedRequest<SystemAuthSession>('/api/system/auth/change-password', {
    method: 'POST', body: JSON.stringify(input),
  }).then((session) => {
    if (!isSystemAuthSession(session)) throw new SystemApiError(502);
    return session;
  }),
  getPasswordPolicies: async (): Promise<SystemPasswordPolicies> => projectSystemPasswordPolicies(
    await protectedRequest<unknown>('/api/system/password-policies'),
  ),
  updatePasswordPolicies: async (input: SystemPasswordPolicies): Promise<SystemPasswordPolicies> => projectSystemPasswordPolicies(
    await protectedRequest<unknown>('/api/system/password-policies', { method: 'PUT', body: JSON.stringify(input) }),
  ),
  getTenantPasswordPolicy: async (tenantId: string): Promise<TenantPasswordPolicy> => projectTenantPasswordPolicy(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}/password-policy`),
  ),
  updateTenantPasswordPolicy: async (tenantId: string, input: TenantPasswordPolicyUpdate): Promise<TenantPasswordPolicy> => projectTenantPasswordPolicy(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}/password-policy`, { method: 'PUT', body: JSON.stringify(input) }),
  ),
  listTenants: async (input?: SystemTenantListInput): Promise<SystemTenantPage> => projectTenantPage(
    await protectedRequest<unknown>(`/api/system/tenants${listQuery(input)}`),
  ),
  getTenant: async (tenantId: string): Promise<SystemTenantDetail> => projectTenantDetail(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}`),
  ),
  provisionTenant: async (input: SystemTenantProvisionInput): Promise<SystemTenantProvisionDetail> => projectTenantProvisionDetail(
    await protectedRequest<unknown>('/api/system/tenants', {
      method: 'POST',
      body: JSON.stringify({
        slug: input.slug,
        display_name: input.display_name,
        initial_admin: {
          username: input.initial_admin.username,
          ...(input.initial_admin.display_name !== undefined
            ? { display_name: input.initial_admin.display_name }
            : {}),
          temporary_password: input.initial_admin.temporary_password,
        },
      }),
    }),
  ),
  renameTenant: async (
    tenantId: string,
    input: SystemTenantRenameInput,
  ): Promise<SystemTenantDetail> => projectTenantDetail(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: input.display_name }),
    }),
  ),
  resetInitialAdminPassword: async (
    tenantId: string,
    input: TemporaryPasswordResetInput,
  ): Promise<Record<string, never>> => {
    await protectedRequest<void>(
      `/api/system/tenants/${encodeURIComponent(tenantId)}/initial-admin/temporary-password`,
      {
        method: 'POST',
        body: JSON.stringify({ temporary_password: input.temporary_password }),
      },
    );
    return {};
  },
  suspendTenant: async (
    tenantId: string,
    input: SystemTenantSuspendInput,
  ): Promise<SystemTenantDetail> => projectTenantDetail(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason }),
    }),
  ),
  reactivateTenant: async (tenantId: string): Promise<SystemTenantDetail> => projectTenantDetail(
    await protectedRequest<unknown>(`/api/system/tenants/${encodeURIComponent(tenantId)}/reactivate`, {
      method: 'POST',
    }),
  ),
  listTenantAudit: async (
    tenantId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<SystemControlAuditPage> => projectAuditPage(
    await protectedRequest<unknown>(
      `/api/system/tenants/${encodeURIComponent(tenantId)}/audit${auditQuery(input)}`,
    ),
  ),
  getCodexA2ARuntimeStatus: async (): Promise<SystemRuntimeStatus> => projectRuntimeStatus(
    await protectedRequest<unknown>('/api/system/runtimes/codex-a2a'),
  ),
};

export type SystemClient = typeof systemClient;

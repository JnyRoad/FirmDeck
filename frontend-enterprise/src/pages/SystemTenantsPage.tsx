import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  isSystemApiError,
  systemClient,
  type SystemClient,
  type SystemControlAudit,
  type PasswordPolicy,
  type SystemRuntimeStatus,
  type SystemTenantDetail,
  type SystemTenantListInput,
  type SystemTenantProvisionInput,
  type SystemTenantStatus,
  type SystemTenantSummary,
} from '@/api/system-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Input } from '@/components/ui';
import { TENANT_STATUS, type TenantStatus } from '@/enums/tenantStatus';
import { useAppIntl } from '@/i18n/useAppIntl';

type PageClient = Pick<SystemClient, 'listTenants' | 'provisionTenant'> & Partial<Pick<
  SystemClient,
  | 'getTenant'
  | 'getPasswordPolicies'
  | 'getTenantPasswordPolicy'
  | 'renameTenant'
  | 'resetInitialAdminPassword'
  | 'suspendTenant'
  | 'reactivateTenant'
  | 'listTenantAudit'
  | 'getCodexA2ARuntimeStatus'
>>;

type SystemTenantsPageProps = { client?: PageClient };
type RequestFence = {
  generation: number;
  revision: number;
  controller: AbortController;
  isCurrent: () => boolean;
};
type CreateForm = {
  slug: string;
  displayName: string;
  adminUsername: string;
  adminDisplayName: string;
  temporaryPassword: string;
};
type CreateErrors = Partial<Record<keyof CreateForm, string>>;

const EMPTY_CREATE_FORM: CreateForm = {
  slug: '',
  displayName: '',
  adminUsername: '',
  adminDisplayName: '',
  temporaryPassword: '',
};
const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  min_length: 8,
  max_length: 20,
  complexity_enabled: false,
  require_uppercase: false,
  require_lowercase: false,
  require_digit: false,
  require_special: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeText(value: unknown, fallback = '—', maxLength = 512): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || fallback;
}

function safeNullableText(value: unknown, maxLength = 512): string | null {
  if (value == null) return null;
  const normalized = safeText(value, '', maxLength);
  return normalized || null;
}

function safeStatus(value: unknown): SystemTenantStatus {
  if (value === TENANT_STATUS.ACTIVE || value === TENANT_STATUS.SUSPENDED) return value;
  return TENANT_STATUS.UNKNOWN;
}

function formatLifecycleTimestamp(value: string, locale: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function projectTenant(value: unknown): SystemTenantSummary {
  const candidate = isRecord(value) ? value : {};
  const admin = isRecord(candidate.initial_admin) ? candidate.initial_admin : null;
  const lifecycleVersion = typeof candidate.lifecycle_version === 'number'
    && Number.isInteger(candidate.lifecycle_version)
    && candidate.lifecycle_version >= 1
    ? candidate.lifecycle_version
    : 1;
  return {
    id: safeText(candidate.id, safeText(candidate.slug, 'tenant', 256), 256),
    slug: safeText(candidate.slug, '—', 120),
    display_name: safeText(candidate.display_name, '—', 120),
    status: safeStatus(candidate.status),
    lifecycle_version: lifecycleVersion,
    initial_admin: admin ? {
      id: safeText(admin.id, '—', 256),
      username: safeText(admin.username, '—', 120),
      display_name: safeNullableText(admin.display_name, 120),
      role: 'admin',
    } : null,
    suspended_at: safeNullableText(candidate.suspended_at, 80),
    reactivated_at: safeNullableText(candidate.reactivated_at, 80),
    created_at: safeText(candidate.created_at, '—', 80),
    updated_at: safeText(candidate.updated_at, '—', 80),
  };
}

function projectDetail(value: unknown): SystemTenantDetail {
  const candidate = isRecord(value) ? value : {};
  return { ...projectTenant(candidate), suspension_reason: safeNullableText(candidate.suspension_reason, 500) };
}

function projectAudit(value: unknown): SystemControlAudit {
  const candidate = isRecord(value) ? value : {};
  const result = candidate.result === 'succeeded'
    || candidate.result === 'rejected'
    || candidate.result === 'failed'
    ? candidate.result
    : 'unknown';
  const safeParams: Record<string, string | number | boolean> = {};
  if (isRecord(candidate.safe_params)) {
    for (const [key, item] of Object.entries(candidate.safe_params).slice(0, 24)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
      if (/(?:password|secret|token|credential|hash|prompt|conversation|artifact|task|raw)/i.test(key)) continue;
      if (typeof item === 'string' && item.length <= 256) safeParams[key] = item;
      else if (typeof item === 'number' && Number.isFinite(item)) safeParams[key] = item;
      else if (typeof item === 'boolean') safeParams[key] = item;
    }
  }
  return {
    id: safeText(candidate.id, '—', 256),
    actor_system_admin_id: safeNullableText(candidate.actor_system_admin_id, 256),
    actor_label: safeNullableText(candidate.actor_label, 120),
    action: safeText(candidate.action, '—', 120),
    target_type: candidate.target_type === 'system_admin' ? 'system_admin' : 'tenant',
    target_id: safeNullableText(candidate.target_id, 256),
    result,
    reason_code: safeText(candidate.reason_code, '—', 120),
    operator_reason: safeNullableText(candidate.operator_reason, 500),
    status_before: candidate.status_before == null ? null : safeStatus(candidate.status_before),
    status_after: candidate.status_after == null ? null : safeStatus(candidate.status_after),
    lifecycle_version: typeof candidate.lifecycle_version === 'number'
      && Number.isInteger(candidate.lifecycle_version)
      && candidate.lifecycle_version >= 1
      ? candidate.lifecycle_version
      : null,
    request_id: safeNullableText(candidate.request_id, 256),
    trace_id: safeNullableText(candidate.trace_id, 256),
    safe_params: safeParams,
    created_at: safeText(candidate.created_at, '—', 80),
  };
}

function projectRuntime(value: unknown): SystemRuntimeStatus {
  const candidate = isRecord(value) ? value : {};
  return {
    key: 'codex_a2a',
    enabled: candidate.enabled === true,
    credential_configured: candidate.credential_configured === true,
    command: safeText(candidate.command, '—', 120),
    workspace_root: safeText(candidate.workspace_root, '—', 512),
    timeout_seconds: typeof candidate.timeout_seconds === 'number'
      && Number.isFinite(candidate.timeout_seconds)
      && candidate.timeout_seconds > 0
      ? candidate.timeout_seconds
      : 1,
  };
}

function isConflictError(error: unknown): boolean {
  if (isSystemApiError(error)) {
    return error.status === 409 && error.code === 'SYSTEM_CONTROL_CONFLICT';
  }
  return isRecord(error) && error.status === 409 && error.code === 'SYSTEM_CONTROL_CONFLICT';
}

/** Tests only the complexity requirements enabled by the active password policy. */
function hasRequiredPasswordComplexity(password: string, policy: PasswordPolicy): boolean {
  return (!policy.require_uppercase || /[A-Z]/.test(password))
    && (!policy.require_lowercase || /[a-z]/.test(password))
    && (!policy.require_digit || /\d/.test(password))
    && (!policy.require_special || /[^A-Za-z0-9]/.test(password));
}

export default function SystemTenantsPage({ client = systemClient }: SystemTenantsPageProps) {
  const { t, locale } = useAppIntl();
  const [rows, setRows] = useState<SystemTenantSummary[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | ''>('');
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [createErrors, setCreateErrors] = useState<CreateErrors>({});
  const [createRequestError, setCreateRequestError] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SystemTenantDetail | null>(null);
  const [audits, setAudits] = useState<SystemControlAudit[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [tenantNextCursor, setTenantNextCursor] = useState<string | null>(null);
  const [tenantLoadingMore, setTenantLoadingMore] = useState(false);
  const [auditNextCursor, setAuditNextCursor] = useState<string | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [auditError, setAuditError] = useState(false);
  const [runtime, setRuntime] = useState<SystemRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(Boolean(client.getCodexA2ARuntimeStatus));
  const [runtimeError, setRuntimeError] = useState(false);
  const [tenantDefaultPolicy, setTenantDefaultPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetPolicy, setResetPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [suspendError, setSuspendError] = useState('');
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [reactivateError, setReactivateError] = useState('');

  const generationRef = useRef(0);
  const listRevisionRef = useRef(0);
  const listControllerRef = useRef<AbortController | null>(null);
  const listMoreRevisionRef = useRef(0);
  const listMoreControllerRef = useRef<AbortController | null>(null);
  const detailRevisionRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const auditRevisionRef = useRef(0);
  const auditControllerRef = useRef<AbortController | null>(null);
  const runtimeRevisionRef = useRef(0);
  const runtimeControllerRef = useRef<AbortController | null>(null);
  const createRevisionRef = useRef(0);
  const createControllerRef = useRef<AbortController | null>(null);
  const renameRevisionRef = useRef(0);
  const renameControllerRef = useRef<AbortController | null>(null);
  const resetRevisionRef = useRef(0);
  const resetControllerRef = useRef<AbortController | null>(null);
  const suspendRevisionRef = useRef(0);
  const suspendControllerRef = useRef<AbortController | null>(null);
  const reactivateRevisionRef = useRef(0);
  const reactivateControllerRef = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  /** Invalidate every in-flight system-control request when the page/client is replaced. */
  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
      [
        listControllerRef,
        listMoreControllerRef,
        detailControllerRef,
        auditControllerRef,
        runtimeControllerRef,
        createControllerRef,
        renameControllerRef,
        resetControllerRef,
        suspendControllerRef,
        reactivateControllerRef,
      ].forEach((controllerRef) => controllerRef.current?.abort());
    };
  }, [client]);

  /** Capture one request generation/revision and abort its previous same-scope request. */
  function beginRequest(
    controllerRef: { current: AbortController | null },
    revisionRef: { current: number },
  ): RequestFence {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = generationRef.current;
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    return {
      generation,
      revision,
      controller,
      isCurrent: () => (
        generationRef.current === generation
        && revisionRef.current === revision
        && controllerRef.current === controller
        && !controller.signal.aborted
      ),
    };
  }

  function currentDetailRequest(
    fence: RequestFence,
    tenantId: string,
    detailRevision: number,
  ): boolean {
    return fence.isCurrent()
      && detailRevisionRef.current === detailRevision
      && selectedIdRef.current === tenantId;
  }

  const listInput = useCallback((cursor?: string): SystemTenantListInput => {
    const input: SystemTenantListInput = {};
    if (query.trim()) input.query = query.trim();
    if (statusFilter) input.status = statusFilter;
    if (cursor) input.cursor = cursor;
    return input;
  }, [query, statusFilter]);

  /** Replace the tenant result for the current query/filter and fence stale responses. */
  const loadTenants = useCallback(async () => {
    listMoreControllerRef.current?.abort();
    listMoreRevisionRef.current += 1;
    setTenantLoadingMore(false);
    const fence = beginRequest(listControllerRef, listRevisionRef);
    setListLoading(true);
    setListError(false);
    setTenantNextCursor(null);
    try {
      const result = await client.listTenants(listInput());
      if (!fence.isCurrent()) return;
      setRows(Array.isArray(result.items) ? result.items.map(projectTenant) : []);
      setTenantNextCursor(safeNullableText(result.next_cursor, 512));
    } catch {
      if (!fence.isCurrent()) return;
      setRows([]);
      setTenantNextCursor(null);
      setListError(true);
    } finally {
      const current = fence.isCurrent();
      if (current) setListLoading(false);
      if (listControllerRef.current === fence.controller) listControllerRef.current = null;
    }
  }, [client, listInput]);

  /** Append one tenant page without replacing the current query/filter result. */
  const loadMoreTenants = useCallback(async () => {
    const cursor = tenantNextCursor;
    if (!cursor || tenantLoadingMore || listLoading || listMoreControllerRef.current) return;
    const listRevision = listRevisionRef.current;
    const fence = beginRequest(listMoreControllerRef, listMoreRevisionRef);
    const isCurrent = () => fence.isCurrent() && listRevisionRef.current === listRevision;
    setTenantLoadingMore(true);
    setListError(false);
    try {
      const result = await client.listTenants(listInput(cursor));
      if (!isCurrent()) return;
      const projected = Array.isArray(result.items) ? result.items.map(projectTenant) : [];
      setRows((current) => {
        const existingIds = new Set(current.map((row) => row.id));
        return [...current, ...projected.filter((row) => !existingIds.has(row.id))];
      });
      setTenantNextCursor(safeNullableText(result.next_cursor, 512));
    } catch {
      if (isCurrent()) setListError(true);
    } finally {
      const current = isCurrent();
      if (current) setTenantLoadingMore(false);
      if (listMoreControllerRef.current === fence.controller) listMoreControllerRef.current = null;
    }
  }, [client, listInput, listLoading, tenantLoadingMore, tenantNextCursor]);

  const loadRuntime = useCallback(async () => {
    if (!client.getCodexA2ARuntimeStatus) return;
    const fence = beginRequest(runtimeControllerRef, runtimeRevisionRef);
    setRuntimeLoading(true);
    setRuntimeError(false);
    try {
      const result = await client.getCodexA2ARuntimeStatus();
      if (!fence.isCurrent()) return;
      setRuntime(projectRuntime(result));
    } catch {
      if (!fence.isCurrent()) return;
      setRuntime(null);
      setRuntimeError(true);
    } finally {
      const current = fence.isCurrent();
      if (current) setRuntimeLoading(false);
      if (runtimeControllerRef.current === fence.controller) runtimeControllerRef.current = null;
    }
  }, [client]);

  const loadDetail = useCallback(async (tenantId: string) => {
    const fence = beginRequest(detailControllerRef, detailRevisionRef);
    const detailRevision = fence.revision;
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    selectedIdRef.current = tenantId;
    auditControllerRef.current?.abort();
    auditRevisionRef.current += 1;
    renameControllerRef.current?.abort();
    resetControllerRef.current?.abort();
    suspendControllerRef.current?.abort();
    reactivateControllerRef.current?.abort();
    setSelectedId(tenantId);
    setDetailLoading(true);
    setDetailError(false);
    setDetail(null);
    setAudits([]);
    setAuditNextCursor(null);
    setAuditLoadingMore(false);
    setAuditError(false);
    setRenameOpen(false);
    setRenameName('');
    setRenameError('');
    setResetOpen(false);
    setResetPassword('');
    setResetPolicy(DEFAULT_PASSWORD_POLICY);
    setResetError('');
    setSuspendOpen(false);
    setSuspendReason('');
    setSuspending(false);
    setSuspendError('');
    setReactivateOpen(false);
    setReactivating(false);
    setReactivateError('');
    const row = rows.find((candidate) => candidate.id === tenantId);
    /** Keep tenant detail and audit available when policy lookup fails; use the bounded default policy. */
    const tenantPolicyPromise = client.getTenantPasswordPolicy
      ? client.getTenantPasswordPolicy(tenantId).catch(() => null)
      : Promise.resolve(null);
    try {
      const [detailResult, auditResult, policyResult] = await Promise.all([
        client.getTenant
          ? client.getTenant(tenantId)
          : Promise.resolve({ ...projectTenant(row), suspension_reason: null }),
        client.listTenantAudit
          ? client.listTenantAudit(tenantId, { limit: 50 })
          : Promise.resolve({ items: [], next_cursor: null }),
        tenantPolicyPromise,
      ]);
      if (!isCurrent()) return;
      setDetail(projectDetail(detailResult));
      setAudits(Array.isArray(auditResult.items) ? auditResult.items.map(projectAudit) : []);
      setAuditNextCursor(safeNullableText(auditResult.next_cursor, 512));
      setResetPolicy(policyResult?.effective ?? DEFAULT_PASSWORD_POLICY);
      setAuditError(false);
    } catch {
      if (isCurrent()) setDetailError(true);
    } finally {
      const current = isCurrent();
      if (current) setDetailLoading(false);
      if (detailControllerRef.current === fence.controller) detailControllerRef.current = null;
    }
  }, [client, rows]);

  /** Append the next audit page only while the same tenant detail remains selected. */
  const loadMoreAudit = useCallback(async () => {
    const cursor = auditNextCursor;
    const tenantId = selectedId;
    if (!cursor || !tenantId || auditLoadingMore || auditControllerRef.current || !client.listTenantAudit) return;
    const detailRevision = detailRevisionRef.current;
    const fence = beginRequest(auditControllerRef, auditRevisionRef);
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    setAuditLoadingMore(true);
    setAuditError(false);
    try {
      const result = await client.listTenantAudit(tenantId, { cursor, limit: 50 });
      if (!isCurrent()) return;
      const projected = Array.isArray(result.items) ? result.items.map(projectAudit) : [];
      setAudits((current) => {
        const existingIds = new Set(current.map((entry) => entry.id));
        return [...current, ...projected.filter((entry) => !existingIds.has(entry.id))];
      });
      setAuditNextCursor(safeNullableText(result.next_cursor, 512));
    } catch {
      if (isCurrent()) setAuditError(true);
    } finally {
      const current = isCurrent();
      if (current) setAuditLoadingMore(false);
      if (auditControllerRef.current === fence.controller) auditControllerRef.current = null;
    }
  }, [auditLoadingMore, auditNextCursor, client, selectedId]);

  useEffect(() => { void loadTenants(); }, [loadTenants]);
  useEffect(() => { void loadRuntime(); }, [loadRuntime]);
  /** Loads the installation tenant-default policy used when creating a tenant. */
  useEffect(() => {
    let cancelled = false;
    if (!client.getPasswordPolicies) return () => { cancelled = true; };
    void client.getPasswordPolicies()
      .then((policies) => {
        if (!cancelled) setTenantDefaultPolicy(policies.tenant_default);
      })
      .catch(() => {
        if (!cancelled) setTenantDefaultPolicy(DEFAULT_PASSWORD_POLICY);
      });
    return () => { cancelled = true; };
  }, [client]);

  function resetCreateForm() {
    setCreateForm({ ...EMPTY_CREATE_FORM });
    setCreateErrors({});
    setCreateRequestError('');
    setCreating(false);
  }

  function closeCreate() {
    if (creating) return;
    resetCreateForm();
    setCreateOpen(false);
  }

  async function submitCreate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const errors: CreateErrors = {};
    if (!TENANT_SLUG_PATTERN.test(createForm.slug.trim())) errors.slug = t('system.tenants.validation.slug');
    if (!createForm.displayName.trim()) errors.displayName = t('system.tenants.validation.displayName');
    if (!createForm.adminUsername.trim()) errors.adminUsername = t('system.tenants.validation.adminUsername');
    if (
      createForm.temporaryPassword.length < tenantDefaultPolicy.min_length
      || createForm.temporaryPassword.length > tenantDefaultPolicy.max_length
    ) {
      errors.temporaryPassword = t('system.tenants.validation.password', {
        min: tenantDefaultPolicy.min_length,
        max: tenantDefaultPolicy.max_length,
      });
    } else if (
      tenantDefaultPolicy.complexity_enabled
      && !hasRequiredPasswordComplexity(createForm.temporaryPassword, tenantDefaultPolicy)
    ) {
      errors.temporaryPassword = t('system.tenants.validation.passwordComplexity');
    }
    setCreateErrors(errors);
    setCreateRequestError('');
    if (Object.keys(errors).length > 0 || creating) return;
    const payload: SystemTenantProvisionInput = {
      slug: createForm.slug.trim(),
      display_name: createForm.displayName.trim(),
      initial_admin: {
        username: createForm.adminUsername.trim(),
        ...(createForm.adminDisplayName.trim() ? { display_name: createForm.adminDisplayName.trim() } : {}),
        temporary_password: createForm.temporaryPassword,
      },
    };
    const listRevision = listRevisionRef.current;
    const fence = beginRequest(createControllerRef, createRevisionRef);
    setCreating(true);
    try {
      const created = projectTenant(await client.provisionTenant(payload));
      if (!fence.isCurrent()) return;
      if (listRevisionRef.current === listRevision) {
        setRows((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      }
      setCreateForm({ ...EMPTY_CREATE_FORM });
      setCreateOpen(false);
    } catch (error) {
      if (fence.isCurrent()) {
        setCreateForm((current) => ({ ...current, temporaryPassword: '' }));
        setCreateRequestError(isConflictError(error)
          ? t('system.tenants.error.conflict')
          : t('system.tenants.error.create'));
      }
    } finally {
      if (fence.isCurrent()) setCreating(false);
      if (createControllerRef.current === fence.controller) createControllerRef.current = null;
    }
  }

  function updateCreate(field: keyof CreateForm, value: string) {
    setCreateForm((current) => ({ ...current, [field]: value }));
    setCreateErrors((current) => ({ ...current, [field]: undefined }));
    setCreateRequestError('');
  }

  async function submitRename(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedId || !client.renameTenant || renaming || !renameName.trim()) return;
    const tenantId = selectedId;
    const detailRevision = detailRevisionRef.current;
    const fence = beginRequest(renameControllerRef, renameRevisionRef);
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    setRenaming(true);
    setRenameError('');
    try {
      const updated = projectDetail(await client.renameTenant(tenantId, {
        display_name: renameName.trim(),
      }));
      if (!isCurrent()) return;
      setDetail(updated);
      setRows((current) => current.map((row) => row.id === updated.id ? projectTenant(updated) : row));
      setRenameOpen(false);
      setRenameName('');
      await refreshAuditAfterLifecycleMutation(tenantId, detailRevision, isCurrent);
    } catch {
      if (isCurrent()) setRenameError(t('system.tenants.rename.error'));
    } finally {
      if (isCurrent()) setRenaming(false);
      if (renameControllerRef.current === fence.controller) renameControllerRef.current = null;
    }
  }

  async function submitReset(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedId || !client.resetInitialAdminPassword || resetting) return;
    if (
      resetPassword.length < resetPolicy.min_length
      || resetPassword.length > resetPolicy.max_length
    ) {
      setResetError(t('system.tenants.validation.password', {
        min: resetPolicy.min_length,
        max: resetPolicy.max_length,
      }));
      return;
    }
    if (
      resetPolicy.complexity_enabled
      && !hasRequiredPasswordComplexity(resetPassword, resetPolicy)
    ) {
      setResetError(t('system.tenants.validation.passwordComplexity'));
      return;
    }
    const tenantId = selectedId;
    const detailRevision = detailRevisionRef.current;
    const fence = beginRequest(resetControllerRef, resetRevisionRef);
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    setResetting(true);
    setResetError('');
    const password = resetPassword;
    try {
      await client.resetInitialAdminPassword(tenantId, { temporary_password: password });
      if (!isCurrent()) return;
      setResetPassword('');
      setResetOpen(false);
      await refreshAuditAfterLifecycleMutation(tenantId, detailRevision, isCurrent);
    } catch {
      if (isCurrent()) {
        setResetPassword('');
        setResetError(t('system.tenants.reset.error'));
      }
    } finally {
      if (isCurrent()) setResetting(false);
      if (resetControllerRef.current === fence.controller) resetControllerRef.current = null;
    }
  }

  async function refreshAuditAfterLifecycleMutation(
    tenantId: string,
    detailRevision: number,
    isActionCurrent: () => boolean,
  ): Promise<void> {
    if (!client.listTenantAudit) return;
    const auditFence = beginRequest(auditControllerRef, auditRevisionRef);
    setAuditLoadingMore(false);
    setAuditError(false);
    try {
      const result = await client.listTenantAudit(tenantId, { limit: 50 });
      if (!isActionCurrent() || !currentDetailRequest(auditFence, tenantId, detailRevision)) return;
      setAudits(result.items.map(projectAudit));
      setAuditNextCursor(safeNullableText(result.next_cursor, 512));
    } catch {
      if (isActionCurrent() && currentDetailRequest(auditFence, tenantId, detailRevision)) {
        setAuditError(true);
      }
    } finally {
      if (auditControllerRef.current === auditFence.controller) {
        auditControllerRef.current = null;
      }
    }
  }

  async function submitSuspend(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedId || suspending) return;
    const reason = suspendReason.trim();
    if (!reason) {
      setSuspendError(t('system.tenants.suspend.validation.reason'));
      return;
    }
    if (!client.suspendTenant) return;
    const tenantId = selectedId;
    const detailRevision = detailRevisionRef.current;
    const fence = beginRequest(suspendControllerRef, suspendRevisionRef);
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    setSuspending(true);
    setSuspendError('');
    try {
      const updated = projectDetail(await client.suspendTenant(tenantId, { reason }));
      if (!isCurrent()) return;
      setDetail(updated);
      setRows((current) => current.map((row) => row.id === updated.id ? projectTenant(updated) : row));
      setSuspendOpen(false);
      setSuspendReason('');
      await refreshAuditAfterLifecycleMutation(tenantId, detailRevision, isCurrent);
    } catch {
      if (isCurrent()) setSuspendError(t('system.tenants.suspend.error'));
    } finally {
      if (isCurrent()) setSuspending(false);
      if (suspendControllerRef.current === fence.controller) suspendControllerRef.current = null;
    }
  }

  async function submitReactivate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedId || !client.reactivateTenant || reactivating) return;
    const tenantId = selectedId;
    const detailRevision = detailRevisionRef.current;
    const fence = beginRequest(reactivateControllerRef, reactivateRevisionRef);
    const isCurrent = () => currentDetailRequest(fence, tenantId, detailRevision);
    setReactivating(true);
    setReactivateError('');
    try {
      const updated = projectDetail(await client.reactivateTenant(tenantId));
      if (!isCurrent()) return;
      setDetail(updated);
      setRows((current) => current.map((row) => row.id === updated.id ? projectTenant(updated) : row));
      setReactivateOpen(false);
      await refreshAuditAfterLifecycleMutation(tenantId, detailRevision, isCurrent);
    } catch {
      if (isCurrent()) setReactivateError(t('system.tenants.reactivate.error'));
    } finally {
      if (isCurrent()) setReactivating(false);
      if (reactivateControllerRef.current === fence.controller) reactivateControllerRef.current = null;
    }
  }

  const closeRename = () => {
    if (renaming) return;
    setRenameOpen(false);
    setRenameName('');
    setRenameError('');
  };
  const closeReset = () => {
    if (resetting) return;
    setResetOpen(false);
    setResetPassword('');
    setResetError('');
  };
  const closeSuspend = () => {
    setSuspendOpen(false);
    setSuspendReason('');
    setSuspendError('');
  };
  const closeReactivate = () => {
    setReactivateOpen(false);
    setReactivateError('');
  };
  const retryAudit = () => {
    const tenantId = selectedId;
    if (!tenantId) return;
    const detailRevision = detailRevisionRef.current;
    void refreshAuditAfterLifecycleMutation(
      tenantId,
      detailRevision,
      () => selectedIdRef.current === tenantId && detailRevisionRef.current === detailRevision,
    );
  };
  const retryAll = useCallback(() => {
    void loadTenants();
    void loadRuntime();
    if (selectedId) void loadDetail(selectedId);
  }, [loadDetail, loadRuntime, loadTenants, selectedId]);
  const pageError = listError || detailError || runtimeError;
  const auditItems = useMemo(() => audits.map((entry) => ({
    ...entry,
    actor: entry.actor_label || entry.actor_system_admin_id || '—',
  })), [audits]);
  const fieldClass = 'h-10 rounded-[9px] border-[#dfe5ef] bg-white text-[13px] shadow-none focus-visible:border-[#1a71ff] focus-visible:ring-2 focus-visible:ring-[#1a71ff]/15';

  return (
    <main aria-busy={listLoading} className="flex min-w-0 flex-1 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-full">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a71ff]">{t('system.tenants.kicker')}</p>
          <h1 className="[overflow-wrap:anywhere] text-[24px] font-semibold tracking-[-0.03em] text-[#18181a] sm:text-[27px]">{t('system.tenants.title')}</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[#6f788a]">{t('system.tenants.description')}</p>
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void loadTenants()}>{t('system.tenants.action.refresh')}</Button>
          <Button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }}>{t('system.tenants.action.create')}</Button>
        </div>
      </header>

      <div className="grid gap-3 rounded-[14px] border border-[#e3e8f1] bg-white p-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <label className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
          <span>{t('system.tenants.search.label')}</span>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('system.tenants.search.label')} placeholder={t('system.tenants.search.placeholder')} className={fieldClass} />
        </label>
        <label className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
          <span>{t('system.tenants.filter.status')}</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TenantStatus | '')} aria-label={t('system.tenants.filter.status')} className={`${fieldClass} px-3 outline-none`}>
            <option value="" onClick={() => setStatusFilter('')}>{t('system.tenants.filter.all')}</option>
            <option value="active" onClick={() => setStatusFilter('active')}>{t('system.tenants.filter.active')}</option>
            <option value="suspended" onClick={() => setStatusFilter('suspended')}>{t('system.tenants.status.suspended')}</option>
          </select>
        </label>
      </div>

      {pageError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-[12px] border border-[#f1c8c8] bg-[#fff7f7] px-4 py-3 text-[13px] text-[#a03c3c]">
          <span>{t('system.tenants.error.load')}</span>
          <Button type="button" variant="outline" onClick={retryAll}>{t('system.tenants.action.retry')}</Button>
        </div>
      )}

      {listLoading ? (
        <div role="status" className="rounded-[14px] border border-[#e3e8f1] bg-white p-7 text-[13px] text-[#6f788a]">{t('system.tenants.loading')}</div>
      ) : (
        <section aria-label={t('system.tenants.listAria')} className="overflow-hidden rounded-[14px] border border-[#e3e8f1] bg-white">
          <div className="border-b border-[#edf0f5] px-5 py-4 text-[13px] font-semibold text-[#30343b]">{t('system.tenants.listTitle')}</div>
          {rows.length === 0 ? (
            <div className="grid justify-items-center gap-3 px-5 py-12 text-[13px] text-[#7d879a]">
              <span>{t('system.tenants.empty')}</span>
            </div>
          ) : (
            <div className="divide-y divide-[#edf0f5]">
              {rows.map((row) => (
                <div key={row.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-[#30343b]">{row.display_name}</p>
                    <p className="mt-1 truncate font-mono text-[11px] text-[#8b94a6]">{row.id}</p>
                  </div>
                  <span className="font-mono text-[12px] text-[#596579]">{row.slug}</span>
                  <div className="text-[12px] text-[#596579]">
                    <span>{row.initial_admin?.username || '—'}</span>
                    <span className="ml-2 rounded-full bg-[#f2f3f7] px-2 py-1 text-[11px]">
                      {row.status === TENANT_STATUS.SUSPENDED
                        ? t('system.tenants.status.suspended')
                        : row.status === TENANT_STATUS.ACTIVE
                          ? t('system.tenants.status.active')
                          : t('system.tenants.status.unknown')}
                    </span>
                  </div>
                  <Button type="button" variant="outline" aria-label={t('system.tenants.detail.open', { name: row.display_name })} onClick={() => void loadDetail(row.id)}>
                    {t('system.tenants.detail.action')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {tenantNextCursor && (
            <div className="flex justify-center border-t border-[#edf0f5] px-5 py-4">
              <Button
                type="button"
                variant="outline"
                disabled={tenantLoadingMore}
                aria-busy={tenantLoadingMore}
                onClick={() => void loadMoreTenants()}
              >
                {t('system.tenants.action.loadMore')}
              </Button>
            </div>
          )}
        </section>
      )}

      {client.getCodexA2ARuntimeStatus && (
        <section role="region" aria-label={t('system.tenants.runtime.title')} className="rounded-[14px] border border-[#dce6f8] bg-[#f8fbff] p-5">
          {runtimeLoading || !runtime ? (
            <div role="status" aria-label={t('system.tenants.runtime.loading')} className="text-[13px] text-[#6f788a]">
              {t('system.tenants.runtime.loading')}
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-[#30343b]">{t('system.tenants.runtime.title')}</h2>
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-[#596579]">
                  {runtime.enabled ? t('system.tenants.runtime.enabled') : t('system.tenants.runtime.disabled')}
                </span>
              </div>
              <dl className="grid gap-3 text-[12px] sm:grid-cols-3">
                <div><dt className="text-[#8b94a6]">{t('system.tenants.runtime.command')}</dt><dd className="mt-1 font-mono text-[#30343b]">{runtime.command}</dd></div>
                <div><dt className="text-[#8b94a6]">{t('system.tenants.runtime.workspace')}</dt><dd className="mt-1 break-all font-mono text-[#30343b]">{runtime.workspace_root}</dd></div>
                <div><dt className="text-[#8b94a6]">{t('system.tenants.runtime.timeout')}</dt><dd className="mt-1 font-mono text-[#30343b]">{runtime.timeout_seconds}</dd></div>
              </dl>
            </>
          )}
        </section>
      )}

      {detailLoading && (
        <div role="status" aria-label={t('system.tenants.detail.loading')} className="rounded-[14px] border border-[#e3e8f1] bg-white p-5 text-[13px] text-[#6f788a]">
          {t('system.tenants.detail.loading')}
        </div>
      )}
      {detail && !detailLoading && (
        <section role="region" aria-label={t('system.tenants.detail.title')} className="rounded-[14px] border border-[#e3e8f1] bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-[#30343b]">{detail.display_name}</h2>
              <p className="mt-1 font-mono text-[12px] text-[#6f788a]">{detail.slug}</p>
              <p className="mt-2 text-[12px] text-[#6f788a]">{detail.initial_admin?.username || '—'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#596579]">
                <span className={detail.status === TENANT_STATUS.SUSPENDED
                  ? 'rounded-full bg-[#fff1f1] px-2.5 py-1 font-medium text-[#a03c3c]'
                  : detail.status === TENANT_STATUS.ACTIVE
                    ? 'rounded-full bg-[#edf8f1] px-2.5 py-1 font-medium text-[#247a45]'
                    : 'rounded-full bg-[#f2f3f7] px-2.5 py-1 font-medium text-[#596579]'}>
                  {detail.status === TENANT_STATUS.SUSPENDED
                    ? t('system.tenants.status.suspended')
                    : detail.status === TENANT_STATUS.ACTIVE
                      ? t('system.tenants.status.active')
                      : t('system.tenants.status.unknown')}
                </span>
                <span>{t('system.tenants.lifecycle.version', { version: detail.lifecycle_version })}</span>
              </div>
              {detail.status === TENANT_STATUS.SUSPENDED && detail.suspension_reason && (
                <p className="mt-3 max-w-xl rounded-[9px] bg-[#fff7f7] px-3 py-2 text-[12px] text-[#7f4040]">
                  {detail.suspension_reason}
                </p>
              )}
              {detail.status === TENANT_STATUS.SUSPENDED && detail.suspended_at && (
                <dl className="mt-2 text-[11px] text-[#8b94a6]">
                  <div className="flex flex-wrap gap-1.5">
                    <dt>{t('system.tenants.lifecycle.suspendedAt')}</dt>
                    <dd>{formatLifecycleTimestamp(detail.suspended_at, locale)}</dd>
                  </div>
                </dl>
              )}
              {detail.status === TENANT_STATUS.ACTIVE && detail.reactivated_at && (
                <dl className="mt-2 text-[11px] text-[#8b94a6]">
                  <div className="flex flex-wrap gap-1.5">
                    <dt>{t('system.tenants.lifecycle.reactivatedAt')}</dt>
                    <dd>{formatLifecycleTimestamp(detail.reactivated_at, locale)}</dd>
                  </div>
                </dl>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => { setRenameName(detail.display_name); setRenameOpen(true); }}>{t('system.tenants.rename.action')}</Button>
              <Button type="button" variant="outline" onClick={() => { setResetPassword(''); setResetError(''); setResetOpen(true); }}>{t('system.tenants.reset.action')}</Button>
              {detail.status === TENANT_STATUS.ACTIVE && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={suspending || reactivating}
                  onClick={() => {
                    setSuspendReason('');
                    setSuspendError('');
                    setSuspendOpen(true);
                  }}
                >
                  {t('system.tenants.suspend.action')}
                </Button>
              )}
              {detail.status === TENANT_STATUS.SUSPENDED && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={suspending || reactivating}
                  onClick={() => {
                    setReactivateError('');
                    setReactivateOpen(true);
                  }}
                >
                  {t('system.tenants.reactivate.action')}
                </Button>
              )}
            </div>
          </div>
          <div className="mt-5 border-t border-[#edf0f5] pt-5">
            <section role="region" aria-label={t('system.tenants.audit.title')}>
              <h3 className="text-[13px] font-semibold text-[#30343b]">{t('system.tenants.audit.title')}</h3>
              {auditError && (
                <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-[9px] bg-[#fff7f7] px-3 py-2 text-[12px] text-[#a03c3c]">
                  <span>{t('system.tenants.audit.refreshError')}</span>
                  <Button type="button" variant="outline" onClick={retryAudit}>{t('system.tenants.action.retry')}</Button>
                </div>
              )}
              {auditItems.length === 0 ? (
                <p className="mt-3 text-[12px] text-[#8b94a6]">{t('system.tenants.audit.empty')}</p>
              ) : (
                <ol className="mt-3 grid gap-3">
                  {auditItems.map((entry) => (
                    <li key={entry.id} className="grid gap-1 rounded-[10px] bg-[#f7f8fa] p-3 text-[11px] text-[#596579] sm:grid-cols-2">
                      <span>{entry.actor}</span><span>{entry.action}</span><span>{entry.reason_code}</span>
                      <span>{entry.request_id || '—'}</span><span>{entry.trace_id || '—'}</span>
                      <span>
                        {entry.result === 'rejected'
                          ? t('system.tenants.audit.result.rejected')
                          : entry.result === 'failed'
                            ? t('system.tenants.audit.result.failed')
                            : entry.result === 'succeeded'
                              ? t('system.tenants.audit.result.succeeded')
                              : t('system.tenants.audit.result.unknown')}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {auditNextCursor && (
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={auditLoadingMore}
                    aria-busy={auditLoadingMore}
                    onClick={() => void loadMoreAudit()}
                  >
                    {t('system.tenants.audit.loadMore')}
                  </Button>
                </div>
              )}
            </section>
          </div>
        </section>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => { if (open) setCreateOpen(true); else closeCreate(); }}>
        <DialogContent showCloseButton={!creating} onEscapeKeyDown={closeCreate} className="max-w-[560px] p-0">
          <div className="border-b border-[#edf0f5] px-6 py-5">
            <DialogTitle>{t('system.tenants.dialog.title')}</DialogTitle>
            <DialogDescription className="mt-2">{t('system.tenants.dialog.description')}</DialogDescription>
          </div>
          <form onSubmit={submitCreate} noValidate className="grid gap-4 px-6 py-5">
            {createRequestError && <div role="alert" className="rounded-lg bg-[#fff2f2] p-3 text-[12px] text-[#a03c3c]">{createRequestError}</div>}
            {Object.keys(createErrors).length > 0 && <div role="alert" className="sr-only">{Object.values(createErrors).filter(Boolean).join(' ')}</div>}
            <CreateField id="system-tenant-slug" label={t('system.tenants.field.slug')} value={createForm.slug} error={createErrors.slug} onChange={(value) => updateCreate('slug', value)} />
            <CreateField id="system-tenant-display-name" label={t('system.tenants.field.displayName')} value={createForm.displayName} error={createErrors.displayName} onChange={(value) => updateCreate('displayName', value)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <CreateField id="system-tenant-admin-username" label={t('system.tenants.field.adminUsername')} value={createForm.adminUsername} error={createErrors.adminUsername} onChange={(value) => updateCreate('adminUsername', value)} />
              <CreateField id="system-tenant-admin-name" label={t('system.tenants.field.adminDisplayName')} value={createForm.adminDisplayName} onChange={(value) => updateCreate('adminDisplayName', value)} />
            </div>
            <CreateField
              id="system-tenant-password"
              type="password"
              label={t('system.tenants.field.temporaryPassword')}
              value={createForm.temporaryPassword}
              error={createErrors.temporaryPassword}
              placeholder={t('system.tenants.field.temporaryPasswordPlaceholder', {
                min: tenantDefaultPolicy.min_length,
                max: tenantDefaultPolicy.max_length,
              })}
              minLength={tenantDefaultPolicy.min_length}
              maxLength={tenantDefaultPolicy.max_length}
              onChange={(value) => updateCreate('temporaryPassword', value)}
            />
            <PasswordPolicyRequirements policy={tenantDefaultPolicy} />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" disabled={creating} onClick={closeCreate}>{t('system.tenants.action.cancel')}</Button>
              <Button type="submit" disabled={creating}>{creating ? t('system.tenants.action.submitting') : t('system.tenants.action.create')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={(open) => { if (open) setRenameOpen(true); else closeRename(); }}>
        <DialogContent showCloseButton={!renaming} onEscapeKeyDown={closeRename} className="max-w-[460px]">
          <DialogTitle>{t('system.tenants.rename.title')}</DialogTitle>
          <DialogDescription>{t('system.tenants.rename.description')}</DialogDescription>
          <form onSubmit={submitRename} className="grid gap-4">
            {renameError && <div role="alert" className="rounded-lg bg-[#fff2f2] p-3 text-[12px] text-[#a03c3c]">{renameError}</div>}
            <label className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
              <span>{t('system.tenants.rename.field')}</span>
              <Input aria-label={t('system.tenants.rename.field')} value={renameName} onChange={(event) => setRenameName(event.target.value)} className={fieldClass} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={renaming} onClick={closeRename}>{t('system.tenants.action.cancel')}</Button>
              <Button type="submit" disabled={renaming || !renameName.trim()}>{t('system.tenants.rename.confirm')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={(open) => { if (open) setResetOpen(true); else closeReset(); }}>
        <DialogContent showCloseButton={!resetting} onEscapeKeyDown={closeReset} className="max-w-[480px]">
          <DialogTitle>{t('system.tenants.reset.title')}</DialogTitle>
          <DialogDescription>{t('system.tenants.reset.description', {
            min: resetPolicy.min_length,
            max: resetPolicy.max_length,
          })}</DialogDescription>
          <form onSubmit={submitReset} noValidate className="grid gap-4">
            {resetError && <div role="alert" className="rounded-lg bg-[#fff2f2] p-3 text-[12px] text-[#a03c3c]">{resetError}</div>}
            <label className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
              <span>{t('system.tenants.reset.field')}</span>
              <Input
                type="password"
                aria-label={t('system.tenants.reset.field')}
                placeholder={t('system.tenants.field.temporaryPasswordPlaceholder', {
                  min: resetPolicy.min_length,
                  max: resetPolicy.max_length,
                })}
                minLength={resetPolicy.min_length}
                maxLength={resetPolicy.max_length}
                value={resetPassword}
                onChange={(event) => { setResetPassword(event.target.value); setResetError(''); }}
                className={fieldClass}
              />
            </label>
            <PasswordPolicyRequirements policy={resetPolicy} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={resetting} onClick={closeReset}>{t('system.tenants.action.cancel')}</Button>
              <Button type="submit" disabled={resetting}>{t('system.tenants.reset.confirm')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={suspendOpen} onOpenChange={(open) => { if (open) setSuspendOpen(true); else closeSuspend(); }}>
        <DialogContent
          showCloseButton={!suspending}
          onEscapeKeyDown={closeSuspend}
          aria-modal="true"
          aria-busy={suspending}
          className="max-w-[480px]"
        >
          <DialogTitle>{t('system.tenants.suspend.title')}</DialogTitle>
          <DialogDescription>{t('system.tenants.suspend.description')}</DialogDescription>
          <form onSubmit={submitSuspend} className="grid gap-4">
            {suspendError && (
              <div id="system-tenant-suspend-reason-error" role="alert" className="rounded-lg bg-[#fff2f2] p-3 text-[12px] text-[#a03c3c]">
                {suspendError}
              </div>
            )}
            <label htmlFor="system-tenant-suspend-reason" className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
              <span>{t('system.tenants.suspend.reason')}</span>
              <Input
                id="system-tenant-suspend-reason"
                aria-label={t('system.tenants.suspend.reason')}
                aria-required="true"
                aria-invalid={Boolean(suspendError)}
                aria-describedby={suspendError ? 'system-tenant-suspend-reason-error' : undefined}
                value={suspendReason}
                maxLength={500}
                onChange={(event) => {
                  setSuspendReason(event.target.value);
                  setSuspendError('');
                }}
                className={fieldClass}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={suspending} onClick={closeSuspend}>
                {t('system.tenants.action.cancel')}
              </Button>
              <Button type="submit" disabled={suspending}>
                {t('system.tenants.suspend.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={reactivateOpen} onOpenChange={(open) => { if (open) setReactivateOpen(true); else closeReactivate(); }}>
        <DialogContent
          showCloseButton={!reactivating}
          onEscapeKeyDown={closeReactivate}
          aria-modal="true"
          aria-busy={reactivating}
          className="max-w-[480px]"
        >
          <DialogTitle>{t('system.tenants.reactivate.title')}</DialogTitle>
          <DialogDescription>{t('system.tenants.reactivate.description')}</DialogDescription>
          <form onSubmit={submitReactivate} className="grid gap-4">
            {reactivateError && (
              <div role="alert" className="rounded-lg bg-[#fff2f2] p-3 text-[12px] text-[#a03c3c]">
                {reactivateError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={reactivating} onClick={closeReactivate}>
                {t('system.tenants.action.cancel')}
              </Button>
              <Button type="submit" disabled={reactivating}>
                {t('system.tenants.reactivate.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

type CreateFieldProps = {
  id: string;
  label: string;
  value: string;
  error?: string;
  type?: 'text' | 'password';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  onChange: (value: string) => void;
};

function CreateField({
  id,
  label,
  value,
  error,
  type = 'text',
  placeholder,
  minLength,
  maxLength,
  onChange,
}: CreateFieldProps) {
  const errorId = `${id}-error`;
  return (
    <label htmlFor={id} className="grid gap-1.5 text-[12px] font-medium text-[#464c5e]">
      <span>{label}</span>
      <Input
        id={id}
        type={type}
        aria-label={label}
        placeholder={placeholder}
        minLength={minLength}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-[9px] border-[#dfe5ef] bg-white text-[13px] shadow-none focus-visible:border-[#1a71ff] focus-visible:ring-2 focus-visible:ring-[#1a71ff]/15"
      />
      {error && <span id={errorId} className="text-[11px] text-[#b24545]">{error}</span>}
    </label>
  );
}

/** Renders only the complexity rules enabled by the current tenant password policy. */
function PasswordPolicyRequirements({ policy }: { policy: PasswordPolicy }) {
  const { t } = useAppIntl();
  if (!policy.complexity_enabled) return null;
  return (
    <ul className="grid gap-1 text-[12px] text-[#6f788a]">
      {policy.require_uppercase && <li>{t('system.passwordPolicies.requireUppercase')}</li>}
      {policy.require_lowercase && <li>{t('system.passwordPolicies.requireLowercase')}</li>}
      {policy.require_digit && <li>{t('system.passwordPolicies.requireDigit')}</li>}
      {policy.require_special && <li>{t('system.passwordPolicies.requireSpecial')}</li>}
    </ul>
  );
}

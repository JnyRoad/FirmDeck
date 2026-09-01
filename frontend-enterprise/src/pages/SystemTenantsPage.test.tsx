// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { AppLocale } from '../i18n/locales';

const SYSTEM_TENANTS_MODULE_PATH = './SystemTenantsPage';
const TEMPORARY_PASSWORD = 'Temporary-secret-2026';

type TenantSummary = {
  id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'suspended';
  lifecycle_version: number;
  initial_admin: {
    id: string;
    username: string;
    display_name: string | null;
    role: 'admin';
    must_change_password: boolean;
  } | null;
  suspended_at: string | null;
  reactivated_at: string | null;
  created_at: string;
  updated_at: string;
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

type TenantListInput = {
  query?: string;
  status?: 'active' | 'suspended';
  cursor?: string;
  limit?: number;
};

type TenantDetail = TenantSummary & {
  suspension_reason: string | null;
};

type TenantSuspendInput = {
  reason: string;
};

type TenantAudit = {
  id: string;
  actor_system_admin_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: 'system_admin' | 'tenant';
  target_id: string | null;
  result: 'succeeded' | 'rejected' | 'failed';
  reason_code: string;
  operator_reason: string | null;
  status_before: 'active' | 'suspended' | null;
  status_after: 'active' | 'suspended' | null;
  lifecycle_version: number | null;
  request_id: string | null;
  trace_id: string | null;
  safe_params: Record<string, string | number | boolean>;
  created_at: string;
};

type RuntimeStatus = {
  key: 'codex_a2a';
  enabled: boolean;
  credential_configured: boolean;
  command: string;
  workspace_root: string;
  timeout_seconds: number;
};

type PageClient = {
  listTenants(input?: TenantListInput): Promise<{ items: TenantSummary[]; next_cursor: string | null }>;
  provisionTenant(input: ProvisionInput): Promise<TenantSummary>;
  getTenant?(tenantId: string): Promise<TenantDetail>;
  renameTenant?(tenantId: string, input: { display_name: string }): Promise<TenantDetail>;
  resetInitialAdminPassword?(
    tenantId: string,
    input: { temporary_password: string },
  ): Promise<unknown>;
  suspendTenant?(tenantId: string, input: TenantSuspendInput): Promise<TenantDetail>;
  reactivateTenant?(tenantId: string): Promise<TenantDetail>;
  listTenantAudit?(
    tenantId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<{ items: TenantAudit[]; next_cursor: string | null }>;
  getCodexA2ARuntimeStatus?(): Promise<RuntimeStatus>;
};

type PageProps = {
  client?: PageClient;
};

const tenant: TenantSummary = {
  id: 'tenant-alpha',
  slug: 'alpha-lab',
  display_name: 'Alpha Lab',
  status: 'active',
  lifecycle_version: 1,
  initial_admin: {
    id: 'user-alpha-admin',
    username: 'admin',
    display_name: 'Alpha Operator',
    role: 'admin',
    must_change_password: true,
  },
  suspended_at: null,
  reactivated_at: null,
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
};

const tenantDetail: TenantDetail = {
  ...tenant,
  suspension_reason: null,
};

const suspendedTenant: TenantSummary = {
  ...tenant,
  id: 'tenant-beta',
  slug: 'beta-lab',
  display_name: 'Beta Lab',
  status: 'suspended',
  lifecycle_version: 3,
  initial_admin: {
    ...tenant.initial_admin!,
    id: 'user-beta-admin',
    display_name: 'Beta Operator',
    must_change_password: false,
  },
  suspended_at: '2026-08-31T01:00:00Z',
  reactivated_at: null,
};

const suspendedTenantDetail: TenantDetail = {
  ...suspendedTenant,
  suspension_reason: 'billing hold',
};

const reactivatedTenantDetail: TenantDetail = {
  ...tenantDetail,
  lifecycle_version: 4,
  reactivated_at: '2026-08-31T03:00:00Z',
};

const auditPage: { items: TenantAudit[]; next_cursor: string | null } = {
  items: [
    {
      id: 'audit-rename-1',
      actor_system_admin_id: 'sysadmin-root',
      actor_label: 'root',
      action: 'tenant.rename',
      target_type: 'tenant' as const,
      target_id: 'tenant-alpha',
      result: 'succeeded' as const,
      reason_code: 'SYSTEM_TENANT_RENAMED',
      operator_reason: null,
      status_before: 'active' as const,
      status_after: 'active' as const,
      lifecycle_version: 1,
      request_id: 'request-rename-1',
      trace_id: 'trace-rename-1',
      safe_params: { display_name_changed: true },
      created_at: '2026-08-31T02:00:00Z',
    },
    {
      id: 'audit-reset-1',
      actor_system_admin_id: 'sysadmin-root',
      actor_label: 'root',
      action: 'tenant.initial_admin_password_reset',
      target_type: 'tenant' as const,
      target_id: 'tenant-alpha',
      result: 'succeeded' as const,
      reason_code: 'SYSTEM_INITIAL_ADMIN_PASSWORD_RESET',
      operator_reason: 'operator recovery',
      status_before: 'active' as const,
      status_after: 'active' as const,
      lifecycle_version: 1,
      request_id: 'request-reset-1',
      trace_id: 'trace-reset-1',
      safe_params: { sessions_invalidated: true },
      created_at: '2026-08-31T02:01:00Z',
    },
  ],
  next_cursor: null,
};

const runtimeStatus: RuntimeStatus = {
  key: 'codex_a2a',
  enabled: true,
  credential_configured: true,
  command: 'codex',
  workspace_root: '/srv/staffdeck/codex-runtime',
  timeout_seconds: 45,
};

function createPageClient(overrides: Partial<PageClient> = {}): PageClient {
  return {
    listTenants: vi.fn(async () => ({ items: [tenant], next_cursor: null })),
    provisionTenant: vi.fn(async () => tenant),
    ...overrides,
  };
}

async function loadPage(): Promise<ComponentType<PageProps>> {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_TENANTS_MODULE_PATH) as {
      default?: ComponentType<PageProps>;
    };
    expect(module.default).toBeTypeOf('function');
    return module.default!;
  } catch (error) {
    throw new Error(`T023 must implement ${SYSTEM_TENANTS_MODULE_PATH}: ${String(error)}`);
  }
}

async function renderPage(client: PageClient, locale: AppLocale = 'zh-CN') {
  const SystemTenantsPage = await loadPage();
  return render(
    <I18nProvider locale={locale}>
      <SystemTenantsPage client={client} />
    </I18nProvider>,
  );
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

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '创建租户' }));
  return screen.getByRole('dialog', { name: '创建租户' });
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('租户标识'), 'alpha-lab');
  await user.type(screen.getByLabelText('租户名称'), 'Alpha Lab');
  await user.type(screen.getByLabelText('初始管理员账号'), 'admin');
  await user.type(screen.getByLabelText('初始管理员名称'), 'Alpha Operator');
  await user.type(screen.getByLabelText('临时密码'), TEMPORARY_PASSWORD);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SystemTenantsPage', () => {
  it('exposes an accessible loading state while the control list is pending', async () => {
    const pending = deferred<{ items: TenantSummary[]; next_cursor: string | null }>();
    const client = {
      listTenants: vi.fn(() => pending.promise),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);

    expect(screen.getByRole('status').textContent).toContain('正在加载租户');
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    expect(client.listTenants).toHaveBeenCalledTimes(1);

    pending.resolve({ items: [], next_cursor: null });
    await screen.findByText('还没有租户');
  });

  it('shows an empty state with an accessible create action', async () => {
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);

    expect(await screen.findByText('还没有租户')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建租户' })).toBeTruthy();
  });

  it('renders only allowlisted control metadata even when a response has malicious extra fields', async () => {
    const malicious = {
      ...tenant,
      password: 'response-password-secret',
      password_hash: 'stored-hash-secret',
      token: 'response-token-secret',
      conversation: 'tenant conversation',
      prompt: 'private prompt',
      artifact: 'private artifact',
    } as TenantSummary;
    const client = {
      listTenants: vi.fn(async () => ({ items: [malicious], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);

    expect(await screen.findByText('Alpha Lab')).toBeTruthy();
    expect(screen.getByText('alpha-lab')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    const rendered = document.body.textContent || '';
    for (const secret of [
      'response-password-secret',
      'stored-hash-secret',
      'response-token-secret',
      'tenant conversation',
      'private prompt',
      'private artifact',
    ]) {
      expect(rendered).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
    }
  });

  it('opens a named dialog with labelled controls and a hidden password field', async () => {
    const user = userEvent.setup();
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);
    const dialog = await openCreateDialog(user);

    expect(within(dialog).getByLabelText('租户标识')).toBeTruthy();
    expect(within(dialog).getByLabelText('租户名称')).toBeTruthy();
    expect(within(dialog).getByLabelText('初始管理员账号')).toBeTruthy();
    expect(within(dialog).getByLabelText('初始管理员名称')).toBeTruthy();
    expect(within(dialog).getByLabelText('临时密码').getAttribute('type')).toBe('password');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '创建租户' })).toBeTruthy();
  });

  it('announces local validation and performs no request for invalid control input', async () => {
    const user = userEvent.setup();
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);
    const dialog = await openCreateDialog(user);

    await user.type(within(dialog).getByLabelText('租户标识'), 'INVALID_');
    await user.type(within(dialog).getByLabelText('临时密码'), 'short');
    await user.click(within(dialog).getByRole('button', { name: '创建租户' }));

    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('租户标识必须为 3 至 63 位小写字母、数字或连字符');
    expect(alert.textContent).toContain('请输入租户名称');
    expect(alert.textContent).toContain('请输入初始管理员账号');
    expect(alert.textContent).toContain('临时密码至少需要 12 位');
    for (const [label, message] of [
      ['租户标识', '租户标识必须为 3 至 63 位小写字母、数字或连字符'],
      ['租户名称', '请输入租户名称'],
      ['初始管理员账号', '请输入初始管理员账号'],
      ['临时密码', '临时密码至少需要 12 位'],
    ]) {
      const control = within(dialog).getByLabelText(label);
      expect(control.getAttribute('aria-invalid')).toBe('true');
      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy || '')?.textContent).toContain(message);
    }
    expect(client.provisionTenant).not.toHaveBeenCalled();
  });

  it('submits the exact payload, displays the created tenant, and clears the temporary password', async () => {
    const user = userEvent.setup();
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);
    await openCreateDialog(user);
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '创建租户' }));

    await waitFor(() => expect(client.provisionTenant).toHaveBeenCalledTimes(1));
    expect(client.provisionTenant).toHaveBeenCalledWith({
      slug: 'alpha-lab',
      display_name: 'Alpha Lab',
      initial_admin: {
        username: 'admin',
        display_name: 'Alpha Operator',
        temporary_password: TEMPORARY_PASSWORD,
      },
    });
    const [submitted] = client.provisionTenant.mock.calls[0] as unknown as [ProvisionInput];
    expect(submitted).not.toHaveProperty('tenant_id');
    expect(await screen.findByText('Alpha Lab')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(TEMPORARY_PASSWORD);
    expect([...document.querySelectorAll('input')].every((input) => input.value !== TEMPORARY_PASSWORD))
      .toBe(true);
    const persistedValues = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.getItem(window.localStorage.key(index) || ''),
    ).join('\n');
    expect(persistedValues).not.toContain(TEMPORARY_PASSWORD);
    const reopened = await openCreateDialog(user);
    expect((within(reopened).getByLabelText('临时密码') as HTMLInputElement).value).toBe('');
  });

  it('shows a stable conflict without raw body or temporary-password echo', async () => {
    const user = userEvent.setup();
    const error = Object.assign(new Error('操作失败，请稍后重试。'), {
      status: 409,
      code: 'SYSTEM_CONTROL_CONFLICT',
      body: `raw conflict ${TEMPORARY_PASSWORD}`,
    });
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => { throw error; }),
    };
    await renderPage(client);
    const dialog = await openCreateDialog(user);
    await fillValidForm(user);
    await user.click(within(dialog).getByRole('button', { name: '创建租户' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('租户标识已存在');
    expect(document.body.textContent).not.toContain('raw conflict');
    expect(document.body.textContent).not.toContain(TEMPORARY_PASSWORD);
  });

  it('supports Enter submission and Escape cancellation without persisting the secret', async () => {
    const user = userEvent.setup();
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(async () => tenant),
    };
    await renderPage(client);
    let dialog = await openCreateDialog(user);
    await fillValidForm(user);
    await user.type(within(dialog).getByLabelText('临时密码'), '{Enter}');
    await waitFor(() => expect(client.provisionTenant).toHaveBeenCalledTimes(1));

    dialog = await openCreateDialog(user);
    await user.type(within(dialog).getByLabelText('临时密码'), TEMPORARY_PASSWORD);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(TEMPORARY_PASSWORD);
    dialog = await openCreateDialog(user);
    expect((within(dialog).getByLabelText('临时密码') as HTMLInputElement).value).toBe('');
  });

  it('keeps the create dialog locked while provisioning is in flight', async () => {
    const user = userEvent.setup();
    const pending = deferred<TenantSummary>();
    const client = {
      listTenants: vi.fn(async () => ({ items: [], next_cursor: null })),
      provisionTenant: vi.fn(() => pending.promise),
    };
    await renderPage(client);
    const dialog = await openCreateDialog(user);
    await fillValidForm(user);

    await user.click(within(dialog).getByRole('button', { name: '创建租户' }));
    await waitFor(() => expect(client.provisionTenant).toHaveBeenCalledTimes(1));

    const cancel = within(dialog).getByRole('button', { name: '取消' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '创建租户' })).toBeTruthy();

    pending.resolve(tenant);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.provisionTenant).toHaveBeenCalledTimes(1);
  });

  it('searches tenants and filters by lifecycle status through the control API', async () => {
    const user = userEvent.setup();
    const listTenants = vi.fn(async (input?: TenantListInput) => {
      if (input?.status === 'suspended') return { items: [suspendedTenant], next_cursor: null };
      if (input?.query === 'alpha') return { items: [tenant], next_cursor: null };
      return { items: [tenant, suspendedTenant], next_cursor: null };
    });
    const client = createPageClient({ listTenants });
    await renderPage(client);

    expect(await screen.findByText('Alpha Lab')).toBeTruthy();
    expect(screen.getByText('Beta Lab')).toBeTruthy();

    const search = screen.getByRole('textbox', { name: '搜索租户' });
    await user.type(search, 'alpha');
    await waitFor(() => expect(listTenants).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'alpha' }),
    ));

    const status = screen.getByRole('combobox', { name: '租户状态' });
    await user.click(status);
    await user.click(screen.getByRole('option', { name: '已暂停' }));
    await waitFor(() => expect(listTenants).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'suspended' }),
    ));
    expect(screen.getByText('Beta Lab')).toBeTruthy();
    expect(screen.queryByText('Alpha Lab')).toBeNull();
  });

  it('opens a tenant detail view with immutable identity and no tenant business content', async () => {
    const user = userEvent.setup();
    const getTenant = vi.fn(async () => tenantDetail);
    const listTenantAudit = vi.fn(async (_tenantId: string) => ({ items: [], next_cursor: null }));
    const client = createPageClient({ getTenant, listTenantAudit });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    expect(getTenant).toHaveBeenCalledWith('tenant-alpha');
    expect(listTenantAudit).toHaveBeenCalled();
    expect(listTenantAudit.mock.calls[0]?.[0]).toBe('tenant-alpha');
    expect(within(detail).getByText('Alpha Lab')).toBeTruthy();
    expect(within(detail).getByText('alpha-lab')).toBeTruthy();
    expect(within(detail).getByText('admin')).toBeTruthy();
    expect(within(detail).queryByRole('textbox', { name: '租户标识' })).toBeNull();
    const rendered = detail.textContent || '';
    for (const forbidden of ['conversation', 'knowledge', 'prompt', 'artifact', 'password', 'token']) {
      expect(rendered.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('keeps the displayed detail aligned with the selected tenant when A arrives after B', async () => {
    const user = userEvent.setup();
    const detailA = deferred<TenantDetail>();
    const detailB = deferred<TenantDetail>();
    const getTenant = vi.fn((tenantId: string) => (
      tenantId === 'tenant-alpha' ? detailA.promise : detailB.promise
    ));
    const listTenantAudit = vi.fn(async () => ({ items: [], next_cursor: null }));
    const renameTenant = vi.fn(async () => ({ ...suspendedTenant, suspension_reason: 'maintenance' }));
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [tenant, suspendedTenant], next_cursor: null })),
      getTenant,
      listTenantAudit,
      renameTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    await waitFor(() => expect(getTenant).toHaveBeenCalledWith('tenant-alpha'));
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Beta Lab' }));
    await waitFor(() => expect(getTenant).toHaveBeenCalledWith('tenant-beta'));

    detailB.resolve({ ...suspendedTenant, suspension_reason: 'maintenance' });
    const detail = await screen.findByRole('region', { name: '租户详情' });
    expect(within(detail).getByText('Beta Lab')).toBeTruthy();

    detailA.resolve(tenantDetail);
    await waitFor(() => {
      const currentDetail = screen.getByRole('region', { name: '租户详情' });
      expect(within(currentDetail).getByText('Beta Lab')).toBeTruthy();
      expect(within(currentDetail).queryByText('Alpha Lab')).toBeNull();
    });

    await user.click(within(detail).getByRole('button', { name: '重命名租户' }));
    const renameDialog = screen.getByRole('dialog', { name: '重命名租户' });
    const renameInput = within(renameDialog).getByRole('textbox', { name: '新的租户名称' });
    expect((renameInput as HTMLInputElement).value).toBe('Beta Lab');
    await user.clear(renameInput);
    await user.type(renameInput, 'Beta Renamed');
    await user.click(within(renameDialog).getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(renameTenant).toHaveBeenCalledWith(
      'tenant-beta',
      { display_name: 'Beta Renamed' },
    ));
  });

  it('suppresses an out-of-order list response from an older search query', async () => {
    const initialTenant: TenantSummary = { ...tenant, display_name: 'Initial Tenant' };
    const alphaResult: TenantSummary = {
      ...tenant,
      id: 'tenant-alpha-result',
      slug: 'alpha-result',
      display_name: 'Alpha Query Result',
    };
    const betaResult: TenantSummary = {
      ...suspendedTenant,
      id: 'tenant-beta-result',
      slug: 'beta-result',
      display_name: 'Beta Query Result',
    };
    const requests: Array<{
      input?: TenantListInput;
      deferred: ReturnType<typeof deferred<{ items: TenantSummary[]; next_cursor: string | null }>>;
    }> = [];
    const listTenants = vi.fn((input?: TenantListInput) => {
      const request = { input, deferred: deferred<{ items: TenantSummary[]; next_cursor: string | null }>() };
      requests.push(request);
      return request.deferred.promise;
    });
    const client = createPageClient({ listTenants });
    await renderPage(client);
    expect(requests).toHaveLength(1);

    requests[0].deferred.resolve({ items: [initialTenant], next_cursor: null });
    await screen.findByText('Initial Tenant');

    const search = screen.getByRole('textbox', { name: '搜索租户' });
    fireEvent.change(search, { target: { value: 'alpha' } });
    await waitFor(() => expect(requests).toHaveLength(2));
    fireEvent.change(search, { target: { value: 'beta' } });
    await waitFor(() => expect(requests).toHaveLength(3));

    requests[2].deferred.resolve({ items: [betaResult], next_cursor: null });
    await screen.findByText('Beta Query Result');
    requests[1].deferred.resolve({ items: [alphaResult], next_cursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitFor(() => {
      expect(screen.getByText('Beta Query Result')).toBeTruthy();
      expect(screen.queryByText('Alpha Query Result')).toBeNull();
    });
  });

  it('loads more tenants with the current query and status and blocks duplicate pending requests', async () => {
    const user = userEvent.setup();
    const nextPage = deferred<{ items: TenantSummary[]; next_cursor: string | null }>();
    const secondTenant: TenantSummary = {
      ...tenant,
      id: 'tenant-gamma',
      slug: 'gamma-lab',
      display_name: 'Gamma Lab',
    };
    const calls: Array<TenantListInput | undefined> = [];
    const listTenants = vi.fn(async (input?: TenantListInput) => {
      calls.push(input);
      if (input?.cursor === 'tenant-next') return nextPage.promise;
      return { items: [tenant], next_cursor: 'tenant-next' };
    });
    const client = createPageClient({ listTenants });
    await renderPage(client);

    const search = screen.getByRole('textbox', { name: '搜索租户' });
    fireEvent.change(search, { target: { value: 'alpha' } });
    await waitFor(() => expect(calls[calls.length - 1]).toEqual({ query: 'alpha' }));
    const status = screen.getByRole('combobox', { name: '租户状态' });
    fireEvent.change(status, { target: { value: 'active' } });
    await waitFor(() => expect(calls[calls.length - 1]).toEqual({ query: 'alpha', status: 'active' }));

    const loadMore = await screen.findByRole('button', { name: '加载更多租户' });
    await user.click(loadMore);
    await waitFor(() => expect(calls.filter((input) => input?.cursor === 'tenant-next')).toHaveLength(1));
    expect((loadMore as HTMLButtonElement).disabled).toBe(true);
    await user.click(loadMore);
    expect(calls.filter((input) => input?.cursor === 'tenant-next')).toHaveLength(1);

    nextPage.resolve({ items: [secondTenant], next_cursor: null });
    await screen.findByText('Gamma Lab');
    expect(screen.getByText('Alpha Lab')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多租户' })).toBeNull();
  });

  it('loads more tenant audit records with a cursor and blocks duplicate pending requests', async () => {
    const user = userEvent.setup();
    const nextPage = deferred<{ items: TenantAudit[]; next_cursor: string | null }>();
    const secondAudit: TenantAudit = {
      ...auditPage.items[0],
      id: 'audit-suspend-1',
      action: 'tenant.suspend',
      reason_code: 'SYSTEM_TENANT_SUSPENDED',
    };
    const calls: Array<{ tenantId: string; input?: { cursor?: string; limit?: number } }> = [];
    const listTenantAudit = vi.fn(async (
      tenantId: string,
      input?: { cursor?: string; limit?: number },
    ) => {
      calls.push({ tenantId, input });
      if (input?.cursor === 'audit-next') return nextPage.promise;
      return { items: [auditPage.items[0]], next_cursor: 'audit-next' };
    });
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit,
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));

    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });
    expect(within(timeline).getByText('tenant.rename')).toBeTruthy();
    const loadMore = await within(timeline).findByRole('button', { name: '加载更多审计记录' });
    await user.click(loadMore);
    await waitFor(() => expect(calls.filter(({ input }) => input?.cursor === 'audit-next')).toHaveLength(1));
    expect((loadMore as HTMLButtonElement).disabled).toBe(true);
    await user.click(loadMore);
    expect(calls.filter(({ input }) => input?.cursor === 'audit-next')).toHaveLength(1);

    nextPage.resolve({ items: [secondAudit], next_cursor: null });
    await within(timeline).findByText('tenant.suspend');
    expect(within(timeline).getByText('tenant.rename')).toBeTruthy();
    expect(within(timeline).queryByRole('button', { name: '加载更多审计记录' })).toBeNull();
  });

  it('discards an older audit page when rename refreshes the selected tenant audit', async () => {
    const user = userEvent.setup();
    const stalePage = deferred<{ items: TenantAudit[]; next_cursor: string | null }>();
    const staleAudit: TenantAudit = {
      ...auditPage.items[0],
      id: 'audit-stale-page',
      action: 'tenant.stale_page',
    };
    const refreshedAudit: TenantAudit = {
      ...auditPage.items[0],
      id: 'audit-refresh-after-rename',
      action: 'tenant.rename_refreshed',
    };
    let initialAuditLoaded = false;
    const listTenantAudit = vi.fn(async (
      _tenantId: string,
      input?: { cursor?: string; limit?: number },
    ) => {
      if (input?.cursor === 'audit-next') return stalePage.promise;
      if (!initialAuditLoaded) {
        initialAuditLoaded = true;
        return { items: [auditPage.items[0]], next_cursor: 'audit-next' };
      }
      return { items: [refreshedAudit], next_cursor: null };
    });
    const renameTenant = vi.fn(async (_tenantId: string, input: { display_name: string }) => ({
      ...tenantDetail,
      display_name: input.display_name,
    }));
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit,
      renameTenant,
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));

    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });
    await user.click(await within(timeline).findByRole('button', { name: '加载更多审计记录' }));
    await waitFor(() => expect(listTenantAudit).toHaveBeenCalledWith(
      'tenant-alpha',
      { cursor: 'audit-next', limit: 50 },
    ));

    const detail = screen.getByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '重命名租户' }));
    const dialog = screen.getByRole('dialog', { name: '重命名租户' });
    const displayName = within(dialog).getByRole('textbox', { name: '新的租户名称' });
    await user.clear(displayName);
    await user.type(displayName, 'Alpha Renamed');
    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }));
    await within(timeline).findByText('tenant.rename_refreshed');

    stalePage.resolve({ items: [staleAudit], next_cursor: 'stale-next' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(within(timeline).queryByText('tenant.stale_page')).toBeNull();
    expect(within(timeline).queryByRole('button', { name: '加载更多审计记录' })).toBeNull();
  });

  it('renames only the display name and keeps the tenant slug immutable', async () => {
    const user = userEvent.setup();
    const renameTenant = vi.fn(async (_tenantId: string, input: { display_name: string }) => ({
      ...tenantDetail,
      display_name: input.display_name,
    }));
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      renameTenant,
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '重命名租户' }));

    const dialog = screen.getByRole('dialog', { name: '重命名租户' });
    const displayName = within(dialog).getByRole('textbox', { name: '新的租户名称' });
    await user.clear(displayName);
    await user.type(displayName, 'Alpha Renamed');
    expect(within(dialog).queryByRole('textbox', { name: '租户标识' })).toBeNull();
    expect(renameTenant).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(renameTenant).toHaveBeenCalledWith(
      'tenant-alpha',
      { display_name: 'Alpha Renamed' },
    ));
    expect(document.body.textContent).toContain('alpha-lab');
    expect(document.body.textContent).toContain('Alpha Renamed');
  });

  it('requires explicit confirmation before resetting a temporary password and never echoes it', async () => {
    const user = userEvent.setup();
    const resetInitialAdminPassword = vi.fn(async () => undefined);
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      resetInitialAdminPassword,
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '重置初始管理员临时密码' }));

    const dialog = screen.getByRole('dialog', { name: '重置初始管理员临时密码' });
    expect(within(dialog).getByText(/现有会话/)).toBeTruthy();
    const password = within(dialog).getByRole('textbox', { name: '新的临时密码' });
    expect(password.getAttribute('type')).toBe('password');
    await user.type(password, TEMPORARY_PASSWORD);
    expect(resetInitialAdminPassword).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '确认重置临时密码' }));
    await waitFor(() => expect(resetInitialAdminPassword).toHaveBeenCalledWith(
      'tenant-alpha',
      { temporary_password: TEMPORARY_PASSWORD },
    ));
    expect(document.body.textContent).not.toContain(TEMPORARY_PASSWORD);
    expect(document.body.innerHTML).not.toContain(TEMPORARY_PASSWORD);
    const persistedValues = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.getItem(window.localStorage.key(index) || ''),
    ).join('\n');
    expect(persistedValues).not.toContain(TEMPORARY_PASSWORD);
  });

  it('shows a stable reset failure without rendering raw response content or credentials', async () => {
    const user = userEvent.setup();
    const raw = `raw-reset-failure-${TEMPORARY_PASSWORD}`;
    const resetInitialAdminPassword = vi.fn(async () => {
      throw new Error(raw);
    });
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      resetInitialAdminPassword,
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '重置初始管理员临时密码' }));
    const dialog = screen.getByRole('dialog', { name: '重置初始管理员临时密码' });
    await user.type(within(dialog).getByRole('textbox', { name: '新的临时密码' }), TEMPORARY_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: '确认重置临时密码' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('重置临时密码失败');
    expect(document.body.textContent).not.toContain(raw);
    expect(document.body.textContent).not.toContain(TEMPORARY_PASSWORD);
  });

  it('renders a secret-safe control audit timeline with actor, result, reason, and correlation data', async () => {
    const user = userEvent.setup();
    const maliciousAudit: { items: TenantAudit[]; next_cursor: string | null } = {
      ...auditPage,
      items: auditPage.items.map((entry) => ({
        ...entry,
        password: 'audit-password-secret',
        token: 'audit-token-secret',
        prompt: 'private prompt body',
        conversation: 'private conversation body',
        artifact: 'private artifact body',
      })) as TenantAudit[],
    };
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async (_tenantId: string) => maliciousAudit),
    });
    await renderPage(client);
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));

    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });
    expect(within(timeline).getAllByText('root')).toHaveLength(2);
    expect(within(timeline).getByText('tenant.rename')).toBeTruthy();
    expect(within(timeline).getByText('SYSTEM_TENANT_RENAMED')).toBeTruthy();
    expect(within(timeline).getByText('request-rename-1')).toBeTruthy();
    expect(within(timeline).getByText('trace-reset-1')).toBeTruthy();
    const rendered = timeline.textContent || '';
    for (const forbidden of [
      'audit-password-secret',
      'audit-token-secret',
      'private prompt body',
      'private conversation body',
      'private artifact body',
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it('shows system-owned Codex runtime status separately from tenant inventory and omits secrets', async () => {
    const runtimeWithForbiddenFields = {
      ...runtimeStatus,
      credential: 'codex-credential-secret',
      prompt: 'codex private prompt',
      task: 'codex private task',
      artifact: 'codex private artifact',
    };
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [tenant], next_cursor: null })),
      getCodexA2ARuntimeStatus: vi.fn(async () => runtimeWithForbiddenFields),
    });
    await renderPage(client);

    const runtime = await screen.findByRole('region', { name: '系统运行时状态' });
    expect(client.getCodexA2ARuntimeStatus).toHaveBeenCalledTimes(1);
    expect(within(runtime).getByText('codex')).toBeTruthy();
    expect(within(runtime).getByText('/srv/staffdeck/codex-runtime')).toBeTruthy();
    expect(within(runtime).getByText('45')).toBeTruthy();
    expect(await screen.findByText('Alpha Lab')).toBeTruthy();
    expect(screen.queryByText('Codex runtime tenant')).toBeNull();
    const rendered = runtime.textContent || '';
    for (const forbidden of [
      'codex-credential-secret',
      'codex private prompt',
      'codex private task',
      'codex private artifact',
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it('keeps detail, audit, and runtime loading/error states accessible and retryable', async () => {
    const user = userEvent.setup();
    const detailPending = deferred<TenantDetail>();
    const auditPending = deferred<typeof auditPage>();
    const runtimePending = deferred<RuntimeStatus>();
    const getTenant = vi.fn(() => detailPending.promise);
    const listTenantAudit = vi.fn(() => auditPending.promise);
    const getCodexA2ARuntimeStatus = vi.fn(() => runtimePending.promise);
    const client = createPageClient({ getTenant, listTenantAudit, getCodexA2ARuntimeStatus });
    await renderPage(client);

    expect(await screen.findByRole('status', { name: '正在加载系统运行时状态' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    expect(await screen.findByRole('status', { name: '正在加载租户详情' })).toBeTruthy();
    detailPending.reject(new Error('raw-detail-failure'));
    auditPending.reject(new Error('raw-audit-failure'));
    runtimePending.reject(new Error('raw-runtime-failure'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw-detail-failure');
    expect(document.body.textContent).not.toContain('raw-audit-failure');
    expect(document.body.textContent).not.toContain('raw-runtime-failure');
  });

  it('requires a non-empty suspension reason and explicit confirmation before suspending a tenant', async () => {
    const user = userEvent.setup();
    const suspendTenant = vi.fn(async (_tenantId: string, input: TenantSuspendInput) => ({
      ...suspendedTenantDetail,
      suspension_reason: input.reason,
    }));
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      suspendTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));

    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    const reason = within(dialog).getByRole('textbox', { name: '暂停原因' });
    const confirm = within(dialog).getByRole('button', { name: '确认暂停租户' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(confirm);

    expect(within(dialog).getByRole('alert').textContent).toContain('请输入暂停原因');
    expect(suspendTenant).not.toHaveBeenCalled();

    await user.type(reason, 'billing hold');
    await user.click(confirm);
    await waitFor(() => expect(suspendTenant).toHaveBeenCalledWith(
      'tenant-alpha',
      { reason: 'billing hold' },
    ));
    expect(within(detail).getByText('已暂停')).toBeTruthy();
    expect(within(detail).getByText('billing hold')).toBeTruthy();
  });

  it('keeps suspend and reactivate confirmations modal for destructive lifecycle actions', async () => {
    const user = userEvent.setup();
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [tenant, suspendedTenant], next_cursor: null })),
      getTenant: vi.fn(async (tenantId: string) => (
        tenantId === 'tenant-beta' ? suspendedTenantDetail : tenantDetail
      )),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    let detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    let dialog = screen.getByRole('dialog', { name: '暂停租户' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Beta Lab' }));
    detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '恢复租户' }));
    dialog = screen.getByRole('dialog', { name: '恢复租户' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('associates the required suspension reason validation with its field', async () => {
    const user = userEvent.setup();
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    const reason = within(dialog).getByRole('textbox', { name: '暂停原因' });
    expect(reason.getAttribute('aria-required')).toBe('true');

    await user.click(within(dialog).getByRole('button', { name: '确认暂停租户' }));

    await waitFor(() => expect(reason.getAttribute('aria-invalid')).toBe('true'));
    const describedBy = reason.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy || '')?.textContent).toContain('请输入暂停原因');
  });

  it.each([
    ['zh-CN', '查看租户详情：Beta Lab', '暂停时间', '恢复时间', '恢复租户', '恢复租户', '确认恢复租户'],
    ['en-US', 'View tenant details: Beta Lab', 'Suspended at', 'Reactivated at', 'Reactivate tenant', 'Reactivate tenant', 'Confirm reactivation'],
  ] as const)('localizes and labels lifecycle timestamps in %s', async (
    locale,
    detailTriggerName,
    suspendedAtLabel,
    reactivatedAtLabel,
    reactivateAction,
    dialogName,
    confirmLabel,
  ) => {
    const user = userEvent.setup();
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [suspendedTenant], next_cursor: null })),
      getTenant: vi.fn(async () => suspendedTenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      reactivateTenant: vi.fn(async () => reactivatedTenantDetail),
    });
    await renderPage(client, locale);

    await user.click(await screen.findByRole('button', { name: detailTriggerName }));
    const detail = await screen.findByRole('region', { name: locale === 'zh-CN' ? '租户详情' : 'Tenant details' });
    expect(within(detail).getByText(suspendedAtLabel)).toBeTruthy();
    expect(detail.textContent).toContain('2026');
    expect(detail.textContent).not.toContain('2026-08-31T01:00:00Z');

    await user.click(within(detail).getByRole('button', { name: reactivateAction }));
    const dialog = screen.getByRole('dialog', { name: dialogName });
    await user.click(within(dialog).getByRole('button', { name: confirmLabel }));

    await waitFor(() => expect(within(detail).getByText(reactivatedAtLabel)).toBeTruthy());
    expect(detail.textContent).toContain('2026');
    expect(detail.textContent).not.toContain('2026-08-31T03:00:00Z');
  });

  it('displays suspension evidence and requires confirmation before reactivating a tenant', async () => {
    const user = userEvent.setup();
    const reactivateTenant = vi.fn(async () => reactivatedTenantDetail);
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [suspendedTenant], next_cursor: null })),
      getTenant: vi.fn(async () => suspendedTenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      reactivateTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Beta Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    expect(within(detail).getByText('已暂停')).toBeTruthy();
    expect(within(detail).getByText('billing hold')).toBeTruthy();

    await user.click(within(detail).getByRole('button', { name: '恢复租户' }));
    const dialog = screen.getByRole('dialog', { name: '恢复租户' });
    expect(within(dialog).getByText(/恢复后/)).toBeTruthy();
    expect(reactivateTenant).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(reactivateTenant).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole('button', { name: '恢复租户' }));
    await user.click(screen.getByRole('button', { name: '确认恢复租户' }));
    await waitFor(() => expect(reactivateTenant).toHaveBeenCalledWith('tenant-beta'));
    expect(within(detail).getByText('启用')).toBeTruthy();
    expect(within(detail).getByText('恢复时间')).toBeTruthy();
    expect(detail.textContent).not.toContain('2026-08-31T03:00:00Z');
  });

  it('accepts an idempotent suspend response without exposing a duplicate transition', async () => {
    const user = userEvent.setup();
    const idempotentSuspension: TenantDetail = {
      ...suspendedTenantDetail,
      lifecycle_version: 3,
      suspension_reason: 'already suspended by another operator',
    };
    const suspendTenant = vi.fn(async () => idempotentSuspension);
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      suspendTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    await user.type(within(dialog).getByRole('textbox', { name: '暂停原因' }), 'operator retry');
    await user.click(within(dialog).getByRole('button', { name: '确认暂停租户' }));

    await waitFor(() => expect(suspendTenant).toHaveBeenCalledTimes(1));
    expect(within(detail).getByText('已暂停')).toBeTruthy();
    expect(within(detail).getByText('already suspended by another operator')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '恢复租户' })).toBeTruthy();
  });

  it('renders the actor for every control audit record', async () => {
    const user = userEvent.setup();
    const secondAudit = {
      ...auditPage.items[1],
      actor_system_admin_id: 'sysadmin-second',
      actor_label: 'second-operator',
    };
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({
        items: [auditPage.items[0], secondAudit],
        next_cursor: null,
      })),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });
    const records = within(timeline).getAllByRole('listitem');
    expect(records).toHaveLength(2);
    expect(within(records[0]).getByText('root')).toBeTruthy();
    expect(within(records[1]).getByText('second-operator')).toBeTruthy();
  });

  it('shows a retryable audit refresh error without reporting a successful suspension as failed', async () => {
    const user = userEvent.setup();
    let auditCalls = 0;
    const refreshedAudit: TenantAudit = {
      ...auditPage.items[0],
      id: 'audit-suspend-after-retry',
      action: 'tenant.suspend',
      reason_code: 'SYSTEM_TENANT_SUSPENDED',
    };
    const listTenantAudit = vi.fn(async () => {
      auditCalls += 1;
      if (auditCalls === 1) return auditPage;
      if (auditCalls === 2) throw new Error('raw-audit-refresh-failure');
      return { items: [refreshedAudit], next_cursor: null };
    });
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit,
      suspendTenant: vi.fn(async () => suspendedTenantDetail),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    await user.type(within(dialog).getByRole('textbox', { name: '暂停原因' }), 'maintenance');
    await user.click(within(dialog).getByRole('button', { name: '确认暂停租户' }));

    await waitFor(() => expect(within(detail).getByText('已暂停')).toBeTruthy());
    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });
    const auditAlert = await within(timeline).findByRole('alert');
    expect(auditAlert.textContent).toContain('审计');
    expect(auditAlert.textContent).not.toContain('暂停租户失败');
    expect(auditAlert.textContent).not.toContain('raw-audit-refresh-failure');

    await user.click(within(timeline).getByRole('button', { name: '重试' }));
    await within(timeline).findByText('tenant.suspend');
    expect(listTenantAudit).toHaveBeenCalledTimes(3);
  });

  it('fails closed when tenant lifecycle status is unknown', async () => {
    const user = userEvent.setup();
    const unknownTenant = {
      ...tenant,
      status: 'pending' as unknown as TenantSummary['status'],
    } as TenantSummary;
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [unknownTenant], next_cursor: null })),
      getTenant: vi.fn(async () => ({ ...unknownTenant, suspension_reason: null } as TenantDetail)),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    expect(within(detail).getByText('Alpha Lab')).toBeTruthy();
    expect(within(detail).queryByText('启用')).toBeNull();
    expect(within(detail).queryByRole('button', { name: '暂停租户' })).toBeNull();
  });

  it('fails closed when an audit result is unknown', async () => {
    const user = userEvent.setup();
    const unknownAudit = {
      ...auditPage.items[0],
      result: 'timed_out' as unknown as TenantAudit['result'],
    } as TenantAudit;
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [unknownAudit], next_cursor: null })),
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const timeline = await screen.findByRole('region', { name: '租户控制审计历史' });

    expect(within(timeline).queryByText('成功')).toBeNull();
  });

  it('renders a stable denial for a rejected suspension and never renders raw error content', async () => {
    const user = userEvent.setup();
    const raw = 'raw-control-denial-with-private-provider-body';
    const suspendTenant = vi.fn(async () => {
      throw Object.assign(new Error(raw), {
        status: 403,
        code: 'TENANT_NOT_FOUND',
        body: raw,
      });
    });
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      suspendTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    const detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    await user.type(within(dialog).getByRole('textbox', { name: '暂停原因' }), 'maintenance');
    await user.click(within(dialog).getByRole('button', { name: '确认暂停租户' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('暂停租户失败');
    expect(document.body.textContent).not.toContain(raw);
    expect(document.body.innerHTML).not.toContain(raw);
  });

  it('keeps lifecycle controls busy and fences a late suspension response after tenant selection changes', async () => {
    const user = userEvent.setup();
    const pending = deferred<TenantDetail>();
    const getTenant = vi.fn(async (tenantId: string) => (
      tenantId === 'tenant-alpha' ? tenantDetail : suspendedTenantDetail
    ));
    const suspendTenant = vi.fn(() => pending.promise);
    const client = createPageClient({
      listTenants: vi.fn(async () => ({ items: [tenant, suspendedTenant], next_cursor: null })),
      getTenant,
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      suspendTenant,
    });
    await renderPage(client);

    await user.click(await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' }));
    let detail = await screen.findByRole('region', { name: '租户详情' });
    await user.click(within(detail).getByRole('button', { name: '暂停租户' }));
    const dialog = screen.getByRole('dialog', { name: '暂停租户' });
    await user.type(within(dialog).getByRole('textbox', { name: '暂停原因' }), 'late response test');
    await user.click(within(dialog).getByRole('button', { name: '确认暂停租户' }));

    await waitFor(() => expect(suspendTenant).toHaveBeenCalledTimes(1));
    expect((within(dialog).getByRole('button', { name: '确认暂停租户' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('true');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '暂停租户' })).toBeNull());
    await user.click(await screen.findByRole('button', { name: '查看租户详情：Beta Lab' }));
    detail = await screen.findByRole('region', { name: '租户详情' });
    expect(within(detail).getByText('Beta Lab')).toBeTruthy();
    pending.resolve({ ...suspendedTenantDetail, suspension_reason: 'late response test' });

    await waitFor(() => {
      expect(within(detail).getByText('Beta Lab')).toBeTruthy();
      expect(within(detail).queryByText('late response test')).toBeNull();
    });
  });

  it.each([
    ['zh-CN', '查看租户详情：Alpha Lab', '租户详情', '暂停租户', '暂停租户', '暂停原因', '确认暂停租户'],
    ['en-US', 'View tenant details: Alpha Lab', 'Tenant details', 'Suspend tenant', 'Suspend tenant', 'Suspension reason', 'Confirm suspension'],
  ] as const)('localizes lifecycle controls and preserves keyboard/ARIA affordances in %s', async (
    locale,
    detailTriggerName,
    detailRegionName,
    suspendAction,
    dialogName,
    reasonLabel,
    confirmLabel,
  ) => {
    const user = userEvent.setup();
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      suspendTenant: vi.fn(async () => suspendedTenantDetail),
    });
    await renderPage(client, locale);

    const detailTrigger = await screen.findByRole('button', { name: detailTriggerName });
    detailTrigger.focus();
    await user.keyboard('{Enter}');
    const detail = await screen.findByRole('region', { name: detailRegionName });
    const suspendTrigger = within(detail).getByRole('button', { name: suspendAction });
    suspendTrigger.focus();
    await user.keyboard('{Enter}');

    const dialog = screen.getByRole('dialog', { name: dialogName });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: reasonLabel })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: confirmLabel })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
  });

  it.each([
    ['zh-CN', '租户管理', '搜索租户', '系统运行时状态'],
    ['en-US', 'Tenant management', 'Search tenants', 'System runtime status'],
  ] as const)('localizes system tenant controls and accessible names in %s', async (
    locale,
    title,
    searchLabel,
    runtimeLabel,
  ) => {
    const client = createPageClient({
      getCodexA2ARuntimeStatus: vi.fn(async () => runtimeStatus),
    });
    await renderPage(client, locale);

    expect(document.documentElement.lang).toBe(locale);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: searchLabel })).toBeTruthy();
    expect(screen.getByRole('region', { name: runtimeLabel })).toBeTruthy();
    expect(await screen.findByText('Alpha Lab')).toBeTruthy();
  });

  it('supports keyboard-only detail and dialog actions with labelled status and password controls', async () => {
    const user = userEvent.setup();
    const client = createPageClient({
      getTenant: vi.fn(async () => tenantDetail),
      listTenantAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
    });
    await renderPage(client);

    const detailTrigger = await screen.findByRole('button', { name: '查看租户详情：Alpha Lab' });
    detailTrigger.focus();
    await user.keyboard('{Enter}');
    const detail = await screen.findByRole('region', { name: '租户详情' });
    const renameTrigger = within(detail).getByRole('button', { name: '重命名租户' });
    renameTrigger.focus();
    await user.keyboard('{Enter}');
    const renameDialog = screen.getByRole('dialog', { name: '重命名租户' });
    expect(renameDialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(renameDialog).getByRole('textbox', { name: '新的租户名称' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名租户' })).toBeNull());

    const resetTrigger = within(detail).getByRole('button', { name: '重置初始管理员临时密码' });
    resetTrigger.focus();
    await user.keyboard('{Enter}');
    const resetDialog = screen.getByRole('dialog', { name: '重置初始管理员临时密码' });
    expect(resetDialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(resetDialog).getByRole('textbox', { name: '新的临时密码' }).getAttribute('type'))
      .toBe('password');
  });
});

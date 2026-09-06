import { expect, test, type Page, type Route } from '@playwright/test';

import { expectNoHorizontalOverflow } from './fixtures';

type Locale = 'zh-CN' | 'en-US';
type TenantStatus = 'active' | 'suspended';

type TenantRecord = {
  id: string;
  slug: string;
  display_name: string;
  status: TenantStatus;
  lifecycle_version: number;
  initial_admin: {
    id: string;
    username: string;
    display_name: string;
    role: 'admin';
  };
  suspended_at: string | null;
  reactivated_at: string | null;
  suspension_reason: string | null;
  created_at: string;
  updated_at: string;
};

type AuditRecord = {
  id: string;
  actor_system_admin_id: string;
  actor_label: string;
  action: string;
  target_type: 'tenant';
  target_id: string;
  result: 'succeeded';
  reason_code: string;
  operator_reason: string | null;
  status_before: TenantStatus;
  status_after: TenantStatus;
  lifecycle_version: number;
  request_id: string;
  trace_id: string;
  safe_params: Record<string, string | number | boolean>;
  created_at: string;
};

type TenantSession = {
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
    display_name: string;
    role: 'admin' | 'member';
    must_change_password: boolean;
    avatar_url: string | null;
  };
};

type LifecycleMutation = {
  tenantId: string;
  method: string;
  body: Record<string, unknown>;
};

type TenantRequest = {
  url: string;
  path: string;
  authorization: string;
};

type MockControlPlane = {
  tenants: Map<string, TenantRecord>;
  audits: Map<string, AuditRecord[]>;
  lifecycleMutations: LifecycleMutation[];
  tenantRequests: TenantRequest[];
};

const SYSTEM_AUTH_STORAGE_KEY = 'ultrarag_system_auth';
const ENTERPRISE_AUTH_STORAGE_KEY = 'ultrarag_auth';
const ONBOARDING_SEEN_STORAGE_KEY = 'firmdeck_onboarding_guide_seen';
const QUICK_START_SEEN_STORAGE_KEY = 'firmdeck_quick_start_guide_seen';
const ALPHA_SCOPE_KEY = 'skill_agent:tenant-user:v1:["tenant-alpha","user-alpha-admin","selected-agent"]';
const BETA_SCOPE_KEY = 'skill_agent:tenant-user:v1:["tenant-beta","user-beta-admin","selected-agent"]';
const SYSTEM_TOKEN = 'e2e-system-token';

const SYSTEM_ADMIN = {
  id: 'sysadmin-e2e',
  username: 'root',
  display_name: 'E2E Root',
  status: 'active' as const,
  must_change_password: false,
  last_login_at: '2026-08-31T00:00:00Z',
  created_at: '2026-08-30T00:00:00Z',
};

const SYSTEM_SESSION = {
  token: SYSTEM_TOKEN,
  scope: 'system' as const,
  system_admin: SYSTEM_ADMIN,
};

const TENANT_SESSIONS: Record<'alpha' | 'beta', TenantSession> = {
  alpha: {
    token: 'e2e-tenant-token-a',
    scope: 'tenant',
    tenant: { id: 'tenant-alpha', slug: 'alpha-lab', display_name: 'Alpha Lab' },
    user: {
      id: 'user-alpha-admin',
      tenant_id: 'tenant-alpha',
      username: 'admin',
      display_name: 'Alpha Operator',
      role: 'admin',
      must_change_password: false,
      avatar_url: null,
    },
  },
  beta: {
    token: 'e2e-tenant-token-b',
    scope: 'tenant',
    tenant: { id: 'tenant-beta', slug: 'beta-lab', display_name: 'Beta Lab' },
    user: {
      id: 'user-beta-admin',
      tenant_id: 'tenant-beta',
      username: 'admin',
      display_name: 'Beta Operator',
      role: 'admin',
      must_change_password: false,
      avatar_url: null,
    },
  },
};

const LOCALE_COPY: Record<Locale, {
  tenantTitle: string;
  detailA: string;
  detailB: string;
  detailRegion: string;
  suspendAction: string;
  suspendTitle: string;
  suspendReason: string;
  suspendConfirm: string;
  suspendRequired: string;
  suspended: string;
  reactivateAction: string;
  reactivateTitle: string;
  reactivateConfirm: string;
  active: string;
  auditTitle: string;
  systemLoginTitle: string;
  systemUsername: string;
  systemSubmit: string;
  tenantLoginAction: string;
  tenantSlug: string;
  account: string;
  password: string;
  accountTitle: string;
  accountMenu: string;
  logout: string;
}> = {
  'zh-CN': {
    tenantTitle: '租户管理',
    detailA: '查看租户详情：Alpha Lab',
    detailB: '查看租户详情：Beta Lab',
    detailRegion: '租户详情',
    suspendAction: '暂停租户',
    suspendTitle: '暂停租户',
    suspendReason: '暂停原因',
    suspendConfirm: '确认暂停租户',
    suspendRequired: '请输入暂停原因',
    suspended: '已暂停',
    reactivateAction: '恢复租户',
    reactivateTitle: '恢复租户',
    reactivateConfirm: '确认恢复租户',
    active: '启用',
    auditTitle: '租户控制审计历史',
    systemLoginTitle: '系统管理员登录',
    systemUsername: '系统管理员账号',
    systemSubmit: '登录系统控制台',
    tenantLoginAction: '登录',
    tenantSlug: '租户标识',
    account: '账号',
    password: '密码',
    accountTitle: '账号管理',
    accountMenu: '账户菜单',
    logout: '退出登录',
  },
  'en-US': {
    tenantTitle: 'Tenant management',
    detailA: 'View tenant details: Alpha Lab',
    detailB: 'View tenant details: Beta Lab',
    detailRegion: 'Tenant details',
    suspendAction: 'Suspend tenant',
    suspendTitle: 'Suspend tenant',
    suspendReason: 'Suspension reason',
    suspendConfirm: 'Confirm suspension',
    suspendRequired: 'Enter a suspension reason',
    suspended: 'Suspended',
    reactivateAction: 'Reactivate tenant',
    reactivateTitle: 'Reactivate tenant',
    reactivateConfirm: 'Confirm reactivation',
    active: 'Active',
    auditTitle: 'Tenant control audit history',
    systemLoginTitle: 'System administrator sign in',
    systemUsername: 'System administrator account',
    systemSubmit: 'Sign in to system console',
    tenantLoginAction: 'Log in',
    tenantSlug: 'Tenant slug',
    account: 'Account',
    password: 'Password',
    accountTitle: 'Account management',
    accountMenu: 'Account menu',
    logout: 'Log out',
  },
};

function createTenant(overrides: Partial<TenantRecord>): TenantRecord {
  const id = overrides.id || 'tenant-alpha';
  const slug = overrides.slug || 'alpha-lab';
  const displayName = overrides.display_name || 'Alpha Lab';
  const adminId = id === 'tenant-beta' ? 'user-beta-admin' : 'user-alpha-admin';
  const adminName = id === 'tenant-beta' ? 'Beta Operator' : 'Alpha Operator';
  return {
    id,
    slug,
    display_name: displayName,
    status: 'active',
    lifecycle_version: 1,
    initial_admin: {
      id: adminId,
      username: 'admin',
      display_name: adminName,
      role: 'admin',
    },
    suspended_at: null,
    reactivated_at: null,
    suspension_reason: null,
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:00Z',
    ...overrides,
  };
}

function createAudit(
  tenantId: string,
  action: string,
  version: number,
  statusBefore: TenantStatus,
  statusAfter: TenantStatus,
  suffix: string,
): AuditRecord {
  return {
    id: `audit-${tenantId}-${suffix}`,
    actor_system_admin_id: SYSTEM_ADMIN.id,
    actor_label: SYSTEM_ADMIN.username,
    action,
    target_type: 'tenant',
    target_id: tenantId,
    result: 'succeeded',
    reason_code: action === 'tenant.suspend'
      ? 'SYSTEM_TENANT_SUSPENDED'
      : action === 'tenant.reactivate'
        ? 'SYSTEM_TENANT_REACTIVATED'
        : 'SYSTEM_TENANT_CONTROL',
    operator_reason: action === 'tenant.suspend' ? 'scheduled maintenance' : null,
    status_before: statusBefore,
    status_after: statusAfter,
    lifecycle_version: version,
    request_id: `request-${tenantId}-${suffix}`,
    trace_id: `trace-${tenantId}-${suffix}`,
    safe_params: { lifecycle_version: version },
    created_at: '2026-08-31T02:00:00Z',
  };
}

function jsonBody(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function requestBody(route: Route): Record<string, unknown> {
  try {
    const value: unknown = route.request().postDataJSON();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function installMockControlPlane(page: Page): Promise<MockControlPlane> {
  const tenants = new Map<string, TenantRecord>([
    ['tenant-alpha', createTenant({ id: 'tenant-alpha', slug: 'alpha-lab', display_name: 'Alpha Lab' })],
    ['tenant-beta', createTenant({
      id: 'tenant-beta',
      slug: 'beta-lab',
      display_name: 'Beta Lab',
      status: 'suspended',
      lifecycle_version: 3,
      initial_admin: {
        id: 'user-beta-admin',
        username: 'admin',
        display_name: 'Beta Operator',
        role: 'admin',
      },
      suspended_at: '2026-08-31T01:00:00Z',
      suspension_reason: 'billing hold',
    })],
  ]);
  const audits = new Map<string, AuditRecord[]>([
    ['tenant-alpha', [createAudit('tenant-alpha', 'tenant.rename', 1, 'active', 'active', 'initial')]],
    ['tenant-beta', [createAudit('tenant-beta', 'tenant.suspend', 3, 'active', 'suspended', 'initial')]],
  ]);
  const mock: MockControlPlane = {
    tenants,
    audits,
    lifecycleMutations: [],
    tenantRequests: [],
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method().toUpperCase();
    const authorization = request.headers().authorization || '';
    const tenantSession = Object.values(TENANT_SESSIONS).find(
      (session) => authorization === `Bearer ${session.token}`,
    );

    // Match only backend API paths; Vite module URLs such as /src/api/client.ts
    // must continue to the dev server instead of being fulfilled as mock APIs.
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    if (path.startsWith('/api/system/')) {
      if (authorization !== `Bearer ${SYSTEM_TOKEN}`) {
        await jsonBody(route, 401, { code: 'SYSTEM_AUTH_REQUIRED' });
        return;
      }

      if (path === '/api/system/auth/me' && method === 'GET') {
        await jsonBody(route, 200, SYSTEM_ADMIN);
        return;
      }
      if (path === '/api/system/runtimes/codex-a2a' && method === 'GET') {
        await jsonBody(route, 200, {
          key: 'codex_a2a',
          enabled: false,
          credential_configured: false,
          command: '—',
          workspace_root: '—',
          timeout_seconds: 45,
        });
        return;
      }
      if (path === '/api/system/tenants' && method === 'GET') {
        const query = url.searchParams.get('query')?.trim().toLowerCase() || '';
        const status = url.searchParams.get('status');
        const items = Array.from(tenants.values()).filter((tenant) => {
          const matchesQuery = !query
            || [tenant.id, tenant.slug, tenant.display_name, tenant.initial_admin.username]
              .some((value) => value.toLowerCase().includes(query));
          const matchesStatus = status !== 'active' && status !== 'suspended' || tenant.status === status;
          return matchesQuery && matchesStatus;
        });
        await jsonBody(route, 200, { items, next_cursor: null });
        return;
      }

      const tenantPath = path.match(/^\/api\/system\/tenants\/([^/]+)(?:\/(audit|suspend|reactivate))?$/);
      if (tenantPath) {
        const tenantId = decodeURIComponent(tenantPath[1]);
        const operation = tenantPath[2];
        const tenant = tenants.get(tenantId);
        if (!tenant) {
          await jsonBody(route, 404, { code: 'SYSTEM_TENANT_NOT_FOUND' });
          return;
        }
        if (!operation && method === 'GET') {
          await jsonBody(route, 200, tenant);
          return;
        }
        if (operation === 'audit' && method === 'GET') {
          await jsonBody(route, 200, { items: audits.get(tenantId) || [], next_cursor: null });
          return;
        }
        if (operation === 'suspend' && method === 'POST') {
          const body = requestBody(route);
          mock.lifecycleMutations.push({ tenantId, method, body });
          if (tenant.status === 'active') {
            const version = tenant.lifecycle_version + 1;
            const reason = typeof body.reason === 'string' ? body.reason : '';
            const updated = {
              ...tenant,
              status: 'suspended' as const,
              lifecycle_version: version,
              suspended_at: '2026-08-31T04:00:00Z',
              reactivated_at: null,
              suspension_reason: reason,
              updated_at: '2026-08-31T04:00:00Z',
            };
            tenants.set(tenantId, updated);
            audits.set(tenantId, [
              ...(audits.get(tenantId) || []),
              createAudit(tenantId, 'tenant.suspend', version, 'active', 'suspended', 'suspend'),
            ]);
          }
          await jsonBody(route, 200, tenants.get(tenantId));
          return;
        }
        if (operation === 'reactivate' && method === 'POST') {
          mock.lifecycleMutations.push({ tenantId, method, body: {} });
          if (tenant.status === 'suspended') {
            const version = tenant.lifecycle_version + 1;
            const updated = {
              ...tenant,
              status: 'active' as const,
              lifecycle_version: version,
              suspended_at: null,
              reactivated_at: '2026-08-31T05:00:00Z',
              suspension_reason: null,
              updated_at: '2026-08-31T05:00:00Z',
            };
            tenants.set(tenantId, updated);
            audits.set(tenantId, [
              ...(audits.get(tenantId) || []),
              createAudit(tenantId, 'tenant.reactivate', version, 'suspended', 'active', 'reactivate'),
            ]);
          }
          await jsonBody(route, 200, tenants.get(tenantId));
          return;
        }
      }

      await jsonBody(route, 405, { code: 'E2E_UNSUPPORTED_SYSTEM_METHOD' });
      return;
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = requestBody(route);
      const slug = typeof body.tenant_slug === 'string' ? body.tenant_slug : '';
      const session = Object.values(TENANT_SESSIONS).find((candidate) => candidate.tenant.slug === slug);
      if (!session) {
        await jsonBody(route, 401, { code: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }
      await jsonBody(route, 200, session);
      return;
    }

    if (path === '/api/auth/me' && method === 'GET') {
      mock.tenantRequests.push({ url: url.toString(), path, authorization });
      if (!tenantSession) {
        await jsonBody(route, 401, { code: 'AUTH_REQUIRED' });
        return;
      }
      await jsonBody(route, 200, tenantSession.user);
      return;
    }

    if (path === '/api/auth/users' && method === 'GET') {
      mock.tenantRequests.push({ url: url.toString(), path, authorization });
      if (!tenantSession) {
        await jsonBody(route, 401, { code: 'AUTH_REQUIRED' });
        return;
      }
      await jsonBody(route, 200, [{
        ...tenantSession.user,
        tenant_id: tenantSession.tenant.id,
        created_at: '2026-08-31T00:00:00Z',
        updated_at: '2026-08-31T00:00:00Z',
      }]);
      return;
    }

    if (path.startsWith('/api/enterprise/') || path.startsWith('/api/chat/')) {
      mock.tenantRequests.push({ url: url.toString(), path, authorization });
      await jsonBody(route, tenantSession ? 200 : 401, tenantSession ? [] : { code: 'AUTH_REQUIRED' });
      return;
    }

    await jsonBody(route, 404, { code: 'E2E_UNHANDLED_API' });
  });

  return mock;
}

async function seedStorage(
  page: Page,
  locale: Locale,
  options: { systemSession?: typeof SYSTEM_SESSION; tenantSession?: TenantSession } = {},
): Promise<void> {
  await page.addInitScript(
    ({ locale: storedLocale, systemSession, tenantSession, onboardingSeenStorageKey, quickStartSeenStorageKey }) => {
      const seedMarker = '__firmdeck_e2e_tenant_seeded__';
      if (window.sessionStorage.getItem(seedMarker) === '1') return;
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem('firmdeck_locale', storedLocale);
      // This fixture represents a returning user so the session-replacement assertions
      // exercise tenant data isolation instead of the unrelated first-run guide.
      window.localStorage.setItem(onboardingSeenStorageKey, '1');
      window.localStorage.setItem(quickStartSeenStorageKey, '1');
      if (systemSession) {
        window.localStorage.setItem('ultrarag_system_auth', JSON.stringify(systemSession));
      }
      if (tenantSession) {
        window.localStorage.setItem('ultrarag_auth', JSON.stringify(tenantSession));
      }
      window.sessionStorage.setItem(seedMarker, '1');
    },
    {
      locale,
      systemSession: options.systemSession,
      tenantSession: options.tenantSession,
      onboardingSeenStorageKey: ONBOARDING_SEEN_STORAGE_KEY,
      quickStartSeenStorageKey: QUICK_START_SEEN_STORAGE_KEY,
    },
  );
}

function copyFor(locale: Locale) {
  return LOCALE_COPY[locale];
}

function assertResponsiveProject(page: Page): void {
  const width = page.viewportSize()?.width || 0;
  if (test.info().project.name === 'mobile-chrome') {
    expect(width).toBeLessThan(600);
  } else {
    expect(width).toBeGreaterThanOrEqual(600);
  }
}

async function signInTenant(page: Page, locale: Locale, session: TenantSession): Promise<void> {
  const copy = copyFor(locale);
  await page.getByRole('button', { name: copy.tenantLoginAction, exact: true }).click();
  await page.getByRole('textbox', { name: copy.tenantSlug, exact: true }).fill(session.tenant.slug);
  await page.getByRole('textbox', { name: copy.account, exact: true }).fill(session.user.username);
  await page.getByLabel(copy.password, { exact: true }).fill('E2E-password-2026');
  await page.getByLabel(copy.password, { exact: true }).press('Enter');
  await expect.poll(async () => page.evaluate((storageKey) => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw)?.tenant?.id || null : null;
    } catch {
      return null;
    }
  }, ENTERPRISE_AUTH_STORAGE_KEY)).toBe(session.tenant.id);
}

test.describe('system tenant management browser matrix', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    test(`opens the tenant deep link with keyboard controls in ${locale}`, async ({ page }) => {
      const copy = copyFor(locale);
      await installMockControlPlane(page);
      await seedStorage(page, locale, { systemSession: SYSTEM_SESSION });
      await page.goto('/system/tenants?source=e2e');

      await expect(page).toHaveURL(/\/system\/tenants\?source=e2e$/);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { name: copy.tenantTitle, exact: true })).toBeVisible();
      await expect(page.getByText('Alpha Lab', { exact: true })).toBeVisible();
      await expect(page.getByText('Beta Lab', { exact: true })).toBeVisible();
      assertResponsiveProject(page);
      await expectNoHorizontalOverflow(page, 'main');

      const detailTrigger = page.getByRole('button', { name: copy.detailA, exact: true });
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await page.keyboard.press('Enter');

      const detail = page.getByRole('region', { name: copy.detailRegion, exact: true });
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('alpha-lab');
      await expect(detail).toContainText('root');
      await expect(page.getByRole('region', { name: copy.auditTitle, exact: true })).toBeVisible();
    });

    test(`requires confirmation and a reason for suspend/reactivate in ${locale}`, async ({ page }) => {
      const copy = copyFor(locale);
      const controlPlane = await installMockControlPlane(page);
      await seedStorage(page, locale, { systemSession: SYSTEM_SESSION });
      await page.goto('/system/tenants');
      await expect(page.getByRole('heading', { name: copy.tenantTitle, exact: true })).toBeVisible();

      await page.getByRole('button', { name: copy.detailA, exact: true }).click();
      const alphaDetail = page.getByRole('region', { name: copy.detailRegion, exact: true });
      await expect(alphaDetail).toBeVisible();
      await alphaDetail.getByRole('button', { name: copy.suspendAction, exact: true }).click();

      const suspendDialog = page.getByRole('dialog', { name: copy.suspendTitle, exact: true });
      await expect(suspendDialog).toBeVisible();
      await suspendDialog.getByRole('button', { name: copy.suspendConfirm, exact: true }).click();
      await expect(suspendDialog.getByRole('alert')).toContainText(copy.suspendRequired);
      await expect(suspendDialog.getByLabel(copy.suspendReason, { exact: true }))
        .toHaveAttribute('aria-invalid', 'true');

      const reason = suspendDialog.getByLabel(copy.suspendReason, { exact: true });
      await reason.fill('scheduled maintenance');
      await reason.press('Enter');
      await expect.poll(() => controlPlane.lifecycleMutations.length).toBe(1);
      expect(controlPlane.lifecycleMutations[0]).toMatchObject({
        tenantId: 'tenant-alpha',
        method: 'POST',
        body: { reason: 'scheduled maintenance' },
      });
      await expect(alphaDetail).toContainText(copy.suspended);
      await expect(alphaDetail).toContainText('scheduled maintenance');

      await page.getByRole('button', { name: copy.detailB, exact: true }).click();
      const betaDetail = page.getByRole('region', { name: copy.detailRegion, exact: true });
      await expect(betaDetail).toBeVisible();
      await betaDetail.getByRole('button', { name: copy.reactivateAction, exact: true }).click();
      const reactivateDialog = page.getByRole('dialog', { name: copy.reactivateTitle, exact: true });
      await expect(reactivateDialog).toBeVisible();
      await reactivateDialog.getByRole('button', { name: copy.reactivateConfirm, exact: true }).click();
      await expect.poll(() => controlPlane.lifecycleMutations.length).toBe(2);
      expect(controlPlane.lifecycleMutations[1]).toMatchObject({
        tenantId: 'tenant-beta',
        method: 'POST',
        body: {},
      });
      await expect(betaDetail).toContainText(copy.active);
      await expect(betaDetail.getByRole('button', { name: copy.suspendAction, exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: copy.auditTitle, exact: true })).toContainText('root');
      assertResponsiveProject(page);
    });

    test(`denies a tenant principal at the system deep link in ${locale}`, async ({ page }) => {
      const copy = copyFor(locale);
      await installMockControlPlane(page);
      await seedStorage(page, locale, { tenantSession: TENANT_SESSIONS.alpha });
      await page.goto('/system/tenants');

      await expect(page).toHaveURL(/\/system\/login$/);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { name: copy.systemLoginTitle, exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: copy.systemUsername, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: copy.systemSubmit, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: copy.tenantTitle, exact: true })).toHaveCount(0);
      await expect.poll(async () => page.evaluate((storageKey) => (
        window.localStorage.getItem(storageKey)
      ), SYSTEM_AUTH_STORAGE_KEY)).toBeNull();
    });
  }
});

test.describe('tenant session replacement browser matrix', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    test(`replaces tenant A with tenant B without carrying visible state in ${locale}`, async ({ page }) => {
      const copy = copyFor(locale);
      const controlPlane = await installMockControlPlane(page);
      await seedStorage(page, locale);
      await page.goto('/login');
      await signInTenant(page, locale, TENANT_SESSIONS.alpha);
      await page.goto('/enterprise/accounts');
      await expect(page.getByRole('banner').getByText(copy.accountTitle, { exact: true })).toBeVisible();
      const alphaIdentity = test.info().project.name === 'mobile-chrome'
        ? page.locator('article').getByText('Alpha Operator', { exact: true })
        : page.getByRole('table').getByText('Alpha Operator', { exact: true });
      await expect(alphaIdentity).toBeVisible();

      await page.getByRole('button', { name: copy.accountMenu, exact: true }).click();
      await expect(page.getByText('tenant-alpha', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
        key: ALPHA_SCOPE_KEY,
        value: 'agent-alpha',
      });

      await page.getByRole('button', { name: copy.accountMenu, exact: true }).click();
      await page.getByRole('menuitem', { name: copy.logout, exact: true }).click();
      await expect(page.getByRole('button', { name: copy.tenantLoginAction, exact: true })).toBeVisible();

      await signInTenant(page, locale, TENANT_SESSIONS.beta);
      await page.goto('/enterprise/accounts');
      await expect(page.getByRole('banner').getByText(copy.accountTitle, { exact: true })).toBeVisible();
      const betaIdentity = test.info().project.name === 'mobile-chrome'
        ? page.locator('article').getByText('Beta Operator', { exact: true })
        : page.getByRole('table').getByText('Beta Operator', { exact: true });
      await expect(betaIdentity).toBeVisible();
      await expect(page.getByText('Alpha Operator', { exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('tenant-alpha');

      await page.getByRole('button', { name: copy.accountMenu, exact: true }).click();
      await expect(page.getByText('tenant-beta', { exact: true })).toBeVisible();
      await expect(page.getByText('tenant-alpha', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await expect.poll(async () => page.evaluate((storageKey) => (
        window.localStorage.getItem(storageKey)
      ), ALPHA_SCOPE_KEY)).toBe('agent-alpha');
      await expect.poll(async () => page.evaluate((storageKey) => (
        window.localStorage.getItem(storageKey)
      ), BETA_SCOPE_KEY)).toBeNull();
      await expect.poll(async () => page.evaluate((storageKey) => {
        try {
          return JSON.parse(window.localStorage.getItem(storageKey) || '{}')?.tenant?.id || null;
        } catch {
          return null;
        }
      }, ENTERPRISE_AUTH_STORAGE_KEY)).toBe('tenant-beta');

      const betaUserRequests = controlPlane.tenantRequests
        .filter((request) => request.path === '/api/auth/users');
      const betaUserRequest = betaUserRequests[betaUserRequests.length - 1];
      expect(betaUserRequest?.authorization).toBe(`Bearer ${TENANT_SESSIONS.beta.token}`);
      expect(new URL(betaUserRequest?.url || 'http://127.0.0.1').searchParams.get('tenant_id'))
        .toBe(TENANT_SESSIONS.beta.tenant.id);
      assertResponsiveProject(page);
    });
  }
});

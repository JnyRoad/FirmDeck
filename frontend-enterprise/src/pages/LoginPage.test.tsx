// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';
import { AppIntlProvider } from '../i18n/provider';
import type { AppLocale } from '../i18n/locales';
import { I18nProvider } from '../i18n';

import LoginPage from './LoginPage';

const session: TenantSession = {
  token: 'token-1',
  scope: 'tenant',
  tenant: {
    id: 'tenant_demo',
    slug: 'demo',
    display_name: 'Demo tenant',
  },
  user: {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'admin',
    display_name: null,
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

const semanticLoginCopy = {
  'zh-CN': {
    hero: '我们来做什么？',
    login: '登录',
    account: '账号',
    password: '密码',
    showPassword: '显示密码',
    previewAlt: 'FirmDeck 产品预览',
  },
  'en-US': {
    hero: 'What will we build today?',
    login: 'Log in',
    account: 'Account',
    password: 'Password',
    showPassword: 'Show Password',
    previewAlt: 'FirmDeck Product Preview',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

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
    display_name: string | null;
    role: 'admin' | 'member';
    must_change_password: boolean;
    avatar_url: string | null;
  };
};

const tenantSession: TenantSession = {
  token: 'tenant-session-token',
  scope: 'tenant',
  tenant: {
    id: 'tenant-alpha',
    slug: 'alpha-lab',
    display_name: 'Alpha Lab',
  },
  user: {
    id: 'user-alpha',
    tenant_id: 'tenant-alpha',
    username: 'operator',
    display_name: 'Alpha Operator',
    role: 'admin',
    must_change_password: true,
    avatar_url: null,
  },
};

const tenantLoginCopy = {
  'zh-CN': {
    tenant: '租户标识',
    tenantDescription: '使用租户标识进入对应工作区。',
    tenantPlaceholder: '请输入租户标识',
    username: '账号',
    password: '密码',
    submit: '登录',
    genericDenied: '租户标识、账号或密码错误',
    tenantRequired: '请输入租户标识',
    tenantInvalid: '租户标识必须为 3 至 63 位小写字母、数字或连字符',
  },
  'en-US': {
    tenant: 'Tenant slug',
    tenantDescription: 'Use your tenant slug to enter the matching workspace.',
    tenantPlaceholder: 'Enter tenant slug',
    username: 'Account',
    password: 'Password',
    submit: 'Log in',
    genericDenied: 'The tenant, account, or password is incorrect.',
    tenantRequired: 'Enter your tenant slug',
    tenantInvalid: 'Use 3–63 lowercase letters, numbers, or hyphens.',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    text: async () => JSON.stringify(body),
  } as Response;
}

function renderLogin(onLogin = vi.fn()) {
  render(
    <I18nProvider>
      <LoginPage onLogin={onLogin} />
    </I18nProvider>,
  );
  return onLogin;
}

/** 仅挂载语义 Provider 渲染登录页，确保新增断言不会经由 legacy source-key 运行时变绿。 */
function renderSemanticLogin(locale: AppLocale, onLogin = vi.fn()) {
  render(
    <AppIntlProvider initialLocale={locale}>
      <LoginPage onLogin={onLogin} />
    </AppIntlProvider>,
  );
  return onLogin;
}

async function showFormAndEnterCredentials(
  user: ReturnType<typeof userEvent.setup>,
  username = 'admin',
  password = 'secret',
  tenantSlug = session.tenant.slug,
) {
  await user.click(screen.getByRole('button', { name: '登录' }));
  await user.type(screen.getByRole('textbox', { name: '租户标识' }), tenantSlug);
  await user.type(screen.getByLabelText('账号'), username);
  await user.type(screen.getByLabelText('密码'), password);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('LoginPage', () => {
  it('shows the original landing hero before revealing credentials', async () => {
    const user = userEvent.setup();
    renderLogin();

    expect(screen.getByText('我们来做什么？')).toBeTruthy();
    expect(screen.getByAltText('FirmDeck 产品预览')).toBeTruthy();
    expect(screen.queryByLabelText('账号')).toBeNull();

    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByLabelText('账号')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
  });

  it('toggles the password between hidden and visible text', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByRole('button', { name: '登录' }));
    const password = screen.getByLabelText('密码');

    expect(password.getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect(password.getAttribute('type')).toBe('text');
    await user.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(password.getAttribute('type')).toBe('password');
  });

  it('posts trimmed username, the entered tenant slug, and opaque password bytes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(session));
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await showFormAndEnterCredentials(user, '  admin  ', '  secret  ');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        tenant_slug: session.tenant.slug,
        username: 'admin',
        password: '  secret  ',
      }),
    }));
  });

  it('stores the session and notifies the caller after a successful login', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(session)));
    const onLogin = renderLogin();

    await showFormAndEnterCredentials(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(session));
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(session);
  });
});

describe('LoginPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'renders owned login copy and accessible names in %s',
    async (locale) => {
      const copy = semanticLoginCopy[locale];
      const user = userEvent.setup();
      renderSemanticLogin(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByText(copy.hero)).toBeTruthy();
      expect(screen.getByAltText(copy.previewAlt)).toBeTruthy();

      await user.click(screen.getByRole('button', { name: copy.login }));

      expect(screen.getByRole('textbox', { name: copy.account })).toBeTruthy();
      expect(screen.getByLabelText(copy.password)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.showPassword })).toBeTruthy();
    },
  );
});

describe('LoginPage tenant slug RED contracts', () => {
  async function revealTenantForm(user: ReturnType<typeof userEvent.setup>, locale: AppLocale = 'zh-CN') {
    renderSemanticLogin(locale);
    await user.click(screen.getByRole('button', { name: tenantLoginCopy[locale].submit }));
  }

  it('asks for a typed tenant slug without exposing a directory or autocomplete control', async () => {
    const user = userEvent.setup();
    await revealTenantForm(user);

    const copy = tenantLoginCopy['zh-CN'];
    const tenantField = screen.getByRole('textbox', { name: copy.tenant });
    expect(tenantField.getAttribute('placeholder')).toBe(copy.tenantPlaceholder);
    expect(screen.getByText(copy.tenantDescription)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: copy.username })).toBeTruthy();
    expect(screen.getByLabelText(copy.password)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('focuses the tenant slug first and reports all required fields accessibly', async () => {
    const user = userEvent.setup();
    await revealTenantForm(user);

    const tenantField = screen.getByRole('textbox', { name: '租户标识' });
    const usernameField = screen.getByRole('textbox', { name: '账号' });
    const passwordField = screen.getByLabelText('密码');
    expect(document.activeElement).toBe(tenantField);

    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(tenantField.getAttribute('aria-invalid')).toBe('true');
    expect(usernameField.getAttribute('aria-invalid')).toBe('true');
    expect(passwordField.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('请输入租户标识')).toBeTruthy();
    expect(document.activeElement).toBe(tenantField);
  });

  it('rejects an invalid slug before making a network request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse(tenantSession));
    vi.stubGlobal('fetch', fetchMock);
    await revealTenantForm(user);

    await user.type(screen.getByRole('textbox', { name: '租户标识' }), 'INVALID_');
    await user.type(screen.getByRole('textbox', { name: '账号' }), 'operator');
    await user.type(screen.getByLabelText('密码'), 'opaque-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(fetchMock).not.toHaveBeenCalled();
    const tenantField = screen.getByRole('textbox', { name: '租户标识' });
    expect(tenantField.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(tenantLoginCopy['zh-CN'].tenantInvalid)).toBeTruthy();
    expect(document.activeElement).toBe(tenantField);
  });

  it('trims only the username, preserves opaque password bytes, and omits deployment tenant identity', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse(tenantSession));
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    renderSemanticLogin('zh-CN', onLogin);
    await user.click(screen.getByRole('button', { name: '登录' }));

    const passwordWithSpaces = '  Opaque password bytes  ';
    await user.type(screen.getByRole('textbox', { name: '租户标识' }), 'alpha-lab');
    await user.type(screen.getByRole('textbox', { name: '账号' }), '  operator  ');
    await user.type(screen.getByLabelText('密码'), passwordWithSpaces);
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1];
    const submitted = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(submitted).toEqual({
      tenant_slug: 'alpha-lab',
      username: 'operator',
      password: passwordWithSpaces,
    });
    expect(submitted).not.toHaveProperty('tenant_id');
  });

  it('normalizes the displayed tenant slug and submits the same lowercase value', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse(tenantSession));
    vi.stubGlobal('fetch', fetchMock);
    await revealTenantForm(user);

    const tenantField = screen.getByRole('textbox', { name: '租户标识' });
    await user.type(tenantField, ' Alpha-Lab ');
    expect((tenantField as HTMLInputElement).value).toBe('alpha-lab');
    await user.type(screen.getByRole('textbox', { name: '账号' }), 'operator');
    await user.type(screen.getByLabelText('密码'), 'opaque-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      tenant_slug: 'alpha-lab',
      username: 'operator',
      password: 'opaque-password',
    });
  });

  it('stores and returns the exact server session, including a forced-change flag', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(tenantSession)));
    const onLogin = vi.fn();
    renderSemanticLogin('zh-CN', onLogin);
    await user.click(screen.getByRole('button', { name: '登录' }));
    await user.type(screen.getByRole('textbox', { name: '租户标识' }), tenantSession.tenant.slug);
    await user.type(screen.getByRole('textbox', { name: '账号' }), tenantSession.user.username);
    await user.type(screen.getByLabelText('密码'), 'opaque-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(tenantSession));
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(tenantSession);
    expect(onLogin.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      scope: 'tenant',
      tenant: tenantSession.tenant,
      user: expect.objectContaining({ must_change_password: true }),
    }));
  });

  it.each([
    ['unknown tenant', 401, 'raw unknown tenant cause'],
    ['upstream outage', 503, 'raw upstream gateway cause'],
  ] as const)(
    'projects %s into the same generic denial without exposing raw details or credentials',
    async (_cause, status, rawCause) => {
      const user = userEvent.setup();
      const password = 'opaque-login-secret';
      const fetchMock = vi.fn(async () => jsonResponse({
        detail: {
          type: 'about:blank',
          title: 'Unauthorized',
          status,
          code: 'AUTH_INVALID_CREDENTIALS',
          message_key: 'errors.auth.invalidCredentials',
          params: { raw_cause: rawCause },
          retryable: false,
        },
      }, status));
      vi.stubGlobal('fetch', fetchMock);
      await revealTenantForm(user);
      await user.type(screen.getByRole('textbox', { name: '租户标识' }), 'alpha-lab');
      await user.type(screen.getByRole('textbox', { name: '账号' }), 'operator');
      await user.type(screen.getByLabelText('密码'), password);
      await user.click(screen.getByRole('button', { name: '登录' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(tenantLoginCopy['zh-CN'].genericDenied);
      expect(document.body.textContent).not.toContain(rawCause);
      expect(document.body.textContent).not.toContain(password);
      expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
    },
  );

  it('hides the password again after a failed request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse({
      detail: {
        code: 'AUTH_INVALID_CREDENTIALS',
        params: {},
        retryable: false,
      },
    }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await revealTenantForm(user);
    await user.type(screen.getByRole('textbox', { name: '租户标识' }), 'alpha-lab');
    await user.type(screen.getByRole('textbox', { name: '账号' }), 'operator');
    await user.type(screen.getByLabelText('密码'), 'opaque-login-secret');
    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('text');

    await user.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('password');
    expect(screen.getByRole('button', { name: '显示密码' })).toBeTruthy();
  });

  it('submits with Enter without changing the opaque password bytes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse(tenantSession));
    vi.stubGlobal('fetch', fetchMock);
    await revealTenantForm(user);

    await user.type(screen.getByRole('textbox', { name: '租户标识' }), 'alpha-lab');
    await user.type(screen.getByRole('textbox', { name: '账号' }), 'operator');
    await user.type(screen.getByLabelText('密码'), 'enter-secret');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      tenant_slug: 'alpha-lab',
      username: 'operator',
      password: 'enter-secret',
    });
  });

  it('cancels with Escape and clears typed secrets before the form can be reopened', async () => {
    const user = userEvent.setup();
    await revealTenantForm(user);
    const password = screen.getByLabelText('密码');
    await user.type(password, 'cancel-secret');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: '租户标识' })).toBeNull();
    expect(screen.queryByDisplayValue('cancel-secret')).toBeNull();
    expect(document.body.textContent).not.toContain('cancel-secret');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps tenant login labels, descriptions, and accessible controls in %s',
    async (locale) => {
      const user = userEvent.setup();
      const copy = tenantLoginCopy[locale];
      await revealTenantForm(user, locale);

      expect(screen.getByRole('textbox', { name: copy.tenant })).toBeTruthy();
      expect(screen.getByText(copy.tenantDescription)).toBeTruthy();
      expect(screen.getByRole('textbox', { name: copy.username })).toBeTruthy();
      expect(screen.getByLabelText(copy.password)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.submit })).toBeTruthy();
      expect(document.documentElement.lang).toBe(locale);
    },
  );
});

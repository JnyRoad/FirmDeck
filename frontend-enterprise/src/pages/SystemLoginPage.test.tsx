// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';
import { I18nProvider } from '../i18n';

const SYSTEM_LOGIN_MODULE_PATH = './SystemLoginPage';

type SystemSession = {
  token: string;
  scope: 'system';
  system_admin: {
    id: string;
    username: string;
    display_name: string | null;
    status: 'active' | 'disabled';
    last_login_at: string | null;
    created_at: string;
  };
};

type LoginClient = {
  login(input: { username: string; password: string }): Promise<SystemSession>;
};

type LoginProps = {
  client?: LoginClient;
  onLogin: (session: SystemSession) => void;
};

const session: SystemSession = {
  token: 'system-token',
  scope: 'system',
  system_admin: {
    id: 'sysadmin-root',
    username: 'root',
    display_name: 'System Operator',
    status: 'active',
    last_login_at: null,
    created_at: '2026-08-31T00:00:00Z',
  },
};

function loginMock(implementation: LoginClient['login'] = async () => session) {
  return vi.fn<LoginClient['login']>(implementation);
}

async function loadPage(): Promise<ComponentType<LoginProps>> {
  try {
    const module = await import(/* @vite-ignore */ SYSTEM_LOGIN_MODULE_PATH) as {
      default?: ComponentType<LoginProps>;
    };
    expect(module.default).toBeTypeOf('function');
    return module.default!;
  } catch (error) {
    throw new Error(`T023 must implement ${SYSTEM_LOGIN_MODULE_PATH}: ${String(error)}`);
  }
}

async function renderLogin(client: LoginClient, onLogin = vi.fn()) {
  const SystemLoginPage = await loadPage();
  render(
    <I18nProvider>
      <SystemLoginPage client={client} onLogin={onLogin} />
    </I18nProvider>,
  );
  return onLogin;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SystemLoginPage', () => {
  it('renders accessible credentials without a tenant chooser or public directory', async () => {
    const client = { login: loginMock() };
    await renderLogin(client);

    expect(screen.getByRole('heading', { name: '系统管理员登录' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '系统管理员账号' })).toBeTruthy();
    const password = screen.getByLabelText('密码');
    expect(password.getAttribute('type')).toBe('password');
    expect(screen.getByRole('button', { name: '显示密码' })).toBeTruthy();
    expect(screen.queryByLabelText('租户')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(client.login).not.toHaveBeenCalled();
  });

  it('trims the username, preserves the password exactly, and omits tenant identity', async () => {
    const user = userEvent.setup();
    const client = { login: loginMock() };
    const onLogin = await renderLogin(client);
    const passwordWithSpaces = `  ${_PASSWORD}  `;

    await user.type(screen.getByRole('textbox', { name: '系统管理员账号' }), '  root  ');
    await user.type(screen.getByLabelText('密码'), passwordWithSpaces);
    await user.click(screen.getByRole('button', { name: '登录系统控制台' }));

    await waitFor(() => expect(client.login).toHaveBeenCalledTimes(1));
    expect(client.login).toHaveBeenCalledWith({ username: 'root', password: passwordWithSpaces });
    expect(client.login.mock.calls[0][0]).not.toHaveProperty('tenant_id');
    expect(onLogin).toHaveBeenCalledWith(session);
  });

  it('never overwrites the ordinary tenant session on success', async () => {
    const user = userEvent.setup();
    const tenantSession = {
      token: 'tenant-token',
      user: { id: 'user-1', tenant_id: 'tenant-a', username: 'admin', role: 'admin' },
    };
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(tenantSession));
    const client = { login: loginMock() };
    await renderLogin(client);

    await user.type(screen.getByRole('textbox', { name: '系统管理员账号' }), 'root');
    await user.type(screen.getByLabelText('密码'), _PASSWORD);
    await user.click(screen.getByRole('button', { name: '登录系统控制台' }));

    await waitFor(() => expect(client.login).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(tenantSession);
  });

  it('toggles password visibility through an accessible control', async () => {
    const user = userEvent.setup();
    await renderLogin({ login: loginMock() });
    const password = screen.getByLabelText('密码');

    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect(password.getAttribute('type')).toBe('text');
    await user.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(password.getAttribute('type')).toBe('password');
  });

  it('shows a stable denial without rendering raw response content or credentials', async () => {
    const user = userEvent.setup();
    const raw = 'raw-database-response-should-never-render';
    const client = { login: loginMock(async () => { throw new Error(raw); }) };
    await renderLogin(client);

    await user.type(screen.getByRole('textbox', { name: '系统管理员账号' }), 'root');
    await user.type(screen.getByLabelText('密码'), _PASSWORD);
    await user.click(screen.getByRole('button', { name: '登录系统控制台' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('系统管理员账号或密码无效');
    expect(document.body.textContent).not.toContain(raw);
    expect(document.body.textContent).not.toContain(_PASSWORD);
  });
});

const _PASSWORD = 'System-login-secret-2026';

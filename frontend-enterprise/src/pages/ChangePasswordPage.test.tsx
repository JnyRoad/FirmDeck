// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';
import { AppIntlProvider } from '../i18n/provider';
import type { AppLocale } from '../i18n/locales';

const CHANGE_PASSWORD_MODULE_PATH = './ChangePasswordPage';

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

type ChangePasswordClient = {
  changePassword(input: {
    current_password: string;
    new_password: string;
  }): Promise<TenantSession>;
};

type ChangePasswordProps = {
  session: TenantSession;
  client: ChangePasswordClient;
  onComplete: (session: TenantSession) => void;
  onCancel?: () => void;
};

const temporarySession: TenantSession = {
  token: 'temporary-tenant-token',
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

const replacementSession: TenantSession = {
  ...temporarySession,
  token: 'replacement-tenant-token',
  user: {
    ...temporarySession.user,
    must_change_password: false,
  },
};

const copy = {
  'zh-CN': {
    title: '修改密码',
    description: '为保护你的账号，请设置至少 12 位的新密码。',
    current: '当前密码',
    next: '新密码',
    confirm: '确认新密码',
    nextDescription: '新密码至少需要 12 位。',
    submit: '更新密码',
    cancel: '取消',
    show: '显示密码',
    hide: '隐藏密码',
    minimum: '新密码至少需要 12 位',
    mismatch: '两次输入的新密码不一致',
    genericFailure: '密码更新失败，请稍后重试。',
  },
  'en-US': {
    title: 'Change password',
    description: 'For account security, set a new password with at least 12 characters.',
    current: 'Current password',
    next: 'New password',
    confirm: 'Confirm new password',
    nextDescription: 'Your new password must be at least 12 characters.',
    submit: 'Update password',
    cancel: 'Cancel',
    show: 'Show password',
    hide: 'Hide password',
    minimum: 'Your new password must be at least 12 characters.',
    mismatch: 'The new passwords do not match.',
    genericFailure: 'Password update failed. Please try again later.',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

async function loadChangePasswordPage(): Promise<ComponentType<ChangePasswordProps>> {
  try {
    const module = await import(/* @vite-ignore */ CHANGE_PASSWORD_MODULE_PATH) as {
      default?: ComponentType<ChangePasswordProps>;
    };
    expect(module.default).toBeTypeOf('function');
    return module.default!;
  } catch (error) {
    throw new Error(`T033 must implement ${CHANGE_PASSWORD_MODULE_PATH}: ${String(error)}`);
  }
}

function changePasswordMock(
  implementation: ChangePasswordClient['changePassword'] = async () => replacementSession,
) {
  return vi.fn<ChangePasswordClient['changePassword']>(implementation);
}

async function renderChangePassword(
  client: ChangePasswordClient,
  locale: AppLocale = 'zh-CN',
  onComplete = vi.fn(),
  onCancel = vi.fn(),
) {
  const ChangePasswordPage = await loadChangePasswordPage();
  render(
    <AppIntlProvider initialLocale={locale}>
      <ChangePasswordPage
        session={temporarySession}
        client={client}
        onComplete={onComplete}
        onCancel={onCancel}
      />
    </AppIntlProvider>,
  );
  return { onComplete, onCancel };
}

async function fillValidChange(
  user: ReturnType<typeof userEvent.setup>,
  current = 'Current opaque password',
  next = 'New opaque password 2026',
) {
  await user.type(screen.getByLabelText('当前密码'), current);
  await user.type(screen.getByLabelText('新密码'), next);
  await user.type(screen.getByLabelText('确认新密码'), next);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('ChangePasswordPage forced-change RED contracts', () => {
  it('renders current, new, and confirmation password fields with an accessible policy description', async () => {
    const client = { changePassword: changePasswordMock() };
    await renderChangePassword(client);

    expect(screen.getByRole('heading', { name: copy['zh-CN'].title })).toBeTruthy();
    expect(screen.getByText(copy['zh-CN'].description)).toBeTruthy();
    expect(screen.getByLabelText(copy['zh-CN'].current)).toBeTruthy();
    expect(screen.getByLabelText(copy['zh-CN'].next)).toBeTruthy();
    expect(screen.getByLabelText(copy['zh-CN'].confirm)).toBeTruthy();
    const description = screen.getByText(copy['zh-CN'].nextDescription);
    const nextField = screen.getByLabelText(copy['zh-CN'].next);
    expect(nextField.getAttribute('aria-describedby')).toContain(description.id);
    expect(nextField.getAttribute('minlength')).toBe('12');
    expect((screen.getByLabelText(copy['zh-CN'].current) as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText(copy['zh-CN'].next) as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText(copy['zh-CN'].confirm) as HTMLInputElement).type).toBe('password');
  });

  it('supports independent accessible password visibility controls', async () => {
    const user = userEvent.setup();
    const client = { changePassword: changePasswordMock() };
    await renderChangePassword(client);

    const fields = [
      screen.getByLabelText(copy['zh-CN'].current),
      screen.getByLabelText(copy['zh-CN'].next),
      screen.getByLabelText(copy['zh-CN'].confirm),
    ] as HTMLInputElement[];
    const showButtons = screen.getAllByRole('button', { name: copy['zh-CN'].show });
    expect(showButtons.length).toBe(3);

    await user.click(showButtons[1]!);
    expect(fields[0]!.type).toBe('password');
    expect(fields[1]!.type).toBe('text');
    expect(fields[2]!.type).toBe('password');
    expect(screen.getAllByRole('button', { name: copy['zh-CN'].hide }).length).toBe(1);
  });

  it('rejects a short new password before calling the client and focuses the invalid field', async () => {
    const user = userEvent.setup();
    const client = { changePassword: changePasswordMock() };
    await renderChangePassword(client);

    await user.type(screen.getByLabelText('当前密码'), 'current-password');
    await user.type(screen.getByLabelText('新密码'), 'short');
    await user.type(screen.getByLabelText('确认新密码'), 'short');
    await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(copy['zh-CN'].minimum);
    expect(client.changePassword).not.toHaveBeenCalled();
    const nextField = screen.getByLabelText('新密码');
    expect(nextField.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nextField);
  });

  it('rejects mismatched confirmation before calling the client and focuses confirmation', async () => {
    const user = userEvent.setup();
    const client = { changePassword: changePasswordMock() };
    await renderChangePassword(client);

    await user.type(screen.getByLabelText('当前密码'), 'current-password');
    await user.type(screen.getByLabelText('新密码'), 'New opaque password 2026');
    await user.type(screen.getByLabelText('确认新密码'), 'Different opaque password');
    await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(copy['zh-CN'].mismatch);
    expect(client.changePassword).not.toHaveBeenCalled();
    const confirmField = screen.getByLabelText('确认新密码');
    expect(confirmField.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(confirmField);
  });

  it('sends exact opaque current/new password bytes and accepts the replacement session', async () => {
    const user = userEvent.setup();
    const current = '  current opaque bytes  ';
    const next = '  new opaque bytes 2026  ';
    const client = { changePassword: changePasswordMock() };
    const { onComplete } = await renderChangePassword(client);

    await fillValidChange(user, current, next);
    await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));

    await waitFor(() => expect(client.changePassword).toHaveBeenCalledTimes(1));
    expect(client.changePassword).toHaveBeenCalledWith({
      current_password: current,
      new_password: next,
    });
    expect(client.changePassword.mock.calls[0]?.[0]).not.toHaveProperty('confirm_password');
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(replacementSession));
    expect(onComplete.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      token: replacementSession.token,
      scope: 'tenant',
      user: expect.objectContaining({ must_change_password: false }),
    }));
    expect(JSON.stringify(window.localStorage)).not.toContain(current);
    expect(JSON.stringify(window.localStorage)).not.toContain(next);
  });

  it('advances the in-memory session when replacement persistence fails after backend success', async () => {
    const user = userEvent.setup();
    const current = 'Current persistence failure secret';
    const next = 'New persistence failure secret 2026';
    const client = { changePassword: changePasswordMock() };
    const onComplete = vi.fn();
    await renderChangePassword(client, 'zh-CN', onComplete);
    const oldStoredSession = JSON.stringify(temporarySession);
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, oldStoredSession);
    // Node may expose a process-level localStorage implementation whose
    // prototype is not the DOM Storage prototype. Replace the window binding
    // so the application observes the intended quota failure in every runtime.
    const originalStorage = window.localStorage;
    const failingStorage: Storage = {
      get length() {
        return originalStorage.length;
      },
      clear: () => originalStorage.clear(),
      getItem: (key) => originalStorage.getItem(key),
      key: (index) => originalStorage.key(index),
      removeItem: (key) => originalStorage.removeItem(key),
      setItem: () => {
        throw new Error('storage quota exhausted');
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: failingStorage,
    });

    try {
      await fillValidChange(user, current, next);
      await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));

      await waitFor(() => expect(client.changePassword).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onComplete).toHaveBeenCalledWith(replacementSession));
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('确认新密码') as HTMLInputElement).value).toBe('');
      expect(document.body.textContent).not.toContain(current);
      expect(document.body.textContent).not.toContain(next);
      expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBe(oldStoredSession);
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalStorage,
      });
    }
  });

  it('clears every secret after a successful replacement and never renders it in visible text', async () => {
    const user = userEvent.setup();
    const current = 'Current success secret';
    const next = 'New success secret 2026';
    const client = { changePassword: changePasswordMock() };
    await renderChangePassword(client);

    await fillValidChange(user, current, next);
    await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));
    await waitFor(() => expect(client.changePassword).toHaveBeenCalled());

    expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('确认新密码') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain(current);
    expect(document.body.textContent).not.toContain(next);
  });

  it('projects any upstream failure into a stable generic error and clears all secrets', async () => {
    const user = userEvent.setup();
    const current = 'Current failure secret';
    const next = 'New failure secret 2026';
    const rawCause = 'raw database password hash and stack trace';
    const client = {
      changePassword: changePasswordMock(async () => {
        throw new Error(rawCause);
      }),
    };
    await renderChangePassword(client);

    await fillValidChange(user, current, next);
    await user.click(screen.getByRole('button', { name: copy['zh-CN'].submit }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(copy['zh-CN'].genericFailure);
    expect(document.body.textContent).not.toContain(rawCause);
    expect(document.body.textContent).not.toContain(current);
    expect(document.body.textContent).not.toContain(next);
    expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('确认新密码') as HTMLInputElement).value).toBe('');
    expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('submits with Enter and cancels with Escape without retaining secrets or changing the session', async () => {
    const user = userEvent.setup();
    const client = { changePassword: changePasswordMock() };
    const onCancel = vi.fn();
    await renderChangePassword(client, 'zh-CN', vi.fn(), onCancel);

    await fillValidChange(user);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(client.changePassword).toHaveBeenCalledTimes(1));

    cleanup();
    const onCancelAgain = vi.fn();
    await renderChangePassword(client, 'zh-CN', vi.fn(), onCancelAgain);
    await user.type(screen.getByLabelText('当前密码'), 'cancel current secret');
    await user.type(screen.getByLabelText('新密码'), 'cancel new secret 2026');
    await user.keyboard('{Escape}');

    expect(onCancelAgain).toHaveBeenCalledTimes(1);
    expect(client.changePassword).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('确认新密码') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('cancel current secret');
    expect(document.body.textContent).not.toContain('cancel new secret 2026');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the forced-change journey and accessible labels in %s',
    async (locale) => {
      const text = copy[locale];
      const client = { changePassword: changePasswordMock() };
      await renderChangePassword(client, locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByRole('heading', { name: text.title })).toBeTruthy();
      expect(screen.getByText(text.description)).toBeTruthy();
      expect(screen.getByLabelText(text.current)).toBeTruthy();
      expect(screen.getByLabelText(text.next)).toBeTruthy();
      expect(screen.getByLabelText(text.confirm)).toBeTruthy();
      expect(screen.getByText(text.nextDescription)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.submit })).toBeTruthy();
    },
  );
});

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';

const MODULE_PATH = './SystemPasswordChangePage';
type Session = { token: string; scope: 'system'; system_admin: { id: string; username: string; status: 'active'; must_change_password: boolean; created_at: string } };
type PasswordPolicy = { min_length: number; max_length: number; complexity_enabled: boolean; require_uppercase: boolean; require_lowercase: boolean; require_digit: boolean; require_special: boolean };
type Client = { changePassword(input: { current_password: string; new_password: string }): Promise<Session>; getPasswordPolicies(): Promise<{ system: PasswordPolicy; tenant_default: PasswordPolicy }> };
type Props = { session: Session; client?: Client; onComplete: (session: Session) => void; forced: boolean };
const session: Session = { token: 'restricted-token', scope: 'system', system_admin: { id: 'root', username: 'sysadmin', status: 'active', must_change_password: true, created_at: '2026-08-31T00:00:00Z' } };
const replacement: Session = { ...session, token: 'replacement-token', system_admin: { ...session.system_admin, must_change_password: false } };

const defaultPolicy: PasswordPolicy = { min_length: 8, max_length: 20, complexity_enabled: false, require_uppercase: false, require_lowercase: false, require_digit: false, require_special: false };

async function renderPage(client: Client, onComplete = vi.fn(), forced = true) {
  const module = await import(/* @vite-ignore */ MODULE_PATH) as { default?: ComponentType<Props> };
  const Page = module.default!;
  render(<I18nProvider><Page session={session} client={client} onComplete={onComplete} forced={forced} /></I18nProvider>);
  return onComplete;
}

afterEach(() => cleanup());

describe('SystemPasswordChangePage', () => {
  it('loads the system policy for a forced replacement before validating the protected request', async () => {
    const user = userEvent.setup();
    const systemPolicy: PasswordPolicy = { ...defaultPolicy, min_length: 12, max_length: 16 };
    const client = { changePassword: vi.fn(async () => replacement), getPasswordPolicies: vi.fn(async () => ({ system: systemPolicy, tenant_default: defaultPolicy })) };
    await renderPage(client);
    expect(screen.getByRole('heading', { name: '必须修改密码' })).toBeTruthy();
    await waitFor(() => expect(client.getPasswordPolicies).toHaveBeenCalledTimes(1));
    expect(screen.getByText('新密码长度必须为 12–16 个字符。')).toBeTruthy();
    await user.type(screen.getByLabelText('当前密码'), 'Current-2026');
    await user.type(screen.getByLabelText('新密码'), 'short');
    await user.type(screen.getByLabelText('确认新密码'), 'short');
    await user.click(screen.getByRole('button', { name: '更新密码' }));
    expect((await screen.findByRole('alert')).textContent).toContain('新密码长度必须为 12–16 个字符');
    expect(client.changePassword).not.toHaveBeenCalled();
  });

  it('sends only current/new opaque password values then gives the replacement session to the app', async () => {
    const user = userEvent.setup();
    const client = { changePassword: vi.fn(async () => replacement), getPasswordPolicies: vi.fn(async () => ({ system: defaultPolicy, tenant_default: defaultPolicy })) };
    const onComplete = await renderPage(client, vi.fn(), false);
    await user.type(screen.getByLabelText('当前密码'), ' Current bytes ');
    await user.type(screen.getByLabelText('新密码'), 'New password 2026');
    await user.type(screen.getByLabelText('确认新密码'), 'New password 2026');
    await user.click(screen.getByRole('button', { name: '更新密码' }));
    await waitFor(() => expect(client.changePassword).toHaveBeenCalledWith({ current_password: ' Current bytes ', new_password: 'New password 2026' }));
    expect(onComplete).toHaveBeenCalledWith(replacement);
    expect(document.body.textContent).not.toContain('Current bytes');
  });

  it('loads and enforces the normal system-admin complexity policy without weakening the 8–20 boundary', async () => {
    const user = userEvent.setup();
    const systemPolicy: PasswordPolicy = { ...defaultPolicy, min_length: 12, max_length: 16, complexity_enabled: true, require_uppercase: true, require_digit: true };
    const client = { changePassword: vi.fn(async () => replacement), getPasswordPolicies: vi.fn(async () => ({ system: systemPolicy, tenant_default: defaultPolicy })) };
    await renderPage(client, vi.fn(), false);
    await waitFor(() => expect(client.getPasswordPolicies).toHaveBeenCalledTimes(1));
    expect(screen.getByText('新密码长度必须为 12–16 个字符。')).toBeTruthy();
    expect(screen.getByText('要求大写字母')).toBeTruthy();
    expect(screen.getByText('要求数字')).toBeTruthy();
    await user.type(screen.getByLabelText('当前密码'), 'Current-2026');
    await user.type(screen.getByLabelText('新密码'), 'lowercasepass');
    await user.type(screen.getByLabelText('确认新密码'), 'lowercasepass');
    await user.click(screen.getByRole('button', { name: '更新密码' }));
    expect((await screen.findByRole('alert')).textContent).toContain('未满足已启用的复杂度规则');
    expect(client.changePassword).not.toHaveBeenCalled();
  });
});

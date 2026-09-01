// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';

const MODULE_PATH = './SystemPasswordPoliciesPage';
const policy = { min_length: 8, max_length: 20, complexity_enabled: true, require_uppercase: true, require_lowercase: true, require_digit: true, require_special: false };
type Client = {
  listTenants(input?: { limit?: number; cursor?: string }): Promise<{ items: Array<{ id: string; display_name: string }>; next_cursor: string | null }>;
  getPasswordPolicies(): Promise<{ system: typeof policy; tenant_default: typeof policy }>;
  updatePasswordPolicies(input: { system: typeof policy; tenant_default: typeof policy }): Promise<unknown>;
  getTenantPasswordPolicy(id: string): Promise<{ mode: 'inherit' | 'custom'; custom: typeof policy | null; effective: typeof policy }>;
  updateTenantPasswordPolicy(id: string, input: { mode: 'inherit' | 'custom'; custom?: typeof policy | null }): Promise<unknown>;
};
type Props = { client?: Client };
async function renderPage(client: Client) {
  const module = await import(/* @vite-ignore */ MODULE_PATH) as { default?: ComponentType<Props> };
  const Page = module.default!;
  render(<I18nProvider><Page client={client} /></I18nProvider>);
}
afterEach(() => cleanup());

describe('SystemPasswordPoliciesPage', () => {
  it('distinguishes installation/default policies from a selected tenant override', async () => {
    const user = userEvent.setup();
    const client: Client = {
      listTenants: vi.fn(async () => ({ items: [{ id: 'tenant-alpha', display_name: 'Alpha Lab' }], next_cursor: null })),
      getPasswordPolicies: vi.fn(async () => ({ system: policy, tenant_default: policy })),
      updatePasswordPolicies: vi.fn(async () => ({ system: policy, tenant_default: policy })),
      getTenantPasswordPolicy: vi.fn(async () => ({ mode: 'inherit' as const, custom: null, effective: policy })),
      updateTenantPasswordPolicy: vi.fn(async () => ({ mode: 'inherit' as const, custom: null, effective: policy })),
    };
    await renderPage(client);
    expect(await screen.findByRole('heading', { name: '密码策略' })).toBeTruthy();
    expect(screen.getByText('系统管理员密码策略')).toBeTruthy();
    expect(screen.getByText('默认租户密码策略')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('租户覆盖策略'), 'tenant-alpha');
    expect(await screen.findByText('继承默认租户策略')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '使用自定义策略' }));
    await user.click(screen.getByRole('button', { name: '保存租户覆盖' }));
    await waitFor(() => expect(client.updateTenantPasswordPolicy).toHaveBeenCalledWith('tenant-alpha', expect.objectContaining({ mode: 'custom' })));
  });

  it('loads every tenant page instead of truncating the policy selector at 100 rows', async () => {
    const client: Client = {
      listTenants: vi.fn(async ({ cursor } = {}) => cursor
        ? { items: [{ id: 'tenant-101', display_name: 'Tenant 101' }], next_cursor: null }
        : { items: [{ id: 'tenant-100', display_name: 'Tenant 100' }], next_cursor: 'page-2' }),
      getPasswordPolicies: vi.fn(async () => ({ system: policy, tenant_default: policy })),
      updatePasswordPolicies: vi.fn(),
      getTenantPasswordPolicy: vi.fn(),
      updateTenantPasswordPolicy: vi.fn(),
    };

    await renderPage(client);

    expect(await screen.findByRole('option', { name: 'Tenant 101' })).toBeTruthy();
    expect(client.listTenants).toHaveBeenCalledTimes(2);
  });

  it('discards a late tenant policy response before it can be saved to another tenant', async () => {
    const user = userEvent.setup();
    let resolveAlpha!: (value: { mode: 'custom'; custom: typeof policy; effective: typeof policy }) => void;
    let resolveBeta!: (value: { mode: 'custom'; custom: typeof policy; effective: typeof policy }) => void;
    const alphaPolicy = { ...policy, min_length: 12 };
    const betaPolicy = { ...policy, min_length: 10 };
    const client: Client = {
      listTenants: vi.fn(async () => ({
        items: [
          { id: 'tenant-alpha', display_name: 'Alpha' },
          { id: 'tenant-beta', display_name: 'Beta' },
        ],
        next_cursor: null,
      })),
      getPasswordPolicies: vi.fn(async () => ({ system: policy, tenant_default: policy })),
      updatePasswordPolicies: vi.fn(),
      getTenantPasswordPolicy: vi.fn((id: string) => new Promise<{
        mode: 'custom';
        custom: typeof policy;
        effective: typeof policy;
      }>((resolve) => {
        if (id === 'tenant-alpha') resolveAlpha = resolve;
        else resolveBeta = resolve;
      })),
      updateTenantPasswordPolicy: vi.fn(async (_id, input) => ({
        mode: 'custom' as const,
        custom: input.custom || betaPolicy,
        effective: input.custom || betaPolicy,
      })),
    };
    await renderPage(client);
    const selector = await screen.findByLabelText('租户覆盖策略');
    await user.selectOptions(selector, 'tenant-alpha');
    await user.selectOptions(selector, 'tenant-beta');
    resolveBeta({ mode: 'custom', custom: betaPolicy, effective: betaPolicy });
    await screen.findByText('使用自定义租户密码策略');
    resolveAlpha({ mode: 'custom', custom: alphaPolicy, effective: alphaPolicy });
    await user.click(screen.getByRole('button', { name: '保存租户覆盖' }));

    await waitFor(() => expect(client.updateTenantPasswordPolicy).toHaveBeenCalledWith(
      'tenant-beta',
      expect.objectContaining({ custom: expect.objectContaining({ min_length: 10 }) }),
    ));
  });
});

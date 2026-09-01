// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SystemApp from './SystemApp';
import { I18nProvider } from './i18n';
import { clearSystemAuthSession, setSystemAuthSession } from './system-auth';

/** Builds a harmless response object for system-session verification. */
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  cleanup();
  clearSystemAuthSession();
  vi.unstubAllGlobals();
});

describe('SystemApp password-change guard', () => {
  it('does not render the tenant console for a restricted first-login bearer', async () => {
    const admin = { id: 'sysadmin-root', username: 'sysadmin', status: 'active' as const, must_change_password: true, created_at: '2026-08-31T00:00:00Z' };
    setSystemAuthSession({ token: 'restricted-token', scope: 'system', system_admin: admin });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(admin)));
    render(<I18nProvider><MemoryRouter initialEntries={['/system/tenants']}><SystemApp /></MemoryRouter></I18nProvider>);
    expect(await screen.findByRole('heading', { name: '必须修改密码' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '租户管理' })).toBeNull();
  });
});

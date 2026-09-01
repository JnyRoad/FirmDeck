// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/i18n';
import SystemLayout from './SystemLayout';

afterEach(cleanup);

describe('SystemLayout navigation shell', () => {
  it('uses a left navigation rail to switch the right-side system workspace', async () => {
    const user = userEvent.setup();
    const systemAdmin = {
      id: 'sysadmin-root',
      username: 'sysadmin',
      display_name: 'System Admin',
      status: 'active' as const,
      must_change_password: false,
      created_at: '2026-08-31T00:00:00Z',
    };

    render(
      <I18nProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/system/tenants']}>
            <SystemLayout systemAdmin={systemAdmin} onLogout={vi.fn()}>
              <Routes>
                <Route path="/system/tenants" element={<h1>租户工作区</h1>} />
                <Route path="/system/password-policies" element={<h1>策略工作区</h1>} />
                <Route path="/system/change-password" element={<h1>密码工作区</h1>} />
              </Routes>
            </SystemLayout>
          </MemoryRouter>
        </TooltipProvider>
      </I18nProvider>,
    );

    const navigation = screen.getByRole('navigation', { name: '系统控制台' });
    const tenantsLink = screen.getByRole('link', { name: '租户管理' });
    const policiesLink = screen.getByRole('link', { name: '密码策略' });
    expect(navigation.contains(tenantsLink)).toBe(true);
    expect(screen.getByRole('link', { name: '修改密码' })).toBeTruthy();
    expect(tenantsLink.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('region', { name: '系统控制台' }).contains(
        screen.getByRole('heading', { name: '租户工作区' }),
      ),
    ).toBe(true);

    await user.click(policiesLink);

    expect(await screen.findByRole('heading', { name: '策略工作区' })).toBeTruthy();
    expect(policiesLink.getAttribute('aria-current')).toBe('page');
    expect(tenantsLink.getAttribute('aria-current')).toBeNull();

    await user.click(screen.getByRole('button', { name: '收起边栏' }));
    expect(policiesLink.getAttribute('aria-label')).toBe('密码策略');
    expect(screen.getByRole('button', { name: '展开边栏' })).toBeTruthy();
  });
});

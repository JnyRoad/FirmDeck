// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { I18nProvider } from '@/i18n';
import { ENTERPRISE_AUTH_STORAGE_KEY } from '@/auth';

import AppHeader from './AppHeader';

const semanticHeaderCopy = {
  'zh-CN': {
    languageSwitcher: '切换语言',
    accountMenu: '账户菜单',
  },
  'en-US': {
    languageSwitcher: 'Switch language',
    accountMenu: 'Account menu',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 仅用语义 Provider 渲染真实 Header，禁止 legacy Provider 或 DOM observer 参与断言。 */
function renderSemanticHeader(locale: AppLocale) {
  return render(
    createElement(
      AppIntlProvider,
      {
        initialLocale: locale,
        children: createElement(AppHeader, { title: 'StaffDeck' }),
      },
    ),
  );
}

describe('AppHeader', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.lang = '';
  });

  it('allows simple page titles to opt into centered controls', () => {
    const { container } = render(
      createElement(
        I18nProvider,
        null,
        createElement(AppHeader, {
          title: '模型',
          right: createElement('span', null, 'controls'),
          className: 'items-center',
        }),
      ),
    );
    const header = container.querySelector('header');

    expect(header?.classList.contains('items-center')).toBe(true);
    expect(header?.classList.contains('items-start')).toBe(false);
  });

  it('places the current user full-access key in the global account menu', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'session-token',
      user: {
        id: 'user_member',
        tenant_id: 'tenant_demo',
        username: 'member',
        display_name: '普通成员',
        role: 'member',
      },
    }));
    const user = userEvent.setup();
    render(
      createElement(
        I18nProvider,
        null,
        createElement(AppHeader, { title: '账号管理' }),
      ),
    );

    await user.click(screen.getByRole('button', { name: '账户菜单' }));

    expect(await screen.findByText('API 全量密钥')).toBeTruthy();
    expect(screen.getByText('普通成员')).toBeTruthy();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes language and account ARIA names under the semantic runtime in %s',
    (locale) => {
      const copy = semanticHeaderCopy[locale];
      renderSemanticHeader(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByRole('button', { name: copy.languageSwitcher })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.accountMenu })).toBeTruthy();
    },
  );

  it('switches the semantic locale and synchronizes the document language', async () => {
    const user = userEvent.setup();
    renderSemanticHeader('zh-CN');

    await user.click(screen.getByRole('button', { name: '切换语言' }));
    await user.click(await screen.findByRole('menuitem', { name: /English/ }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en-US');
      expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy();
    });
    expect(window.localStorage.getItem('staffdeck_locale')).toBe('en-US');
  });
});

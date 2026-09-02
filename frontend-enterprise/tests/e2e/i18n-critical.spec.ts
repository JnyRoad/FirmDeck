import { expect, test } from '@playwright/test';

import {
  expectNoHorizontalOverflow,
  openApplicationLocale,
  openPseudoLocaleHarness,
} from './fixtures';

const LOGIN_LOCALES = [
  {
    locale: 'zh-CN' as const,
    action: '登录',
    account: '账号',
    product: '数字员工运营平台',
    title: 'StaffDeck 数字员工运营平台',
  },
  {
    locale: 'en-US' as const,
    action: 'Log in',
    account: 'Account',
    product: 'Digital Employee Operations Platform',
    title: 'StaffDeck Digital Employee Operations Platform',
  },
];

test.describe('critical product locale matrix', () => {
  for (const copy of LOGIN_LOCALES) {
    test(`renders login product and accessibility text in ${copy.locale}`, async ({ page }) => {
      await openApplicationLocale(page, copy.locale);

      await expect(page).toHaveTitle(copy.title);
      await expect(page.getByRole('heading', { name: new RegExp(copy.product) })).toBeVisible();
      await page.getByRole('button', { name: copy.action }).click();
      await expect(page.getByRole('textbox', { name: copy.account })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', copy.locale);
      await expectNoHorizontalOverflow(page, 'main');
    });
  }

  test('exposes pseudo expansion, exact raw data, iframe chrome, and product postMessage errors', async ({
    page,
  }) => {
    await openPseudoLocaleHarness(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
    await expect(page.getByRole('heading')).toContainText('⟦');
    await expect(page.getByTestId('raw-business-content')).toHaveText(
      '知识库原文 / User supplied record',
    );
    await expect(page.locator('iframe[title^="⟦"]')).toBeVisible();

    await page.evaluate(() => window.postMessage({ type: 'fixture_product_error' }, '*'));
    await expect(page.getByRole('status')).toContainText('⟦');
    await expectNoHorizontalOverflow(page, '[data-testid="pseudo-surface"]');
  });

  test('localizes native dialog text in pseudo mode without changing raw prompt defaults', async ({
    page,
  }) => {
    await openPseudoLocaleHarness(page);
    const dialogAssertion = new Promise<void>((resolve, reject) => {
      page.once('dialog', async (dialog) => {
        try {
          expect(dialog.message()).toContain('⟦');
          expect(dialog.defaultValue()).toBe('知识库原文 / User supplied record');
          await dialog.dismiss();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await page.getByRole('button', { name: /native dialog/i }).click();
    await dialogAssertion;
  });
});

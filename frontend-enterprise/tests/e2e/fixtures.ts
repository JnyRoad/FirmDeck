import { expect, type Page } from '@playwright/test';

const LOCALE_STORAGE_KEY = 'staffdeck_locale';

/** Open the real signed-out application after seeding one supported production locale. */
export async function openApplicationLocale(page: Page, locale: 'zh-CN' | 'en-US') {
  await page.addInitScript(
    ([storageKey, storedLocale]) => {
      window.localStorage.clear();
      window.localStorage.setItem(storageKey, storedLocale);
    },
    [LOCALE_STORAGE_KEY, locale] as const,
  );
  await page.goto('/');
}

/** Open the isolated browser-only en-XA surface; production application code cannot select it. */
export async function openPseudoLocaleHarness(page: Page) {
  await page.goto('/tests/e2e/harness.html');
  await expect(page.getByTestId('pseudo-surface')).toBeVisible();
}

/** Assert one critical surface fits its viewport without horizontal clipping. */
export async function expectNoHorizontalOverflow(page: Page, selector: string) {
  const dimensions = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

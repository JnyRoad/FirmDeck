import { defineConfig, devices } from '@playwright/test';

// Local acceptance uses installed Google Chrome; CI uses Playwright's pinned Chromium artifact.
const browserChannel = process.env.CI ? {} : { channel: 'chrome' as const };

/**
 * Runs deterministic internationalization browser checks against the real Vite application and a
 * test-only pseudo-locale surface. Production builds never import the pseudo harness.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...browserChannel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], ...browserChannel },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], ...browserChannel },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

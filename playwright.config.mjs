import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4187/health',
    reuseExistingServer: false,
    env: { NODE_ENV: 'development', DATABASE_URL: '', HOST: '127.0.0.1', PORT: '4187',
      CANONICAL_PUBLIC_HOST: '', ALLOWED_ORIGINS: 'http://127.0.0.1:4187', ADSENSE_ENABLED: '0' },
  },
});

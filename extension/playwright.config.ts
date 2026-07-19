import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/specs',
  globalSetup: './tests/e2e/setup/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results/e2e-artifacts',
  webServer: {
    command: 'node tests/e2e/fixtures/server.mjs',
    url: 'http://127.0.0.1:4175/health',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});

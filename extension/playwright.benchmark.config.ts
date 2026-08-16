import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig(baseConfig, {
  testDir: './tests/benchmarks',
  outputDir: 'test-results/benchmark-artifacts',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: 'list',
});

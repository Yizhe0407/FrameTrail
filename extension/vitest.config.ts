import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/browser-storage.ts'],
    coverage: {
      provider: 'v8',
      // Opt-in via `pnpm test:coverage`; no thresholds yet so the report
      // informs without failing CI while coverage is still being built out.
      include: ['lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'entrypoints/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});

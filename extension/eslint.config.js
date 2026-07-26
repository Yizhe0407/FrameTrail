import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.output/', '.wxt/', 'node_modules/', 'test-results/', 'dist/', 'playwright-report/', 'blob-report/', 'coverage/'],
  },
  js.configs.recommended,
  // Non-type-checked: keeps `pnpm lint` fast. `tsc --noEmit` already covers the
  // type-aware ground these rules would add.
  tseslint.configs.recommended,
  reactHooks.configs.recommended,
  {
    languageOptions: {
      globals: {
        // WXT entrypoints and content scripts run in extension pages, where both
        // the DOM and the WebExtension APIs (`browser`, `chrome`) are ambient.
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    // Build/validation scripts and tooling configs run in Node.
    files: ['tests/build/**', '*.config.{ts,js,mjs}', '**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      // TS's own `noUnusedLocals`/`noUnusedParameters` already fail the build for
      // these; the ESLint copy only adds duplicate noise, so keep the underscore
      // escape hatch and let `tsc` own the rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // TypeScript resolves these; the core rules misfire on type-only and
      // ambient declarations.
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      // Control characters in a regex are the point in this codebase: every hit
      // is an input sanitizer stripping \x00-\x1f before it reaches storage,
      // an archive, or a message boundary.
      'no-control-regex': 'off',
    },
  },
  {
    // Playwright fixtures take a callback named `use`, which the React rule
    // cannot distinguish from the `use` hook. These are the only
    // rules-of-hooks reports in the repo and all six are false positives.
    files: ['tests/e2e/**'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      // `async ({}, use) => …` is Playwright's own fixture signature.
      'no-empty-pattern': 'off',
    },
  },
  {
    // Test doubles legitimately reach for `any` when standing in for browser
    // APIs. Production code does not get that latitude.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

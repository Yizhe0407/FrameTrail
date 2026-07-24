import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { preparedExtensionPath } from './paths';

export const FIXTURE_URL = 'http://127.0.0.1:4175/';

type Fixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  appPage: Page;
  popupPage: Page;
  browserErrors: string[];
};

export const test = base.extend<Fixtures>({
  extensionContext: async ({}, use, testInfo) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'frametrail-playwright-'));
    const requiresNativeScrollbars = testInfo.file.endsWith('capture-presentation.spec.ts');
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.PW_HEADED !== '1',
      // Chromium normally adds --hide-scrollbars in headless mode. Only the
      // presentation suite removes it, so CI exercises real scrollbar paint
      // without changing geometry in unrelated E2E coverage.
      ignoreDefaultArgs: requiresNativeScrollbars ? ['--hide-scrollbars'] : undefined,
      viewport: null,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${preparedExtensionPath}`,
        `--load-extension=${preparedExtensionPath}`,
        '--window-size=1280,900',
        '--force-device-scale-factor=1',
        // Playwright adds --hide-scrollbars in headless mode. Chromium's
        // explicit override keeps native scrollbars paintable for pixel tests.
        ...(requiresNativeScrollbars || process.env.PW_HEADED === '1' ? ['--show-scrollbars'] : []),
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await mkdir(testInfo.outputPath('browser'), { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    try {
      await use(context);
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const [index, page] of context.pages().entries()) {
          await page.screenshot({ path: testInfo.outputPath(`browser/page-${index}.png`), fullPage: true }).catch(() => {});
        }
        await context.tracing.stop({ path: testInfo.outputPath('browser/trace.zip') }).catch(() => {});
      } else {
        await context.tracing.stop().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  extensionId: async ({ extensionContext }, use) => {
    let worker = extensionContext.serviceWorkers()[0];
    if (!worker) worker = await extensionContext.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },

  appPage: async ({ extensionContext }, use) => {
    const page = extensionContext.pages()[0] ?? await extensionContext.newPage();
    await page.goto(FIXTURE_URL);
    await use(page);
  },

  popupPage: async ({ extensionContext, extensionId }, use) => {
    const popup = await extensionContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(popup);
  },

  browserErrors: async ({ extensionContext }, use, testInfo) => {
    const errors: string[] = [];
    const attachPage = (page: Page) => {
      page.on('pageerror', (error) => errors.push(`pageerror: ${error}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
      });
    };
    for (const page of extensionContext.pages()) attachPage(page);
    extensionContext.on('page', attachPage);
    for (const worker of extensionContext.serviceWorkers()) {
      worker.on('console', (message) => {
        if (message.type() === 'error') errors.push(`worker: ${message.text()}`);
      });
    }
    await use(errors);
    if (errors.length > 0) {
      await testInfo.attach('browser-errors.json', {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      });
    }
    expect(errors, 'browser console errors').toEqual([]);
  },
});

export { expect };

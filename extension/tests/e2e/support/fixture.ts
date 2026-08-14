import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { preparedExtensionPath } from './paths';

export const FIXTURE_URL = 'http://127.0.0.1:4175/';

type Fixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  appPage: Page;
  popupPage: Page;
  browserErrors: string[];
};

type Options = {
  /**
   * Opt a spec into scrollbars that paint and take layout space, via
   * `test.use({ nativeScrollbars: true })`. Off by default so the rest of the
   * suite keeps the scrollbar-free geometry Chromium's headless mode gives it.
   */
  nativeScrollbars: boolean;
};

export const test = base.extend<Fixtures & Options>({
  nativeScrollbars: [false, { option: true }],

  extensionContext: async ({ nativeScrollbars }, use, testInfo) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'frametrail-playwright-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.PW_HEADED !== '1',
      // Chromium 的 --hide-scrollbars 是此 fixture 捲軸間隙的唯一開關；僅像素斷言需移除它。
      ignoreDefaultArgs: nativeScrollbars ? ['--hide-scrollbars'] : undefined,
      viewport: null,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${preparedExtensionPath}`,
        `--load-extension=${preparedExtensionPath}`,
        '--window-size=1280,900',
        '--force-device-scale-factor=1',
        // ignoreDefaultArgs 處理 headless；此參數只補強 headed 模式。
        ...(nativeScrollbars || process.env.PW_HEADED === '1' ? ['--show-scrollbars'] : []),
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
    const attachWorker = (worker: Worker) => {
      worker.on('console', (message) => {
        if (message.type() === 'error') errors.push(`worker: ${message.text()}`);
      });
    };
    for (const worker of extensionContext.serviceWorkers()) attachWorker(worker);
    // MV3 service workers restart at will; hook the replacements too so errors
    // from a respawned background are never silently dropped.
    extensionContext.on('serviceworker', attachWorker);
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

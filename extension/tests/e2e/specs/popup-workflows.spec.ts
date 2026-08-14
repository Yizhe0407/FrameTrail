import { test, expect } from '../support/fixture';
import {
  clickTarget,
  expectStepCount,
  readRecordingState,
  resetExtensionData,
  startStepsRunWithFirstStep,
  stopRecording,
} from '../support/harness';

// Runs inside extension pages via page.evaluate; typed locally like the harness.
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
};

async function readActiveGuideId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get('frametrail:activeGuideId');
    const value = stored['frametrail:activeGuideId'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

async function readGuideIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('frametrail', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const keysRequest = db.transaction('guides', 'readonly').objectStore('guides').getAllKeys();
        keysRequest.onsuccess = () => {
          db.close();
          resolve((keysRequest.result as string[]).sort());
        };
        keysRequest.onerror = () => {
          db.close();
          reject(keysRequest.error);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  }));
}

async function clickPopupCommandWithoutActivatingTab(
  popupPage: import('@playwright/test').Page,
  label: string,
): Promise<void> {
  await popupPage.evaluate((expectedLabel) => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === expectedLabel,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Popup command ${expectedLabel} was not found`);
    button.click();
  }, label);
}

test.describe('popup workflows', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('starts snapshot recording always numbered and shows the active-run summary', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    const stepsMode = popupPage.getByRole('radio', { name: '步驟' });
    const snapshotMode = popupPage.getByRole('radio', { name: '快照' });
    await expect(stepsMode).toHaveAttribute('aria-checked', 'true');
    await snapshotMode.click();
    await expect(snapshotMode).toHaveAttribute('aria-checked', 'true');
    await expect(popupPage.getByText('鎖定目前畫面，在同一張截圖上加入多個標註點。')).toBeVisible();

    await expect(popupPage.getByRole('switch', { name: '自動編號' })).toHaveCount(0);

    const statePage = await extensionContext.newPage();
    await statePage.goto(`chrome-extension://${extensionId}/editor.html`);
    // The mount-time preflight reads the active tab; a real popup opens while
    // the target page is active, so activate it before remounting the popup
    // (the popup-as-tab harness would otherwise preflight against itself and
    // show the restricted-page notice).
    await appPage.bringToFront();
    await popupPage.reload({ waitUntil: 'domcontentloaded' });
    await popupPage.evaluate(() => {
      window.close = () => {};
    });
    await popupPage.getByRole('radio', { name: '快照' }).click();
    await expect(popupPage.getByRole('radio', { name: '快照' })).toHaveAttribute('aria-checked', 'true');
    const seededGuideId = await readActiveGuideId(statePage);
    expect(seededGuideId).toBeTruthy();
    await clickPopupCommandWithoutActivatingTab(popupPage, '開始錄製');

    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(true);
    await expect.poll(async () => (await readRecordingState(statePage)).phase).toBe('recording');
    await expect.poll(async () => (await readRecordingState(statePage)).mode).toBe('snapshot');
    await expect.poll(async () => (await readRecordingState(statePage)).numbered).toBe(true);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(1);

    // Popup start always records into a brand-new Guide (Scribe/Tango
    // convention); the previously selected Guide is never appended to.
    const runSessionId = (await readRecordingState(statePage)).sessionId;
    expect(runSessionId).toBeTruthy();
    expect(runSessionId).not.toBe(seededGuideId);

    await expect(popupPage.getByText('快照 · 0 個標註')).toBeVisible();
    await expect(popupPage.getByRole('button', { name: '回到錄製分頁' })).toBeEnabled();
    await expect(popupPage.getByRole('button', { name: '停止錄製' })).toHaveCount(0);
    await stopRecording(statePage);
    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);

    // The run captured nothing, so the auto-created Guide is reclaimed: only
    // the seeded Guide survives and the dangling selection is cleared.
    await expect.poll(() => readGuideIds(statePage)).toEqual([seededGuideId]);
    await expect.poll(() => readActiveGuideId(statePage)).toBeNull();
  });

  test('opens the editor and keeps data actions disabled for an empty session', async ({
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    // resetExtensionData creates and selects an empty Guide. Keep this id so
    // the assertion verifies URL-owned Guide selection rather than whatever
    // recording state happens to be current when the editor initializes.
    const activeGuideId = await popupPage.evaluate(async () => {
      const extensionChrome = globalThis as typeof globalThis & {
        chrome: { storage: { local: { get(keys: string): Promise<Record<string, unknown>> } } };
      };
      const stored = await extensionChrome.chrome.storage.local.get('frametrail:activeGuideId');
      return stored['frametrail:activeGuideId'];
    });
    if (typeof activeGuideId !== 'string' || activeGuideId.length === 0) {
      throw new Error('Expected reset data to select an empty Guide.');
    }

    await expect(popupPage.getByRole('button', { name: '重置' })).toBeDisabled();
    await expect(popupPage.getByRole('button', { name: '作品庫', exact: true })).toBeEnabled();

    const editorPromise = extensionContext.waitForEvent('page');
    await popupPage.getByRole('button', { name: '編輯器' }).click();
    const editor = await editorPromise;
    await editor.waitForLoadState('domcontentloaded');

    const editorUrl = new URL(editor.url());
    expect(editorUrl.protocol).toBe('chrome-extension:');
    expect(editorUrl.host).toBe(extensionId);
    expect(editorUrl.pathname).toBe('/editor.html');
    expect(editorUrl.searchParams.get('sessionId')).toBe(activeGuideId);
    expect(editorUrl.searchParams.get('entryId')).toBeNull();

    await expect(editor.getByText('尚未建立內容', { exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: '回到網頁開始錄製' })).toBeVisible();
    await expect(editor.getByRole('button', { name: '匯出' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '重置' })).toBeDisabled();
  });

  test('opens a multi-step guide at its first entry, not its latest capture', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    await clickTarget(appPage, '#visual-container strong');
    await expectStepCount(popupPage, 2);
    await stopRecording(popupPage);

    const editorOpened = extensionContext.waitForEvent('page');
    await popupPage.getByRole('button', { name: '開啟編輯器' }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');

    // Ordinary navigation must not inherit the newest capture as its target:
    // opening a finished guide should start reading it from the top.
    expect(new URL(editor.url()).searchParams.get('entryId')).toBeNull();
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveAttribute('aria-current', 'step');
    await expect(editor.getByRole('button', { name: '開啟步驟 2' })).not.toHaveAttribute('aria-current', 'step');
  });

  test('keeps recorded data recoverable when the source tab closes', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);

    await appPage.close();

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(async () => {
      const error = (await readRecordingState(popupPage)).recoverableError as { code?: string } | undefined;
      return error?.code;
    }).toBe('RECORDED_TAB_CLOSED');
    await expect(popupPage.getByText('錄製分頁已關閉。已錄內容仍保留，可完成並開啟編輯器。')).toBeVisible();
    await expect(popupPage.getByRole('button', { name: '完成並開啟編輯器' })).toBeVisible();

    const editorOpened = extensionContext.waitForEvent('page');
    await popupPage.getByRole('button', { name: '完成並開啟編輯器' }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    expect(editor.url()).toContain('entryId=');
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveAttribute('aria-current', 'step');
    await expect.poll(async () => (await readRecordingState(editor)).recoverableError).toBeNull();
  });
});

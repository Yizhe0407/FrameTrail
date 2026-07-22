import { test, expect } from '../support/fixture';
import {
  clickTarget,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';

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

  test('starts snapshot recording with the selected numbering option and shows the active-run summary', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    const stepsMode = popupPage.getByRole('radio', { name: '操作流程' });
    const snapshotMode = popupPage.getByRole('radio', { name: '單頁標註' });
    await expect(stepsMode).toHaveAttribute('aria-checked', 'true');
    await snapshotMode.click();
    await expect(snapshotMode).toHaveAttribute('aria-checked', 'true');
    await expect(popupPage.getByText('鎖定目前畫面；在同一張圖加入多個標註。')).toBeVisible();

    const numbering = popupPage.getByRole('switch', { name: '顯示順序編號' });
    await expect(numbering).toBeChecked();
    await numbering.click();
    await expect(numbering).not.toBeChecked();

    const statePage = await extensionContext.newPage();
    await statePage.goto(`chrome-extension://${extensionId}/editor.html`);
    await popupPage.evaluate(() => {
      window.close = () => {};
    });
    await appPage.bringToFront();
    await clickPopupCommandWithoutActivatingTab(popupPage, '開始');

    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(true);
    await expect.poll(async () => (await readRecordingState(statePage)).phase).toBe('recording');
    await expect.poll(async () => (await readRecordingState(statePage)).mode).toBe('snapshot');
    await expect.poll(async () => (await readRecordingState(statePage)).numbered).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(1);

    await expect(popupPage.getByText('單頁標註 · 0 個標註')).toBeVisible();
    await expect(popupPage.getByRole('button', { name: '回到錄製分頁' })).toBeEnabled();
    await expect(popupPage.getByRole('button', { name: '停止錄製' })).toHaveCount(0);
    await stopRecording(statePage);
    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
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

    await expect(popupPage.getByRole('button', { name: '匯出圖片' })).toHaveCount(0);
    await expect(popupPage.getByRole('button', { name: '重置' })).toHaveCount(0);

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
    await expect(editor.getByRole('button', { name: '發佈' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '重置' })).toBeDisabled();
  });

  test('keeps recorded data recoverable when the source tab closes', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

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

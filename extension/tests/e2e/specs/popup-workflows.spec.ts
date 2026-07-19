import { test, expect } from '../support/fixture';
import {
  readRecordingState,
  resetExtensionData,
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

  test('starts snapshot recording with the selected numbering option and stops from the popup', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    const stepsMode = popupPage.getByRole('button', { name: '步驟模式' });
    const snapshotMode = popupPage.getByRole('button', { name: '快照模式' });
    await expect(stepsMode).toHaveAttribute('aria-pressed', 'true');
    await snapshotMode.click();
    await expect(snapshotMode).toHaveAttribute('aria-pressed', 'true');
    await expect(popupPage.getByText('滑過任意可見元素會先預覽，選取後疊標在同一張圖。')).toBeVisible();

    const numbering = popupPage.getByRole('switch', { name: '標記順序編號' });
    await expect(numbering).toBeChecked();
    await numbering.click();
    await expect(numbering).not.toBeChecked();

    const statePage = await extensionContext.newPage();
    await statePage.goto(`chrome-extension://${extensionId}/editor.html`);
    await popupPage.evaluate(() => {
      window.close = () => {};
    });
    await appPage.bringToFront();
    await clickPopupCommandWithoutActivatingTab(popupPage, '開始錄製');

    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(true);
    await expect.poll(async () => (await readRecordingState(statePage)).mode).toBe('snapshot');
    await expect.poll(async () => (await readRecordingState(statePage)).numbered).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(1);

    await expect(popupPage.getByRole('button', { name: '停止錄製' })).toBeEnabled();
    await clickPopupCommandWithoutActivatingTab(popupPage, '停止錄製');
    await expect.poll(async () => (await readRecordingState(statePage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
  });

  test('opens the editor and keeps data actions disabled for an empty session', async ({
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await expect(popupPage.getByRole('button', { name: '匯出圖片' })).toBeDisabled();
    await expect(popupPage.getByRole('button', { name: '重置' })).toBeDisabled();

    const editorPromise = extensionContext.waitForEvent('page');
    await popupPage.getByRole('button', { name: '開啟編輯器' }).click();
    const editor = await editorPromise;
    await editor.waitForLoadState('domcontentloaded');

    expect(editor.url()).toMatch(/^chrome-extension:\/\/[^/]+\/editor\.html$/);
    await expect(editor.getByText('尚未錄製任何步驟')).toBeVisible();
    await expect(editor.getByRole('button', { name: '匯出圖片' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '重置' })).toBeDisabled();
  });
});

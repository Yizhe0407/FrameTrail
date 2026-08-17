import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../support/fixture';
import {
  clickTarget,
  expectStepCount,
  resetExtensionData,
  seedAndSelectGuide,
  sendRecordingControl,
  startRecording,
  startStepsRunWithFirstStep,
} from '../support/harness';

/**
 * The product keeps exactly one editor tab. Mocked openers are what let the
 * duplicate-tab bug survive for so long, so these assertions are deliberately
 * about what a user can see: how many editor pages exist, and which Guide the
 * surviving one shows.
 */
function extensionPages(context: BrowserContext, page: 'editor' | 'library'): Page[] {
  return context.pages().filter((candidate) => new URL(candidate.url()).pathname === `/${page}.html`);
}

function viewedSessionId(editor: Page): string | null {
  return new URL(editor.url()).searchParams.get('sessionId');
}

test.describe('single editor tab', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('reuses the open editor when the library opens a different Guide', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    // The seeded Guide gets one captured step, so the two Guides are told apart
    // by what the editor renders and not only by its URL.
    await startStepsRunWithFirstStep(appPage, popupPage);
    const editorOpened = extensionContext.waitForEvent('page');
    await sendRecordingControl(popupPage, 'FINISH_RECORDING');

    const firstEditor = await editorOpened;
    await firstEditor.waitForLoadState('domcontentloaded');
    const recordedGuideId = viewedSessionId(firstEditor);
    expect(recordedGuideId).toBeTruthy();
    await expect(firstEditor.getByText('步驟 · 1', { exact: true })).toBeVisible();

    const library = await extensionContext.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    // 新增 creates an empty Guide and opens it, which must land in the editor
    // tab that is already open rather than a third tab. The toolbar control and
    // the trailing add-card tile share the same name; the toolbar one is first.
    await library.getByRole('button', { name: '新增', exact: true }).first().click();

    await expect.poll(() => viewedSessionId(firstEditor)).not.toBe(recordedGuideId);
    const newGuideId = viewedSessionId(firstEditor);
    await expect(firstEditor.getByText('尚未建立內容', { exact: true })).toBeVisible();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);

    // Back the other way: the recorded Guide's card must reuse the same tab.
    await library.bringToFront();
    const recordedCard = library.getByRole('listitem').filter({ hasText: '1 個畫面' });
    await expect(recordedCard).toHaveCount(1);
    await recordedCard.getByRole('button', { name: '開啟', exact: true }).click();

    await expect.poll(() => viewedSessionId(firstEditor)).toBe(recordedGuideId);
    expect(newGuideId).not.toBe(recordedGuideId);
    await expect(firstEditor.getByText('步驟 · 1', { exact: true })).toBeVisible();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);

    // The library page is discovered by the same registry, so returning to it
    // from the editor must not open a second one either.
    await firstEditor.bringToFront();
    await firstEditor.getByRole('button', { name: '作品庫', exact: true }).click();
    await expect.poll(() => extensionPages(extensionContext, 'library').length).toBe(1);
  });

  test('finishing two recordings in a row leaves one editor tab', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    const editorOpened = extensionContext.waitForEvent('page');
    const firstFinish = await sendRecordingControl(popupPage, 'FINISH_RECORDING');
    expect(firstFinish.ok).toBe(true);

    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    const firstGuideId = viewedSessionId(editor);
    expect(firstGuideId).toBeTruthy();

    // A second run records into another Guide, exactly as a popup start does.
    // That mismatch is what used to spawn a new tab on every 完成.
    const secondGuideId = await seedAndSelectGuide(popupPage, '第二份錄製');
    expect(secondGuideId).not.toBe(firstGuideId);
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#plain-text');
    // Step counts are read across the whole store, so the second run's capture
    // has to be awaited as the second row overall.
    await expectStepCount(popupPage, 2);
    const secondFinish = await sendRecordingControl(popupPage, 'FINISH_RECORDING');
    expect(secondFinish.ok).toBe(true);

    await expect.poll(() => viewedSessionId(editor)).toBe(secondGuideId);
    // Finishing hands the editor the run's last capture, as before.
    await expect.poll(() => new URL(editor.url()).searchParams.get('entryId')).not.toBeNull();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);
  });
});

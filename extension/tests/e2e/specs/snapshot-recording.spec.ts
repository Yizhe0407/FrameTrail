import { test, expect } from '../support/fixture';
import {
  clickSnapshotTarget,
  getSnapshotFrame,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
  targetCenter,
} from '../support/harness';

test.describe('snapshot recording', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('shows hover preview, commits numbered marks, and deduplicates the same target', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot', true);
    const point = await targetCenter(appPage, '#plain-text');
    const shield = await getSnapshotFrame(appPage);

    await shield.locator('body').hover({ position: point });
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    await expect(shield.locator('body')).toHaveClass(/has-preview-target/);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect(shield.locator('.snapshot-annotation__badge-label')).toHaveText('1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await clickSnapshotTarget(appPage, point);
    await appPage.waitForTimeout(300);
    expect(await readSteps(popupPage)).toHaveLength(2);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);

    const steps = await readSteps(popupPage);
    const anchor = steps.find((step) => step.bounds === null);
    const annotation = steps.find((step) => step.bounds !== null);
    expect(anchor).toMatchObject({ hasScreenshot: true, groupId: expect.any(String) });
    expect(annotation).toMatchObject({ hasScreenshot: false, description: '標記 這是一段不可點擊的純文字' });
    expect(annotation?.groupId).toBe(anchor?.id);

    await stopRecording(popupPage);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
  });

  test('isolates page input and supports parent candidate navigation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot', false);
    const point = await targetCenter(appPage, '#plain-text');
    const shield = await getSnapshotFrame(appPage);

    await shield.locator('body').hover({ position: point });
    await expect.poll(() => shield.evaluate(() => document.hasFocus())).toBe(true);
    await expect.poll(() => appPage.evaluate(() => document.activeElement?.hasAttribute('data-frametrail-snapshot-shield'))).toBe(true);
    const initialStyle = await shield.locator('.snapshot-box--preview').getAttribute('style');
    await appPage.keyboard.press('ArrowUp');
    await expect.poll(async () => shield.locator('.snapshot-box--preview').getAttribute('style')).not.toBe(initialStyle);

    await clickSnapshotTarget(appPage, point);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    expect(await appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(0);

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
  }
}

import { test, expect } from '../support/fixture';
import {
  clickSnapshotTarget,
  getSnapshotFrame,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';

test.describe('frames and recording lifecycle', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('records targets in cross-origin and nested frames', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto('http://127.0.0.1:4175/frames-host.html');
    await startRecording(appPage, popupPage, 'snapshot', false);
    const outer = appPage.frameLocator('#cross-origin-frame');
    const outerBox = await outer.locator('#frame-text').boundingBox();
    if (!outerBox) throw new Error('Cross-origin frame target has no box');
    await clickSnapshotTarget(appPage, {
      x: outerBox.x + outerBox.width / 2,
      y: outerBox.y + outerBox.height / 2,
    });
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const nested = outer.frameLocator('#nested-frame');
    const outerFrameMetrics = await appPage.locator('#cross-origin-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedFrameMetrics = await outer.locator('#nested-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedTargetMetrics = await nested.locator('#nested-text').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const nestedPoint = {
      x:
        outerFrameMetrics.x + outerFrameMetrics.borderLeft + nestedFrameMetrics.x +
        nestedFrameMetrics.borderLeft + nestedTargetMetrics.x + nestedTargetMetrics.width / 2,
      y:
        outerFrameMetrics.y + outerFrameMetrics.borderTop + nestedFrameMetrics.y +
        nestedFrameMetrics.borderTop + nestedTargetMetrics.y + nestedTargetMetrics.height / 2,
    };
    const shield = await getSnapshotFrame(appPage);
    await shield.locator('body').hover({
      position: nestedPoint,
    });
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    await clickSnapshotTarget(appPage, nestedPoint);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(3);

    expect((await readSteps(popupPage)).map((step) => step.description).filter(Boolean)).toEqual([
      '標記頁面區域',
      '標記頁面區域',
    ]);
    await stopRecording(popupPage);
  });

  test('falls back to the visible iframe box when a sandboxed frame is inaccessible', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto('http://127.0.0.1:4175/sandbox-host.html');
    await startRecording(appPage, popupPage, 'snapshot', false);
    await appPage.locator('#sandbox-frame').evaluate((element) => {
      element.replaceWith(element.cloneNode(true));
    });
    await expect(appPage.frameLocator('#sandbox-frame').locator('body')).toContainText('sandbox 純文字');
    const frameBox = await appPage.locator('#sandbox-frame').boundingBox();
    if (!frameBox) throw new Error('Sandbox frame has no box');
    await clickSnapshotTarget(appPage, {
      x: frameBox.x + frameBox.width / 2,
      y: frameBox.y + frameBox.height / 2,
    });

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    const annotation = (await readSteps(popupPage)).find((step) => step.bounds !== null);
    expect(annotation?.description).toBe('標記頁面區域');
    expect(annotation?.bounds?.width).toBeGreaterThan(500);
    await stopRecording(popupPage);
  });

  test('stops a snapshot run when its document navigates', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await appPage.goto('http://127.0.0.1:4175/navigated.html');

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    expect((await readRecordingState(popupPage)).error).toBe('Recording stopped because the snapshot page changed.');
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
  });

  test('reinjects step recording after a top-level navigation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await appPage.goto('http://127.0.0.1:4175/navigated.html');

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(true);
    await expect.poll(() => appPage.locator('[data-frametrail-step-preview]').count()).toBe(1);
    const heading = appPage.getByRole('heading', { name: '已導覽到新文件' });
    const box = await heading.boundingBox();
    if (!box) throw new Error('Navigated heading has no box');
    await appPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    expect((await readSteps(popupPage))[0]?.description).toBe('標記頁面區域');
    await stopRecording(popupPage);
  });

  test('removes an empty snapshot anchor on stop', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    expect(await readSteps(popupPage)).toHaveLength(1);
    await stopRecording(popupPage);
    expect(await readSteps(popupPage)).toHaveLength(0);
  });
});

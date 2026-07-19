import { test, expect } from '../support/fixture';
import {
  clickTarget,
  getStepPreviewStyle,
  hoverTarget,
  rawScreenshotRosePixels,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';

test.describe('step recording', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('previews and records generic visible elements without baking the hover frame', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await hoverTarget(appPage, '#plain-text');

    const preview = await getStepPreviewStyle(appPage);
    expect(preview.hidden).toBe(false);
    expect(preview.style).toContain('border: 2px solid rgb(244, 63, 94)');
    expect(preview.style).toContain('box-shadow: none');

    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    const [step] = await readSteps(popupPage);
    expect(step.description).toBe('標記 這是一段不可點擊的純文字');
    expect(step.bounds).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(step.hasScreenshot).toBe(true);
    expect(await rawScreenshotRosePixels(popupPage, step.id)).toBe(0);

    await stopRecording(popupPage);
    await expect.poll(() => appPage.locator('[data-frametrail-step-preview]').count()).toBe(0);
  });

  test('records interactive controls as clicks and replays the page handler once', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#action-button span');

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(1);
    const [step] = await readSteps(popupPage);
    expect(step.description).toBe('點擊 執行操作');

    await stopRecording(popupPage);
  });

  test('marks disabled controls, SVG, canvas, and general containers', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    const selectors = ['#disabled-button', '#fixture-svg rect', '#fixture-canvas', '#visual-container strong'];
    for (const [index, selector] of selectors.entries()) {
      await clickTarget(appPage, selector);
      await expect.poll(
        async () => (await readSteps(popupPage)).length,
        { message: `expected ${selector} to create a step` },
      ).toBe(index + 1);
      await appPage.waitForTimeout(420);
    }

    const descriptions = (await readSteps(popupPage)).map((step) => step.description);
    expect(descriptions).toEqual([
      '標記 停用操作',
      '標記 流程圖示',
      '標記 趨勢圖',
      '標記 一般視覺容器',
    ]);

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
  }
}

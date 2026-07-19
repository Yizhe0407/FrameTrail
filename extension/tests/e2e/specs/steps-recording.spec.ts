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

  test('keeps scrolling usable, previews below-the-fold targets, and ignores the scrollbar gutter', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');

    // Bug A: a nested viewport must keep scrolling while step-recording, and
    // the stationary pointer must be re-hit-tested against the newly revealed
    // element rather than keeping a stale preview.
    await hoverTarget(appPage, '#scroll-first');
    const previewBeforeScroll = await getStepPreviewStyle(appPage);
    expect(previewBeforeScroll.hidden).toBe(false);
    const scrollPoint = await appPage.locator('#scroll-viewport').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    // Virtualized sites can emit this while replacing the element under a
    // stationary pointer. It must not clear the last viewport coordinate.
    await appPage.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent('pointerout', {
        clientX: x,
        clientY: y,
        relatedTarget: null,
      }));
    }, scrollPoint);
    await appPage.mouse.wheel(0, 110);
    await expect.poll(() => appPage.locator('#scroll-viewport').evaluate((element) => element.scrollTop)).toBe(110);
    await expect.poll(() => appPage.evaluate(
      ({ x: clientX, y: clientY }) => document.elementFromPoint(clientX, clientY)?.id,
      scrollPoint,
    )).toBe('scroll-second');
    await expect.poll(async () => {
      const preview = await getStepPreviewStyle(appPage);
      return !preview.hidden && preview.style !== previewBeforeScroll.style;
    }).toBe(true);

    // A virtual list may replace the row under a stationary pointer after its
    // scroll event has settled. The local observer must refresh immediately,
    // without relying on another pointermove or the low-frequency fallback.
    const beforeReplacement = await getStepPreviewStyle(appPage);
    await appPage.evaluate(() => {
      const current = document.querySelector('#scroll-second')!;
      const replacement = document.createElement('button');
      replacement.id = 'scroll-replacement';
      replacement.textContent = '虛擬列表替換內容';
      replacement.style.cssText = 'display:block;width:180px;height:70px;margin-left:100px';
      current.replaceWith(replacement);
    });
    await expect.poll(async () => {
      const preview = await getStepPreviewStyle(appPage);
      return !preview.hidden && preview.style !== beforeReplacement.style;
    }, { timeout: 500 }).toBe(true);

    // Page-level wheel scrolling remains native as well. Google News applies
    // overflow to <body>; after scrolling its border box starts at -scrollY,
    // while hit-test and preview coordinates remain viewport-relative.
    await appPage.evaluate(() => {
      document.body.style.overflowY = 'scroll';
    });
    await appPage.mouse.move(900, 400);
    const startScroll = await appPage.evaluate(() => window.scrollY);
    await appPage.mouse.wheel(0, 900);
    await expect.poll(() => appPage.evaluate(() => window.scrollY)).toBeGreaterThan(startScroll);
    expect(await appPage.evaluate(() => document.body.getBoundingClientRect().top)).toBeLessThan(0);

    // The hover preview follows a target that only exists below the fold.
    await appPage.locator('#below-fold').scrollIntoViewIfNeeded();
    await hoverTarget(appPage, '#below-fold');
    const preview = await getStepPreviewStyle(appPage);
    expect(preview.hidden).toBe(false);

    // Clicking it captures a step whose rect sits inside the viewport and whose
    // screenshot never baked the hover frame (preview stayed hidden through capture).
    await clickTarget(appPage, '#below-fold');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const [belowFoldStep] = await readSteps(popupPage);
    expect(belowFoldStep.description).toBe('標記 頁面下方內容');
    const viewport = await appPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(belowFoldStep.bounds).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(belowFoldStep.bounds!.x).toBeGreaterThanOrEqual(0);
    expect(belowFoldStep.bounds!.y).toBeGreaterThanOrEqual(0);
    expect(belowFoldStep.bounds!.x + belowFoldStep.bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(belowFoldStep.bounds!.y + belowFoldStep.bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await rawScreenshotRosePixels(popupPage, belowFoldStep.id)).toBe(0);

    // Bug A1: a pointerdown in the native scrollbar gutter must not record a step.
    const gutter = await appPage.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      const clientHeight = document.documentElement.clientHeight;
      return {
        x: Math.min(clientWidth + 1, window.innerWidth - 1),
        y: Math.floor(clientHeight / 2),
      };
    });
    await appPage.mouse.move(gutter.x, gutter.y);
    await appPage.mouse.down();
    await appPage.mouse.move(gutter.x, gutter.y + 120, { steps: 4 });
    await appPage.mouse.up();
    await appPage.waitForTimeout(300);
    expect((await readSteps(popupPage)).length).toBe(1);

    // The same rule applies to a nested scrollport: its scrollbar gutter is a
    // native scroll gesture, never a generic mark on the scroll container.
    const nestedGutter = await appPage.locator('#scroll-viewport').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + rect.height / 2 };
    });
    await appPage.mouse.move(nestedGutter.x, nestedGutter.y);
    await appPage.mouse.down();
    await appPage.mouse.move(nestedGutter.x, nestedGutter.y + 30, { steps: 2 });
    await appPage.mouse.up();
    await appPage.waitForTimeout(300);
    expect((await readSteps(popupPage)).length).toBe(1);

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

import { test, expect } from '../support/fixture';
import { readPageScreenshotPixel, resetExtensionData, startRecording, stopRecording } from '../support/harness';

/** Recorder chrome (the toolbar) must stay above the recorder's own annotations: a hover frame wrapping most of the page must never tint or hide the controls. */
test('the hover preview never draws over the recording toolbar', async ({ appPage, popupPage, browserErrors }) => {
  await appPage.setViewportSize({ width: 1280, height: 760 });
  await resetExtensionData(popupPage);
  await appPage.evaluate(() => {
    const cover = document.createElement('button');
    cover.id = 'viewport-cover';
    cover.type = 'button';
    cover.style.cssText = 'position:fixed;inset:0;z-index:1;border:0;background:#fff;cursor:pointer';
    document.body.append(cover);
  });
  await startRecording(appPage, popupPage, 'steps');

  // Bottom-right is the toolbar's default home; sample inside its primary "完成" button.
  const point = { x: 1186, y: 715 };
  await appPage.mouse.move(640, 300);
  await appPage.waitForTimeout(400);
  const hovered = await readPageScreenshotPixel(appPage, point.x, point.y);

  // Park the pointer on nothing targetable to hide the frame, then compare.
  await appPage.evaluate(() => document.getElementById('viewport-cover')!.style.setProperty('pointer-events', 'none'));
  await appPage.mouse.move(2, 2);
  await appPage.waitForTimeout(400);
  const idle = await readPageScreenshotPixel(appPage, point.x, point.y);

  expect(hovered).toEqual(idle);
  await stopRecording(popupPage);
  expect(browserErrors).toEqual([]);
});

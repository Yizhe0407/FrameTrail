import { test, expect, FIXTURE_URL } from '../support/fixture';
import { readSteps, resetExtensionData, startRecording, stopRecording } from '../support/harness';

interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rectOf(page: Parameters<typeof startRecording>[0], id: string): Promise<ProbeRect> {
  return page.evaluate((target) => window.detectionProbe.rectOf(target), id);
}

async function clickRect(page: Parameters<typeof startRecording>[0], rect: ProbeRect): Promise<void> {
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

function expectBoundsNear(bounds: ProbeRect | null, expected: ProbeRect): void {
  expect(bounds).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(bounds![key] - expected[key]), `${key} of captured bounds`).toBeLessThanOrEqual(1);
  }
}

test.describe('element detection', () => {
  test.beforeEach(async ({ appPage, popupPage }) => {
    await resetExtensionData(popupPage);
    await appPage.goto(`${FIXTURE_URL}detection.html`);
  });

  test('targets the control inside a closed shadow root, not its host', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const shadowButton = await rectOf(appPage, 'shadow-button');
    const host = await rectOf(appPage, 'closed-host');
    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, shadowButton);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const [step] = await readSteps(popupPage);
    // Without closed-root access the hit test stops at the host, which would
    // record the whole 320x160 block as an unlabelled page region.
    expect(step.description).toBe('點擊按鈕');
    expectBoundsNear(step.bounds, shadowButton);
    expect(step.bounds!.width).toBeLessThan(host.width);

    await stopRecording(popupPage);
  });

  test('records delegated click bindings as controls', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const jsaction = await rectOf(appPage, 'jsaction-card');
    const stimulus = await rectOf(appPage, 'stimulus-card');
    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, jsaction);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await clickRect(appPage, stimulus);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const steps = await readSteps(popupPage);
    // Neither card has a role, href, handler property or pointer cursor: the
    // framework attribute is the only evidence that they are controls.
    expect(steps.map((step) => step.description)).toEqual(['點擊互動元素', '點擊互動元素']);
    expectBoundsNear(steps[0].bounds, jsaction);
    expectBoundsNear(steps[1].bounds, stimulus);

    await stopRecording(popupPage);
  });

  test('looks past a small transparent hit-test shim', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const covered = await rectOf(appPage, 'small-covered-button');
    await startRecording(appPage, popupPage, 'steps');
    await appPage.evaluate(() => window.detectionProbe.armSmallOverlay());
    await expect
      .poll(() => appPage.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
        x: covered.x + covered.width / 2,
        y: covered.y + covered.height / 2,
      }))
      .toBe('small-blank-overlay');
    await clickRect(appPage, covered);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const [step] = await readSteps(popupPage);
    expect(step.description).toBe('點擊按鈕');
    expectBoundsNear(step.bounds, covered);

    await stopRecording(popupPage);
  });

  test('looks past a blank overlay to the button it covers', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const covered = await rectOf(appPage, 'covered-button');
    await startRecording(appPage, popupPage, 'steps');
    await appPage.evaluate(() => window.detectionProbe.armOverlay());
    await expect
      .poll(() => appPage.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
        x: covered.x + covered.width / 2,
        y: covered.y + covered.height / 2,
      }))
      .toBe('blank-overlay');
    await clickRect(appPage, covered);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const [step] = await readSteps(popupPage);
    expect(step.description).toBe('點擊按鈕');
    expectBoundsNear(step.bounds, covered);

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    detectionProbe: {
      rectOf(id: string): ProbeRect;
      armOverlay(): void;
      armSmallOverlay(): void;
    };
  }
}

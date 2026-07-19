import { test, expect } from '../support/fixture';
import {
  clickSnapshotTarget,
  getSnapshotFrame,
  readRecordingState,
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

  test('undoes, restores, and finishes through the snapshot shield toolbar', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot', true);
    const shield = await getSnapshotFrame(appPage);
    const point = await targetCenter(appPage, '#plain-text');
    await expect(shield.getByRole('button', { name: '完成快照' })).toBeVisible();

    await clickSnapshotTarget(appPage, point);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await shield.getByRole('button', { name: '復原上一個' }).click();
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect(shield.locator('.ft-snackbar')).toContainText('已移除標註 1');

    await shield.getByRole('button', { name: '還原' }).click();
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const editorOpened = extensionContext.waitForEvent('page');
    await shield.getByRole('button', { name: '完成快照' }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
    expect(editor.url()).toContain('groupId=');
    await expect(editor.getByRole('button', { name: '選取步驟 1' })).toHaveAttribute('aria-current', 'step');
  });

  test('reuses committed SVG nodes while relayout moves existing annotations', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot', true);
    const shield = await getSnapshotFrame(appPage);
    const firstPoint = await targetCenter(appPage, '#plain-text');
    const secondPoint = await targetCenter(appPage, '#action-button');

    await clickSnapshotTarget(appPage, firstPoint);
    const firstTargetGroup = shield.locator('g[data-snapshot-selection-id="1"]', {
      has: shield.locator('.snapshot-annotation__frame'),
    });
    await expect(firstTargetGroup).toHaveCount(1);
    await firstTargetGroup.evaluate((element) => element.setAttribute('data-reconciliation-probe', 'retained'));

    await clickSnapshotTarget(appPage, secondPoint);

    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(2);
    await expect(firstTargetGroup).toHaveAttribute('data-reconciliation-probe', 'retained');
    await stopRecording(popupPage);
  });

  test('keeps a committed frame fully painted when its target touches every viewport edge', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.evaluate(() => {
      const target = document.createElement('button');
      target.id = 'viewport-edge-target';
      target.type = 'button';
      target.textContent = 'Viewport edge target';
      Object.assign(target.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147480000',
        margin: '0',
        padding: '0',
        border: '0',
        borderRadius: '0',
        background: '#ffffff',
      });
      document.body.append(target);
    });

    const point = await targetCenter(appPage, '#viewport-edge-target');
    await startRecording(appPage, popupPage, 'snapshot', false);
    const shield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, point);

    const paintBounds = await shield.locator('.snapshot-annotation__frame').evaluate((element) => {
      const frame = element as SVGRectElement;
      const svg = frame.ownerSVGElement!;
      const viewBox = svg.viewBox.baseVal;
      const strokeWidth = Number(frame.getAttribute('stroke-width'));
      const halfStroke = strokeWidth / 2;
      return {
        viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
        strokeWidth,
        left: frame.x.baseVal.value - halfStroke,
        top: frame.y.baseVal.value - halfStroke,
        right: frame.x.baseVal.value + frame.width.baseVal.value + halfStroke,
        bottom: frame.y.baseVal.value + frame.height.baseVal.value + halfStroke,
        frameWidth: frame.width.baseVal.value,
        frameHeight: frame.height.baseVal.value,
      };
    });

    expect(paintBounds.strokeWidth).toBeGreaterThan(0);
    expect(paintBounds.frameWidth).toBeGreaterThan(0);
    expect(paintBounds.frameHeight).toBeGreaterThan(0);
    expect(paintBounds.left).toBeGreaterThanOrEqual(paintBounds.viewBox.x);
    expect(paintBounds.top).toBeGreaterThanOrEqual(paintBounds.viewBox.y);
    expect(paintBounds.right).toBeLessThanOrEqual(paintBounds.viewBox.x + paintBounds.viewBox.width);
    expect(paintBounds.bottom).toBeLessThanOrEqual(paintBounds.viewBox.y + paintBounds.viewBox.height);
    expect(paintBounds.left).toBe(paintBounds.viewBox.x);
    expect(paintBounds.top).toBe(paintBounds.viewBox.y);
    expect(paintBounds.right).toBe(paintBounds.viewBox.x + paintBounds.viewBox.width);
    expect(paintBounds.bottom).toBe(paintBounds.viewBox.y + paintBounds.viewBox.height);

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
  }
}

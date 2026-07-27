import { test, expect } from '../support/fixture';
import {
  clickSnapshotTarget,
  expectSteady,
  getSnapshotFrame,
  readRecordingState,
  readSteps,
  resetExtensionData,
  sendRecordingControl,
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
    await startRecording(appPage, popupPage, 'snapshot');
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
    await expectSteady(async () => (await readSteps(popupPage)).length, 2);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);

    const steps = await readSteps(popupPage);
    const anchor = steps.find((step) => step.bounds === null);
    const annotation = steps.find((step) => step.bounds !== null);
    expect(anchor).toMatchObject({ hasScreenshot: true, groupId: expect.any(String) });
    expect(annotation).toMatchObject({ hasScreenshot: false, description: '標記頁面區域' });
    expect(annotation?.groupId).toBe(anchor?.id);

    await stopRecording(popupPage);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
  });

  test('isolates page input and supports parent candidate navigation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
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
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = await targetCenter(appPage, '#plain-text');
    await expect(shield.getByRole('button', { name: '完成', exact: true })).toBeVisible();

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
    await shield.getByRole('button', { name: '完成', exact: true }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
    expect(editor.url()).toContain('groupId=');
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveAttribute('aria-current', 'step');
  });

  test('moves and persists the toolbar, then discards the current run after confirmation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    const readToolbarCorner = () => popupPage.evaluate(async () => {
      const extensionApi = (globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }).chrome;
      const result = await extensionApi.storage.local.get('frametrail:recordingToolbarCorner');
      return result['frametrail:recordingToolbarCorner'];
    });

    const positionControl = shield.getByRole('button', { name: /拖曳或使用方向鍵移動/ });
    await positionControl.focus();
    await positionControl.press('ArrowUp');
    await expect.poll(() => shield.locator('.ft-toolbar').evaluate((element) => {
      return Math.round(element.getBoundingClientRect().top);
    })).toBe(16);
    await expect.poll(readToolbarCorner).toBe('top-right');

    const handle = await positionControl.boundingBox();
    const viewportHeight = await appPage.evaluate(() => window.innerHeight);
    expect(handle).not.toBeNull();
    await appPage.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(40, viewportHeight - 40, { steps: 6 });
    await appPage.mouse.up();
    await expect.poll(() => shield.locator('.ft-toolbar').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        bottom: Math.round(window.innerHeight - rect.bottom),
      };
    })).toEqual({ left: 16, bottom: 16 });
    await expect.poll(readToolbarCorner).toBe('bottom-left');

    // The "更多錄製動作" dropdown-menu trigger only exists in the toolbar's
    // invalidated-viewport variant now (lib/recording/recording-toolbar.tsx).
    // The normal toolbar shows "放棄這次錄製" as an always-visible icon button
    // directly, with no menu step in between.
    await shield.getByRole('button', { name: '放棄這次錄製' }).click();
    await expect(shield.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeVisible();
    await shield.getByRole('button', { name: '放棄錄製' }).click();

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(0);
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
  });

  test('creates independent snapshot groups after releasing the page for navigation', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const firstShield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    await firstShield.getByRole('button', { name: '完成並新增快照' }).click();
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('preparing-next');
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(0);
    await expect(appPage.locator('[data-frametrail-recording-toolbar]')).toHaveCount(1);

    await appPage.goto('http://127.0.0.1:4175/navigated.html');
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('preparing-next');
    await expect.poll(() => appPage.locator('[data-frametrail-recording-toolbar]').count()).toBe(1);

    const createResults = await Promise.all([
      sendRecordingControl(popupPage, 'CREATE_NEXT_SNAPSHOT'),
      sendRecordingControl(popupPage, 'CREATE_NEXT_SNAPSHOT'),
    ]);
    expect(createResults.filter((result) => result.ok)).toHaveLength(1);
    expect(createResults.filter((result) => !result.ok)).toHaveLength(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');

    const secondShield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(
      appPage,
      await targetCenter(appPage, 'h1'),
    );
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    const steps = await readSteps(popupPage);
    const anchors = steps.filter((step) => step.bounds === null);
    const annotations = steps.filter((step) => step.bounds !== null);
    expect(anchors).toHaveLength(2);
    expect(annotations).toHaveLength(2);
    expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(2);
    expect(new Set(annotations.map((annotation) => annotation.groupId))).toEqual(
      new Set(anchors.map((anchor) => anchor.id)),
    );

    const editorOpened = extensionContext.waitForEvent('page');
    await secondShield.getByRole('button', { name: '完成', exact: true }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect(editor.getByRole('button', { name: /開啟步驟/ })).toHaveCount(2);
  });

  test('invalidates changed viewports, preserves the old group, and rebuilds onto a new anchor', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    const originalSteps = await readSteps(popupPage);
    const originalAnchor = originalSteps.find((step) => step.bounds === null)!;
    const currentViewport = await appPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await appPage.setViewportSize({ width: 320, height: Math.max(currentViewport.height - 40, 500) });

    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('invalidated');
    const invalidatedShield = await getSnapshotFrame(appPage);
    await expect(invalidatedShield.getByText('畫面尺寸已改變，需建立新快照才能繼續。')).toBeVisible();
    await expect(invalidatedShield.getByRole('button', { name: '保留並重建' })).toBeVisible();
    await expect(invalidatedShield.getByRole('button', { name: '完成錄製' })).toBeVisible();
    const invalidatedLayout = await invalidatedShield.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
      };
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        toolbar: rect('.ft-toolbar--invalidated'),
        status: rect('.ft-invalidated-status'),
        secondary: rect('.ft-invalidated-actions .ft-secondary'),
        primary: rect('.ft-invalidated-actions .ft-finish'),
      };
    });
    expect(invalidatedLayout.scrollWidth).toBeLessThanOrEqual(invalidatedLayout.viewportWidth);
    expect(invalidatedLayout.toolbar.left).toBeGreaterThanOrEqual(0);
    expect(invalidatedLayout.toolbar.right).toBeLessThanOrEqual(invalidatedLayout.viewportWidth);
    expect(invalidatedLayout.status.bottom).toBeLessThanOrEqual(invalidatedLayout.secondary.top);
    expect(invalidatedLayout.secondary.right).toBeLessThanOrEqual(invalidatedLayout.primary.left);

    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#action-button'));
    await expectSteady(async () => await readSteps(popupPage), originalSteps);

    await invalidatedShield.getByRole('button', { name: '保留並重建' }).click();
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');
    const rebuiltSteps = await readSteps(popupPage);
    const rebuiltAnchors = rebuiltSteps.filter((step) => step.bounds === null);
    expect(rebuiltAnchors).toHaveLength(2);
    expect(rebuiltSteps).toEqual(expect.arrayContaining(originalSteps));
    expect(rebuiltAnchors.map((step) => step.id)).toContain(originalAnchor.id);

    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#action-button'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    const afterRebuild = await readSteps(popupPage);
    const newestAnchor = afterRebuild.filter((step) => step.bounds === null).at(-1)!;
    const newestAnnotation = afterRebuild.filter((step) => step.bounds !== null).at(-1)!;
    expect(newestAnchor.id).not.toBe(originalAnchor.id);
    expect(newestAnnotation.groupId).toBe(newestAnchor.id);

    const countBeforeScroll = afterRebuild.length;
    await appPage.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('invalidated');
    expect(await readSteps(popupPage)).toHaveLength(countBeforeScroll);
    const scrolledShield = await getSnapshotFrame(appPage);
    await expect(scrolledShield.getByRole('button', { name: '保留並重建' })).toBeVisible();

    const editorOpened = extensionContext.waitForEvent('page');
    await scrolledShield.getByRole('button', { name: '完成錄製' }).click();
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    expect(editor.url()).toContain('groupId=');
  });

  test('reuses committed SVG nodes while relayout moves existing annotations', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
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
    await startRecording(appPage, popupPage, 'snapshot');
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

  test('commits and undoes an annotation with the keyboard only', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    await expect(shield.getByRole('button', { name: '完成', exact: true })).toBeVisible();

    // Focus the skip link to enter the shield, then Tab to the first candidate
    // (the enabled action button, first in reading order). No pointer is used.
    await shield.locator('.snapshot-skip-link').focus();
    await appPage.keyboard.press('Tab');
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible({ timeout: 10_000 });

    await appPage.keyboard.press('Enter');
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect(shield.locator('.snapshot-annotation__badge-label')).toHaveText('1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await appPage.keyboard.press('Delete');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);

    // The page underneath never received the activation.
    expect(await appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(0);

    await stopRecording(popupPage);
  });

  test('advertises candidate cycling only where another box exists', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    // The hint lives inside the shield toolbar, which already occupies its own
    // pixels: an affordance next to the box would cover the content the user
    // is trying to annotate.
    const hint = shield.locator('.ft-cycle-hint');

    // Nested content: the span sits inside a card inside <main>, so the point
    // has ancestors to widen into but nothing narrower than the default.
    const nested = await targetCenter(appPage, '#plain-text');
    await appPage.mouse.move(nested.x, nested.y);
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    await expect(hint).toHaveText('↑ 選取更大範圍');

    // After widening once, both directions are live.
    await appPage.keyboard.press('ArrowUp');
    await expect(hint).toHaveText('↑↓ 調整選取範圍');

    const widened = await shield.locator('.snapshot-box--preview').getAttribute('style');
    await appPage.keyboard.press('ArrowDown');
    await expect
      .poll(() => shield.locator('.snapshot-box--preview').getAttribute('style'))
      .not.toBe(widened);

    // The hint is chrome, not content: committing must not bake it into the
    // screenshot, and the committed annotation clears it.
    await clickSnapshotTarget(appPage, nested);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await expect(hint).toBeHidden();

    await stopRecording(popupPage);
  });

  test('scrolling keys cannot move the frozen page out from under the snapshot', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await getSnapshotFrame(appPage);
    // Focus lands on a shield toolbar button, which the candidate handler
    // deliberately leaves alone. The shield document cannot scroll, so any key
    // the browser still acts on chains its scroll to the frozen page and
    // invalidates the run.
    await appPage.mouse.move(400, 300);

    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'End', 'Home', 'Space']) {
      await appPage.keyboard.press(key);
    }
    await expectSteady(async () => (await readRecordingState(popupPage)).phase, 'recording');

    expect(await appPage.evaluate(() => window.scrollY)).toBe(0);
    const state = await readRecordingState(popupPage);
    expect(state.phase).not.toBe('invalidated');
    expect(state.recoverableError).toBeNull();

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
  }
}

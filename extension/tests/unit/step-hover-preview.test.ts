// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStepHoverPreview, type StepHoverPreview } from '@/lib/recording/step-hover-preview';
import { createViewportOverlayHost } from '@/lib/capture/viewport-overlay-host';

function makeVisible(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  const box = {
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect,
  };
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => box });
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [box] });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('step hover preview candidate cycling', () => {
  let preview: StepHoverPreview;
  let cycling: Array<{ canWiden: boolean; canNarrow: boolean } | null>;
  let card: HTMLElement;
  let text: HTMLElement;

  beforeEach(() => {
    const article = document.createElement('article');
    card = document.createElement('div');
    text = document.createElement('span');
    card.append(text);
    article.append(card);
    document.body.append(article);
    makeVisible(article, { x: 0, y: 0, width: 600, height: 400 });
    makeVisible(card, { x: 20, y: 20, width: 300, height: 120 });
    makeVisible(text, { x: 30, y: 30, width: 90, height: 24 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => text });

    cycling = [];
    preview = createStepHoverPreview({
      isPaused: () => false,
      isGestureActive: () => false,
      isRegionCaptureActive: () => false,
      onCandidateCycling: (state) => cycling.push(state),
    });
  });

  afterEach(() => {
    preview.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function hover(clientX = 40, clientY = 40): Promise<void> {
    preview.handlers.onPointerMove({ clientX, clientY } as PointerEvent);
    await nextFrame();
  }

  it('reports only the direction the point can still be cycled', async () => {
    await hover();

    expect(cycling.at(-1)).toEqual({ canWiden: true, canNarrow: false });
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });

  it('widens the target and updates the hint, then refuses a dead-end key', async () => {
    await hover();

    expect(preview.adjustCandidateOffset(1)).toBe(true);
    expect(preview.resolveTargetAt(40, 40)).toBe(card);
    expect(cycling.at(-1)).toEqual({ canWiden: true, canNarrow: true });

    // Two more widens reach the outermost box; a third has nothing left, and
    // saying so lets the content script leave the key to the page.
    preview.adjustCandidateOffset(1);
    preview.adjustCandidateOffset(1);
    expect(preview.adjustCandidateOffset(1)).toBe(false);
    expect(cycling.at(-1)).toEqual({ canWiden: false, canNarrow: true });
  });

  it('retains an explicitly selected level while moving inside its visual surface', async () => {
    await hover();
    preview.adjustCandidateOffset(1);
    expect(preview.resolveTargetAt(40, 40)).toBe(card);

    await hover(41, 41);

    expect(preview.resolveTargetAt(41, 41)).toBe(card);
  });

  it('locks target identity across descendants with different wrapper depths', async () => {
    const nestedWrapper = document.createElement('div');
    const nestedText = document.createElement('span');
    nestedWrapper.append(nestedText);
    card.append(nestedWrapper);
    makeVisible(nestedWrapper, { x: 180, y: 30, width: 100, height: 50 });
    makeVisible(nestedText, { x: 190, y: 40, width: 60, height: 20 });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (clientX: number) => (clientX < 150 ? text : nestedText),
    });

    await hover(40, 40);
    preview.adjustCandidateOffset(1);
    expect(preview.resolveTargetAt(40, 40)).toBe(card);

    // Reusing offset 1 on the deeper chain would select nestedWrapper. The
    // explicit lock must keep the card itself instead.
    await hover(200, 50);
    expect(preview.resolveTargetAt(200, 50)).toBe(card);
  });

  it('releases the selected level after leaving its hysteresis boundary', async () => {
    await hover();
    preview.adjustCandidateOffset(1);

    // The card starts at x=20; six pixels of spill remain locked, the seventh
    // starts a new chain from its default candidate.
    await hover(14, 40);
    expect(preview.resolveTargetAt(14, 40)).toBe(card);
    await hover(13, 40);
    expect(preview.resolveTargetAt(13, 40)).toBe(text);
  });

  it('drops the controls when the highlight goes away', async () => {
    await hover();
    preview.suspend();

    expect(cycling.at(-1)).toBeNull();
  });

  it('freezes on its last page target while the pointer is over recorder UI', async () => {
    await hover();
    const overlayHost = createViewportOverlayHost('data-frametrail-recording-toolbar');
    document.body.append(overlayHost);

    preview.handlers.onPointerMove({ clientX: 500, clientY: 500, target: overlayHost } as unknown as PointerEvent);
    await nextFrame();

    // The point never moved, so the toolbar's resize controls still act on the
    // page element the user was aiming at — and the toolbar is never a target.
    expect(cycling.at(-1)).toEqual({ canWiden: true, canNarrow: false });
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });
});

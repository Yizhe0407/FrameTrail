// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStepHoverPreview, type StepHoverPreview } from '@/lib/recording/step-hover-preview';

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
  let hints: Array<string | null>;
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

    hints = [];
    preview = createStepHoverPreview({
      isPaused: () => false,
      isGestureActive: () => false,
      isRegionCaptureActive: () => false,
      onCycleHint: (label) => hints.push(label),
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

  it('announces only the direction the point can still be cycled', async () => {
    await hover();

    expect(hints.at(-1)).toBe('Alt+↑ 選取更大範圍');
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });

  it('widens the target and updates the hint, then refuses a dead-end key', async () => {
    await hover();

    expect(preview.adjustCandidateOffset(1)).toBe(true);
    expect(preview.resolveTargetAt(40, 40)).toBe(card);
    expect(hints.at(-1)).toBe('Alt+↑↓ 調整選取範圍');

    // Two more widens reach the outermost box; a third has nothing left, and
    // saying so lets the content script leave the key to the page.
    preview.adjustCandidateOffset(1);
    preview.adjustCandidateOffset(1);
    expect(preview.adjustCandidateOffset(1)).toBe(false);
    expect(hints.at(-1)).toBe('Alt+↓ 選取更小範圍');
  });

  it('resets the offset when the pointer lands on a new point', async () => {
    await hover();
    preview.adjustCandidateOffset(1);
    expect(preview.resolveTargetAt(40, 40)).toBe(card);

    await hover(41, 41);

    expect(preview.resolveTargetAt(41, 41)).toBe(text);
  });

  it('clears the hint when the highlight goes away', async () => {
    await hover();
    preview.suspend();

    expect(hints.at(-1)).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import {
  collectKeyboardCandidateAnchors,
  createSnapshotTargetResolver,
} from '@/lib/recording/snapshot-targeting';
import { SNAPSHOT_FREEZE_EVENTS } from '@/lib/recording/content-script-constants';
import { describeElement, replayElementClick } from '@/lib/capture/element-description';
import {
  isOutOfViewport,
  readRegionScrollSnapshot,
  readScrollSnapshot,
} from '@/lib/capture/scroll-snapshot';
import { snapshotRectKey } from '@/lib/recording/snapshot-shield-protocol';

/** jsdom performs no layout, so scroll geometry is stubbed per element. */
function makeScrollable(
  element: HTMLElement,
  { scrollTop = 0, scrollLeft = 0, axis = 'y' as 'x' | 'y' } = {},
): void {
  // jsdom does not expand the overflow shorthand into computed longhands.
  element.style.overflowX = axis === 'x' ? 'auto' : 'visible';
  element.style.overflowY = axis === 'y' ? 'auto' : 'visible';
  const vertical = axis === 'y';
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: vertical ? 400 : 0 });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: vertical ? 100 : 0 });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: vertical ? 0 : 400 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: vertical ? 0 : 100 });
  Object.defineProperty(element, 'scrollTop', { configurable: true, value: scrollTop });
  Object.defineProperty(element, 'scrollLeft', { configurable: true, value: scrollLeft });
}

function stubRect(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    }),
  });
}

function stubElementFromPoint(implementation: (x: number, y: number) => Element | null) {
  const spy = vi.fn(implementation);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: spy });
  return spy;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});


describe('createSnapshotTargetResolver', () => {
  it('uses the shared Element identity lock instead of reapplying an offset to each hit chain', async () => {
    const card = document.createElement('div');
    const shallowText = document.createElement('span');
    const wrapper = document.createElement('div');
    const nestedText = document.createElement('span');
    wrapper.append(nestedText);
    card.append(shallowText, wrapper);
    document.body.append(card);
    stubRect(card, { x: 20, y: 20, width: 300, height: 120 });
    stubRect(shallowText, { x: 30, y: 30, width: 90, height: 24 });
    stubRect(wrapper, { x: 180, y: 30, width: 100, height: 50 });
    stubRect(nestedText, { x: 190, y: 40, width: 60, height: 20 });
    for (const element of [card, shallowText, wrapper, nestedText]) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => [element.getBoundingClientRect()],
      });
    }
    stubElementFromPoint((x) => (x < 150 ? shallowText : nestedText));
    const resolver = createSnapshotTargetResolver('run-1');

    const widened = await resolver.resolveAt(40, 40, 1, 0);
    expect(widened?.element).toBe(card);

    // Offset 1 on nestedText's fresh chain would select wrapper. The retained
    // concrete identity must continue selecting card instead.
    const retained = await resolver.resolveAt(200, 50, 1, 0);
    expect(retained?.element).toBe(card);

    // A deliberate epoch reset starts a fresh chain at the current hit.
    const reset = await resolver.resolveAt(200, 50, 0, 1);
    expect(reset?.element).toBe(nestedText);
  });
});

describe('SNAPSHOT_FREEZE_EVENTS', () => {
  it('covers every activation family without duplicates', () => {
    expect(new Set(SNAPSHOT_FREEZE_EVENTS).size).toBe(SNAPSHOT_FREEZE_EVENTS.length);
    // Both halves of each press/release pair must freeze, or a page sees an
    // unmatched up/down through the pre-ready window.
    const events: readonly string[] = SNAPSHOT_FREEZE_EVENTS;
    for (const pair of [
      ['pointerdown', 'pointerup'],
      ['mousedown', 'mouseup'],
      ['keydown', 'keyup'],
      ['touchstart', 'touchend'],
    ]) {
      expect(events).toContain(pair[0]);
      expect(events).toContain(pair[1]);
    }
    for (const type of ['click', 'submit', 'beforeinput', 'input', 'wheel', 'contextmenu', 'dragstart', 'drop']) {
      expect(events).toContain(type);
    }
  });
});

describe('isOutOfViewport', () => {
  it('accepts rects fully inside the viewport, including exact fits', () => {
    expect(isOutOfViewport({ x: 10, y: 10, width: 100, height: 50 })).toBe(false);
    expect(isOutOfViewport({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })).toBe(false);
  });

  it('rejects rects crossing any viewport edge', () => {
    expect(isOutOfViewport({ x: -1, y: 10, width: 10, height: 10 })).toBe(true);
    expect(isOutOfViewport({ x: 10, y: -0.5, width: 10, height: 10 })).toBe(true);
    expect(isOutOfViewport({ x: window.innerWidth - 5, y: 10, width: 10, height: 10 })).toBe(true);
    expect(isOutOfViewport({ x: 10, y: window.innerHeight - 5, width: 10, height: 10 })).toBe(true);
  });
});

describe('snapshotRectKey', () => {
  it('is stable at half-pixel precision', () => {
    expect(snapshotRectKey({ x: 1, y: 2, width: 3, height: 4 })).toBe('2:4:6:8');
    // Sub-half-pixel jitter maps to the same key…
    expect(snapshotRectKey({ x: 1.2, y: 2.2, width: 3.1, height: 4.2 })).toBe(
      snapshotRectKey({ x: 1, y: 2, width: 3, height: 4 }),
    );
    // …but a genuine half-pixel move produces a new one.
    expect(snapshotRectKey({ x: 1.5, y: 2, width: 3, height: 4 })).not.toBe(
      snapshotRectKey({ x: 1, y: 2, width: 3, height: 4 }),
    );
  });
});

describe('describeElement', () => {
  it('prefers aria-label over every other source and trims it', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', '  Save changes  ');
    button.setAttribute('title', 'tooltip');
    expect(describeElement(button)).toBe('Save changes');
  });

  it('uses the field label, then the placeholder, for form controls', () => {
    const label = document.createElement('label');
    label.htmlFor = 'field';
    Object.defineProperty(label, 'innerText', { configurable: true, value: ' 電子郵件 ' });
    const input = document.createElement('input');
    input.id = 'field';
    input.placeholder = 'name@example.com';
    document.body.append(label, input);

    expect(describeElement(input)).toBe('電子郵件');
    label.htmlFor = 'other';
    expect(describeElement(input)).toBe('name@example.com');
  });

  it('falls back to the first non-empty visible text line', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'innerText', { configurable: true, value: '  \n 第一行文字 \n second line' });
    expect(describeElement(div)).toBe('第一行文字');
  });

  it('falls back to title, then alt, and caps the result at 200 characters', () => {
    const image = document.createElement('img');
    image.setAttribute('alt', 'diagram');
    expect(describeElement(image)).toBe('diagram');
    image.setAttribute('title', 'Chart of results');
    expect(describeElement(image)).toBe('Chart of results');

    const long = document.createElement('button');
    long.setAttribute('aria-label', 'x'.repeat(300));
    expect(describeElement(long)).toHaveLength(200);
  });
});

describe('readScrollSnapshot', () => {
  it('captures window offsets plus every scrollable composed ancestor', () => {
    const outer = document.createElement('div');
    const middle = document.createElement('div');
    const target = document.createElement('button');
    middle.append(target);
    outer.append(middle);
    document.body.append(outer);
    makeScrollable(outer, { scrollTop: 25, scrollLeft: 5 });

    const snapshot = readScrollSnapshot(target);

    expect(snapshot.x).toBe(window.scrollX);
    expect(snapshot.y).toBe(window.scrollY);
    expect(snapshot.containers).toEqual([{ element: outer, x: 5, y: 25 }]);
  });

  it('crosses shadow boundaries through the composed tree', () => {
    const host = document.createElement('div');
    document.body.append(host);
    makeScrollable(host, { scrollTop: 60 });
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    shadow.append(inner);

    expect(readScrollSnapshot(inner).containers).toEqual([{ element: host, x: 0, y: 60 }]);
  });
});

describe('readRegionScrollSnapshot', () => {
  it('samples the center and inset corners and dedupes shared containers', () => {
    const container = document.createElement('div');
    const childA = document.createElement('span');
    const childB = document.createElement('span');
    container.append(childA, childB);
    document.body.append(container);
    makeScrollable(container, { scrollTop: 40 });

    const hits = stubElementFromPoint((x) => (x < 50 ? childA : childB));
    const snapshot = readRegionScrollSnapshot({ x: 8, y: 8, width: 80, height: 40 });

    // Center plus four corners inset by min(4, size/4).
    expect(hits.mock.calls).toEqual([
      [48, 28],
      [12, 12],
      [84, 12],
      [12, 44],
      [84, 44],
    ]);
    // Different hit elements, one shared scroll container: recorded once.
    expect(snapshot.containers).toEqual([{ element: container, x: 0, y: 40 }]);
    expect(snapshot.x).toBe(window.scrollX);
    expect(snapshot.y).toBe(window.scrollY);
  });

  it('shrinks the sampling inset for slim regions', () => {
    const hits = stubElementFromPoint(() => null);
    const snapshot = readRegionScrollSnapshot({ x: 0, y: 0, width: 8, height: 8 });

    expect(hits.mock.calls).toEqual([
      [4, 4],
      [2, 2],
      [6, 2],
      [2, 6],
      [6, 6],
    ]);
    expect(snapshot.containers).toEqual([]);
  });
});

describe('collectKeyboardCandidateAnchors', () => {
  it('collects visible interactive elements ordered top-to-bottom with fallback labels', () => {
    const lower = document.createElement('button');
    Object.defineProperty(lower, 'innerText', { configurable: true, value: '送出' });
    const upper = document.createElement('div');
    upper.setAttribute('role', 'button');
    const invisible = document.createElement('button');
    const disabled = document.createElement('button');
    disabled.disabled = true;
    document.body.append(lower, upper, invisible, disabled);
    stubRect(lower, { x: 10, y: 200, width: 80, height: 30 });
    stubRect(upper, { x: 10, y: 40, width: 80, height: 30 });
    stubRect(invisible, { x: 0, y: 0, width: 0, height: 0 });
    stubRect(disabled, { x: 10, y: 10, width: 80, height: 30 });

    const anchors = collectKeyboardCandidateAnchors();

    expect(anchors.map((anchor) => anchor.label)).toEqual(['div', '送出']);
    // Anchors carry the candidate's center point for the shield to target.
    expect(anchors[0]).toMatchObject({ x: 50, y: 55 });
  });
});

describe('replayElementClick', () => {
  it('focuses without scrolling and replays the native click exactly once', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const focus = vi.spyOn(button, 'focus');
    const click = vi.spyOn(button, 'click');

    replayElementClick(button);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('dispatches a composed bubbling click for elements without a click method', () => {
    // Vitest's jsdom globals reject `view: window` in MouseEventInit even
    // though it is valid in a page; a minimal stand-in keeps the branch runnable.
    vi.stubGlobal(
      'MouseEvent',
      class extends Event {
        constructor(type: string, init: EventInit = {}) {
          super(type, init);
        }
      },
    );
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    document.body.append(rect);
    const seen: Event[] = [];
    document.body.addEventListener('click', (event) => seen.push(event));

    try {
      replayElementClick(rect);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].composed).toBe(true);
  });
});

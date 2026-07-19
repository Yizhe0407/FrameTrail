// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSnapshotTargetIdentity,
  findInteractiveTargetAtPoint,
  findVisualTargetCandidates,
  getVisibleHighlightBounds,
  isInteractiveElement,
  isElementVisuallyUnavailable,
  selectVisualTargetCandidate,
} from './selector-utils';

function makeVisible(element: Element, rect = { x: 20, y: 20, width: 120, height: 40 }): void {
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
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => [
      {
        ...rect,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      },
    ],
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('findInteractiveTargetAtPoint', () => {
  it('selects the perceived control instead of its nested label', () => {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);
    makeVisible(button);
    makeVisible(label, { x: 30, y: 25, width: 40, height: 20 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => label) });

    expect(findInteractiveTargetAtPoint(35, 30)).toBe(button);
  });

  it('looks through an open shadow root before choosing the target', () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    document.body.append(host);
    makeVisible(host);
    makeVisible(button);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => host) });
    Object.defineProperty(shadowRoot, 'elementFromPoint', { configurable: true, value: vi.fn(() => button) });

    expect(findInteractiveTargetAtPoint(35, 30)).toBe(button);
  });

  it('excludes disabled and inert controls', () => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    container.append(button);
    document.body.append(container);
    makeVisible(container);
    makeVisible(button);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => button) });

    button.disabled = true;
    expect(findInteractiveTargetAtPoint(35, 30)).toBeNull();

    button.disabled = false;
    container.setAttribute('inert', '');
    expect(findInteractiveTargetAtPoint(35, 30)).toBeNull();
  });

  it('keeps semantically interactive SVG controls', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('role', 'button');
    document.body.append(svg);
    makeVisible(svg);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => svg) });

    expect(findInteractiveTargetAtPoint(35, 30)).toBe(svg);
  });

  it('recognizes fallback ARIA role tokens and ignores inert links without href', () => {
    const control = document.createElement('div');
    control.setAttribute('role', 'unknown button');
    document.body.append(control);
    makeVisible(control);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => control) });
    expect(findInteractiveTargetAtPoint(35, 30)).toBe(control);

    const link = document.createElement('a');
    control.replaceWith(link);
    makeVisible(link);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => link) });
    expect(findInteractiveTargetAtPoint(35, 30)).toBeNull();
    link.setAttribute('onclick', 'void 0');
    expect(findInteractiveTargetAtPoint(35, 30)).toBe(link);

    const heading = document.createElement('div');
    heading.setAttribute('role', 'heading button');
    link.replaceWith(heading);
    makeVisible(heading);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => heading) });
    expect(findInteractiveTargetAtPoint(35, 30)).toBeNull();
  });

  it('treats ARIA disabled values case-insensitively', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-disabled', ' TRUE ');
    document.body.append(button);
    makeVisible(button);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => button) });

    expect(findInteractiveTargetAtPoint(35, 30)).toBeNull();
  });

  it('recognizes assigned click handlers and all editable true states', () => {
    const target = document.createElement('div');
    document.body.append(target);
    makeVisible(target);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });

    target.onclick = () => {};
    expect(findInteractiveTargetAtPoint(35, 30)).toBe(target);
    target.onclick = null;
    target.setAttribute('contenteditable', '');
    expect(findInteractiveTargetAtPoint(35, 30)).toBe(target);
    target.setAttribute('contenteditable', 'plaintext-only');
    expect(findInteractiveTargetAtPoint(35, 30)).toBe(target);
  });
});

describe('findVisualTargetCandidates', () => {
  it('selects non-interactive content and cycles through distinct parent boxes', () => {
    const article = document.createElement('article');
    const paragraph = document.createElement('p');
    const text = document.createElement('span');
    paragraph.append(text);
    article.append(paragraph);
    document.body.append(article);
    makeVisible(article, { x: 10, y: 10, width: 300, height: 180 });
    makeVisible(paragraph, { x: 20, y: 20, width: 240, height: 80 });
    makeVisible(text, { x: 30, y: 30, width: 100, height: 24 });

    const targets = findVisualTargetCandidates(text, 40, 40);

    expect(targets.candidates.map((candidate) => candidate.element)).toEqual([text, paragraph, article]);
    expect(selectVisualTargetCandidate(targets, 0)).toMatchObject({ element: text, candidateOffset: 0 });
    expect(selectVisualTargetCandidate(targets, 1)).toMatchObject({ element: paragraph, candidateOffset: 1 });
    expect(selectVisualTargetCandidate(targets, 99)).toMatchObject({ element: article, candidateOffset: 2 });
  });

  it('keeps a semantic control as the default while allowing its child to be selected', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    document.body.append(button);
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    makeVisible(icon, { x: 30, y: 25, width: 20, height: 20 });

    const targets = findVisualTargetCandidates(icon, 35, 30);

    expect(selectVisualTargetCandidate(targets, 0)).toMatchObject({ element: button, candidateOffset: 0 });
    expect(selectVisualTargetCandidate(targets, -1)).toMatchObject({ element: icon, candidateOffset: -1 });
    expect(selectVisualTargetCandidate(targets, 1)).toMatchObject({ element: button, candidateOffset: 0 });
  });

  it('allows visible disabled and inert content in snapshot mode', () => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    container.setAttribute('inert', '');
    button.disabled = true;
    container.append(button);
    document.body.append(container);
    makeVisible(container, { x: 10, y: 10, width: 180, height: 80 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });

    const targets = findVisualTargetCandidates(button, 30, 30);

    expect(isInteractiveElement(button)).toBe(false);
    expect(isElementVisuallyUnavailable(button)).toBe(false);
    expect(selectVisualTargetCandidate(targets, 0)?.element).toBe(button);
  });

  it('collapses identical child and control boxes to the semantic control', () => {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);
    makeVisible(button);
    makeVisible(label);

    const targets = findVisualTargetCandidates(label, 35, 30);

    expect(targets.candidates).toHaveLength(1);
    expect(targets.candidates[0].element).toBe(button);
  });

  it('skips invisible descendants and decorative SVG geometry', () => {
    const paragraph = document.createElement('p');
    const hiddenText = document.createElement('span');
    hiddenText.style.opacity = '0';
    paragraph.append(hiddenText);
    document.body.append(paragraph);
    makeVisible(paragraph, { x: 20, y: 20, width: 160, height: 50 });
    makeVisible(hiddenText, { x: 30, y: 25, width: 80, height: 20 });

    expect(findVisualTargetCandidates(hiddenText, 35, 30).candidates[0].element).toBe(paragraph);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(path);
    paragraph.replaceWith(svg);
    makeVisible(svg, { x: 20, y: 20, width: 40, height: 40 });
    makeVisible(path, { x: 25, y: 25, width: 20, height: 20 });

    expect(findVisualTargetCandidates(path, 30, 30).candidates[0].element).toBe(svg);

    path.setAttribute('role', 'button');
    expect(findVisualTargetCandidates(path, 30, 30).candidates[0].element).toBe(path);
  });

  it('follows the composed tree through assigned slots', () => {
    const host = document.createElement('section');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const wrapper = document.createElement('div');
    const slot = document.createElement('slot');
    const slotted = document.createElement('span');
    wrapper.append(slot);
    shadowRoot.append(wrapper);
    host.append(slotted);
    document.body.append(host);
    Object.defineProperty(slotted, 'assignedSlot', { configurable: true, value: slot });
    makeVisible(host, { x: 10, y: 10, width: 220, height: 100 });
    makeVisible(wrapper, { x: 20, y: 20, width: 180, height: 60 });
    makeVisible(slotted, { x: 30, y: 30, width: 80, height: 20 });

    const targets = findVisualTargetCandidates(slotted, 40, 35);

    expect(targets.candidates.map((candidate) => candidate.element)).toEqual([slotted, wrapper, host]);
  });

  it('uses the inline fragment containing the pointer', () => {
    const text = document.createElement('span');
    document.body.append(text);
    makeVisible(text, { x: 20, y: 20, width: 160, height: 50 });
    Object.defineProperty(text, 'getClientRects', {
      configurable: true,
      value: () => [
        { x: 20, y: 20, top: 20, left: 20, right: 100, bottom: 40, width: 80, height: 20 },
        { x: 20, y: 50, top: 50, left: 20, right: 140, bottom: 70, width: 120, height: 20 },
      ],
    });

    expect(findVisualTargetCandidates(text, 30, 60).candidates[0].bounds).toEqual({
      x: 20,
      y: 50,
      width: 120,
      height: 20,
    });
  });
});

describe('getVisibleHighlightBounds', () => {
  it('intersects the target with its clipping ancestors and viewport', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 100, height: 50 });
    makeVisible(button, { x: -20, y: 10, width: 200, height: 100 });

    expect(getVisibleHighlightBounds(button, 30, 30, { width: 90, height: 80 })).toEqual({
      x: 20,
      y: 20,
      width: 70,
      height: 50,
    });
  });

  it('uses the overflow scrollport inside a scaled border box', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 200, height: 100 });
    makeVisible(button, { x: 0, y: 0, width: 300, height: 200 });
    for (const [name, value] of Object.entries({
      offsetWidth: 100,
      offsetHeight: 50,
      clientLeft: 5,
      clientTop: 4,
      clientWidth: 90,
      clientHeight: 42,
    })) {
      Object.defineProperty(clip, name, { configurable: true, value });
    }

    expect(getVisibleHighlightBounds(button, 40, 40, { width: 400, height: 300 })).toEqual({
      x: 30,
      y: 28,
      width: 180,
      height: 84,
    });
  });

  it('honors paint containment shorthands', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.contain = 'content';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 100, height: 50 });
    makeVisible(button, { x: 0, y: 0, width: 200, height: 100 });

    expect(getVisibleHighlightBounds(button, 40, 40, { width: 400, height: 300 })).toEqual({
      x: 20,
      y: 20,
      width: 100,
      height: 50,
    });
  });
});

describe('isInteractiveElement', () => {
  it('requires image-map areas to have an action', () => {
    const area = document.createElement('area');
    expect(isInteractiveElement(area)).toBe(false);
    area.href = '/details';
    expect(isInteractiveElement(area)).toBe(true);
  });
});

describe('buildSnapshotTargetIdentity', () => {
  it('keeps the same identity when a framework remounts the same logical control', () => {
    const container = document.createElement('div');
    container.id = 'toolbar';
    const first = document.createElement('button');
    container.append(first);
    document.body.append(container);
    const identity = buildSnapshotTargetIdentity(first);

    const replacement = document.createElement('button');
    first.replaceWith(replacement);

    expect(buildSnapshotTargetIdentity(replacement)).toBe(identity);
  });
});

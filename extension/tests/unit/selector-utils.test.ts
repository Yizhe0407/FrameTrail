// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_TARGETING_POLICY,
  buildSnapshotTargetIdentity,
  deepElementFromPoint,
  findVisualTargetCandidatesAtPoint,
  getHighlightBounds,
  getVisibleHighlightBounds,
  INTERACTIVE_CANDIDATE_SELECTOR,
  isInteractiveElement,
  isElementVisuallyUnavailable,
  selectVisualTargetCandidate,
} from '@/lib/capture/selector-utils';

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
  vi.unstubAllGlobals();
});

describe('findVisualTargetCandidatesAtPoint', () => {
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

    const targets = findVisualTargetCandidatesAtPoint(text, 40, 40);

    expect(targets.candidates.map((candidate) => candidate.element)).toEqual([text, paragraph, article]);
    expect(selectVisualTargetCandidate(targets, 0)).toMatchObject({ element: text, candidateOffset: 0 });
    expect(selectVisualTargetCandidate(targets, 1)).toMatchObject({ element: paragraph, candidateOffset: 1 });
    expect(selectVisualTargetCandidate(targets, 99)).toMatchObject({ element: article, candidateOffset: 2 });
  });

  it('collapses near-identical wrapper boxes into one perceived boundary', () => {
    const surface = document.createElement('div');
    const wrapper = document.createElement('span');
    const label = document.createElement('span');
    wrapper.append(label);
    surface.append(wrapper);
    document.body.append(surface);
    makeVisible(surface, { x: 20, y: 20, width: 124, height: 44 });
    makeVisible(wrapper, { x: 21, y: 21, width: 122, height: 42 });
    makeVisible(label, { x: 22, y: 22, width: 120, height: 40 });

    const targets = findVisualTargetCandidatesAtPoint(label, 40, 30);

    expect(targets.candidates).toHaveLength(1);
    expect(targets.candidates[0].element).toBe(label);
    expect(selectVisualTargetCandidate(targets, 1)?.offsetRange).toEqual({ min: 0, max: 0 });
  });

  it('keeps the semantic control when fuzzy visual dedup merges its child box', () => {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);
    makeVisible(button, { x: 20, y: 20, width: 124, height: 44 });
    makeVisible(label, { x: 22, y: 22, width: 120, height: 40 });

    const targets = findVisualTargetCandidatesAtPoint(label, 40, 30);

    expect(targets.candidates).toHaveLength(1);
    expect(targets.candidates[0].element).toBe(button);
    expect(selectVisualTargetCandidate(targets, 0)?.element).toBe(button);
  });

  it('keeps a semantic control as the default while allowing its child to be selected', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    document.body.append(button);
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    makeVisible(icon, { x: 30, y: 25, width: 20, height: 20 });

    const targets = findVisualTargetCandidatesAtPoint(icon, 35, 30);

    expect(selectVisualTargetCandidate(targets, 0)).toMatchObject({ element: button, candidateOffset: 0 });
    expect(selectVisualTargetCandidate(targets, -1)).toMatchObject({ element: icon, candidateOffset: -1 });
    expect(selectVisualTargetCandidate(targets, 1)).toMatchObject({ element: button, candidateOffset: 0 });
  });

  it('reads each ancestor style and candidate rectangle once per hit-test', () => {
    const button = document.createElement('button');
    const wrapper = document.createElement('span');
    const icon = document.createElement('span');
    wrapper.append(icon);
    button.append(wrapper);
    document.body.append(button);
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    makeVisible(wrapper, { x: 30, y: 25, width: 40, height: 20 });
    makeVisible(icon, { x: 32, y: 27, width: 16, height: 16 });
    const styleSpy = vi.spyOn(window, 'getComputedStyle');
    const rectSpies = [button, wrapper, icon].map((element) => vi.spyOn(element, 'getBoundingClientRect'));
    const clientRectSpies = [button, wrapper, icon].map((element) => vi.spyOn(element, 'getClientRects'));

    expect(selectVisualTargetCandidate(findVisualTargetCandidatesAtPoint(icon, 36, 32), 0)?.element).toBe(button);

    // body/html are part of the composed chain as well; no element is styled
    // more than once and candidate geometry is never recalculated for sorting.
    const callsByElement = new Map<Element, number>();
    for (const [element] of styleSpy.mock.calls) callsByElement.set(element, (callsByElement.get(element) ?? 0) + 1);
    expect(Math.max(...callsByElement.values())).toBe(1);
    expect(rectSpies.every((spy) => spy.mock.calls.length <= 1)).toBe(true);
    expect(clientRectSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
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

    const targets = findVisualTargetCandidatesAtPoint(button, 30, 30);

    expect(isInteractiveElement(button)).toBe(false);
    expect(isElementVisuallyUnavailable(button)).toBe(false);
    expect(selectVisualTargetCandidate(targets, 0)?.element).toBe(button);
  });

  it('keeps a visibility-visible child selectable under a visibility-hidden parent', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.style.visibility = 'hidden';
    child.style.visibility = 'visible';
    parent.append(child);
    document.body.append(parent);
    makeVisible(parent, { x: 10, y: 10, width: 180, height: 80 });
    makeVisible(child, { x: 20, y: 20, width: 120, height: 40 });

    const targets = findVisualTargetCandidatesAtPoint(child, 30, 30);

    expect(isElementVisuallyUnavailable(parent)).toBe(true);
    expect(isElementVisuallyUnavailable(child)).toBe(false);
    expect(targets.candidates.map((candidate) => candidate.element)).toEqual([child]);
  });

  it('deduplicates parent and child by their overflow-clipped visible bounds', () => {
    const clip = document.createElement('div');
    const parent = document.createElement('div');
    const child = document.createElement('span');
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    parent.append(child);
    clip.append(parent);
    document.body.append(clip);
    makeVisible(clip, { x: 10, y: 10, width: 140, height: 80 });
    makeVisible(parent, { x: 0, y: 0, width: 220, height: 120 });
    makeVisible(child, { x: -20, y: -20, width: 260, height: 160 });
    for (const [name, value] of Object.entries({
      offsetWidth: 140,
      offsetHeight: 80,
      clientLeft: 10,
      clientTop: 10,
      clientWidth: 120,
      clientHeight: 60,
    })) {
      Object.defineProperty(clip, name, { configurable: true, value });
    }

    const targets = findVisualTargetCandidatesAtPoint(child, 30, 30, { width: 400, height: 300 });

    expect(targets.candidates.map((candidate) => candidate.element)).toEqual([child, clip]);
    expect(targets.candidates[0].bounds).toEqual({ x: 20, y: 20, width: 120, height: 60 });
  });

  it('collapses identical child and control boxes to the semantic control', () => {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);
    makeVisible(button);
    makeVisible(label);

    const targets = findVisualTargetCandidatesAtPoint(label, 35, 30);

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

    expect(findVisualTargetCandidatesAtPoint(hiddenText, 35, 30).candidates[0].element).toBe(paragraph);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(path);
    paragraph.replaceWith(svg);
    makeVisible(svg, { x: 20, y: 20, width: 40, height: 40 });
    makeVisible(path, { x: 25, y: 25, width: 20, height: 20 });

    expect(findVisualTargetCandidatesAtPoint(path, 30, 30).candidates[0].element).toBe(svg);

    path.setAttribute('role', 'button');
    expect(findVisualTargetCandidatesAtPoint(path, 30, 30).candidates[0].element).toBe(path);
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

    const targets = findVisualTargetCandidatesAtPoint(slotted, 40, 35);

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

    expect(findVisualTargetCandidatesAtPoint(text, 30, 60).candidates[0].bounds).toEqual({
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

  it('clips a scrolled root body against the viewport instead of its moving border box', () => {
    const button = document.createElement('button');
    document.body.append(button);
    document.body.style.overflowY = 'scroll';
    makeVisible(button, { x: 396, y: 459, width: 28, height: 28 });
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -420,
      top: -420,
      left: 0,
      right: 1280,
      bottom: 393,
      width: 1280,
      height: 813,
      toJSON: () => ({}),
    });

    expect(getVisibleHighlightBounds(button, 410, 473, { width: 1280, height: 813 })).toEqual({
      x: 396,
      y: 459,
      width: 28,
      height: 28,
    });

    document.body.style.overflowY = '';
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


  it('uses an image-map area region and the associated image paint ancestry', () => {
    const imageClip = document.createElement('div');
    imageClip.style.overflowX = 'hidden';
    imageClip.style.overflowY = 'hidden';
    const image = document.createElement('img');
    image.setAttribute('usemap', 'prefix#Hotspots');
    Object.defineProperty(image, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(image, 'offsetHeight', { configurable: true, value: 100 });
    imageClip.append(image);

    const mapClip = document.createElement('div');
    mapClip.style.contain = 'paint';
    const map = document.createElement('map');
    map.name = 'Hotspots';
    const area = document.createElement('area');
    area.href = '#details';
    area.shape = 'rect';
    area.coords = '10,10,100,80';
    map.append(area);
    mapClip.append(map);
    document.body.append(imageClip, mapClip);

    makeVisible(image, { x: 100, y: 50, width: 200, height: 100 });
    makeVisible(imageClip, { x: 120, y: 65, width: 60, height: 35 });
    // If clipping followed <map> ancestry, this unrelated paint container
    // would erase the area instead of clipping through imageClip.
    makeVisible(mapClip, { x: 0, y: 0, width: 5, height: 5 });

    expect(Array.from(area.getClientRects())).toHaveLength(0);
    expect(getHighlightBounds(area, 130, 70)).toEqual({
      x: 110,
      y: 60,
      width: 90,
      height: 70,
    });
    expect(getVisibleHighlightBounds(area, 130, 70, { width: 400, height: 300 })).toEqual({
      x: 120,
      y: 65,
      width: 60,
      height: 35,
    });

    const selected = selectVisualTargetCandidate(
      findVisualTargetCandidatesAtPoint(
        area,
        130,
        70,
        { width: 400, height: 300 },
        ACTIVATION_TARGETING_POLICY,
      ),
      0,
    );
    expect(selected).toMatchObject({
      element: area,
      bounds: { x: 120, y: 65, width: 60, height: 35 },
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

  it('recognizes delegated click bindings and rejects other event types', () => {
    const element = document.createElement('div');
    document.body.append(element);
    makeVisible(element);

    // jsaction and Stimulus data-action name the event before their separator;
    // an entry without one defaults to click.
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('jsaction', 'keydown:menu.key');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('jsaction', 'keydown:menu.key;click:menu.toggle');
    expect(isInteractiveElement(element)).toBe(true);
    element.setAttribute('jsaction', 'menu.toggle');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('jsaction');
    element.setAttribute('data-action', 'mouseenter->menu#preview');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('data-action', 'menu#toggle');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('data-action');
    for (const attribute of ['ng-click', 'v-on:click', 'wire:click', 'hx-post', 'onpointerdown']) {
      element.setAttribute(attribute, 'noop');
      expect(isInteractiveElement(element), attribute).toBe(true);
      element.removeAttribute(attribute);
    }

    // Vue's @click shorthand cannot go through setAttribute — jsdom enforces
    // the XML Name production — but the HTML parser accepts it, which is how
    // it reaches a real page.
    const parsed = document.createElement('div');
    parsed.innerHTML = '<span @click="submit()">送出</span>';
    const shorthand = parsed.firstElementChild!;
    document.body.append(parsed);
    makeVisible(shorthand);
    expect(shorthand.hasAttribute('@click')).toBe(true);
    expect(isInteractiveElement(shorthand)).toBe(true);
    expect(parsed.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR)).toHaveLength(1);
  });

  it('treats widget state attributes as controls, except an explicit no-popup', () => {
    const element = document.createElement('div');
    document.body.append(element);
    makeVisible(element);

    element.setAttribute('aria-haspopup', 'false');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('aria-haspopup', 'menu');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('aria-haspopup');
    // A collapsed toggle is still a toggle, so "false" stays interactive here.
    element.setAttribute('aria-expanded', 'false');
    expect(isInteractiveElement(element)).toBe(true);
  });

  it('accepts natively actionable tags that carry no role or handler', () => {
    for (const tag of ['details', 'object', 'embed']) {
      const element = document.createElement(tag);
      document.body.append(element);
      makeVisible(element);
      expect(isInteractiveElement(element), tag).toBe(true);
    }
  });
});

describe('shadow and occlusion aware hit testing', () => {
  function stubElementFromPoint(root: Document | ShadowRoot, element: Element | null): void {
    Object.defineProperty(root, 'elementFromPoint', { configurable: true, value: () => element });
  }

  it('descends into closed shadow roots through the extension accessor', () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    document.body.append(host);
    stubElementFromPoint(document, host);
    stubElementFromPoint(shadowRoot, button);

    // Without the accessor a closed host is a dead end: host.shadowRoot is null.
    expect(deepElementFromPoint(30, 30)).toBe(host);

    vi.stubGlobal('chrome', { dom: { openOrClosedShadowRoot: () => shadowRoot } });
    expect(deepElementFromPoint(30, 30)).toBe(button);
  });

  it('looks past a blank full-viewport overlay to the control underneath', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = '送出';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(button, { x: 10, y: 10, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, button, document.body],
    });

    const viewport = { width: 1024, height: 768 };
    expect(findVisualTargetCandidatesAtPoint(overlay, 30, 30, viewport).candidates[0].element).toBe(button);

    // A covering element that shows its own content is real content: it stays
    // the target instead of being treated as a shim.
    overlay.textContent = '請先同意條款';
    expect(findVisualTargetCandidatesAtPoint(overlay, 30, 30, viewport).candidates[0].element).toBe(overlay);
  });

  it('does not pierce a blank child whose exclusive overlay ancestor paints', () => {
    const shared = document.createElement('main');
    const overlay = document.createElement('div');
    const hitSurface = document.createElement('span');
    const button = document.createElement('button');
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    button.textContent = '底下按鈕';
    overlay.append(hitSurface);
    shared.append(overlay, button);
    document.body.append(shared);
    makeVisible(shared, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(overlay, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(hitSurface, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [hitSurface, overlay, button, shared, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(
      hitSurface,
      30,
      30,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates.some((candidate) => candidate.element === button)).toBe(false);
    expect(targets.candidates[0].element).toBe(hitSurface);
  });

  it('does not pierce an otherwise blank branch whose pointer-events-none descendant paints', () => {
    const overlay = document.createElement('div');
    const paintedChild = document.createElement('div');
    const button = document.createElement('button');
    paintedChild.style.position = 'absolute';
    paintedChild.style.inset = '0';
    paintedChild.style.pointerEvents = 'none';
    paintedChild.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    button.textContent = '底下按鈕';
    overlay.append(paintedChild);
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(paintedChild, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      // Chromium omits paintedChild because pointer-events:none and reports
      // its otherwise blank hit-test ancestor instead.
      value: () => [overlay, button, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(
      overlay,
      30,
      30,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates.some((candidate) => candidate.element === button)).toBe(false);
    expect(targets.candidates[0].element).toBe(overlay);
  });

  it('does not pierce a branch painted by a generated backdrop', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = '底下按鈕';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, button, document.body],
    });

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const blankPseudoStyle = document.createElement('div').style;
    const paintedPseudoStyle = document.createElement('div').style;
    paintedPseudoStyle.content = '""';
    paintedPseudoStyle.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    vi.stubGlobal('CSS', { supports: (query: string) => query === 'selector(::before)' });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
      if (element === overlay && pseudoElement === '::before') return paintedPseudoStyle;
      if (pseudoElement) return blankPseudoStyle;
      return originalGetComputedStyle(element);
    });

    const targets = findVisualTargetCandidatesAtPoint(
      overlay,
      30,
      30,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates.some((candidate) => candidate.element === button)).toBe(false);
    expect(targets.candidates[0].element).toBe(overlay);
  });

  it('does not pierce fixed generated paint outside its originating element box', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    overlay.style.position = 'absolute';
    button.textContent = '底下按鈕';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 1, height: 1 });
    makeVisible(button, { x: 200, y: 200, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      // Chromium reports the originating element when its generated box is hit,
      // even though the pointer is outside the host's own client rects.
      value: () => [overlay, button, document.body],
    });

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const blankPseudoStyle = document.createElement('div').style;
    const paintedPseudoStyle = document.createElement('div').style;
    paintedPseudoStyle.content = '""';
    paintedPseudoStyle.position = 'fixed';
    paintedPseudoStyle.top = '0px';
    paintedPseudoStyle.right = '0px';
    paintedPseudoStyle.bottom = '0px';
    paintedPseudoStyle.left = '0px';
    paintedPseudoStyle.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    vi.stubGlobal('CSS', { supports: (query: string) => query === 'selector(::before)' });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
      if (element === overlay && pseudoElement === '::before') return paintedPseudoStyle;
      if (pseudoElement) return blankPseudoStyle;
      return originalGetComputedStyle(element);
    });

    const targets = findVisualTargetCandidatesAtPoint(
      overlay,
      220,
      220,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates.some((candidate) => candidate.element === button)).toBe(false);
    expect(targets.candidates[0].element).toBe(overlay);
  });

  it('does not treat positioned generated paint elsewhere as covering the pointer', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    overlay.style.position = 'absolute';
    button.textContent = '底下按鈕';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 1, height: 1 });
    makeVisible(button, { x: 200, y: 200, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, button, document.body],
    });

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const blankPseudoStyle = document.createElement('div').style;
    const paintedPseudoStyle = document.createElement('div').style;
    paintedPseudoStyle.content = '"elsewhere"';
    paintedPseudoStyle.position = 'fixed';
    paintedPseudoStyle.top = '0px';
    paintedPseudoStyle.left = '0px';
    paintedPseudoStyle.width = '20px';
    paintedPseudoStyle.height = '20px';
    paintedPseudoStyle.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    vi.stubGlobal('CSS', { supports: (query: string) => query === 'selector(::before)' });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
      if (element === overlay && pseudoElement === '::before') return paintedPseudoStyle;
      if (pseudoElement) return blankPseudoStyle;
      return originalGetComputedStyle(element);
    });

    const targets = findVisualTargetCandidatesAtPoint(
      overlay,
      220,
      220,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates[0].element).toBe(button);
  });

  it('pierces a blank overlay branch even when its shared app ancestor paints', () => {
    const shared = document.createElement('main');
    const overlay = document.createElement('div');
    const hitSurface = document.createElement('span');
    const button = document.createElement('button');
    shared.style.backgroundColor = 'white';
    button.textContent = '底下按鈕';
    overlay.append(hitSurface);
    shared.append(overlay, button);
    document.body.append(shared);
    makeVisible(shared, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(overlay, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(hitSurface, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [hitSurface, overlay, button, shared, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(
      hitSurface,
      30,
      30,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates[0].element).toBe(button);
  });

  it('does not pierce a painted non-interactive layer below a blank shim', () => {
    const shim = document.createElement('div');
    const backdrop = document.createElement('div');
    const button = document.createElement('button');
    backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    button.textContent = '底下按鈕';
    document.body.append(shim, backdrop, button);
    makeVisible(shim, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(backdrop, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [shim, backdrop, button, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(
      shim,
      30,
      30,
      { width: 1024, height: 768 },
    );

    expect(targets.candidates.some((candidate) => candidate.element === button)).toBe(false);
    expect(targets.candidates[0].element).toBe(shim);
  });

  it('pierces a transparent hit-test shim for annotation but preserves it for activation', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = '送出';
    overlay.style.opacity = '0';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, button, document.body],
    });
    const styleSpy = vi.spyOn(window, 'getComputedStyle');
    const viewport = { width: 1024, height: 768 };

    const annotationTargets = findVisualTargetCandidatesAtPoint(overlay, 30, 30, viewport);
    const activationTargets = findVisualTargetCandidatesAtPoint(
      overlay,
      30,
      30,
      viewport,
      ACTIVATION_TARGETING_POLICY,
    );

    expect(annotationTargets.candidates[0].element).toBe(button);
    expect(activationTargets.candidates[0].element).toBe(overlay);
    expect(styleSpy.mock.calls.filter(([element]) => element === overlay)).toHaveLength(2);
  });

  it('preserves a painted fullscreen backdrop for annotation and activation', () => {
    const backdrop = document.createElement('div');
    const button = document.createElement('button');
    backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    button.textContent = '底下按鈕';
    document.body.append(backdrop, button);
    makeVisible(backdrop, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [backdrop, button, document.body],
    });
    const viewport = { width: 1024, height: 768 };

    const annotationTargets = findVisualTargetCandidatesAtPoint(backdrop, 30, 30, viewport);
    const activationTargets = findVisualTargetCandidatesAtPoint(
      backdrop,
      30,
      30,
      viewport,
      ACTIVATION_TARGETING_POLICY,
    );

    expect(annotationTargets.candidates[0].element).toBe(backdrop);
    expect(activationTargets.candidates[0].element).toBe(backdrop);
  });

  it('does not click through a small painted or accessibly named surface', () => {
    const overlay = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = '底下按鈕';
    document.body.append(overlay, button);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(button, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, button, document.body],
    });

    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
    expect(
      findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 }).candidates[0].element,
    ).toBe(overlay);

    overlay.style.backgroundColor = 'transparent';
    overlay.setAttribute('aria-label', '拖曳區域');
    expect(
      findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 }).candidates[0].element,
    ).toBe(overlay);

    overlay.removeAttribute('aria-label');
    overlay.setAttribute('role', 'region');
    expect(
      findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 }).candidates[0].element,
    ).toBe(overlay);

    overlay.removeAttribute('role');
    overlay.style.filter = 'blur(2px)';
    expect(
      findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 }).candidates[0].element,
    ).toBe(overlay);
  });

  it('does not click through a transparent disabled control', () => {
    const overlay = document.createElement('button');
    const underneath = document.createElement('button');
    overlay.disabled = true;
    underneath.textContent = '底下按鈕';
    document.body.append(overlay, underneath);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(underneath, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, underneath, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 });

    expect(targets.candidates[0].element).toBe(overlay);
  });

  it('keeps the topmost chain when the stack holds no control', () => {
    const overlay = document.createElement('div');
    const text = document.createElement('p');
    document.body.append(overlay, text);
    makeVisible(overlay, { x: 0, y: 0, width: 1024, height: 768 });
    makeVisible(text, { x: 10, y: 10, width: 120, height: 40 });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, text, document.body],
    });

    const targets = findVisualTargetCandidatesAtPoint(overlay, 30, 30, { width: 1024, height: 768 });

    expect(targets.candidates[0].element).toBe(overlay);
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

describe('selectVisualTargetCandidate', () => {
  it('reports the offsets a point can still be cycled to', () => {
    const article = document.createElement('article');
    const paragraph = document.createElement('p');
    const text = document.createElement('span');
    paragraph.append(text);
    article.append(paragraph);
    document.body.append(article);
    makeVisible(article, { x: 10, y: 10, width: 300, height: 180 });
    makeVisible(paragraph, { x: 20, y: 20, width: 240, height: 80 });
    makeVisible(text, { x: 30, y: 30, width: 100, height: 24 });

    const targets = findVisualTargetCandidatesAtPoint(text, 40, 40);

    // Default is the deepest box, so only widening is available from there.
    expect(selectVisualTargetCandidate(targets, 0)?.offsetRange).toEqual({ min: 0, max: 2 });
    expect(selectVisualTargetCandidate(targets, 5)).toMatchObject({
      candidateOffset: 2,
      offsetRange: { min: 0, max: 2 },
    });
  });

  it('reports an empty range when the chain offers a single box', () => {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);
    makeVisible(button);
    makeVisible(label);

    const targets = findVisualTargetCandidatesAtPoint(label, 35, 30);

    expect(selectVisualTargetCandidate(targets, 0)?.offsetRange).toEqual({ min: 0, max: 0 });
  });
});

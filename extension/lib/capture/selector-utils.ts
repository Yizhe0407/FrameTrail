import type { Bounds } from '../storage/db';
import { getOpenOrClosedShadowRoot } from './shadow-dom';
import type { CandidateOffsetRange } from './candidate-cycling';

const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'area',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'details',
  'option',
  'object',
  'embed',
]);
/**
 * Attributes that bind a click through a delegation library or framework
 * template. Handlers registered with addEventListener are invisible to a
 * content script — the DevTools-only getEventListeners is not available to
 * extensions — so these markers are the practical evidence that a plain
 * div/span is a control. Without them a jsaction-driven page (all of Google's
 * products) reads as inert text.
 */
const DELEGATED_CLICK_ATTRIBUTES = [
  'jsaction',
  'data-action',
  'ng-click',
  'data-ng-click',
  'x-ng-click',
  'v-on:click',
  '@click',
  'wire:click',
  'hx-get',
  'hx-post',
  'hx-put',
  'hx-patch',
  'hx-delete',
] as const;
/** Attributes whose separator-prefixed values name the bound event type. */
const EVENT_QUALIFIED_ATTRIBUTES: Record<string, string> = { jsaction: ':', 'data-action': '->' };
const INLINE_POINTER_HANDLER_ATTRIBUTES = [
  'onclick',
  'onmousedown',
  'onmouseup',
  'onpointerdown',
  'onpointerup',
] as const;
/** ARIA state that only a widget carries; the element answers to activation
 * even when its role is implicit or supplied by an ancestor. */
const ARIA_WIDGET_STATE_ATTRIBUTES = [
  'aria-expanded',
  'aria-pressed',
  'aria-checked',
  'aria-selected',
] as const;
const POINTER_CURSORS = new Set(['pointer', 'zoom-in', 'zoom-out']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'tab',
  'switch',
  'option',
  'combobox',
  'gridcell',
  'listbox',
  'menu',
  'menubar',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'textbox',
  'treeitem',
]);
const KNOWN_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
  'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none',
  'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);
const DECORATIVE_SVG_TAGS = new Set(['path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect', 'use']);
const NON_SELECTABLE_VISUAL_TAGS = new Set([
  'html',
  'body',
  'head',
  'base',
  'link',
  'meta',
  'title',
  'script',
  'style',
  'template',
  'noscript',
  'br',
  'wbr',
  'source',
  'track',
]);

type InteractionKind = 'native' | 'role' | 'handler' | 'focusable' | 'cursor';

export function getComposedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isElementInteractionDisabled(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (
      current.hasAttribute('inert') ||
      current.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true' ||
      ('disabled' in current && Boolean((current as HTMLButtonElement).disabled))
    ) {
      return true;
    }
    current = getComposedParent(current);
  }
  return false;
}

export function isElementVisuallyUnavailable(el: Element): boolean {
  const isImageMapArea = el instanceof HTMLAreaElement;
  let current: Element | null = el;
  while (current) {
    // <area> and its <map> tree have no rendered boxes; the associated <img>
    // supplies visibility and clipping. Their CSS display state therefore
    // does not make an otherwise actionable image-map region unavailable.
    if (!isImageMapArea) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        (current === el && style.display === 'contents') ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        (style.opacity !== '' && Number(style.opacity) === 0) ||
        style.contentVisibility === 'hidden'
      ) {
        return true;
      }
    }
    current = getComposedParent(current);
  }
  return false;
}

export function isElementUnavailable(el: Element): boolean {
  return isElementInteractionDisabled(el) || isElementVisuallyUnavailable(el);
}

/**
 * Decides whether an event-qualified binding covers click. `jsaction` entries
 * read `eventType:namespace.action` and Stimulus `data-action` entries read
 * `event->controller#method`; in both, an entry without the separator defaults
 * to click, so `jsaction="menu.toggle"` and `data-action="menu#toggle"` count.
 */
function declaresClickBinding(value: string, separator: string): boolean {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const boundary = entry.indexOf(separator);
      return boundary < 0 || entry.slice(0, boundary).trim() === 'click';
    });
}

function hasDelegatedClickBinding(el: Element): boolean {
  return DELEGATED_CLICK_ATTRIBUTES.some((attribute) => {
    const value = el.getAttribute(attribute);
    if (value === null) return false;
    const separator = EVENT_QUALIFIED_ATTRIBUTES[attribute];
    return separator === undefined || declaresClickBinding(value, separator);
  });
}

function hasWidgetStateAttribute(el: Element): boolean {
  // aria-haspopup="false" is the documented way to say "no popup"; every other
  // state attribute stays meaningful at "false" because only a toggle has one.
  return (
    ARIA_WIDGET_STATE_ATTRIBUTES.some((attribute) => el.hasAttribute(attribute)) ||
    (el.getAttribute('aria-haspopup')?.trim().toLowerCase() ?? 'false') !== 'false'
  );
}

function interactionKind(el: Element, style?: CSSStyleDeclaration): InteractionKind | null {
  const tag = el.tagName.toLowerCase();
  const isNative =
    INTERACTIVE_TAGS.has(tag) &&
    !(tag === 'input' && (el as HTMLInputElement).type === 'hidden') &&
    !((tag === 'a' || tag === 'area') && !el.hasAttribute('href')) &&
    !(tag === 'label' && el instanceof HTMLLabelElement && !el.control);
  if (isNative) return 'native';
  if ((el instanceof HTMLAudioElement || el instanceof HTMLVideoElement) && el.controls) return 'native';

  const roles = el.getAttribute('role')?.trim().toLowerCase().split(/\s+/) ?? [];
  const role = roles.find((candidate) => KNOWN_ARIA_ROLES.has(candidate));
  if (role && INTERACTIVE_ROLES.has(role)) return 'role';

  const contentEditable = el.getAttribute('contenteditable')?.trim().toLowerCase();
  const assignedClick = (el as Element & { onclick?: unknown }).onclick;
  if (
    INLINE_POINTER_HANDLER_ATTRIBUTES.some((attribute) => el.hasAttribute(attribute)) ||
    typeof assignedClick === 'function' ||
    hasDelegatedClickBinding(el) ||
    hasWidgetStateAttribute(el) ||
    contentEditable === '' ||
    contentEditable === 'true' ||
    contentEditable === 'plaintext-only'
  ) {
    return 'handler';
  }

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return 'focusable';

  return POINTER_CURSORS.has((style ?? getComputedStyle(el)).cursor) ? 'cursor' : null;
}

export function isInteractiveElement(el: Element): boolean {
  return interactionKind(el) !== null && !isElementUnavailable(el);
}

function isDecorativeLeaf(el: Element, kind: InteractionKind): boolean {
  const tag = el.tagName.toLowerCase();
  return DECORATIVE_SVG_TAGS.has(tag) && kind === 'cursor';
}

interface AnalyzedElement {
  element: Element;
  kind: InteractionKind | null;
  interactionUnavailable: boolean;
  visuallyUnavailable: boolean;
  boundingRect?: DOMRect;
  highlightBounds?: Bounds | null;
}

function hasOwnInteractionDisabledState(el: Element): boolean {
  return (
    el.hasAttribute('inert') ||
    el.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true' ||
    ('disabled' in el && Boolean((el as HTMLButtonElement).disabled))
  );
}

function hasOwnVisualUnavailableState(style: CSSStyleDeclaration): boolean {
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    (style.opacity !== '' && Number(style.opacity) === 0) ||
    style.contentVisibility === 'hidden'
  );
}

/** Builds the composed ancestor chain and all inherited state once per hit-test.
 * Entries remain deepest-first to preserve candidate cycling semantics. */
function analyzeElements(nodes: Iterable<unknown>): AnalyzedElement[] {
  const elements: Element[] = [];
  const seen = new Set<Element>();
  for (const node of nodes) {
    if (!(node instanceof Element) || seen.has(node)) continue;
    seen.add(node);
    elements.push(node);
  }

  const entries = new Array<AnalyzedElement>(elements.length);
  let interactionUnavailable = false;
  let visualUnavailable = false;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    const style = getComputedStyle(element);
    interactionUnavailable ||= hasOwnInteractionDisabledState(element);
    visualUnavailable ||= hasOwnVisualUnavailableState(style);
    entries[index] = {
      element,
      kind: interactionKind(element, style),
      interactionUnavailable,
      // Image-map areas intentionally inherit their rendered state from the
      // associated image rather than their non-rendered <map> ancestry.
      visuallyUnavailable: element instanceof HTMLAreaElement
        ? false
        : visualUnavailable || style.display === 'contents',
    };
  }
  return entries;
}

function boundingRect(entry: AnalyzedElement): DOMRect {
  entry.boundingRect ??= entry.element.getBoundingClientRect();
  return entry.boundingRect;
}

function visibleArea(entry: AnalyzedElement): number {
  const rect = boundingRect(entry);
  return Number.isFinite(rect.width) && Number.isFinite(rect.height)
    ? Math.max(rect.width, 0) * Math.max(rect.height, 0)
    : 0;
}

/**
 * Chooses the element users perceive as the control. Native/ARIA controls
 * outrank cursor-only descendants; this prevents an icon or text node inside
 * a button-like surface from producing a tiny, inconsistent annotation box.
 */
function findInteractiveTargetFromEntries(entries: AnalyzedElement[]): Element | null {
  const kindScore: Record<InteractionKind, number> = {
    native: 5,
    role: 4,
    handler: 3,
    focusable: 2,
    cursor: 1,
  };

  let best: { entry: AnalyzedElement; cursorScore: number } | null = null;
  for (const entry of entries) {
    if (entry.element === document.body || entry.element === document.documentElement) break;
    const kind = entry.kind;
    if (
      !kind ||
      isDecorativeLeaf(entry.element, kind) ||
      entry.interactionUnavailable ||
      entry.visuallyUnavailable ||
      visibleArea(entry) === 0
    ) {
      continue;
    }

    const rect = boundingRect(entry);
    const cursorScore = kind === 'cursor'
      ? Math.min(Math.min(rect.width, rect.height), 44) * 100 - Math.min(visibleArea(entry), 40_000) / 100
      : 0;
    if (
      !best ||
      kindScore[kind] > kindScore[best.entry.kind!] ||
      (kind === best.entry.kind && kind === 'cursor' && cursorScore > best.cursorScore)
    ) {
      best = { entry, cursorScore };
    }
  }
  return best?.entry.element ?? null;
}

/** Walks a hit element down through every shadow root it hosts, open or
 * closed, to the innermost element actually under the point. */
function descendShadowRoots(start: Element, clientX: number, clientY: number): Element {
  let target = start;
  const visited = new Set<ShadowRoot>();

  while (true) {
    const shadowRoot = getOpenOrClosedShadowRoot(target);
    if (!shadowRoot || visited.has(shadowRoot)) return target;
    visited.add(shadowRoot);
    const next = shadowRoot.elementFromPoint(clientX, clientY);
    if (!next) return target;
    target = next;
  }
}

export function deepElementFromPoint(clientX: number, clientY: number): Element | null {
  const hit = document.elementFromPoint(clientX, clientY);
  return hit ? descendShadowRoots(hit, clientX, clientY) : null;
}

function elementAndComposedAncestors(target: Element): Element[] {
  const nodes: Element[] = [];
  let current: Element | null = target;

  while (current) {
    nodes.push(current);
    current = getComposedParent(current);
  }
  return nodes;
}

export interface VisualTargetCandidate {
  element: Element;
  bounds: Bounds;
}

export interface VisualTargetCandidates {
  candidates: VisualTargetCandidate[];
  defaultIndex: number;
}

export interface SelectedVisualTargetCandidate extends VisualTargetCandidate {
  candidateOffset: number;
  /** Offsets the point can still be cycled to, relative to the default
   * candidate. `min === max` means this point offers no alternative box, which
   * is what the shield needs to know before advertising the shortcut. */
  offsetRange: CandidateOffsetRange;
}

function visualBoundsKey(bounds: Bounds): string {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

function isVisuallySelectableEntry(entry: AnalyzedElement): boolean {
  const tag = entry.element.tagName.toLowerCase();
  return (
    !NON_SELECTABLE_VISUAL_TAGS.has(tag) &&
    (!DECORATIVE_SVG_TAGS.has(tag) || (entry.kind !== null && entry.kind !== 'cursor')) &&
    !entry.visuallyUnavailable
  );
}

/** Memoized per hit-test so a candidate chain measures each element once. */
function highlightBounds(entry: AnalyzedElement, clientX: number, clientY: number): Bounds | null {
  // Not `??=`: a cached null is a real answer (the element has no painted
  // box), and recomputing it would re-measure on every lookup.
  if (entry.highlightBounds === undefined) {
    entry.highlightBounds = getHighlightBounds(entry.element, clientX, clientY);
  }
  return entry.highlightBounds;
}

interface ChainAnalysis {
  targets: VisualTargetCandidates;
  /** The control the chain resolves to, or null when it holds none. */
  interactive: Element | null;
}

/** Builds the visually distinct target chain under a point, from the deepest
 * rendered element toward its composed ancestors. Semantic controls remain
 * the default even when the pointer lands on a nested label or icon. */
function analyzeChain(hit: Element, clientX: number, clientY: number): ChainAnalysis {
  const entries = analyzeElements(elementAndComposedAncestors(hit));
  const interactive = findInteractiveTargetFromEntries(entries);
  const candidates: VisualTargetCandidate[] = [];
  const indexByBounds = new Map<string, number>();

  for (const entry of entries) {
    const element = entry.element;
    if (!isVisuallySelectableEntry(entry)) continue;
    const bounds = highlightBounds(entry, clientX, clientY);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;

    const key = visualBoundsKey(bounds);
    const existingIndex = indexByBounds.get(key);
    if (existingIndex !== undefined) {
      if (element === interactive) candidates[existingIndex] = { element, bounds };
      continue;
    }
    indexByBounds.set(key, candidates.length);
    candidates.push({ element, bounds });
  }

  const interactiveIndex = interactive
    ? candidates.findIndex((candidate) => candidate.element === interactive)
    : -1;
  return {
    targets: { candidates, defaultIndex: interactiveIndex >= 0 ? interactiveIndex : 0 },
    interactive,
  };
}

/** How far down the paint stack a blank occluder is searched past. */
const OCCLUDER_STACK_LIMIT = 8;
/** Share of the viewport a blank element must cover to read as an overlay. */
const OCCLUDER_COVERAGE_RATIO = 0.6;

/**
 * A shim, drag layer or modal backdrop swallows the hit test while showing
 * nothing of its own. Text content is the discriminator: a cookie banner or a
 * hero section covering the viewport is real content and stays the target.
 */
function looksLikeBlankOccluder(el: Element, viewport: { width: number; height: number }): boolean {
  if ((el.textContent ?? '').trim().length > 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width * rect.height >= viewport.width * viewport.height * OCCLUDER_COVERAGE_RATIO;
}

/**
 * Resolves the candidate chain for a point, looking past a blank overlay that
 * covers the control the user is aiming at. The topmost chain wins whenever it
 * holds a control of its own, so the extra paint-stack walk only runs for the
 * hit tests that would otherwise return nothing actionable.
 */
export function findVisualTargetCandidatesAtPoint(
  hit: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): VisualTargetCandidates {
  const top = analyzeChain(hit, clientX, clientY);
  if (
    top.interactive ||
    typeof document.elementsFromPoint !== 'function' ||
    !looksLikeBlankOccluder(hit, viewport)
  ) {
    return top.targets;
  }

  const analyzed = new Set(elementAndComposedAncestors(hit));
  for (const occluded of document.elementsFromPoint(clientX, clientY).slice(0, OCCLUDER_STACK_LIMIT)) {
    if (analyzed.has(occluded)) continue;
    const deeper = analyzeChain(descendShadowRoots(occluded, clientX, clientY), clientX, clientY);
    if (deeper.interactive) return deeper.targets;
    for (const element of elementAndComposedAncestors(occluded)) analyzed.add(element);
  }
  return top.targets;
}

export function selectVisualTargetCandidate(
  targets: VisualTargetCandidates,
  requestedOffset: number,
): SelectedVisualTargetCandidate | null {
  if (targets.candidates.length === 0) return null;
  // `|| 0` keeps a default index of 0 from producing -0, which would travel
  // through the shield channel and compare unequal under Object.is.
  const minimumOffset = -targets.defaultIndex || 0;
  const maximumOffset = targets.candidates.length - 1 - targets.defaultIndex;
  const candidateOffset = Math.max(minimumOffset, Math.min(requestedOffset, maximumOffset));
  const candidate = targets.candidates[targets.defaultIndex + candidateOffset];
  return { ...candidate, candidateOffset, offsetRange: { min: minimumOffset, max: maximumOffset } };
}

/** Hit-tests a viewport point and resolves the candidate `candidateOffset`
 * selects there, clamped to what the point actually offers. Shared by the
 * top-frame step recorder and the child-frame relay so both frames pick
 * identical targets. */
export function resolveVisualTargetAtPoint(
  clientX: number,
  clientY: number,
  candidateOffset = 0,
): SelectedVisualTargetCandidate | null {
  const hit = deepElementFromPoint(clientX, clientY);
  if (!hit) return null;
  return selectVisualTargetCandidate(
    findVisualTargetCandidatesAtPoint(hit, clientX, clientY),
    candidateOffset,
  );
}

function attributeSelector(attribute: string): string {
  return `[${attribute.replace(/[^\w-]/g, (character) => `\\${character}`)}]`;
}

/**
 * Every marker that can make an element a control, as a CSS selector. It
 * over-selects on purpose — `isInteractiveElement` is the authority, and this
 * only has to avoid missing anything it would accept. Cursor-only controls
 * cannot be expressed here and stay pointer-reachable.
 */
export const INTERACTIVE_CANDIDATE_SELECTOR = [
  ...INTERACTIVE_TAGS,
  '[role]',
  '[tabindex]',
  '[contenteditable]',
  '[aria-haspopup]',
  ...DELEGATED_CLICK_ATTRIBUTES.map(attributeSelector),
  ...INLINE_POINTER_HANDLER_ATTRIBUTES.map(attributeSelector),
  ...ARIA_WIDGET_STATE_ATTRIBUTES.map(attributeSelector),
].join(',');

/**
 * Returns the precise border-box fragment clicked by the user. A multiline
 * inline element has multiple client rects; getBoundingClientRect() is their
 * union and can enclose unrelated whitespace, so it is not appropriate for a
 * click annotation by itself.
 */
export function getHighlightBounds(el: Element, clientX: number, clientY: number): Bounds | null {
  const rects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;

  const containingRects = rects.filter(
    (rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
  );
  const rect = (containingRects.length > 0 ? containingRects : rects).reduce((smallest, candidate) =>
    candidate.width * candidate.height < smallest.width * smallest.height ? candidate : smallest,
  );

  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function overflowClipBounds(el: Element, viewport: { width: number; height: number }): Bounds {
  // Client coordinates are viewport-relative. Root boxes, especially <body>
  // on pages that set overflow themselves, move to -scrollX/-scrollY in
  // getBoundingClientRect() as the document scrolls; using that moving rect as
  // a clip would incorrectly hide every target revealed below the fold.
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  const rect = el.getBoundingClientRect();
  if (!(el instanceof HTMLElement) || el.clientWidth <= 0 || el.clientHeight <= 0) {
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  const scaleX = rect.width / (el.offsetWidth || rect.width || 1);
  const scaleY = rect.height / (el.offsetHeight || rect.height || 1);
  return {
    x: rect.left + el.clientLeft * scaleX,
    y: rect.top + el.clientTop * scaleY,
    width: el.clientWidth * scaleX,
    height: el.clientHeight * scaleY,
  };
}

function clipsPaint(style: CSSStyleDeclaration): boolean {
  const containment = style.contain.split(/\s+/);
  return (
    Boolean(style.clipPath && style.clipPath !== 'none') ||
    containment.includes('paint') ||
    containment.includes('content') ||
    containment.includes('strict')
  );
}

/** Returns only the rectangular portion a user can actually see and click.
 * It accounts for the viewport and clipping/scrolling ancestors. Arbitrary
 * non-rectangular clip paths still resolve to their element's bounding box,
 * which is the closest representation supported by the Bounds data model. */
export function getVisibleHighlightBounds(
  el: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): Bounds | null {
  let visible = getHighlightBounds(el, clientX, clientY);
  if (!visible) return null;
  visible = intersectBounds(visible, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!visible) return null;

  let ancestor = getComposedParent(el);
  while (ancestor) {
    const style = getComputedStyle(ancestor);
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const clipsX = Boolean(overflowX && overflowX !== 'visible');
    const clipsY = Boolean(overflowY && overflowY !== 'visible');
    const paintClip = clipsPaint(style);
    if (clipsX || clipsY) {
      const rect = overflowClipBounds(ancestor, viewport);
      const clip = {
        x: clipsX ? rect.x : visible.x,
        y: clipsY ? rect.y : visible.y,
        width: clipsX ? rect.width : visible.width,
        height: clipsY ? rect.height : visible.height,
      };
      visible = intersectBounds(visible, clip);
      if (!visible) return null;
    }
    if (paintClip) {
      const rect = ancestor.getBoundingClientRect();
      visible = intersectBounds(visible, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      if (!visible) return null;
    }
    ancestor = getComposedParent(ancestor);
  }
  return visible;
}

/** Stable within one immutable snapshot document, including when a framework
 * replaces an element node with an equivalent node at the same DOM path. */
export function buildSnapshotTargetIdentity(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node) {
    const parent: Element | null = node.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((s) => s.tagName === node!.tagName) : [node];
    const index = siblings.indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]${node.id ? `#${node.id}` : ''}`);
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      parts.unshift('::shadow');
      node = root.host;
      continue;
    }
    node = null;
  }

  return JSON.stringify(parts);
}

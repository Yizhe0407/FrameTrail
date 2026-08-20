import { type Bounds } from '../storage/models';
import { resolveImageMapAreaBounds } from './image-map-geometry';
import { getOpenOrClosedShadowRoot } from './shadow-dom';
import { isExtensionOverlay } from './viewport-overlay-host';

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

/** Replaced/graphics elements can paint meaningful pixels without DOM text or
 * CSS background/border clues, so they must never be treated as transparent
 * hit-test shims. */
const SELF_PAINTING_TAGS = new Set([
  'canvas',
  'embed',
  'iframe',
  'img',
  'object',
  'picture',
  'svg',
  'video',
]);
/** Wrappers in component trees frequently differ by a one-pixel inset even
 * though users perceive one boundary. The candidate chain should hold visually
 * distinct boxes, not every implementation wrapper. */
const VISUAL_EDGE_MERGE_TOLERANCE = 2;

type InteractionKind = 'native' | 'role' | 'handler' | 'focusable' | 'cursor';

export function getComposedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function isElementInteractionDisabled(el: Element): boolean {
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
  const targetStyle = isImageMapArea ? null : getComputedStyle(el);
  if (
    targetStyle &&
    (hasComputedVisibilityUnavailable(targetStyle) || targetStyle.display === 'contents')
  ) {
    return true;
  }
  let current: Element | null = el;
  while (current) {
    // <area> and its <map> tree have no rendered boxes; the associated <img>
    // supplies visibility and clipping. Their CSS display state therefore
    // does not make an otherwise actionable image-map region unavailable.
    if (!isImageMapArea) {
      const style = getComputedStyle(current);
      if (
        hasOwnSubtreeVisualUnavailableState(style)
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
  style: CSSStyleDeclaration;
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

/** Visual states that suppress an entire rendered subtree. Unlike
 * `visibility`, descendants cannot override any of these states. */
function hasOwnSubtreeVisualUnavailableState(style: CSSStyleDeclaration): boolean {
  return (
    style.display === 'none' ||
    (style.opacity !== '' && Number(style.opacity) === 0) ||
    style.contentVisibility === 'hidden'
  );
}

/** `visibility` is inherited but explicitly overridable by descendants, so
 * only the current element's computed value is authoritative. Accumulating a
 * hidden ancestor would incorrectly discard `visibility: visible` children. */
function hasComputedVisibilityUnavailable(style: CSSStyleDeclaration): boolean {
  return style.visibility === 'hidden' || style.visibility === 'collapse';
}

/** Builds the composed ancestor chain and all inherited state once per hit-test.
 * Entries remain deepest-first, which is the order the candidate chain and its
 * `defaultIndex` are expressed in. */
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
  let subtreeVisuallyUnavailable = false;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    const style = getComputedStyle(element);
    interactionUnavailable ||= hasOwnInteractionDisabledState(element);
    subtreeVisuallyUnavailable ||= hasOwnSubtreeVisualUnavailableState(style);
    entries[index] = {
      element,
      style,
      kind: interactionKind(element, style),
      interactionUnavailable,
      // Image-map areas intentionally inherit their rendered state from the
      // associated image rather than their non-rendered <map> ancestry.
      visuallyUnavailable: element instanceof HTMLAreaElement
        ? false
        : subtreeVisuallyUnavailable ||
          hasComputedVisibilityUnavailable(style) ||
          style.display === 'contents',
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

/**
 * The deepest element under a point, piercing shadow roots. Returns null over
 * the extension's own overlays: the recorder must never target its toolbar or
 * highlight — and since it can pierce its own closed roots, the hit test would
 * otherwise resolve a toolbar button as if it were page content.
 */
export function deepElementFromPoint(clientX: number, clientY: number): Element | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit || isExtensionOverlay(hit)) return null;
  return descendShadowRoots(hit, clientX, clientY);
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

/**
 * Browser recording has two different targeting contracts:
 *
 * - annotation: choose the visible UI surface, optionally looking through a
 *   completely blank hit-test shim (the browser equivalent of an accessibility
 *   API omitting a non-semantic overlay);
 * - activation: preserve the page's actual top hit surface, because replaying a
 *   click on an element hidden underneath an overlay changes page behaviour.
 */
export interface VisualTargetPolicy {
  pierceTransparentOccluders: boolean;
  preserveHitSurface: boolean;
}

export const ANNOTATION_TARGETING_POLICY: Readonly<VisualTargetPolicy> = Object.freeze({
  pierceTransparentOccluders: true,
  preserveHitSurface: false,
});

export const ACTIVATION_TARGETING_POLICY: Readonly<VisualTargetPolicy> = Object.freeze({
  pierceTransparentOccluders: false,
  preserveHitSurface: true,
});

function visualBoundsKey(bounds: Bounds): string {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

function boundsEdges(bounds: Bounds): [number, number, number, number] {
  return [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];
}

/** Collapses tiny layout insets while retaining genuinely different parent
 * levels. Comparing edges rather than width/height avoids treating translated
 * sibling boxes as equivalent. */
function hasSamePerceivedBoundary(a: Bounds, b: Bounds): boolean {
  const aEdges = boundsEdges(a);
  const bEdges = boundsEdges(b);
  return aEdges.every(
    (edge, index) => Math.abs(edge - bEdges[index]) <= VISUAL_EDGE_MERGE_TOLERANCE,
  );
}

function isVisuallySelectableEntry(
  entry: AnalyzedElement,
  isHit: boolean,
  policy: Readonly<VisualTargetPolicy>,
): boolean {
  const tag = entry.element.tagName.toLowerCase();
  return (
    !NON_SELECTABLE_VISUAL_TAGS.has(tag) &&
    (!DECORATIVE_SVG_TAGS.has(tag) || (entry.kind !== null && entry.kind !== 'cursor')) &&
    (!entry.visuallyUnavailable || (isHit && policy.preserveHitSurface))
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

function overflowClipBoundsFromEntry(
  entry: AnalyzedElement,
  viewport: { width: number; height: number },
): Bounds {
  const el = entry.element;
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  const rect = boundingRect(entry);
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

/** Candidate-chain variant of `getVisibleHighlightBounds`. It reuses the
 * styles and rectangles already measured for this hit test, which lets visual
 * dedup compare the actual on-screen boxes without multiplying layout reads. */
function visibleHighlightBoundsFromEntries(
  entries: AnalyzedElement[],
  index: number,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): Bounds | null {
  // An <area> paints through its associated <img>, not through its <map>
  // ancestry. Use the canonical path so clipping starts at the image tree.
  if (entries[index].element instanceof HTMLAreaElement) {
    return getVisibleHighlightBounds(entries[index].element, clientX, clientY, viewport);
  }

  let visible = highlightBounds(entries[index], clientX, clientY);
  if (!visible) return null;
  visible = intersectBounds(visible, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!visible) return null;

  for (let ancestorIndex = index + 1; ancestorIndex < entries.length; ancestorIndex += 1) {
    const ancestor = entries[ancestorIndex];
    const style = ancestor.style;
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const clipsX = Boolean(overflowX && overflowX !== 'visible');
    const clipsY = Boolean(overflowY && overflowY !== 'visible');
    if (clipsX || clipsY) {
      const rect = overflowClipBoundsFromEntry(ancestor, viewport);
      visible = intersectBounds(visible, {
        x: clipsX ? rect.x : visible.x,
        y: clipsY ? rect.y : visible.y,
        width: clipsX ? rect.width : visible.width,
        height: clipsY ? rect.height : visible.height,
      });
      if (!visible) return null;
    }
    if (clipsPaint(style)) {
      const rect = boundingRect(ancestor);
      visible = intersectBounds(visible, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      if (!visible) return null;
    }
  }
  return visible;
}

interface ChainAnalysis {
  targets: VisualTargetCandidates;
  /** The control the chain resolves to, or null when it holds none. */
  interactive: Element | null;
  /** Deepest-first composed branch, retained so occlusion fallback can inspect
   * only the part that sits above a deeper target. Shared app/body ancestors do
   * not occlude one sibling branch with another and must not block piercing. */
  entries: AnalyzedElement[];
}

/** Builds the visually distinct target chain under a point, from the deepest
 * rendered element toward its composed ancestors. Semantic controls remain
 * the default even when the pointer lands on a nested label or icon. */
function analyzeChain(
  hit: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
  policy: Readonly<VisualTargetPolicy>,
): ChainAnalysis {
  const entries = analyzeElements(elementAndComposedAncestors(hit));
  const interactive = findInteractiveTargetFromEntries(entries);
  const candidates: VisualTargetCandidate[] = [];
  const indexByBounds = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const element = entry.element;
    if (!isVisuallySelectableEntry(entry, index === 0, policy)) continue;
    const bounds = visibleHighlightBoundsFromEntries(entries, index, clientX, clientY, viewport);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;

    const key = visualBoundsKey(bounds);
    const exactIndex = indexByBounds.get(key);
    if (exactIndex !== undefined) {
      if (element === interactive) candidates[exactIndex] = { element, bounds };
      continue;
    }

    // Component libraries often nest icon/label/surface wrappers whose boxes
    // differ by only one or two CSS pixels. Keeping all of them would make one
    // visible boundary occupy several chain entries. Ancestors are visited in
    // visual depth order, so the immediately preceding distinct box is the only
    // fuzzy comparison needed; exact non-adjacent repeats still use the map.
    const previousIndex = candidates.length - 1;
    const previous = candidates[previousIndex];
    if (previous && hasSamePerceivedBoundary(previous.bounds, bounds)) {
      if (element === interactive) candidates[previousIndex] = { element, bounds };
      indexByBounds.set(key, previousIndex);
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
    entries,
  };
}

/** How far down the paint stack a blank occluder is searched past. */
const OCCLUDER_STACK_LIMIT = 8;
/** A hostile or unusually large component tree must not turn one pointer move
 * into an unbounded DOM walk. Reaching the cap means the branch cannot be
 * proven blank, so targeting conservatively keeps the upper surface. */
const OCCLUDER_SUBTREE_SCAN_LIMIT = 256;
/** Containing-block discovery is repeated inside the bounded subtree scan, so
 * cap each ancestor walk as well. Exceeding it leaves the pseudo unproven. */
const PSEUDO_CONTAINING_BLOCK_SCAN_LIMIT = 64;
const GENERATED_PSEUDO_ELEMENTS = ['::before', '::after'] as const;

function cssColorIsTransparent(color: string): boolean {
  const normalized = color.replace(/\s+/g, '').toLowerCase();
  if (!normalized || normalized === 'transparent') return true;
  const rgba = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,([\d.]+)\)$/);
  if (rgba) return Number(rgba[1]) === 0;
  const modernRgb = normalized.match(/^rgb\([^/]+\/([\d.]+)%?\)$/);
  if (!modernRgb) return false;
  return Number(modernRgb[1]) === 0;
}

function cssPaintIsAbsent(value: string | undefined): boolean {
  return !value || value === 'none' || value === 'normal';
}

/**
 * Whether the hit element itself contributes visible pixels. This deliberately
 * stays conservative: unknown paint (images, pseudo-like filters, borders) is
 * considered real, because selecting the top visual object is safer than
 * clicking through it.
 */
function hasNoOwnVisualPaint(el: Element, style: CSSStyleDeclaration): boolean {
  if (SELF_PAINTING_TAGS.has(el.tagName.toLowerCase())) return false;
  // Disabled/inert controls are intentionally still selectable in snapshot
  // mode. interactionKind describes their own semantics before inherited
  // disabled state is applied, so they never become accidental pass-throughs.
  if (interactionKind(el, style) !== null) return false;
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
  if (role && role !== 'none' && role !== 'presentation' && role !== 'generic') return false;
  if (Number(style.opacity) === 0) return true;
  if (!cssColorIsTransparent(style.backgroundColor) || !cssPaintIsAbsent(style.backgroundImage)) return false;
  if (
    !cssPaintIsAbsent(style.boxShadow) ||
    !cssPaintIsAbsent(style.outlineStyle) ||
    !cssPaintIsAbsent(style.filter)
  ) {
    return false;
  }

  const extended = style as CSSStyleDeclaration & {
    backdropFilter?: string;
    maskImage?: string;
    webkitBackdropFilter?: string;
    webkitMaskImage?: string;
  };
  if (
    !cssPaintIsAbsent(extended.backdropFilter) ||
    !cssPaintIsAbsent(extended.webkitBackdropFilter) ||
    !cssPaintIsAbsent(extended.maskImage) ||
    !cssPaintIsAbsent(extended.webkitMaskImage)
  ) {
    return false;
  }

  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = Number.parseFloat(style[`border${side}Width`]);
    const borderStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    if (width > 0 && borderStyle !== 'none' && !cssColorIsTransparent(color)) return false;
  }
  return true;
}

function hasSurfaceDescription(el: Element): boolean {
  return (
    (el.textContent ?? '').trim().length > 0 ||
    (el.getAttribute('aria-label') ?? '').trim().length > 0 ||
    (el.getAttribute('aria-labelledby') ?? '').trim().length > 0 ||
    (el.getAttribute('title') ?? '').trim().length > 0
  );
}

/**
 * A transparent shim or drag layer can swallow hit testing without being the
 * thing users see. Annotation targeting follows visible UI boundaries, so a
 * small transparent layer is just as pass-through as a full-viewport one.
 * Text, accessible semantics and any painted surface — notably a modal
 * backdrop — stay real targets regardless of their size.
 */
function looksLikeBlankOccluder(entry: AnalyzedElement): boolean {
  return !hasSurfaceDescription(entry.element) && hasNoOwnVisualPaint(entry.element, entry.style);
}

function rectContainsPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function elementHasBoxAtPoint(el: Element, clientX: number, clientY: number): boolean {
  try {
    return Array.from(el.getClientRects()).some((rect) => rectContainsPoint(rect, clientX, clientY));
  } catch {
    // A layout read that cannot be completed means the branch is not safely
    // classifiable as blank. The caller treats this sentinel as painted.
    return true;
  }
}

function browserSupportsPseudoComputedStyle(): boolean {
  try {
    return (
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('selector(::before)')
    );
  } catch {
    return false;
  }
}

function generatedContentPaints(style: CSSStyleDeclaration): boolean {
  if (hasOwnSubtreeVisualUnavailableState(style) || hasComputedVisibilityUnavailable(style)) {
    return false;
  }

  const content = style.content.trim();
  const hasVisibleTextContent =
    content !== '' && content !== 'none' && content !== 'normal' && content !== '""' && content !== "''";
  if (hasVisibleTextContent) return true;

  if (!cssColorIsTransparent(style.backgroundColor) || !cssPaintIsAbsent(style.backgroundImage)) return true;
  if (
    !cssPaintIsAbsent(style.boxShadow) ||
    !cssPaintIsAbsent(style.outlineStyle) ||
    !cssPaintIsAbsent(style.filter)
  ) {
    return true;
  }

  const extended = style as CSSStyleDeclaration & {
    backdropFilter?: string;
    maskImage?: string;
    webkitBackdropFilter?: string;
    webkitMaskImage?: string;
  };
  if (
    !cssPaintIsAbsent(extended.backdropFilter) ||
    !cssPaintIsAbsent(extended.webkitBackdropFilter) ||
    !cssPaintIsAbsent(extended.maskImage) ||
    !cssPaintIsAbsent(extended.webkitMaskImage)
  ) {
    return true;
  }

  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = Number.parseFloat(style[`border${side}Width`]);
    const borderStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    if (width > 0 && borderStyle !== 'none' && !cssColorIsTransparent(color)) return true;
  }
  return false;
}

function computedPixelLength(value: string | undefined): number | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '0') return 0;
  if (!normalized.endsWith('px')) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function elementPaddingBounds(el: Element): Bounds | null {
  try {
    const rect = el.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
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
  } catch {
    return null;
  }
}

function establishesAbsoluteContainingBlock(style: CSSStyleDeclaration): boolean {
  const containment = style.contain.split(/\s+/);
  return (
    (style.position !== '' && style.position !== 'static') ||
    (style.transform !== '' && style.transform !== 'none') ||
    (style.perspective !== '' && style.perspective !== 'none') ||
    containment.some((value) => value === 'layout' || value === 'paint' || value === 'content' || value === 'strict')
  );
}

function positionedPseudoContainingBounds(
  el: Element,
  position: string,
  viewport: { width: number; height: number },
): Bounds | null {
  if (position === 'fixed') return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (position !== 'absolute') return null;

  let ancestor: Element | null = el;
  let scanned = 0;
  while (ancestor) {
    scanned += 1;
    if (scanned > PSEUDO_CONTAINING_BLOCK_SCAN_LIMIT) return null;
    try {
      if (establishesAbsoluteContainingBlock(getComputedStyle(ancestor))) {
        return elementPaddingBounds(ancestor);
      }
    } catch {
      return null;
    }
    ancestor = getComposedParent(ancestor);
  }

  // With no positioned ancestor, an absolutely positioned pseudo uses the
  // initial containing block. Client coordinates make the visible viewport the
  // useful, bounded approximation for deciding whether the pointer can be hit.
  return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

function pseudoOuterSize(style: CSSStyleDeclaration, axis: 'horizontal' | 'vertical'): number | null {
  const size = computedPixelLength(axis === 'horizontal' ? style.width : style.height);
  if (size === null) return null;
  if (style.boxSizing === 'border-box') return Math.max(0, size);

  const sides = axis === 'horizontal' ? (['Left', 'Right'] as const) : (['Top', 'Bottom'] as const);
  let outerSize = size;
  for (const side of sides) {
    outerSize += computedPixelLength(style[`padding${side}`]) ?? 0;
    outerSize += computedPixelLength(style[`border${side}Width`]) ?? 0;
  }
  return Math.max(0, outerSize);
}

function positionedPseudoAxisRange(
  containingStart: number,
  containingSize: number,
  startValue: string,
  endValue: string,
  outerSize: number | null,
): [number, number] | null {
  const start = computedPixelLength(startValue);
  const end = computedPixelLength(endValue);
  if (start !== null && end !== null) {
    const lower = containingStart + start;
    const upper = containingStart + containingSize - end;
    return upper >= lower ? [lower, upper] : null;
  }
  if (outerSize === null) return null;
  if (start !== null) {
    const lower = containingStart + start;
    return [lower, lower + outerSize];
  }
  if (end !== null) {
    const upper = containingStart + containingSize - end;
    return [upper - outerSize, upper];
  }
  return null;
}

/**
 * Pseudo-elements expose computed styles but no DOM geometry. For paint outside
 * the originating box, accept only positioned boxes whose used pixel insets or
 * size produce a finite axis-aligned bound. This catches common fixed/absolute
 * backdrops without treating unrelated generated text elsewhere as if it
 * covered every pointer position. Unsupported transforms or intrinsic sizing
 * remain non-evidence rather than causing an unbounded DOM/style search.
 */
function positionedPseudoMayCoverPoint(
  el: Element,
  style: CSSStyleDeclaration,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  if (style.transform && style.transform !== 'none') return false;
  const containing = positionedPseudoContainingBounds(el, style.position, viewport);
  if (!containing) return false;

  const horizontal = positionedPseudoAxisRange(
    containing.x,
    containing.width,
    style.left,
    style.right,
    pseudoOuterSize(style, 'horizontal'),
  );
  const vertical = positionedPseudoAxisRange(
    containing.y,
    containing.height,
    style.top,
    style.bottom,
    pseudoOuterSize(style, 'vertical'),
  );
  return Boolean(
    horizontal &&
      vertical &&
      clientX >= horizontal[0] &&
      clientX <= horizontal[1] &&
      clientY >= vertical[0] &&
      clientY <= vertical[1],
  );
}

function elementHasGeneratedPaintAtPoint(
  el: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  if (!browserSupportsPseudoComputedStyle()) return false;
  const hostCoversPoint = elementHasBoxAtPoint(el, clientX, clientY);

  for (const pseudo of GENERATED_PSEUDO_ELEMENTS) {
    try {
      const style = getComputedStyle(el, pseudo);
      if (
        generatedContentPaints(style) &&
        (hostCoversPoint || positionedPseudoMayCoverPoint(el, style, clientX, clientY, viewport))
      ) {
        return true;
      }
    } catch {
      // Modern target browsers expose pseudo-element computed style. If a page
      // makes that inspection fail, piercing would no longer be evidence-based.
      return true;
    }
  }
  return false;
}

function composedElementChildren(el: Element): Element[] {
  const children = Array.from(el.children);
  const shadowRoot = getOpenOrClosedShadowRoot(el);
  if (shadowRoot) children.push(...Array.from(shadowRoot.children));
  return children;
}

/**
 * `elementsFromPoint()` cannot report a painted descendant with
 * `pointer-events:none`, and it reports the originating element rather than a
 * `::before`/`::after` box. Before piercing an otherwise blank branch, inspect
 * its composed subtree for pixels or semantics at the pointer. The scan is
 * deliberately conservative: an incomplete style/layout read, or a tree over
 * the bounded budget, means the branch is kept rather than clicked through.
 */
function branchOwnsPaintAtPoint(
  branchRoot: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
  analyzedStyles: ReadonlyMap<Element, CSSStyleDeclaration>,
): boolean {
  const pending = [branchRoot];
  const visited = new Set<Element>();
  let scanned = 0;

  while (pending.length > 0) {
    const element = pending.pop()!;
    if (visited.has(element)) continue;
    visited.add(element);
    scanned += 1;
    if (scanned > OCCLUDER_SUBTREE_SCAN_LIMIT) return true;

    let style = analyzedStyles.get(element);
    if (!style) {
      try {
        style = getComputedStyle(element);
      } catch {
        return true;
      }
    }
    if (hasOwnSubtreeVisualUnavailableState(style)) continue;

    const coversPoint = elementHasBoxAtPoint(element, clientX, clientY);
    if (
      coversPoint &&
      !hasComputedVisibilityUnavailable(style) &&
      (hasSurfaceDescription(element) || !hasNoOwnVisualPaint(element, style))
    ) {
      return true;
    }
    if (elementHasGeneratedPaintAtPoint(element, clientX, clientY, viewport)) return true;

    pending.push(...composedElementChildren(element));
  }
  return false;
}

/**
 * Whether every element unique to an upper paint-stack branch is a genuinely
 * blank hit-test shim. The first composed ancestor shared with the target
 * branch is structural context (for example a painted application root), not
 * an intervening surface, so it and the rest of the shared ancestry are
 * deliberately excluded.
 */
function hasOnlyBlankExclusiveOccluders(
  occludingEntries: AnalyzedElement[],
  targetElements: ReadonlySet<Element>,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  const exclusiveEntries: AnalyzedElement[] = [];
  for (const entry of occludingEntries) {
    if (targetElements.has(entry.element)) break;
    if (!looksLikeBlankOccluder(entry)) return false;
    exclusiveEntries.push(entry);
  }

  // The last exclusive entry is the branch root immediately below the first
  // shared composed ancestor, so one bounded subtree walk covers all paint the
  // upper branch owns without inspecting unrelated siblings or the app root.
  const branchRoot = exclusiveEntries.at(-1)?.element;
  const analyzedStyles = new Map(exclusiveEntries.map((entry) => [entry.element, entry.style]));
  return branchRoot
    ? !branchOwnsPaintAtPoint(branchRoot, clientX, clientY, viewport, analyzedStyles)
    : true;
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
  policy: Readonly<VisualTargetPolicy> = ANNOTATION_TARGETING_POLICY,
): VisualTargetCandidates {
  const top = analyzeChain(hit, clientX, clientY, viewport, policy);
  if (
    !policy.pierceTransparentOccluders ||
    top.interactive ||
    typeof document.elementsFromPoint !== 'function'
  ) {
    return top.targets;
  }

  const occludingBranches: AnalyzedElement[][] = [top.entries];
  const analyzed = new Set(top.entries.map((entry) => entry.element));
  for (const occluded of document.elementsFromPoint(clientX, clientY).slice(0, OCCLUDER_STACK_LIMIT)) {
    if (analyzed.has(occluded) || isExtensionOverlay(occluded)) continue;
    const deeper = analyzeChain(
      descendShadowRoots(occluded, clientX, clientY),
      clientX,
      clientY,
      viewport,
      policy,
    );
    for (const entry of deeper.entries) analyzed.add(entry.element);
    if (deeper.interactive) {
      const targetElements = new Set(deeper.entries.map((entry) => entry.element));
      return occludingBranches.every((branch) =>
        hasOnlyBlankExclusiveOccluders(branch, targetElements, clientX, clientY, viewport)
      )
        ? deeper.targets
        : top.targets;
    }
    occludingBranches.push(deeper.entries);
  }
  return top.targets;
}

/** Picks the chain's default candidate — the one box a point resolves to.
 * `defaultIndex` is where the policy landed, so this is the single place that
 * knows how to read a candidate list. */
export function selectVisualTargetCandidate(
  targets: VisualTargetCandidates,
): VisualTargetCandidate | null {
  return targets.candidates[targets.defaultIndex] ?? null;
}

/** Hit-tests a viewport point and resolves the candidate it selects there.
 * Shared by the top-frame step recorder and the child-frame relay so both
 * frames pick identical targets. */
export function resolveVisualTargetAtPoint(
  clientX: number,
  clientY: number,
  policy: Readonly<VisualTargetPolicy> = ANNOTATION_TARGETING_POLICY,
): VisualTargetCandidate | null {
  const hit = deepElementFromPoint(clientX, clientY);
  if (!hit) return null;
  return selectVisualTargetCandidate(
    findVisualTargetCandidatesAtPoint(
      hit,
      clientX,
      clientY,
      { width: window.innerWidth, height: window.innerHeight },
      policy,
    ),
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

interface HighlightGeometry {
  bounds: Bounds;
  /** The rendered element whose composed ancestors clip these bounds. */
  paintElement: Element;
}

function resolveHighlightGeometry(
  el: Element,
  clientX: number,
  clientY: number,
): HighlightGeometry | null {
  if (el instanceof HTMLAreaElement) {
    const resolved = resolveImageMapAreaBounds(el, clientX, clientY);
    return resolved ? { bounds: resolved.bounds, paintElement: resolved.image } : null;
  }

  const rects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;

  const containingRects = rects.filter(
    (rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
  );
  const rect = (containingRects.length > 0 ? containingRects : rects).reduce((smallest, candidate) =>
    candidate.width * candidate.height < smallest.width * smallest.height ? candidate : smallest,
  );

  return {
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    paintElement: el,
  };
}

/**
 * Returns the precise painted fragment clicked by the user. A multiline inline
 * element uses its smallest relevant client rect; an image-map <area> uses its
 * region projected through the associated image because the area itself has no
 * layout box.
 */
export function getHighlightBounds(el: Element, clientX: number, clientY: number): Bounds | null {
  return resolveHighlightGeometry(el, clientX, clientY)?.bounds ?? null;
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
  const geometry = resolveHighlightGeometry(el, clientX, clientY);
  if (!geometry) return null;
  let visible: Bounds | null = geometry.bounds;
  visible = intersectBounds(visible, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!visible) return null;

  let ancestor = getComposedParent(geometry.paintElement);
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

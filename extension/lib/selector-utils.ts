import type { Bounds } from './db';

const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'area',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'option',
]);
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

function composedParent(el: Element): Element | null {
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
    current = composedParent(current);
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
    current = composedParent(current);
  }
  return false;
}

export function isElementUnavailable(el: Element): boolean {
  return isElementInteractionDisabled(el) || isElementVisuallyUnavailable(el);
}

function interactionKind(el: Element): InteractionKind | null {
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
    el.hasAttribute('onclick') ||
    typeof assignedClick === 'function' ||
    contentEditable === '' ||
    contentEditable === 'true' ||
    contentEditable === 'plaintext-only'
  ) {
    return 'handler';
  }

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return 'focusable';

  return getComputedStyle(el).cursor === 'pointer' ? 'cursor' : null;
}

export function isInteractiveElement(el: Element): boolean {
  return interactionKind(el) !== null && !isElementUnavailable(el);
}

function isDecorativeLeaf(el: Element, kind: InteractionKind): boolean {
  const tag = el.tagName.toLowerCase();
  return DECORATIVE_SVG_TAGS.has(tag) && kind === 'cursor';
}

function visibleArea(el: Element): number {
  const rect = el.getBoundingClientRect();
  return Number.isFinite(rect.width) && Number.isFinite(rect.height)
    ? Math.max(rect.width, 0) * Math.max(rect.height, 0)
    : 0;
}

/**
 * Chooses the element users perceive as the control. Native/ARIA controls
 * outrank cursor-only descendants; this prevents an icon or text node inside
 * a button-like surface from producing a tiny, inconsistent annotation box.
 */
function findInteractiveTargetFromNodes(nodes: Iterable<unknown>): Element | null {
  const candidates: Array<{ el: Element; kind: InteractionKind; depth: number }> = [];

  for (const [depth, node] of Array.from(nodes).entries()) {
    if (!(node instanceof Element)) continue;
    if (node === document.body || node === document.documentElement) break;

    const kind = interactionKind(node);
    if (!kind || isDecorativeLeaf(node, kind) || isElementUnavailable(node)) continue;
    if (visibleArea(node) === 0) continue;
    candidates.push({ el: node, kind, depth });
  }

  if (candidates.length === 0) return null;

  const kindScore: Record<InteractionKind, number> = {
    native: 5,
    role: 4,
    handler: 3,
    focusable: 2,
    cursor: 1,
  };

  return candidates
    .sort((a, b) => {
      const kindDifference = kindScore[b.kind] - kindScore[a.kind];
      if (kindDifference !== 0) return kindDifference;

      // For cursor-only controls, prefer a usable hit surface over a tiny
      // nested label/icon, while avoiding selection of a page-sized parent.
      if (a.kind === 'cursor' && b.kind === 'cursor') {
        const aArea = visibleArea(a.el);
        const bArea = visibleArea(b.el);
        const aMinSide = Math.min(a.el.getBoundingClientRect().width, a.el.getBoundingClientRect().height);
        const bMinSide = Math.min(b.el.getBoundingClientRect().width, b.el.getBoundingClientRect().height);
        const aScore = Math.min(aMinSide, 44) * 100 - Math.min(aArea, 40_000) / 100;
        const bScore = Math.min(bMinSide, 44) * 100 - Math.min(bArea, 40_000) / 100;
        if (aScore !== bScore) return bScore - aScore;
      }

      return a.depth - b.depth;
    })[0].el;
}

export function findInteractiveTarget(event: Event): Element | null {
  return findInteractiveTargetFromNodes(event.composedPath());
}

export function deepElementFromPoint(clientX: number, clientY: number): Element | null {
  let root: Document | ShadowRoot = document;
  let target: Element | null = null;
  const visited = new Set<ShadowRoot>();

  while (true) {
    const next: Element | null = root.elementFromPoint(clientX, clientY);
    if (!next) return target;
    target = next;
    const shadowRoot: ShadowRoot | null = next.shadowRoot;
    if (!shadowRoot || visited.has(shadowRoot)) return target;
    visited.add(shadowRoot);
    root = shadowRoot;
  }
}

function elementAndComposedAncestors(target: Element): Element[] {
  const nodes: Element[] = [];
  let current: Element | null = target;

  while (current) {
    nodes.push(current);
    current = composedParent(current);
  }
  return nodes;
}

/** Finds the control under viewport coordinates while an input shield is
 * temporarily click-blind. Open shadow roots are traversed when possible. */
export function findInteractiveTargetAtPoint(clientX: number, clientY: number): Element | null {
  const target = deepElementFromPoint(clientX, clientY);
  return target ? findInteractiveTargetFromNodes(elementAndComposedAncestors(target)) : null;
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
}

function visualBoundsKey(bounds: Bounds): string {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

function isVisuallySelectableElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const kind = interactionKind(el);
  return (
    !NON_SELECTABLE_VISUAL_TAGS.has(tag) &&
    (!DECORATIVE_SVG_TAGS.has(tag) || (kind !== null && kind !== 'cursor')) &&
    !isElementVisuallyUnavailable(el)
  );
}

/** Builds the visually distinct target chain under a point, from the deepest
 * rendered element toward its composed ancestors. Semantic controls remain
 * the default even when the pointer lands on a nested label or icon. */
export function findVisualTargetCandidates(
  hit: Element,
  clientX: number,
  clientY: number,
): VisualTargetCandidates {
  const nodes = elementAndComposedAncestors(hit);
  const interactive = findInteractiveTargetFromNodes(nodes);
  const candidates: VisualTargetCandidate[] = [];
  const indexByBounds = new Map<string, number>();

  for (const element of nodes) {
    if (!isVisuallySelectableElement(element)) continue;
    const bounds = getHighlightBounds(element, clientX, clientY);
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
  return { candidates, defaultIndex: interactiveIndex >= 0 ? interactiveIndex : 0 };
}

export function selectVisualTargetCandidate(
  targets: VisualTargetCandidates,
  requestedOffset: number,
): SelectedVisualTargetCandidate | null {
  if (targets.candidates.length === 0) return null;
  const minimumOffset = -targets.defaultIndex;
  const maximumOffset = targets.candidates.length - 1 - targets.defaultIndex;
  const candidateOffset = Math.max(minimumOffset, Math.min(requestedOffset, maximumOffset));
  const candidate = targets.candidates[targets.defaultIndex + candidateOffset];
  return { ...candidate, candidateOffset };
}

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

function overflowClipBounds(el: Element): Bounds {
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

  let ancestor = composedParent(el);
  while (ancestor) {
    const style = getComputedStyle(ancestor);
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const clipsX = Boolean(overflowX && overflowX !== 'visible');
    const clipsY = Boolean(overflowY && overflowY !== 'visible');
    const paintClip = clipsPaint(style);
    if (clipsX || clipsY) {
      const rect = overflowClipBounds(ancestor);
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
    ancestor = composedParent(ancestor);
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

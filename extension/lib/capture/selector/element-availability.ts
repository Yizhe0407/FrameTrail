import { getOpenOrClosedShadowRoot } from '../shadow-dom';
import { isExtensionOverlay } from '../viewport-overlay-host';

export const DECORATIVE_SVG_TAGS = new Set(['path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect', 'use']);

export const NON_SELECTABLE_VISUAL_TAGS = new Set([
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

/** Replaced/graphics elements can paint meaningful pixels without DOM text or
 * CSS background/border clues, so they must never be treated as transparent
 * hit-test shims. */
export const SELF_PAINTING_TAGS = new Set([
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

export function hasOwnInteractionDisabledState(el: Element): boolean {
  return (
    el.hasAttribute('inert') ||
    el.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true' ||
    ('disabled' in el && Boolean((el as HTMLButtonElement).disabled))
  );
}

/** Visual states that suppress an entire rendered subtree. Unlike
 * `visibility`, descendants cannot override any of these states. */

/** Visual states that suppress an entire rendered subtree. Unlike
 * `visibility`, descendants cannot override any of these states. */
export function hasOwnSubtreeVisualUnavailableState(style: CSSStyleDeclaration): boolean {
  return (
    style.display === 'none' ||
    (style.opacity !== '' && Number(style.opacity) === 0) ||
    style.contentVisibility === 'hidden'
  );
}

/** `visibility` is inherited but explicitly overridable by descendants, so
 * only the current element's computed value is authoritative. Accumulating a
 * hidden ancestor would incorrectly discard `visibility: visible` children. */

/** `visibility` is inherited but explicitly overridable by descendants, so
 * only the current element's computed value is authoritative. Accumulating a
 * hidden ancestor would incorrectly discard `visibility: visible` children. */
export function hasComputedVisibilityUnavailable(style: CSSStyleDeclaration): boolean {
  return style.visibility === 'hidden' || style.visibility === 'collapse';
}

/** Builds the composed ancestor chain and all inherited state once per hit-test.
 * Entries remain deepest-first, which is the order the candidate chain and its
 * `defaultIndex` are expressed in. */

/** Walks a hit element down through every shadow root it hosts, open or
 * closed, to the innermost element actually under the point. */
export function descendShadowRoots(start: Element, clientX: number, clientY: number): Element {
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

export function elementAndComposedAncestors(target: Element): Element[] {
  const nodes: Element[] = [];
  let current: Element | null = target;

  while (current) {
    nodes.push(current);
    current = getComposedParent(current);
  }
  return nodes;
}

export function composedElementChildren(el: Element): Element[] {
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

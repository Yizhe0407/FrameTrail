import type { Bounds } from './db';

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'option']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'checkbox',
  'radio',
  'tab',
  'switch',
  'option',
]);

type InteractionKind = 'native' | 'role' | 'handler' | 'focusable' | 'cursor';

function interactionKind(el: Element): InteractionKind | null {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag) && !(tag === 'input' && (el as HTMLInputElement).type === 'hidden')) return 'native';

  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return 'role';

  if (el.hasAttribute('onclick') || el.getAttribute('contenteditable') === 'true') return 'handler';

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return 'focusable';

  return getComputedStyle(el).cursor === 'pointer' ? 'cursor' : null;
}

function isDecorativeLeaf(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return el instanceof SVGElement || ['path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect', 'use'].includes(tag);
}

function visibleArea(el: Element): number {
  const rect = el.getBoundingClientRect();
  return Math.max(rect.width, 0) * Math.max(rect.height, 0);
}

/**
 * Chooses the element users perceive as the control. Native/ARIA controls
 * outrank cursor-only descendants; this prevents an icon or text node inside
 * a button-like surface from producing a tiny, inconsistent annotation box.
 */
export function findInteractiveTarget(event: Event): HTMLElement | null {
  const path = event.composedPath();
  const candidates: Array<{ el: HTMLElement; kind: InteractionKind; depth: number }> = [];

  for (const [depth, node] of path.entries()) {
    if (!(node instanceof Element)) continue;
    if (node === document.body || node === document.documentElement) break;

    const kind = interactionKind(node);
    if (!kind || isDecorativeLeaf(node)) continue;
    if (visibleArea(node) === 0) continue;
    candidates.push({ el: node as HTMLElement, kind, depth });
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

/** Builds a reasonably-stable CSS selector path from html to the element. */
export function buildCssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const siblings = Array.from(parent.children).filter((s) => s.tagName === node!.tagName);
    const index = siblings.indexOf(node) + 1;
    const tag = node.tagName.toLowerCase();
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = parent;
  }

  return parts.join(' > ');
}

/** Builds an XPath fallback for elements without stable CSS selectors (e.g. SPAs with no ids/classes). */
export function buildXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const siblings = Array.from(parent.children).filter((s) => s.tagName === node!.tagName);
    const index = siblings.indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = parent;
  }

  return `/${parts.join('/')}`;
}

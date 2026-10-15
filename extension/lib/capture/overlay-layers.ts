/**
 * Stacking order for every in-page overlay the extension injects.
 *
 * Two stacking systems are in play: plain `z-index`, and the browser's top
 * layer (`showPopover()`), which always paints above any z-index. An overlay
 * that must sit above a top-layer sibling therefore has to be in the top layer
 * itself, and the top layer stacks in the order `showPopover()` was called, so
 * the order has to be managed rather than left to whichever mounted last.
 *
 * Each overlay declares a rank; whenever one opens, every already-open overlay
 * of a higher rank is raised back above it. Without popover support all hosts
 * fall back to their fixed max z-index, which keeps document order.
 */
export const OVERLAY_LAYER = {
  /** Marks drawn on the page content: hover frames. */
  annotation: 0,
  /** Recorder controls the user operates: the floating toolbar. */
  chrome: 1,
  /** Full-viewport interactions that take over the page: region selection. */
  modal: 2,
} as const;

export type OverlayLayer = (typeof OVERLAY_LAYER)[keyof typeof OVERLAY_LAYER];

const ranked = new Map<HTMLElement, OverlayLayer>();

function isOpen(host: HTMLElement): boolean {
  try {
    return host.matches(':popover-open');
  } catch {
    return false;
  }
}

/** Moves an open host to the top of the top layer; re-showing is synchronous, so nothing paints in between. */
function raise(host: HTMLElement): void {
  if (!host.isConnected || !isOpen(host)) {
    ranked.delete(host);
    return;
  }
  try {
    host.hidePopover();
    host.showPopover();
  } catch {
    // A popover that changed state mid-call is already out of the way.
  }
}

/**
 * Shows `host` in the top layer at `layer`. Idempotent: an already-open host is
 * left where it is, so calling this on every update never reshuffles the stack.
 */
export function showInTopLayer(host: HTMLElement, layer: OverlayLayer): void {
  if (typeof host.showPopover !== 'function') return;
  if (isOpen(host)) {
    ranked.set(host, layer);
    return;
  }
  try {
    host.showPopover();
  } catch {
    // Not connected yet or already open in some browser versions; the fixed z-index remains the fallback.
    return;
  }
  ranked.set(host, layer);
  for (const [other, rank] of [...ranked]) {
    if (other !== host && rank > layer) raise(other);
  }
}

/** Forgets `host`; call when the overlay is removed so a dead host is never raised. */
export function releaseTopLayer(host: HTMLElement): void {
  ranked.delete(host);
}

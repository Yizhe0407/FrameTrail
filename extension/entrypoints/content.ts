import { browser } from 'wxt/browser';
import { buildCssSelector, buildXPath, findInteractiveTarget, getHighlightBounds } from '@/lib/selector-utils';
import type { ClickCapture } from '@/lib/messages';

// Dispatched on (re)injection so any previous instance in this same isolated
// world tears down its listener before we add a new one — prevents duplicate
// captures when the recorder is injected more than once (e.g. re-inject after
// navigation). Mirrors Mimik's cleanup-event pattern.
const CLEANUP_EVENT = `frame_trail_cleanup_${browser.runtime.id}`;

// Ignore a repeat click on the same element within this window (double-clicks,
// event bubbling quirks) so one user action becomes one step.
const DEDUP_MS = 400;

// Wait a few frames after the click so the page has painted its reaction
// (menu opened, active state, etc.) before the background grabs a screenshot.
const PAINT_FRAMES = 2;

function isOutOfViewport(rect: { x: number; y: number; width: number; height: number }): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return rect.y < 0 || rect.x < 0 || bottom > window.innerHeight || right > window.innerWidth;
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    let remaining = PAINT_FRAMES;
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

/**
 * First non-empty line of rendered text, capped. innerText (not textContent)
 * so CSS-hidden content stays out; only the first line because a control's
 * accessible label is its lead text — trailing lines are badges, hints, etc.
 */
function getVisibleText(el: HTMLElement): string {
  const lines = el.innerText?.split('\n') ?? [];
  return (lines.find((line) => line.trim().length > 0)?.trim() ?? '').slice(0, 80);
}

/** Form controls carry no innerText; their name lives on the label or placeholder. */
function getFieldLabel(el: HTMLElement): string {
  if (
    !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
  ) {
    return '';
  }
  // .labels covers both label[for=id] and an ancestor <label>.
  return el.labels?.[0]?.innerText?.trim() || el.getAttribute('placeholder')?.trim() || '';
}

/**
 * aria-label outranks visible text: icon-only controls (a "×" on a tag chip)
 * render a glyph that is meaningless in a written step, and their real name is
 * only in the label.
 */
function describeElement(el: HTMLElement): string {
  return (
    el.getAttribute('aria-label')?.trim() ||
    getFieldLabel(el) ||
    getVisibleText(el) ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('alt')?.trim() ||
    ''
  ).slice(0, 200);
}

/** Plain in-page anchor that will navigate away and destroy this document. */
function getNavigatingAnchor(el: Element): HTMLAnchorElement | null {
  const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return null;
  if (anchor.target === '_blank') return null;
  const href = anchor.getAttribute('href') ?? '';
  if (href.startsWith('#') || href.startsWith('javascript:')) return null;
  return anchor;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // Tear down any prior instance living in this isolated world.
    document.dispatchEvent(new CustomEvent(CLEANUP_EVENT));

    let lastTarget: Element | null = null;
    let lastTime = 0;

    const onClick = async (e: Event) => {
      const me = e as MouseEvent;
      const el = findInteractiveTarget(e);
      if (!el) return;

      const now = Date.now();
      if (el === lastTarget && now - lastTime < DEDUP_MS) return;
      lastTarget = el;
      lastTime = now;

      // If this click navigates away, hold the navigation until the screenshot
      // is taken — otherwise captureVisibleTab grabs the *next* page.
      const anchor = getNavigatingAnchor(el);
      if (anchor) {
        me.preventDefault();
        me.stopImmediatePropagation();
      }

      let clientX = me.clientX;
      let clientY = me.clientY;

      let rect = getHighlightBounds(el, clientX, clientY);
      if (!rect) return;

      if (isOutOfViewport(rect)) {
        // The click point is fixed relative to the element, so scrolling moves
        // it by the same delta. Without this translation the stale coordinates
        // land outside every post-scroll rect and getHighlightBounds silently
        // falls back to the smallest fragment of a multi-rect element.
        const before = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await waitForPaint();
        const after = el.getBoundingClientRect();
        clientX += after.left - before.left;
        clientY += after.top - before.top;
      } else {
        await waitForPaint();
      }

      rect = getHighlightBounds(el, clientX, clientY);
      if (!rect) return;

      const payload: ClickCapture = {
        type: 'FRAME_TRAIL_CLICK',
        selector: buildCssSelector(el),
        xpath: buildXPath(el),
        rect,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        text: describeElement(el),
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        url: location.href,
        pageTitle: document.title,
        timestamp: now,
      };

      try {
        await browser.runtime.sendMessage(payload);
      } catch (err) {
        console.error('[frametrail] sendMessage failed', err);
      }

      if (anchor) window.location.href = anchor.href;
    };

    document.addEventListener('click', onClick, { capture: true });

    const cleanup = () => {
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener(CLEANUP_EVENT, cleanup);
    };
    document.addEventListener(CLEANUP_EVENT, cleanup);

    console.log('[frametrail] recorder ready on', location.href);
  },
});

import { browser } from 'wxt/browser';
import { buildCssSelector, buildXPath, findInteractiveTarget, getHighlightBounds } from '@/lib/selector-utils';
import { getRecordingState } from '@/lib/storage';
import type { ClickCapture, FrameTrailStopMessage } from '@/lib/messages';

// Dispatched on (re)injection so any previous instance in this same isolated
// world tears down its listener before we add a new one — prevents duplicate
// captures when the recorder is injected more than once (e.g. re-inject after
// navigation). Mirrors Mimik's cleanup-event pattern.
const CLEANUP_EVENT = `frame_trail_cleanup_${browser.runtime.id}`;

// Ignore a repeat pointerdown on the same element within this window
// (double-clicks, event bubbling quirks) so one user action becomes one step.
const DEDUP_MS = 400;

// Matches the name background.ts listens for on runtime.onConnect.
const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';

// Well under the ~30s MV3 service-worker idle timeout, so the port never goes
// quiet long enough for Chrome to reclaim the worker mid-recording.
const KEEPALIVE_INTERVAL_MS = 20_000;

// Snapshot mode annotates every click onto one screenshot taken at the first
// click, so the page must not react to any of them (navigation, SPA route
// changes, menus, form submits) or later boxes point at a stale screenshot.
// preventDefault + stopImmediatePropagation on every event a click/tap can
// produce blocks default actions and the page's own listeners in one pass;
// Enter/Space activation and form-submit-on-Enter are covered for free since
// browsers synthesize 'click'/'submit' for those.
const FREEZE_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'submit'] as const;

function isOutOfViewport(rect: { x: number; y: number; width: number; height: number }): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return rect.y < 0 || rect.x < 0 || bottom > window.innerHeight || right > window.innerWidth;
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  async main() {
    // Tear down any prior instance living in this isolated world.
    document.dispatchEvent(new CustomEvent(CLEANUP_EVENT));

    // Read once per injection: background re-injects this script on every
    // recording start and every navigation, so the stored state is always
    // current for this instance's lifetime.
    const recordingState = await getRecordingState();
    const shouldFreeze = recordingState.isRecording && recordingState.mode === 'snapshot';

    let lastTarget: Element | null = null;
    let lastTime = 0;

    // pointerdown fires before the page reacts to the click (menu open,
    // navigation, SPA route change, ...), so the screenshot always shows the
    // state the red box refers to — no waiting on, or racing against, the
    // page's own click handling.
    const onPointerDown = async (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0 || !pe.isPrimary) return;

      const el = findInteractiveTarget(e);
      if (!el) return;

      const now = Date.now();
      if (el === lastTarget && now - lastTime < DEDUP_MS) return;
      lastTarget = el;
      lastTime = now;

      let clientX = pe.clientX;
      let clientY = pe.clientY;

      let rect = getHighlightBounds(el, clientX, clientY);
      if (!rect) return;

      if (isOutOfViewport(rect)) {
        // The pointer point is fixed relative to the element, so scrolling
        // moves it by the same delta. Without this translation the stale
        // coordinates land outside every post-scroll rect and
        // getHighlightBounds silently falls back to the smallest fragment of
        // a multi-rect element.
        const before = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await waitForNextFrame();
        const after = el.getBoundingClientRect();
        clientX += after.left - before.left;
        clientY += after.top - before.top;

        rect = getHighlightBounds(el, clientX, clientY);
        if (!rect) return;
      }

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
    };

    document.addEventListener('pointerdown', onPointerDown, { capture: true });

    // Registered after onPointerDown above so the recorder always observes
    // the click before stopImmediatePropagation cuts off everything else
    // (including the page's own listeners) on the same event.
    const onFreeze = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (shouldFreeze) {
      for (const type of FREEZE_EVENTS) {
        document.addEventListener(type, onFreeze, { capture: true });
      }
    }
    // Known limitation: this only blocks the DOM event chain. Page JS
    // reacting to a window-level capture listener that ran before ours, or
    // to an unrelated timer, can still mutate the page — not something a
    // content script can prevent. Accepted per product decision.

    // The background service worker can be reclaimed mid-recording if it goes
    // ~30s without activity; an open port with a periodic message keeps it
    // alive for the whole session instead of only while messages happen to
    // arrive from clicks.
    let keepAlivePort: ReturnType<typeof browser.runtime.connect> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let keepAliveStopped = false;

    const connectKeepAlive = () => {
      const port = browser.runtime.connect({ name: KEEPALIVE_PORT_NAME });
      keepAlivePort = port;
      keepAliveTimer = setInterval(() => port.postMessage({ type: 'heartbeat' }), KEEPALIVE_INTERVAL_MS);
      port.onDisconnect.addListener(() => {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        // A worker restart disconnects the port; reconnect unless this
        // instance has been torn down deliberately.
        if (!keepAliveStopped) connectKeepAlive();
      });
    };
    connectKeepAlive();

    // Background sends this to the recorded tab once recording stops, so the
    // keep-alive port (and its 20s heartbeat) closes instead of running for
    // as long as the tab stays open — otherwise it holds the MV3 service
    // worker alive indefinitely, well past the end of the recording.
    const onStopMessage = (message: FrameTrailStopMessage) => {
      if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
    };

    const cleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (shouldFreeze) {
        for (const type of FREEZE_EVENTS) {
          document.removeEventListener(type, onFreeze, { capture: true });
        }
      }
      document.removeEventListener(CLEANUP_EVENT, cleanup);
      browser.runtime.onMessage.removeListener(onStopMessage);
      // Set before disconnecting so the port's onDisconnect handler sees
      // keepAliveStopped=true and does not reconnect.
      keepAliveStopped = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAlivePort?.disconnect();
    };
    document.addEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.addListener(onStopMessage);

    console.log('[frametrail] recorder ready on', location.href);
  },
});

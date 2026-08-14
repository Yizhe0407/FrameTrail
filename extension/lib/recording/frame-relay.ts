import { browser } from 'wxt/browser';
import { type Bounds } from '../storage/models';
import {
  getVisibleHighlightBounds,
  intersectBounds,
  isElementVisuallyUnavailable,
  isInteractiveElement,
  resolveVisualTargetAtPoint,
} from '../capture/selector-utils';
import { createFrameCoordinateMapper } from '../capture/frame-geometry';
import {
  closePortQuietly,
  createFrameProbeRateLimiter,
  type FrameProbeRateLimiter,
} from '../capture/frame-probe';
import {
  createLateClickSuppressor,
  createStepCaptureDedup,
  createStepFollowupHandler,
} from '../capture/step-capture';
import { describeElement, replayClickWithSuppression } from '../capture/element-description';
import {
  isInScrollbarGutter,
  isPointInAnyScrollGutter,
} from './recording-guards';
import { onRecordingStateChange } from '../storage/storage';
import {
  CAPTURE_FAILSAFE_MS,
  CLEANUP_EVENT,
  SNAPSHOT_FREEZE_EVENTS,
  STEP_DEDUP_MS,
  STEP_FOLLOWUP_EVENTS,
  STEP_LATE_CLICK_SUPPRESS_MS,
} from './content-script-constants';
import { isFiniteRect } from '../shared/validation';
import type { FrameTrailStopMessage } from '../runtime/messages';

/**
 * Step-mode child frames capture their own clicks and relay them toward the
 * top frame, mapping the target rect into the receiving frame's viewport at
 * every hop. The relayed payload deliberately carries NO run-scoped secret:
 * the parent's origin is unknown to a child frame, so an upward postMessage
 * must use '*', and embedding the runId there would hand it to ancestor page
 * scripts that never legitimately learn it. Authentication instead relies on
 * every hop verifying that the sending window is one of its own child iframes
 * plus strict payload validation and a fixed-window rate limit. The capture
 * confirmation travels back over a transferred MessagePort, which page
 * scripts cannot observe.
 */

const STEP_FRAME_TEXT_LIMIT = 200;
const STEP_FRAME_TAG_LIMIT = 100;
const STEP_FRAME_COORDINATE_LIMIT = 1_000_000;
/** Slightly above the top frame's CAPTURE_FAILSAFE_MS so a healthy capture
 * always beats this local budget; when the relay chain is broken the click is
 * replayed anyway to keep the page usable. */
const STEP_FRAME_CLICK_FAILSAFE_MS = CAPTURE_FAILSAFE_MS + 500;
const STEP_FRAME_RELAY_MAX_CONCURRENT = 8;
const STEP_FRAME_RELAY_MAX_REQUESTS_PER_WINDOW = 90;
const STEP_FRAME_RELAY_RATE_WINDOW_MS = 10_000;
const MAX_SHADOW_SCAN_DEPTH = 8;

export function stepFrameClickMessageType(runtimeId: string): string {
  return `frame_trail_step_frame_click_${runtimeId}`;
}

export function snapshotFrameScrollPingType(runtimeId: string): string {
  return `frame_trail_snapshot_frame_scroll_${runtimeId}`;
}

export interface StepFrameClickPayload {
  type: string;
  /** Target rect in the SENDING frame's viewport coordinates. */
  rect: Bounds;
  text: string;
  tagName: string;
  interactive: boolean;
}

export interface StepFrameClickResponse {
  replay: boolean;
}

function isRelayRect(value: unknown): value is Bounds {
  return isFiniteRect(value, { maxMagnitude: STEP_FRAME_COORDINATE_LIMIT });
}

export function isStepFrameClickPayload(value: unknown, messageType: string): value is StepFrameClickPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<StepFrameClickPayload>;
  return (
    payload.type === messageType &&
    isRelayRect(payload.rect) &&
    typeof payload.text === 'string' &&
    payload.text.length <= STEP_FRAME_TEXT_LIMIT &&
    typeof payload.tagName === 'string' &&
    payload.tagName.length > 0 &&
    payload.tagName.length <= STEP_FRAME_TAG_LIMIT &&
    typeof payload.interactive === 'boolean'
  );
}

export function isStepFrameClickResponse(value: unknown): value is StepFrameClickResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { replay?: unknown }).replay === 'boolean',
  );
}

export function respondToStepFrameClick(port: MessagePort, replay: boolean): void {
  try {
    port.postMessage({ replay } satisfies StepFrameClickResponse);
  } catch {
    // The originating frame may already be gone; its local failsafe replays.
  }
  closePortQuietly(port);
}

function findIframeInNode(root: ParentNode, source: unknown, depth: number): HTMLIFrameElement | null {
  for (const frame of root.querySelectorAll('iframe')) {
    if ((frame as HTMLIFrameElement).contentWindow === source) return frame as HTMLIFrameElement;
  }
  if (depth >= MAX_SHADOW_SCAN_DEPTH) return null;
  for (const host of root.querySelectorAll('*')) {
    const shadow = host.shadowRoot;
    if (!shadow) continue;
    const found = findIframeInNode(shadow, source, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Locates the iframe element in this document whose browsing context sent a
 * message. This is the authentication anchor of the relay: page scripts in
 * this frame post with THIS window as their source, never a child's. */
export function findIframeForWindow(source: unknown): HTMLIFrameElement | null {
  if (!source || source === window) return null;
  return findIframeInNode(document, source, 0);
}

/** Maps a rect from a child frame's viewport into this frame's viewport and
 * clips it to the visible portion of the iframe. Returns null when nothing
 * remains visible (hidden, collapsed, or fully clipped frames). */
function mapChildRectIntoFrameViewport(frame: HTMLIFrameElement, rect: Bounds): Bounds | null {
  if (isElementVisuallyUnavailable(frame)) return null;
  const mapper = createFrameCoordinateMapper(frame);
  if (!mapper) return null;
  const mapped = mapper.toParentBounds(rect);
  const visibleFrame = getVisibleHighlightBounds(
    frame,
    mapped.x + mapped.width / 2,
    mapped.y + mapped.height / 2,
  );
  if (!visibleFrame) return null;
  return intersectBounds(mapped, visibleFrame);
}

export interface RelayedStepFrameClick {
  payload: StepFrameClickPayload;
  port: MessagePort;
  /** The direct child iframe (in this document) that relayed the click. */
  frame: HTMLIFrameElement;
  /** Payload rect mapped into this frame's viewport; null when the sending
   * iframe is not visible here. */
  rect: Bounds | null;
}

/**
 * Validates and maps one relayed child-frame click. Returns null (after
 * closing or answering the port) for anything that must not propagate:
 * malformed payloads, windows that are not our own child iframes, and
 * messages beyond the rate budget.
 */
export function resolveRelayedStepFrameClick(
  event: MessageEvent,
  messageType: string,
  limiter: FrameProbeRateLimiter,
): RelayedStepFrameClick | null {
  const port = event.ports[0];
  if (!port) return null;
  if (!isStepFrameClickPayload(event.data, messageType)) {
    closePortQuietly(port);
    return null;
  }
  const release = limiter.tryAcquire();
  if (!release) {
    respondToStepFrameClick(port, false);
    return null;
  }
  // Admission control here bounds request volume (and the O(document) frame
  // scan below); the actual capture concurrency is bounded by the top frame's
  // single-flight gesture.
  release();
  const frame = findIframeForWindow(event.source);
  if (!frame) {
    closePortQuietly(port);
    return null;
  }
  return { payload: event.data, port, frame, rect: mapChildRectIntoFrameViewport(frame, event.data.rect) };
}

export function createStepFrameRelayLimiter(): FrameProbeRateLimiter {
  return createFrameProbeRateLimiter({
    maxConcurrent: STEP_FRAME_RELAY_MAX_CONCURRENT,
    maxRequestsPerWindow: STEP_FRAME_RELAY_MAX_REQUESTS_PER_WINDOW,
    windowMs: STEP_FRAME_RELAY_RATE_WINDOW_MS,
  });
}

/**
 * Installs the step-mode recorder for one child frame: it swallows the local
 * gesture, sends the resolved target up the relay, and replays the click only
 * after the top frame's screenshot has settled (or the failsafe expired). It
 * also relays clicks arriving from its own nested frames toward the top.
 */
export function installStepFrameRecorder(runId: string, initiallyPaused: boolean): void {
  if (window.top === window) return;
  const clickType = stepFrameClickMessageType(browser.runtime.id);
  let paused = initiallyPaused;
  let removed = false;
  let gestureActive = false;
  let gestureCancelled = false;
  const dedup = createStepCaptureDedup<Element>(STEP_DEDUP_MS);
  const lateClicks = createLateClickSuppressor<Element>(STEP_LATE_CLICK_SUPPRESS_MS);
  const relayLimiter = createStepFrameRelayLimiter();

  const replayInto = (el: Element) => replayClickWithSuppression(el, lateClicks);

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    // A new trusted press ends the previous gesture's trailing-click era; any
    // click after it is genuine and must be delivered (double-click fix).
    if (event.isTrusted) lateClicks.onTrustedPointerDown();
    if (paused) return;
    if (isInScrollbarGutter(event.clientX, event.clientY, document.documentElement)) return;
    if (isPointInAnyScrollGutter(event.clientX, event.clientY)) return;
    const el = resolveVisualTargetAtPoint(event.clientX, event.clientY)?.element ?? null;
    if (!el) return;
    if (gestureActive) {
      // A relayed capture is still in flight; swallow the gesture so it cannot
      // mutate the page before that screenshot lands.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!dedup.shouldCapture(el)) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const rect = getVisibleHighlightBounds(el, event.clientX, event.clientY);
    if (!rect) {
      // Nothing capturable, but the gesture was already consumed: replay so
      // the activation is not lost.
      replayInto(el);
      return;
    }

    gestureActive = true;
    gestureCancelled = false;
    const payload: StepFrameClickPayload = {
      type: clickType,
      rect,
      text: describeElement(el),
      tagName: el.tagName.toLowerCase(),
      interactive: isInteractiveElement(el),
    };
    const channel = new MessageChannel();
    let settled = false;
    let failsafe: ReturnType<typeof setTimeout> | null = null;
    const settle = (replay: boolean) => {
      if (settled) return;
      settled = true;
      if (failsafe !== null) clearTimeout(failsafe);
      closePortQuietly(channel.port1);
      gestureActive = false;
      if (removed || gestureCancelled) return;
      if (replay) replayInto(el);
    };
    failsafe = setTimeout(() => settle(true), STEP_FRAME_CLICK_FAILSAFE_MS);
    channel.port1.onmessage = (response) => {
      settle(isStepFrameClickResponse(response.data) ? response.data.replay : true);
    };
    channel.port1.start();
    try {
      window.parent.postMessage(payload, '*', [channel.port2]);
    } catch {
      settle(true);
    }
  };

  const onFollowup = createStepFollowupHandler(lateClicks, {
    isActive: () => gestureActive,
    cancel: () => {
      gestureCancelled = true;
    },
  });

  const onRelayMessage = (event: MessageEvent) => {
    const relayed = resolveRelayedStepFrameClick(event, clickType, relayLimiter);
    if (!relayed) return;
    if (relayed.rect === null) {
      respondToStepFrameClick(relayed.port, false);
      return;
    }
    const forwarded: StepFrameClickPayload = { ...relayed.payload, rect: relayed.rect };
    try {
      window.parent.postMessage(forwarded, '*', [relayed.port]);
    } catch {
      respondToStepFrameClick(relayed.port, false);
    }
  };

  const onStop = (message: FrameTrailStopMessage) => {
    if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
  };
  let unsubscribe = () => {};
  function cleanup() {
    if (removed) return;
    removed = true;
    lateClicks.clear();
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    for (const type of STEP_FOLLOWUP_EVENTS) document.removeEventListener(type, onFollowup, { capture: true });
    window.removeEventListener('message', onRelayMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
    unsubscribe();
  }
  unsubscribe = onRecordingStateChange((state) => {
    if (state.operation !== 'recording' || !state.isRecording || state.runId !== runId || state.mode !== 'steps') {
      cleanup();
      return;
    }
    paused = state.phase === 'paused';
  });

  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('message', onRelayMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);
}

/**
 * Freezes a snapshot child frame and reports pixel-shifting scrolls upward.
 * The top frame cannot observe iframe-internal scrolling, so each frame pings
 * its parent (relayed hop by hop, each hop re-verifying the sending window)
 * and the top frame force-invalidates the frozen snapshot. The ping carries
 * no secret, so '*' is a safe target origin.
 */
export function installSnapshotFrameFreeze(): void {
  if (window.top === window) return;
  const pingType = snapshotFrameScrollPingType(browser.runtime.id);
  const baseline = { x: window.scrollX, y: window.scrollY };
  let pinged = false;
  let removed = false;

  const consume = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const ping = () => {
    if (pinged || removed) return;
    pinged = true;
    try {
      window.parent.postMessage({ type: pingType }, '*');
    } catch {
      // A detaching frame no longer affects the snapshot.
    }
  };
  const onScroll = (event: Event) => {
    // Element scrolls always shift pixels; a window-level scroll event only
    // matters when the scroll offset actually moved off the frozen baseline.
    if (event.target === document && window.scrollX === baseline.x && window.scrollY === baseline.y) return;
    ping();
  };
  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type !== pingType) return;
    if (!findIframeForWindow(event.source)) return;
    ping();
  };
  const onStop = (message: FrameTrailStopMessage) => {
    if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
  };
  const cleanup = () => {
    if (removed) return;
    removed = true;
    for (const type of SNAPSHOT_FREEZE_EVENTS) window.removeEventListener(type, consume, { capture: true });
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', ping);
    window.removeEventListener('message', onMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
  };

  for (const type of SNAPSHOT_FREEZE_EVENTS) window.addEventListener(type, consume, { capture: true, passive: false });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', ping, { passive: true });
  window.addEventListener('message', onMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);
}

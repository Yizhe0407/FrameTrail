import { browser } from 'wxt/browser';
import { startKeepAlive } from '@/lib/keep-alive';
import {
  buildSnapshotTargetIdentity,
  deepElementFromPoint,
  findVisualTargetCandidates,
  getComposedParent,
  getHighlightBounds,
  getVisibleHighlightBounds,
  intersectBounds,
  isInteractiveElement,
  isElementVisuallyUnavailable,
  selectVisualTargetCandidate,
} from '@/lib/selector-utils';
import { createSnapshotShield, type SnapshotShield } from '@/lib/snapshot-shield';
import { createStepPreview, type StepPreview } from '@/lib/step-preview';
import { orchestrateStepCapture, type ScrollSnapshot } from '@/lib/step-capture';
import {
  isInScrollableElementGutter,
  isInScrollbarGutter,
  isMatchingSnapshotViewport,
  isPointInsideViewport,
} from '@/lib/recording-guards';
import {
  SNAPSHOT_KEYBOARD_LABEL_LIMIT,
  SNAPSHOT_TARGET_OFFSET_LIMIT,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldPreviewResult,
  type SnapshotShieldRect,
  type SnapshotShieldRegionCaptureMessage,
  type SnapshotShieldSelection,
  type SnapshotShieldControlMessage,
} from '@/lib/snapshot-shield-protocol';
import { featureFlags } from '@/lib/feature-flags';
import { orderKeyboardCandidates, type RawKeyboardCandidate } from '@/lib/snapshot-candidates';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage';
import { createFrameCoordinateMapper } from '@/lib/frame-geometry';
import {
  childFrameProbeTimeout,
  classifyFrameProbeOutcome,
  createFrameProbeRateLimiter,
  createLatestAsyncRequestRunner,
  isExplicitFrameProbeFallback,
  resolveFrameProbeTargetOrigin,
} from '@/lib/frame-probe';
import { createImageCoordinateMapper } from '@/lib/image-geometry';
import {
  createRegionCapture,
  isRegionRectInsideViewport,
  type RegionCapture,
} from '@/lib/region-capture';
import { mountRecordingToolbar, type MountedRecordingToolbar } from '@/lib/recording-toolbar-host';
import {
  isClickCaptureResult,
  isRecordingControlResult,
  isRuntimeBoolean,
  isStepRecaptureTargetResult,
  requireRuntimeMessageResult,
} from '@/lib/runtime-message-result';
import type {
  ClickCapture,
  ClickCaptureResult,
  FrameTrailRecaptureTargetMessage,
  FrameTrailSnapshotActiveMessage,
  FrameTrailStopMessage,
  RecordingControlMessage,
  RecordingControlResult,
  RecordingState,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
  StepRecaptureContext,
  StepRecaptureTargetResult,
} from '@/lib/messages';

const CLEANUP_EVENT = `frame_trail_cleanup_${browser.runtime.id}`;
const INSTANCE_KEY = `__frame_trail_instance_${browser.runtime.id}`;
const DEDUP_MS = 400;
const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';
const KEEPALIVE_INTERVAL_MS = 20_000;
const FRAME_PROBE_MESSAGE = `frame_trail_snapshot_probe_${browser.runtime.id}`;
const FRAME_PROBE_TIMEOUT_MS = 120;
const FRAME_PROBE_CHILD_BUDGET_MS = 20;
const FRAME_PROBE_RETRY_DELAY_MS = 2_000;
const FRAME_PROBE_MAX_CONCURRENT_REQUESTS = 12;
const FRAME_PROBE_MAX_REQUESTS_PER_WINDOW = 720;
const FRAME_PROBE_RATE_WINDOW_MS = 10_000;
// Only a genuinely hung capture should hit this; normal-latency captures (even
// throttled) settle well under it, so they never lose the race to the replay.
const CAPTURE_FAILSAFE_MS = 2_000;
const LATE_CLICK_SUPPRESS_MS = 2_000;
const STEP_PREVIEW_FALLBACK_MS = 750;
const timedOutFrameProbes = new WeakMap<HTMLIFrameElement, { runId: string; retryAt: number }>();

const SNAPSHOT_FREEZE_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'submit',
  'keydown',
  'keyup',
  'beforeinput',
  'wheel',
  'touchmove',
] as const;

const STEP_FOLLOWUP_EVENTS = [
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
] as const;

function isOutOfViewport(rect: { x: number; y: number; width: number; height: number }): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return rect.y < 0 || rect.x < 0 || bottom > window.innerHeight || right > window.innerWidth;
}

function isScrollableElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const overflowX = style.overflowX || style.overflow;
  const overflowY = style.overflowY || style.overflow;
  return (
    (['auto', 'scroll', 'overlay'].includes(overflowX) && element.scrollWidth > element.clientWidth) ||
    (['auto', 'scroll', 'overlay'].includes(overflowY) && element.scrollHeight > element.clientHeight)
  );
}

function getScrollableAncestors(target: Element): Element[] {
  const ancestors: Element[] = [];
  let ancestor = getComposedParent(target);
  while (ancestor) {
    if (isScrollableElement(ancestor)) ancestors.push(ancestor);
    ancestor = getComposedParent(ancestor);
  }
  return ancestors;
}

function readScrollSnapshot(target: Element): ScrollSnapshot {
  return {
    x: window.scrollX,
    y: window.scrollY,
    containers: getScrollableAncestors(target).map((element) => ({
      element,
      x: element.scrollLeft,
      y: element.scrollTop,
    })),
  };
}

function snapshotRectKey(rect: SnapshotShieldRect): string {
  return [rect.x, rect.y, rect.width, rect.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

function getSnapshotTargetBounds(
  el: Element,
  clientX: number,
  clientY: number,
): SnapshotShieldRect | null {
  return getVisibleHighlightBounds(el, clientX, clientY);
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function getVisibleText(el: Element): string {
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  const lines = text?.split('\n') ?? [];
  return (lines.find((line) => line.trim().length > 0)?.trim() ?? '').slice(0, 80);
}

function getFieldLabel(el: Element): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return '';
  }
  return el.labels?.[0]?.innerText?.trim() || el.getAttribute('placeholder')?.trim() || '';
}

function describeElement(el: Element): string {
  return (
    el.getAttribute('aria-label')?.trim() ||
    getFieldLabel(el) ||
    getVisibleText(el) ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('alt')?.trim() ||
    ''
  ).slice(0, 200);
}

const KEYBOARD_CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[role]',
  '[tabindex]',
  '[contenteditable]',
].join(',');

/**
 * Enumerates top-frame annotation candidates for keyboard traversal (§9.5).
 * The page is frozen while annotating, so this runs once. Ordering, dedup and
 * capping are delegated to the pure helper; cross-frame candidates are out of
 * scope for this flag-gated first pass and remain pointer-reachable.
 */
function collectKeyboardCandidateAnchors(): SnapshotShieldKeyboardAnchor[] {
  const raw: RawKeyboardCandidate[] = [];
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll(KEYBOARD_CANDIDATE_SELECTOR)) {
    if (seen.has(el) || !isInteractiveElement(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    raw.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      label: (describeElement(el) || el.tagName.toLowerCase()).slice(0, SNAPSHOT_KEYBOARD_LABEL_LIMIT),
    });
  }
  return orderKeyboardCandidates(raw, window.innerWidth, window.innerHeight);
}

function replayElementClick(el: Element): void {
  const focus = (el as Element & { focus?: (options?: FocusOptions) => void }).focus;
  focus?.call(el, { preventScroll: true });
  const click = (el as Element & { click?: () => void }).click;
  if (typeof click === 'function') {
    click.call(el);
    return;
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
}

interface SnapshotProbeResult {
  rect: SnapshotShieldRect;
  identity: string;
  text: string;
  tagName: string;
  candidateOffset: number;
}

interface ResolvedSnapshotTarget extends SnapshotProbeResult {
  element?: Element;
}

interface SnapshotProbeRequest {
  type: typeof FRAME_PROBE_MESSAGE;
  runId: string;
  timeoutMs: number;
  clientX: number;
  clientY: number;
  candidateOffset: number;
}

function isSnapshotProbeResult(value: unknown): value is SnapshotProbeResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<SnapshotProbeResult>;
  const rect = result.rect;
  return (
    Boolean(rect) &&
    Number.isFinite(rect!.x) &&
    Number.isFinite(rect!.y) &&
    Number.isFinite(rect!.width) &&
    Number.isFinite(rect!.height) &&
    rect!.width > 0 &&
    rect!.height > 0 &&
    typeof result.identity === 'string' &&
    result.identity.length > 0 &&
    result.identity.length <= 4_096 &&
    typeof result.text === 'string' &&
    result.text.length <= 200 &&
    typeof result.tagName === 'string' &&
    result.tagName.length > 0 &&
    result.tagName.length <= 100 &&
    Number.isSafeInteger(result.candidateOffset) &&
    Math.abs(result.candidateOffset!) <= SNAPSHOT_TARGET_OFFSET_LIMIT
  );
}

function resolvedElement(
  el: Element,
  rect: SnapshotShieldRect | null,
  candidateOffset = 0,
): ResolvedSnapshotTarget | null {
  if (!rect) return null;
  return {
    element: el,
    rect,
    identity: buildSnapshotTargetIdentity(el),
    text: describeElement(el),
    tagName: el.tagName.toLowerCase(),
    candidateOffset,
  };
}

function pointInPolygon(x: number, y: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[previous];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1) + xi) inside = !inside;
  }
  return inside;
}

function resolveImageMapTarget(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): ResolvedSnapshotTarget | null {
  const mapName = image.useMap.replace(/^#/, '');
  if (!mapName) return null;
  const map = Array.from(document.querySelectorAll('map')).find(
    (candidate) => (candidate as HTMLMapElement).name === mapName,
  ) as HTMLMapElement | undefined;
  const imageRect = image.getBoundingClientRect();
  if (!map || imageRect.width <= 0 || imageRect.height <= 0) return null;
  const sourceWidth = image.naturalWidth || imageRect.width;
  const sourceHeight = image.naturalHeight || imageRect.height;
  const mapper = createImageCoordinateMapper(image, sourceWidth, sourceHeight);
  if (!mapper) return null;
  const { x, y } = mapper.toSourcePoint(clientX, clientY);
  if (x < 0 || y < 0 || x > sourceWidth || y > sourceHeight) return null;

  for (const area of Array.from(map.areas) as HTMLAreaElement[]) {
    if (!isInteractiveElement(area)) continue;
    const coords = area.coords.split(',').map(Number).filter(Number.isFinite);
    const shape = area.shape.toLowerCase();
    let contains = shape === 'default';
    let sourceBounds = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    if (shape === 'rect' && coords.length >= 4) {
      const [left, top, right, bottom] = coords;
      contains = x >= left && x <= right && y >= top && y <= bottom;
      sourceBounds = { x: left, y: top, width: right - left, height: bottom - top };
    } else if (shape === 'circle' && coords.length >= 3) {
      const [cx, cy, radius] = coords;
      contains = Math.hypot(x - cx, y - cy) <= radius;
      sourceBounds = { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 };
    } else if (shape === 'poly' && coords.length >= 6) {
      const points = Array.from({ length: Math.floor(coords.length / 2) }, (_, index) => [
        coords[index * 2],
        coords[index * 2 + 1],
      ] as [number, number]);
      contains = pointInPolygon(x, y, points);
      const xs = points.map(([pointX]) => pointX);
      const ys = points.map(([, pointY]) => pointY);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      sourceBounds = { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }
    if (!contains || sourceBounds.width <= 0 || sourceBounds.height <= 0) continue;

    const areaBounds = mapper.toViewportBounds(sourceBounds);
    const visibleImage = getVisibleHighlightBounds(image, clientX, clientY);
    const visibleContent = visibleImage && intersectBounds(mapper.contentBounds, visibleImage);
    const visibleArea = visibleContent && intersectBounds(areaBounds, visibleContent);
    return visibleArea ? resolvedElement(area, visibleArea) : null;
  }
  return null;
}

function imageForArea(area: HTMLAreaElement): HTMLImageElement | null {
  const map = area.closest('map');
  const mapName = map?.getAttribute('name');
  if (!mapName) return null;
  const normalizedName = mapName.toLowerCase();
  return (
    Array.from(document.images).find(
      (image) => image.useMap.replace(/^#/, '').toLowerCase() === normalizedName,
    ) ?? null
  );
}

async function probeChildFrame(
  frame: HTMLIFrameElement,
  runId: string,
  clientX: number,
  clientY: number,
  timeoutMs: number,
  candidateOffset: number,
): Promise<ResolvedSnapshotTarget | null> {
  if (!frame.contentWindow || isElementVisuallyUnavailable(frame)) return null;
  const visibleFrame = getVisibleHighlightBounds(frame, clientX, clientY);
  const mapper = createFrameCoordinateMapper(frame);
  if (!visibleFrame || !mapper) return null;
  if (timeoutMs <= 0) return resolvedElement(frame, visibleFrame);
  const timedOutProbe = timedOutFrameProbes.get(frame);
  if (timedOutProbe?.runId === runId && timedOutProbe.retryAt > Date.now()) {
    return resolvedElement(frame, visibleFrame);
  }

  const targetOrigin = resolveFrameProbeTargetOrigin(
    frame.getAttribute('src'),
    document.baseURI,
    {
      hasSrcdoc: frame.hasAttribute('srcdoc'),
      opaqueSandbox: frame.hasAttribute('sandbox') && !frame.sandbox.contains('allow-same-origin'),
    },
  );
  if (!targetOrigin) return resolvedElement(frame, visibleFrame);

  const channel = new MessageChannel();
  let responseTimeout: ReturnType<typeof setTimeout> | null = null;
  let settleResponse = (_result: { child: SnapshotProbeResult | null; timedOut: boolean }): void => {};
  const response = new Promise<{ child: SnapshotProbeResult | null; timedOut: boolean }>((resolve) => {
    settleResponse = resolve;
    responseTimeout = setTimeout(() => {
      channel.port1.close();
      resolve({ child: null, timedOut: true });
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      if (responseTimeout) clearTimeout(responseTimeout);
      channel.port1.close();
      resolve({
        child: isSnapshotProbeResult(event.data) ? event.data : null,
        timedOut: isExplicitFrameProbeFallback(event.data),
      });
    };
    channel.port1.start();
  });
  const childPoint = mapper.toChildPoint({ x: clientX, y: clientY });
  const request: SnapshotProbeRequest = {
    type: FRAME_PROBE_MESSAGE,
    runId,
    timeoutMs: childFrameProbeTimeout(timeoutMs, FRAME_PROBE_CHILD_BUDGET_MS),
    clientX: childPoint.x,
    clientY: childPoint.y,
    candidateOffset,
  };
  try {
    frame.contentWindow.postMessage(request, targetOrigin, [channel.port2]);
  } catch {
    if (responseTimeout) clearTimeout(responseTimeout);
    channel.port1.close();
    settleResponse({ child: null, timedOut: true });
    timedOutFrameProbes.set(frame, { runId, retryAt: Date.now() + FRAME_PROBE_RETRY_DELAY_MS });
    return resolvedElement(frame, visibleFrame);
  }
  const { child: probeTarget, timedOut } = await response;
  const outcome = classifyFrameProbeOutcome(probeTarget, timedOut);
  if (outcome.kind === 'fallback') {
    timedOutFrameProbes.set(frame, { runId, retryAt: Date.now() + FRAME_PROBE_RETRY_DELAY_MS });
    return resolvedElement(frame, visibleFrame);
  }
  timedOutFrameProbes.delete(frame);
  if (outcome.kind === 'empty') return null;

  const child = outcome.target;
  const mapped = mapper.toParentBounds(child.rect);
  const rect = intersectBounds(mapped, visibleFrame);
  return rect
    ? {
        rect,
        identity: `${buildSnapshotTargetIdentity(frame)}::frame::${child.identity}`,
        text: child.text,
        tagName: child.tagName,
        candidateOffset: child.candidateOffset,
      }
    : null;
}

async function resolveSnapshotTargetAtPoint(
  runId: string,
  clientX: number,
  clientY: number,
  candidateOffset = 0,
  frameProbeTimeoutMs = FRAME_PROBE_TIMEOUT_MS,
): Promise<ResolvedSnapshotTarget | null> {
  if (clientX < 0 || clientY < 0 || clientX >= window.innerWidth || clientY >= window.innerHeight) return null;
  const hit = deepElementFromPoint(clientX, clientY);
  if (!hit) return null;
  if (hit instanceof HTMLIFrameElement) {
    return probeChildFrame(hit, runId, clientX, clientY, frameProbeTimeoutMs, candidateOffset);
  }
  if (hit instanceof HTMLAreaElement) {
    const image = imageForArea(hit);
    if (image) return resolveImageMapTarget(image, clientX, clientY);
  }
  if (hit instanceof HTMLImageElement && hit.useMap) {
    const area = resolveImageMapTarget(hit, clientX, clientY);
    if (area) return area;
  }

  const targets = findVisualTargetCandidates(hit, clientX, clientY);
  const selected = selectVisualTargetCandidate(targets, candidateOffset);
  return selected
    ? resolvedElement(
        selected.element,
        getSnapshotTargetBounds(selected.element, clientX, clientY),
        selected.candidateOffset,
      )
    : null;
}

function installSnapshotFrameProbe(runId: string): void {
  const admission = createFrameProbeRateLimiter({
    maxConcurrent: FRAME_PROBE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: FRAME_PROBE_MAX_REQUESTS_PER_WINDOW,
    windowMs: FRAME_PROBE_RATE_WINDOW_MS,
  });
  const closePort = (port: MessagePort | undefined) => {
    try {
      port?.close();
    } catch {
      // The sender can detach or close a transferred port before validation.
    }
  };
  const onMessage = (event: MessageEvent) => {
    const request = event.data as Partial<SnapshotProbeRequest> | null;
    const port = event.ports[0];
    if (
      event.source !== parent ||
      !port ||
      request?.type !== FRAME_PROBE_MESSAGE ||
      request.runId !== runId ||
      !Number.isFinite(request.timeoutMs) ||
      request.timeoutMs! < 0 ||
      request.timeoutMs! > FRAME_PROBE_TIMEOUT_MS ||
      !Number.isFinite(request.clientX) ||
      !Number.isFinite(request.clientY) ||
      !Number.isSafeInteger(request.candidateOffset) ||
      Math.abs(request.candidateOffset!) > SNAPSHOT_TARGET_OFFSET_LIMIT
    ) {
      closePort(port);
      return;
    }
    const release = admission.tryAcquire();
    if (!release) {
      try {
        // An explicit fallback response closes the transferred port immediately
        // instead of forcing the parent to retain it until the transport timeout.
        port.postMessage({ fallback: true });
      } catch {
        // The sender may already have abandoned the request.
      } finally {
        closePort(port);
      }
      return;
    }
    void (async () => {
      let response: SnapshotProbeResult | null = null;
      try {
        const target = await resolveSnapshotTargetAtPoint(
          runId,
          request.clientX!,
          request.clientY!,
          request.candidateOffset!,
          request.timeoutMs!,
        );
        response = target
          ? {
              rect: target.rect,
              identity: target.identity,
              text: target.text,
              tagName: target.tagName,
              candidateOffset: target.candidateOffset,
            }
          : null;
      } catch (error) {
        console.error('[frametrail] child frame probe failed', error);
      }
      try {
        port.postMessage(response);
      } catch (error) {
        console.warn('[frametrail] child frame probe response channel closed', error);
      } finally {
        release();
        closePort(port);
      }
    })();
  };
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
  };
  const onStop = (message: FrameTrailStopMessage) => {
    if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
  };
  window.addEventListener('message', onMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);
}

function createRecaptureToolbar(onCancel: () => void): { host: HTMLElement; remove(): void } {
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-recording-toolbar', '');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '16px', 'important');
  host.style.setProperty('left', '50%', 'important');
  host.style.setProperty('transform', 'translateX(-50%)', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'status');
  wrapper.style.cssText = [
    'all:initial',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:10px 12px',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:12px',
    'background:#111827',
    'box-shadow:0 12px 32px rgba(0,0,0,.35)',
    'color:#f9fafb',
    'font:600 14px/1.3 system-ui,sans-serif',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = '請選取要補拍的目標（Esc 取消）';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.style.cssText = [
    'all:initial',
    'cursor:pointer',
    'padding:7px 10px',
    'border-radius:8px',
    'background:#374151',
    'color:#fff',
    'font:600 14px/1 system-ui,sans-serif',
  ].join(';');
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  });
  wrapper.append(label, cancel);
  root.append(wrapper);
  document.documentElement.append(host);
  return { host, remove: () => host.remove() };
}

async function installRecaptureRecorder(context: StepRecaptureContext): Promise<void> {
  const runId = context.runId;
  let active = false;
  let busy = false;
  let removed = false;
  let hoverVersion = 0;

  const preview = createStepPreview();
  const keepAlive = startKeepAlive(browser.runtime, {
    name: KEEPALIVE_PORT_NAME,
    intervalMs: KEEPALIVE_INTERVAL_MS,
  });

  const cancelWorkflow = () => {
    if (removed) return;
    void browser.runtime.sendMessage({ type: 'CANCEL_STEP_RECAPTURE', runId }).catch((error) => {
      console.error('[frametrail] failed to cancel recapture', error);
    });
  };
  const toolbar = createRecaptureToolbar(cancelWorkflow);

  const hoverProbe = createLatestAsyncRequestRunner(
    async (point: { clientX: number; clientY: number; version: number }) => {
      if (removed || !active || busy) return;
      const target = await resolveSnapshotTargetAtPoint(runId, point.clientX, point.clientY);
      if (removed || !active || busy || point.version !== hoverVersion) return;
      if (target) preview.show(target.rect);
      else preview.hide();
    },
    (error) => {
      if (!removed && active) preview.hide();
      console.warn('[frametrail] failed to preview recapture target', error);
    },
  );

  const onPointerMove = (event: PointerEvent) => {
    if (!active || busy || toolbar.host === event.target || toolbar.host.contains(event.target as Node)) return;
    hoverProbe.submit({
      clientX: event.clientX,
      clientY: event.clientY,
      version: ++hoverVersion,
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.composedPath().includes(toolbar.host)) return;
    if (isInScrollbarGutter(event.clientX, event.clientY, document.documentElement)) return;
    const hit = deepElementFromPoint(event.clientX, event.clientY);
    let gutterAncestor = hit;
    while (gutterAncestor) {
      if (isInScrollableElementGutter(event.clientX, event.clientY, gutterAncestor)) return;
      gutterAncestor = getComposedParent(gutterAncestor);
    }
    if (!active || busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // This gesture only selects a capture target. It is never replayed into the
    // page, regardless of success, cancellation or screenshot failure.
    event.preventDefault();
    event.stopImmediatePropagation();
    busy = true;
    hoverVersion++;
    hoverProbe.clearPending();
    const clientX = event.clientX;
    const clientY = event.clientY;
    void (async () => {
      const target = await resolveSnapshotTargetAtPoint(runId, clientX, clientY);
      if (!target || removed) {
        busy = false;
        return;
      }
      await preview.prepareForCapture();
      if (removed) return;
      const captureId = crypto.randomUUID();
      const payload: FrameTrailRecaptureTargetMessage = {
        type: 'FRAME_TRAIL_RECAPTURE_TARGET',
        runId,
        captureId,
        rect: target.rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        devicePixelRatio: window.devicePixelRatio,
        url: location.href,
        timestamp: Date.now(),
      };
      try {
        const result = requireRuntimeMessageResult<StepRecaptureTargetResult>(
          await browser.runtime.sendMessage(payload),
          isStepRecaptureTargetResult,
          '補拍服務回應格式無效，請重新整理頁面後再試一次。',
        );
        if (!result.ok && result.status === 'rejected' && !removed) {
          busy = false;
          preview.show(target.rect);
        }
      } catch (error) {
        console.error('[frametrail] recapture target failed', error);
        cancelWorkflow();
      }
    })();
  };

  const onFollowup = (event: Event) => {
    if (!busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelWorkflow();
  };
  let unsubscribe = () => {};
  const onStop = (message: FrameTrailStopMessage) => {
    if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
  };
  function cleanup() {
    if (removed) return;
    removed = true;
    active = false;
    hoverProbe.clearPending();
    preview.remove();
    toolbar.remove();
    window.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    for (const type of STEP_FOLLOWUP_EVENTS) document.removeEventListener(type, onFollowup, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
    unsubscribe();
    keepAlive.stop();
  }
  unsubscribe = onRecordingStateChange((state) => {
    if (state.operation !== 'recapture' || state.recapture?.runId !== runId) cleanup();
    else {
      active = state.recapture.phase === 'awaiting-target';
      if (!active) {
        hoverVersion += 1;
        hoverProbe.clearPending();
        preview.hide();
      }
    }
  });

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);

  let ready = false;
  try {
    ready = requireRuntimeMessageResult(
      await browser.runtime.sendMessage({
        type: 'FRAME_TRAIL_RECAPTURE_READY',
        runId,
        url: location.href,
      }),
      isRuntimeBoolean,
      '補拍服務回應格式無效，請重新整理頁面後再試一次。',
    );
  } catch (error) {
    console.error('[frametrail] recapture readiness check failed', error);
  }
  if (!ready || removed) {
    cleanup();
    return;
  }
  // The durable phase change may land immediately after the ready response.
  // Storage subscription is authoritative; this read closes the tiny gap when
  // the change event fired before the listener was installed.
  const latest = await getRecordingState();
  active = latest.operation === 'recapture' && latest.recapture?.runId === runId && latest.recapture.phase === 'awaiting-target';
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  async main() {
    // Concurrent executeScript calls can both dispatch cleanup before either
    // reaches its first await. The instance token makes only the latest one
    // eligible to install listeners after reading storage.
    document.dispatchEvent(new CustomEvent(CLEANUP_EVENT));
    const instanceId = crypto.randomUUID();
    const instanceHost = globalThis as unknown as Record<string, unknown>;
    instanceHost[INSTANCE_KEY] = instanceId;

    const recordingState = await getRecordingState();
    if (instanceHost[INSTANCE_KEY] !== instanceId) return;
    if (recordingState.operation === 'recapture' && recordingState.recapture) {
      if (window.top !== window) {
        installSnapshotFrameProbe(recordingState.recapture.runId);
        return;
      }
      await installRecaptureRecorder(recordingState.recapture);
      return;
    }
    if (recordingState.operation !== 'recording' || !recordingState.isRecording || !recordingState.runId) return;

    const runId = recordingState.runId;
    const isSnapshotMode = recordingState.mode === 'snapshot';
    const isStepMode = recordingState.mode === 'steps';
    const shouldFreezeSnapshot = isSnapshotMode && recordingState.phase !== 'preparing-next';
    if (isSnapshotMode && window.top !== window) {
      if (shouldFreezeSnapshot) installSnapshotFrameProbe(runId);
      return;
    }
    const snapshotViewportContract = recordingState.snapshotViewport ?? {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    const snapshotDevicePixelRatioContract = recordingState.snapshotDevicePixelRatio ?? window.devicePixelRatio;

    let lastTarget: Element | null = null;
    let lastTime = 0;
    let stepGesture: {
      target: Element;
      captureId: string;
      isCancelled: () => boolean;
      cancel: () => void;
      cancelled: Promise<void>;
    } | null = null;
    // While a capture is in flight the stored rect is pinned to this scroll
    // position, so the screenshot pixels always match it. Null when idle.
    let captureScrollLock: ScrollSnapshot | null = null;
    const lockedScrollElements = new Set<Element>();
    let suppressLateClickTarget: Element | null = null;
    let suppressLateClickUntil = 0;
    let snapshotAnnotationNumber = 0;
    let recorderPaused = recordingState.phase === 'paused';
    let snapshotShield: SnapshotShield | null = null;
    let manualRegionCapture: RegionCapture | null = null;
    let recordingToolbar: MountedRecordingToolbar | null = null;
    let snapshotInteractionsActive = false;
    let snapshotInvalidationSent = recordingState.phase === 'invalidated';
    let snapshotDprQuery: MediaQueryList | null = null;
    let stepPreview: StepPreview | null = null;
    let stepPreviewFrame: number | null = null;
    let stepPreviewPoint: { clientX: number; clientY: number } | null = null;
    let stepPreviewObserver: MutationObserver | null = null;
    let stepPreviewObservedTarget: Element | null = null;
    let stepPreviewFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const selectedSnapshotTargets = new Set<string>();
    const selectedSnapshotElements = new WeakSet<Element>();
    const selectedSnapshotRects = new Set<string>();
    const selectedSnapshotHistory: ResolvedSnapshotTarget[] = [];
    let undoneSnapshotTarget: ResolvedSnapshotTarget | null = null;

    const readSnapshotViewport = (): ClickCapture['viewport'] => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
    const notifySnapshotInvalidated = () => {
      if (!shouldFreezeSnapshot || !snapshotInteractionsActive || snapshotInvalidationSent) return;
      const viewport = readSnapshotViewport();
      if (
        isMatchingSnapshotViewport(
          snapshotViewportContract,
          snapshotDevicePixelRatioContract,
          viewport,
          window.devicePixelRatio,
        )
      ) {
        return;
      }
      snapshotInvalidationSent = true;
      snapshotInteractionsActive = false;
      void browser.runtime.sendMessage({
        type: 'SNAPSHOT_INVALIDATED',
        runId,
        viewport,
        devicePixelRatio: window.devicePixelRatio,
      } satisfies SnapshotInvalidatedMessage).catch((error) => {
        console.error('[frametrail] failed to invalidate changed snapshot viewport', error);
      });
    };
    const onSnapshotDprChange = () => {
      notifySnapshotInvalidated();
      snapshotDprQuery?.removeEventListener('change', onSnapshotDprChange);
      snapshotDprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      snapshotDprQuery.addEventListener('change', onSnapshotDprChange);
    };

    const beginStepGesture = (target: Element) => {
      let cancel!: () => void;
      let cancelledFlag = false;
      const cancelled = new Promise<void>((resolve) => {
        cancel = () => {
          cancelledFlag = true;
          resolve();
        };
      });
      stepGesture = { target, captureId: crypto.randomUUID(), isCancelled: () => cancelledFlag, cancel, cancelled };
      return stepGesture;
    };

    const shouldCaptureTarget = (el: Element, now: number) => {
      if (el === lastTarget && now - lastTime < DEDUP_MS) return;
      lastTarget = el;
      lastTime = now;
      return true;
    };

    const resolvePrimaryVisualTarget = (clientX: number, clientY: number): Element | null => {
      const hit = deepElementFromPoint(clientX, clientY);
      return hit
        ? selectVisualTargetCandidate(findVisualTargetCandidates(hit, clientX, clientY), 0)?.element ?? null
        : null;
    };

    const disconnectStepPreviewObserver = () => {
      stepPreviewObserver?.disconnect();
      stepPreviewObservedTarget = null;
    };

    const observeStepPreviewTarget = (target: Element | null) => {
      if (!stepPreviewObserver || target === stepPreviewObservedTarget) return;
      disconnectStepPreviewObserver();
      if (!target) return;

      const observedNodes = new Map<Node, MutationObserverInit>();
      const mergeOptions = (node: Node, options: MutationObserverInit) => {
        const current = observedNodes.get(node) ?? {};
        observedNodes.set(node, {
          childList: current.childList || options.childList,
          attributes: current.attributes || options.attributes,
          characterData: current.characterData || options.characterData,
          subtree: current.subtree || options.subtree,
          ...(current.attributes || options.attributes
            ? { attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] }
            : {}),
        });
      };

      // Observe content/style changes inside the selected target, direct child
      // replacement in its DOM parent, and only style-affecting attributes on
      // composed ancestors. Unrelated document subtrees produce no records.
      mergeOptions(target, { subtree: true, childList: true, attributes: true, characterData: true });
      if (target.parentNode) mergeOptions(target.parentNode, { childList: true });
      let ancestor = getComposedParent(target);
      while (ancestor) {
        // Direct child replacement on any composed ancestor can detach the
        // current target (for example a virtualized row replacing its wrapper).
        // This remains bounded to the ancestor chain; no document subtree is
        // observed.
        mergeOptions(ancestor, { attributes: true, childList: true });
        ancestor = getComposedParent(ancestor);
      }
      for (const [node, options] of observedNodes) stepPreviewObserver.observe(node, options);
      stepPreviewObservedTarget = target;
    };

    const stopStepPreviewFallback = () => {
      if (stepPreviewFallbackTimer !== null) clearTimeout(stepPreviewFallbackTimer);
      stepPreviewFallbackTimer = null;
    };

    const armStepPreviewFallback = () => {
      if (recorderPaused || !stepPreview || !stepPreviewPoint || stepGesture || stepPreviewFallbackTimer !== null) return;
      stepPreviewFallbackTimer = setTimeout(() => {
        stepPreviewFallbackTimer = null;
        scheduleStepPreview();
        armStepPreviewFallback();
      }, STEP_PREVIEW_FALLBACK_MS);
    };

    const renderStepPreview = () => {
      stepPreviewFrame = null;
      if (recorderPaused || !stepPreview || !stepPreviewPoint || stepGesture) {
        disconnectStepPreviewObserver();
        stepPreview?.hide();
        return;
      }
      const { clientX, clientY } = stepPreviewPoint;
      const target = resolvePrimaryVisualTarget(clientX, clientY);
      const bounds = target ? getVisibleHighlightBounds(target, clientX, clientY) : null;
      observeStepPreviewTarget(target);
      if (bounds) stepPreview.show(bounds);
      else stepPreview.hide();
      armStepPreviewFallback();
    };

    const scheduleStepPreview = () => {
      if (!stepPreview || !stepPreviewPoint || stepGesture || stepPreviewFrame !== null) return;
      stepPreviewFrame = requestAnimationFrame(renderStepPreview);
    };

    const suspendStepPreview = () => {
      if (stepPreviewFrame !== null) cancelAnimationFrame(stepPreviewFrame);
      stepPreviewFrame = null;
      disconnectStepPreviewObserver();
      stopStepPreviewFallback();
      stepPreview?.hide();
    };

    const onStepScroll = () => {
      // A queued capture is pinned to one viewport and every nested scrollport.
      // Snap any user scroll back so the eventual screenshot pixels still match
      // the stored rect; otherwise fall through to refresh the hover preview.
      if (captureScrollLock) {
        let changed = window.scrollX !== captureScrollLock.x || window.scrollY !== captureScrollLock.y;
        if (changed) window.scrollTo(captureScrollLock.x, captureScrollLock.y);
        for (const container of captureScrollLock.containers ?? []) {
          if (container.element.scrollLeft !== container.x || container.element.scrollTop !== container.y) {
            container.element.scrollLeft = container.x;
            container.element.scrollTop = container.y;
            changed = true;
          }
        }
        if (changed) return;
      }
      scheduleStepPreview();
    };

    const setCaptureScrollLock = (lock: ScrollSnapshot | null) => {
      for (const element of lockedScrollElements) {
        element.removeEventListener('scroll', onStepScroll);
      }
      lockedScrollElements.clear();
      captureScrollLock = lock;
      for (const container of lock?.containers ?? []) {
        container.element.addEventListener('scroll', onStepScroll, { passive: true });
        lockedScrollElements.add(container.element);
      }
    };

    const onStepPointerMove = (event: PointerEvent) => {
      if (recorderPaused || manualRegionCapture?.isActive()) return;
      stepPreviewPoint = { clientX: event.clientX, clientY: event.clientY };
      scheduleStepPreview();
      armStepPreviewFallback();
    };

    const onStepPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget) return;
      if (
        isPointInsideViewport(event.clientX, event.clientY, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      ) {
        // Virtualized pages can detach the old target during scroll and emit a
        // null-relatedTarget pointerout even though the cursor never left the
        // viewport. Keep the point and resolve whatever moved underneath it.
        scheduleStepPreview();
        return;
      }
      stepPreviewPoint = null;
      suspendStepPreview();
    };

    const onStepPointerLeave = (event: PointerEvent) => {
      if (event.relatedTarget) return;
      stepPreviewPoint = null;
      suspendStepPreview();
    };

    const sendCapture = async (
      rect: SnapshotShieldRect,
      target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
      intent: ClickCapture['intent'],
      now: number,
      captureId: string = crypto.randomUUID(),
      captureKind: ClickCapture['captureKind'] = 'element',
    ): Promise<boolean> => {
      const payload: ClickCapture = {
        type: 'FRAME_TRAIL_CLICK',
        captureKind,
        captureId,
        runId,
        rect,
        devicePixelRatio: window.devicePixelRatio,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        text: target.text,
        tagName: target.tagName,
        intent,
        url: location.href,
        timestamp: now,
      };
      const result = requireRuntimeMessageResult<ClickCaptureResult>(
        await browser.runtime.sendMessage(payload),
        isClickCaptureResult,
        '截圖服務回應格式無效，請重新整理頁面後再試一次。',
      );
      if (result.ok) return true;
      console.warn('[frametrail] step was not captured');
      return false;
    };

    const startStepRegionCapture = () => {
      if (!isStepMode || recorderPaused || stepGesture || manualRegionCapture?.isActive()) return;
      suspendStepPreview();
      const captureId = crypto.randomUUID();
      let captureSent = false;
      const origin: ScrollSnapshot = { x: window.scrollX, y: window.scrollY, containers: [] };
      setCaptureScrollLock(origin);

      const controller = createRegionCapture({
        onCapture: async (rect) => {
          captureSent = true;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const outcome = await Promise.race([
            sendCapture(
              rect,
              { text: '', tagName: 'region' },
              'mark',
              Date.now(),
              captureId,
              'region',
            ).then((saved) => ({ kind: 'settled' as const, saved })),
            new Promise<{ kind: 'timeout'; saved: false }>((resolve) => {
              timeout = setTimeout(() => resolve({ kind: 'timeout', saved: false }), CAPTURE_FAILSAFE_MS);
            }),
          ]);
          if (timeout) clearTimeout(timeout);
          if (outcome.kind === 'timeout') {
            await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId, captureId });
            console.warn('[frametrail] region capture exceeded its failsafe budget and was cancelled');
          }
        },
        onCancel: async () => {
          if (!captureSent) return;
          await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId, captureId });
        },
        onClose: () => {
          if (manualRegionCapture === controller) manualRegionCapture = null;
          setCaptureScrollLock(null);
          recordingToolbar?.setRegionCaptureActive(false);
          scheduleStepPreview();
        },
      });
      manualRegionCapture = controller;
      recordingToolbar?.setRegionCaptureActive(true);
    };

    const captureElement = async (
      el: Element,
      initialClientX: number,
      initialClientY: number,
      intent: ClickCapture['intent'],
      now: number,
      captureId: string,
      shouldCancel: () => boolean,
    ): Promise<boolean> => {
      try {
        let clientX = initialClientX;
        let clientY = initialClientY;
        let rect = getHighlightBounds(el, clientX, clientY);
        if (!rect) return false;

        if (isStepMode && isOutOfViewport(rect)) {
          const before = el.getBoundingClientRect();
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          await waitForNextFrame();
          if (shouldCancel()) return false;
          const after = el.getBoundingClientRect();
          clientX += after.left - before.left;
          clientY += after.top - before.top;
          rect = getHighlightBounds(el, clientX, clientY);
          if (!rect) return false;
        }
        rect = getVisibleHighlightBounds(el, clientX, clientY);
        if (!rect) return false;
        if (shouldCancel()) return false;

        // Pin scrolling from here until the screenshot actually lands so nothing
        // shifts the pixels out from under this rect (auto-scroll included).
        setCaptureScrollLock(readScrollSnapshot(el));
        return sendCapture(
          rect,
          { text: describeElement(el), tagName: el.tagName.toLowerCase() },
          intent,
          now,
          captureId,
        );
      } catch (err) {
        console.error('[frametrail] sendMessage failed', err);
        return false;
      }
    };

    const onPointerDown = async (event: Event) => {
      const pe = event as PointerEvent;
      if (pe.button !== 0 || !pe.isPrimary) return;
      if (recorderPaused || manualRegionCapture?.isActive()) return;
      if (pe.target instanceof Element && pe.target.closest('[data-frametrail-recording-toolbar]')) return;

      // A pointerdown in a native scrollbar gutter is a scroll gesture, not a
      // step: leave it untouched so the drag scrolls and no bogus step lands.
      if (isInScrollbarGutter(pe.clientX, pe.clientY, document.documentElement)) return;
      const pointTarget = deepElementFromPoint(pe.clientX, pe.clientY);
      let gutterAncestor = pointTarget;
      while (gutterAncestor) {
        if (isInScrollableElementGutter(pe.clientX, pe.clientY, gutterAncestor)) return;
        gutterAncestor = getComposedParent(gutterAncestor);
      }

      const el = resolvePrimaryVisualTarget(pe.clientX, pe.clientY);
      if (!el) return;
      if (stepGesture) {
        // A capture is still in flight; swallow the gesture so it cannot mutate
        // the page before that screenshot lands.
        pe.preventDefault();
        pe.stopImmediatePropagation();
        return;
      }

      const now = Date.now();
      if (!shouldCaptureTarget(el, now)) return;
      suspendStepPreview();

      // Event dispatch never waits for an async listener. Stop the original
      // gesture synchronously; it is replayed only after capture finishes.
      pe.preventDefault();
      pe.stopImmediatePropagation();
      const gesture = beginStepGesture(el);

      const outcome = await orchestrateStepCapture({
        failsafeMs: CAPTURE_FAILSAFE_MS,
        cancelled: gesture.cancelled,
        readScroll: () => readScrollSnapshot(el),
        hidePreview: () => stepPreview?.prepareForCapture() ?? Promise.resolve(),
        capture: () =>
          captureElement(
            el,
            pe.clientX,
            pe.clientY,
            isInteractiveElement(el) ? 'click' : 'mark',
            now,
            gesture.captureId,
            gesture.isCancelled,
          ),
        cancelCapture: async () => {
          gesture.cancel();
          await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId, captureId: gesture.captureId });
        },
        endGesture: () => {
          // Capture window closed: stop swallowing page events. The scroll pin
          // stays installed until restoreScroll has copied every ancestor back.
          if (stepGesture === gesture) stepGesture = null;
        },
        restoreScroll: (origin) => {
          setCaptureScrollLock(null);
          if (window.scrollX !== origin.x || window.scrollY !== origin.y) {
            window.scrollTo(origin.x, origin.y);
          }
          for (const container of origin.containers ?? []) {
            container.element.scrollLeft = container.x;
            container.element.scrollTop = container.y;
          }
        },
        replay: () => {
          if (!el.isConnected) return;
          // A trailing trusted click can still arrive after the gesture cleared;
          // suppress it so the page handler runs exactly once — from this replay.
          suppressLateClickTarget = el;
          suppressLateClickUntil = Date.now() + LATE_CLICK_SUPPRESS_MS;
          // click() preserves control/default behavior and bubbling page click
          // handlers, but intentionally runs only after the screenshot.
          replayElementClick(el);
        },
        resumePreview: () => scheduleStepPreview(),
      });

      if (outcome === 'timeout') {
        console.warn('[frametrail] capture exceeded its failsafe budget; invalidated it before replaying the click');
      }
    };

    const onSnapshotHover = async (
      point: SnapshotShieldPointerMoveMessage,
    ): Promise<SnapshotShieldPreviewResult> => {
      const shield = snapshotShield;
      if (!shield || !snapshotInteractionsActive) {
        return { rect: null, candidateOffset: point.candidateOffset };
      }
      const target = await shield.runWithoutShield(() =>
        resolveSnapshotTargetAtPoint(runId, point.clientX, point.clientY, point.candidateOffset),
      );
      if (
        !snapshotInteractionsActive ||
        !target ||
        (target.element ? selectedSnapshotElements.has(target.element) : false) ||
        selectedSnapshotTargets.has(target.identity) ||
        selectedSnapshotRects.has(snapshotRectKey(target.rect))
      ) {
        return {
          rect: null,
          candidateOffset: target?.candidateOffset ?? point.candidateOffset,
        };
      }
      return { rect: target.rect, candidateOffset: target.candidateOffset };
    };

    const onSnapshotPoint = async (
      point: SnapshotShieldPointerDownMessage,
    ): Promise<SnapshotShieldSelection | null> => {
      const shield = snapshotShield;
      if (!shield || !snapshotInteractionsActive) return null;
      const target = await shield.runWithoutShield(() =>
        resolveSnapshotTargetAtPoint(runId, point.clientX, point.clientY, point.candidateOffset),
      );
      const now = Date.now();
      if (!snapshotInteractionsActive || !target) return null;
      if (
        (target.element ? selectedSnapshotElements.has(target.element) : false) ||
        selectedSnapshotTargets.has(target.identity) ||
        selectedSnapshotRects.has(snapshotRectKey(target.rect))
      ) {
        return null;
      }
      if (!(await sendCapture(target.rect, target, 'mark', now))) return null;
      selectedSnapshotTargets.add(target.identity);
      if (target.element) selectedSnapshotElements.add(target.element);
      selectedSnapshotRects.add(snapshotRectKey(target.rect));
      selectedSnapshotHistory.push(target);
      undoneSnapshotTarget = null;
      snapshotAnnotationNumber += 1;
      return {
        rect: target.rect,
        label: recordingState.numbered ? snapshotAnnotationNumber : null,
      };
    };

    const onSnapshotRegion = async (
      message: SnapshotShieldRegionCaptureMessage,
    ): Promise<SnapshotShieldSelection | null> => {
      if (!snapshotInteractionsActive) return null;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (!isRegionRectInsideViewport(message.rect, viewport)) return null;
      const key = snapshotRectKey(message.rect);
      if (selectedSnapshotRects.has(key)) return null;

      const target: ResolvedSnapshotTarget = {
        rect: message.rect,
        identity: `region:${key}`,
        text: '',
        tagName: 'region',
        candidateOffset: 0,
      };
      if (!(await sendCapture(message.rect, target, 'mark', Date.now(), crypto.randomUUID(), 'region'))) return null;
      if (!snapshotInteractionsActive) return null;
      selectedSnapshotTargets.add(target.identity);
      selectedSnapshotRects.add(key);
      selectedSnapshotHistory.push(target);
      undoneSnapshotTarget = null;
      snapshotAnnotationNumber += 1;
      return {
        rect: message.rect,
        label: recordingState.numbered ? snapshotAnnotationNumber : null,
      };
    };

    const onSnapshotControl = async (
      message: SnapshotShieldControlMessage,
    ): Promise<RecordingControlResult> => {
      const result = await sendToolbarCommand(message.action, message.undoToken);
      if (!result.ok) return result;

      if (message.action === 'UNDO_LAST_CAPTURE') {
        const target = selectedSnapshotHistory.pop() ?? null;
        if (target) {
          selectedSnapshotTargets.delete(target.identity);
          if (target.element) selectedSnapshotElements.delete(target.element);
          selectedSnapshotRects.delete(snapshotRectKey(target.rect));
          snapshotAnnotationNumber = Math.max(0, snapshotAnnotationNumber - 1);
          undoneSnapshotTarget = target;
        }
      } else if (message.action === 'RESTORE_LAST_CAPTURE' && undoneSnapshotTarget) {
        const target = undoneSnapshotTarget;
        selectedSnapshotTargets.add(target.identity);
        if (target.element) selectedSnapshotElements.add(target.element);
        selectedSnapshotRects.add(snapshotRectKey(target.rect));
        selectedSnapshotHistory.push(target);
        snapshotAnnotationNumber += 1;
        undoneSnapshotTarget = null;
      }
      return result;
    };

    if (isStepMode) {
      stepPreview = createStepPreview();
      window.addEventListener('pointermove', onStepPointerMove, { capture: true, passive: true });
      window.addEventListener('pointerout', onStepPointerOut, { capture: true, passive: true });
      window.addEventListener('pointerleave', onStepPointerLeave, { capture: true, passive: true });
      window.addEventListener('scroll', onStepScroll, { capture: true, passive: true });
      window.addEventListener('scrollend', scheduleStepPreview, { capture: true, passive: true });
      window.addEventListener('resize', scheduleStepPreview, { passive: true });
      stepPreviewObserver = new MutationObserver(scheduleStepPreview);
      document.addEventListener('pointerdown', onPointerDown, { capture: true });
    }

    const onStepFollowup = (event: Event) => {
      if (
        event.type === 'click' &&
        event.isTrusted &&
        suppressLateClickTarget &&
        Date.now() < suppressLateClickUntil &&
        (event.target === suppressLateClickTarget || suppressLateClickTarget.contains(event.target as Node))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressLateClickTarget = null;
        return;
      }
      if (!stepGesture) return;
      // Swallow the raw pointer sequence while the capture runs; the canonical
      // click is replayed once the screenshot lands. Replay timing is driven by
      // the capture, not by pointerup, so only cancellation matters here.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'pointercancel') stepGesture.cancel();
    };
    if (isStepMode) {
      for (const type of STEP_FOLLOWUP_EVENTS) {
        document.addEventListener(type, onStepFollowup, { capture: true });
      }
    }

    const onSnapshotFreeze = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onSnapshotScroll = () => notifySnapshotInvalidated();
    if (shouldFreezeSnapshot) {
      for (const type of SNAPSHOT_FREEZE_EVENTS) {
        window.addEventListener(type, onSnapshotFreeze, { capture: true, passive: false });
      }
      window.addEventListener('scroll', onSnapshotScroll, { capture: true, passive: true });
      window.addEventListener('resize', notifySnapshotInvalidated, { passive: true });
      snapshotDprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      snapshotDprQuery.addEventListener('change', onSnapshotDprChange);
    }

    const toToolbarState = (state: RecordingState) => ({
      runId,
      mode: state.mode,
      phase: state.phase,
      itemCount: state.itemCount,
      error: state.recoverableError?.message ?? state.error,
    });
    const sendToolbarCommand = async (
      action: RecordingControlMessage['type'],
      undoToken?: string,
    ): Promise<RecordingControlResult> => {
      return requireRuntimeMessageResult<RecordingControlResult>(
        await browser.runtime.sendMessage({
          type: action,
          runId,
          ...(undoToken ? { undoToken } : {}),
        } satisfies RecordingControlMessage),
        isRecordingControlResult,
        '錄製服務已中斷，請重新整理頁面後再試一次。',
      );
    };

    if (isStepMode || recordingState.phase === 'preparing-next') {
      recordingToolbar = mountRecordingToolbar(toToolbarState(recordingState), {
        onCommand: sendToolbarCommand,
        ...(isStepMode ? { onStartRegionCapture: startStepRegionCapture } : {}),
      });
    }

    const unsubscribeRecordingState = onRecordingStateChange((state) => {
      if (state.runId !== runId) return;
      recorderPaused = state.phase === 'paused';
      if (isSnapshotMode) {
        snapshotInteractionsActive = state.phase === 'recording';
        if (state.phase === 'invalidated') snapshotInvalidationSent = true;
      }
      if (recorderPaused) suspendStepPreview();
      if (state.phase !== 'recording') manualRegionCapture?.cancel('removed');
      recordingToolbar?.update(toToolbarState(state));
      snapshotShield?.updateToolbar(toToolbarState(state));
    });

    const keepAlive = startKeepAlive(browser.runtime, {
      name: KEEPALIVE_PORT_NAME,
      intervalMs: KEEPALIVE_INTERVAL_MS,
    });

    const onRecorderMessage = (message: FrameTrailStopMessage | FrameTrailSnapshotActiveMessage) => {
      if (message?.type === 'FRAME_TRAIL_STOP') {
        cleanup();
        return;
      }
      if (message?.type === 'FRAME_TRAIL_SNAPSHOT_ACTIVE' && message.runId === runId) {
        snapshotInteractionsActive = true;
        notifySnapshotInvalidated();
        return Promise.resolve(true);
      }
    };

    const cleanup = () => {
      if (isStepMode) document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (isStepMode) {
        window.removeEventListener('pointermove', onStepPointerMove, { capture: true });
        window.removeEventListener('pointerout', onStepPointerOut, { capture: true });
        window.removeEventListener('pointerleave', onStepPointerLeave, { capture: true });
        window.removeEventListener('scroll', onStepScroll, { capture: true });
        window.removeEventListener('scrollend', scheduleStepPreview, { capture: true });
        window.removeEventListener('resize', scheduleStepPreview);
        stepPreviewObserver?.disconnect();
        stepPreviewObserver = null;
        stepPreviewObservedTarget = null;
        stopStepPreviewFallback();
        for (const type of STEP_FOLLOWUP_EVENTS) {
          document.removeEventListener(type, onStepFollowup, { capture: true });
        }
      }
      if (shouldFreezeSnapshot) {
        for (const type of SNAPSHOT_FREEZE_EVENTS) {
          window.removeEventListener(type, onSnapshotFreeze, { capture: true });
        }
        window.removeEventListener('scroll', onSnapshotScroll, { capture: true });
        window.removeEventListener('resize', notifySnapshotInvalidated);
        snapshotDprQuery?.removeEventListener('change', onSnapshotDprChange);
        snapshotDprQuery = null;
      }
      manualRegionCapture?.cancel('removed');
      manualRegionCapture = null;
      snapshotShield?.remove();
      snapshotShield = null;
      recordingToolbar?.remove();
      recordingToolbar = null;
      if (stepPreviewFrame !== null) cancelAnimationFrame(stepPreviewFrame);
      stepPreviewFrame = null;
      stepPreview?.remove();
      stepPreview = null;
      if (stepGesture) {
        stepGesture.cancel();
        stepGesture = null;
      }
      setCaptureScrollLock(null);
      document.removeEventListener(CLEANUP_EVENT, cleanup);
      browser.runtime.onMessage.removeListener(onRecorderMessage);
      unsubscribeRecordingState();
      keepAlive.stop();
    };
    document.addEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.addListener(onRecorderMessage);

    if (shouldFreezeSnapshot) {
      snapshotShield = createSnapshotShield(
        onSnapshotPoint,
        onSnapshotHover,
        onSnapshotControl,
        onSnapshotRegion,
        async () => {
          snapshotInteractionsActive = false;
          cleanup();
          try {
            await browser.runtime.sendMessage({
              type: 'SNAPSHOT_RECORDER_FAILED',
              runId,
              reason: 'shield-channel',
            } satisfies SnapshotRecorderFailureMessage);
          } catch (error) {
            console.error('[frametrail] failed to report snapshot shield failure', error);
          }
        },
      );
      try {
        await snapshotShield.ready;
        snapshotShield.updateToolbar(toToolbarState(recordingState));
        if (featureFlags.snapshotKeyboardNav) {
          // Defer enumeration off the startup path so a large page cannot stall
          // the clean-base handoff (§9.5). The frozen page keeps anchors valid.
          const shield = snapshotShield;
          const sendCandidates = () => {
            try {
              shield.sendKeyboardCandidates(collectKeyboardCandidateAnchors());
            } catch (error) {
              console.warn('[frametrail] failed to enumerate keyboard candidates', error);
            }
          };
          if (typeof requestIdleCallback === 'function') requestIdleCallback(sendCandidates, { timeout: 500 });
          else setTimeout(sendCandidates, 0);
        }
        await waitForNextFrame();
        await waitForNextFrame();
      } catch (err) {
        cleanup();
        if (instanceHost[INSTANCE_KEY] !== instanceId) return;
        throw err;
      }
    }

    // START_RECORDING must not resolve until every listener above is active.
    // Otherwise the popup can close while early page clicks still reach JS.
    let isCurrentRecordedTab = false;
    try {
      const readyMessage: import('@/lib/messages').RecorderReadyMessage = {
        type: 'FRAME_TRAIL_READY',
        runId,
        ...(shouldFreezeSnapshot
          ? {
              snapshotContext: {
                viewport: {
                  width: window.innerWidth,
                  height: window.innerHeight,
                  scrollX: window.scrollX,
                  scrollY: window.scrollY,
                },
                devicePixelRatio: window.devicePixelRatio,
                url: location.href,
                timestamp: Date.now(),
              },
            }
          : {}),
      };
      isCurrentRecordedTab = requireRuntimeMessageResult(
        await browser.runtime.sendMessage(readyMessage),
        isRuntimeBoolean,
        '錄製服務回應格式無效，請重新整理頁面後再試一次。',
      );
    } catch (err) {
      console.error('[frametrail] recorder readiness check failed', err);
    }
    if (!isCurrentRecordedTab || instanceHost[INSTANCE_KEY] !== instanceId) {
      cleanup();
      return;
    }
    if (isStepMode) snapshotInteractionsActive = true;

    console.log('[frametrail] recorder ready on', location.href);
  },
});

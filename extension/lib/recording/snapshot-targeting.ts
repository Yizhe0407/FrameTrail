import { browser } from 'wxt/browser';
import {
  buildSnapshotTargetIdentity,
  deepElementFromPoint,
  findVisualTargetCandidatesAtPoint,
  getVisibleHighlightBounds,
  INTERACTIVE_CANDIDATE_SELECTOR,
  intersectBounds,
  isElementVisuallyUnavailable,
  isInteractiveElement,
  selectVisualTargetCandidate,
} from '../capture/selector-utils';
import { describeElement } from '../capture/element-description';
import {
  SNAPSHOT_KEYBOARD_LABEL_LIMIT,
  SNAPSHOT_REGION_COORDINATE_LIMIT,
  SNAPSHOT_TARGET_OFFSET_LIMIT,
  NO_CANDIDATE_CYCLING,
  isCandidateOffsetRange,
  type SnapshotCandidateOffsetRange,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldRect,
} from './snapshot-shield-protocol';
import { orderKeyboardCandidates, type RawKeyboardCandidate } from '../capture/snapshot-candidates';
import { createFrameCoordinateMapper } from '../capture/frame-geometry';
import {
  childFrameProbeTimeout,
  classifyFrameProbeOutcome,
  closePortQuietly,
  createFrameProbeRateLimiter,
  isExplicitFrameProbeFallback,
  resolveFrameProbeTargetOrigin,
} from '../capture/frame-probe';
import { createImageCoordinateMapper } from '../capture/image-geometry';
import { isFiniteRect } from '../shared/validation';
import { CLEANUP_EVENT } from './content-script-constants';
import type { FrameTrailStopMessage } from '../runtime/messages';

const FRAME_PROBE_MESSAGE = `frame_trail_snapshot_probe_${browser.runtime.id}`;
const FRAME_PROBE_TIMEOUT_MS = 120;
const FRAME_PROBE_CHILD_BUDGET_MS = 20;
const FRAME_PROBE_RETRY_DELAY_MS = 2_000;
const FRAME_PROBE_MAX_CONCURRENT_REQUESTS = 12;
const FRAME_PROBE_MAX_REQUESTS_PER_WINDOW = 720;
const FRAME_PROBE_RATE_WINDOW_MS = 10_000;
const timedOutFrameProbes = new WeakMap<HTMLIFrameElement, { runId: string; retryAt: number }>();

export function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Enumerates top-frame annotation candidates for keyboard traversal (§9.5).
 * The page is frozen while annotating, so this runs once. Ordering, dedup and
 * capping are delegated to the pure helper; cross-frame candidates are out of
 * scope for this flag-gated first pass and remain pointer-reachable.
 */
export function collectKeyboardCandidateAnchors(): SnapshotShieldKeyboardAnchor[] {
  const raw: RawKeyboardCandidate[] = [];
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR)) {
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

interface SnapshotProbeResult {
  rect: SnapshotShieldRect;
  identity: string;
  text: string;
  tagName: string;
  candidateOffset: number;
  /** See SelectedVisualTargetCandidate.offsetRange. Targets resolved without a
   * candidate chain (an opaque child frame, an image-map area) report an empty
   * range so the shield never advertises cycling that would do nothing. */
  offsetRange: SnapshotCandidateOffsetRange;
}

export interface ResolvedSnapshotTarget extends SnapshotProbeResult {
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
  const candidateOffset = result.candidateOffset;
  return (
    isCandidateOffsetRange(result.offsetRange) &&
    isFiniteRect(result.rect, { maxMagnitude: SNAPSHOT_REGION_COORDINATE_LIMIT }) &&
    typeof result.identity === 'string' &&
    result.identity.length > 0 &&
    result.identity.length <= 4_096 &&
    typeof result.text === 'string' &&
    result.text.length <= 200 &&
    typeof result.tagName === 'string' &&
    result.tagName.length > 0 &&
    result.tagName.length <= 100 &&
    candidateOffset !== undefined &&
    Number.isSafeInteger(candidateOffset) &&
    Math.abs(candidateOffset) <= SNAPSHOT_TARGET_OFFSET_LIMIT
  );
}

function resolvedElement(
  el: Element,
  rect: SnapshotShieldRect | null,
  candidateOffset = 0,
  offsetRange: SnapshotCandidateOffsetRange = NO_CANDIDATE_CYCLING,
): ResolvedSnapshotTarget | null {
  if (!rect) return null;
  return {
    element: el,
    rect,
    identity: buildSnapshotTargetIdentity(el),
    text: describeElement(el),
    tagName: el.tagName.toLowerCase(),
    candidateOffset,
    offsetRange,
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
        offsetRange: child.offsetRange,
      }
    : null;
}

export async function resolveSnapshotTargetAtPoint(
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

  const targets = findVisualTargetCandidatesAtPoint(hit, clientX, clientY);
  const selected = selectVisualTargetCandidate(targets, candidateOffset);
  return selected
    ? resolvedElement(
        selected.element,
        getVisibleHighlightBounds(selected.element, clientX, clientY),
        selected.candidateOffset,
        selected.offsetRange,
      )
    : null;
}

export function installSnapshotFrameProbe(runId: string): void {
  const admission = createFrameProbeRateLimiter({
    maxConcurrent: FRAME_PROBE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: FRAME_PROBE_MAX_REQUESTS_PER_WINDOW,
    windowMs: FRAME_PROBE_RATE_WINDOW_MS,
  });
  const onMessage = (event: MessageEvent) => {
    const request = event.data as Partial<SnapshotProbeRequest> | null;
    const port = event.ports[0];
    const { timeoutMs, clientX, clientY, candidateOffset } = request ?? {};
    if (
      event.source !== parent ||
      !port ||
      request?.type !== FRAME_PROBE_MESSAGE ||
      request.runId !== runId ||
      timeoutMs === undefined ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > FRAME_PROBE_TIMEOUT_MS ||
      clientX === undefined ||
      !Number.isFinite(clientX) ||
      clientY === undefined ||
      !Number.isFinite(clientY) ||
      candidateOffset === undefined ||
      !Number.isSafeInteger(candidateOffset) ||
      Math.abs(candidateOffset) > SNAPSHOT_TARGET_OFFSET_LIMIT
    ) {
      closePortQuietly(port);
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
        closePortQuietly(port);
      }
      return;
    }
    void (async () => {
      let response: SnapshotProbeResult | null = null;
      try {
        const target = await resolveSnapshotTargetAtPoint(
          runId,
          clientX,
          clientY,
          candidateOffset,
          timeoutMs,
        );
        response = target
          ? {
              rect: target.rect,
              identity: target.identity,
              text: target.text,
              tagName: target.tagName,
              candidateOffset: target.candidateOffset,
              offsetRange: target.offsetRange,
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
        closePortQuietly(port);
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

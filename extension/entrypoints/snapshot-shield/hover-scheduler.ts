/**
 * Frame-coalesced hover probing for the snapshot shield page.
 *
 * The shield cannot hit-test the frozen page itself: every hover preview is a
 * round-trip over the shield channel. This state machine owns the interacting
 * pieces of that pipeline — the last pointer position, the candidate offset,
 * point revisions, and the single in-flight request — with three invariants:
 *
 * - At most one probe is in flight; new input only bumps the point revision
 *   and the next probe is sent when the current one settles (or times out).
 * - A response only applies when it answers the latest request AND the point
 *   has not moved since it was sent; anything else re-schedules instead.
 * - `sentPointRevision` suppresses re-probing an unchanged point; resetting
 *   it to -1 (hover timeout, capture completion) forces one fresh probe.
 */

export interface HoverProbeRequest {
  requestId: number;
  clientX: number;
  clientY: number;
  candidateOffset: number;
}

export interface HoverPreviewResponse {
  requestId: number;
  candidateOffset: number;
}

export type HoverPreviewOutcome = 'ignored' | 'stale' | 'accepted';

export interface HoverSchedulerDeps {
  /** Hovering is allowed at all (toolbar state says recording). */
  isEnabled(): boolean;
  /** A capture is in flight; probing pauses until it settles. */
  isCapturing(): boolean;
  /** Sends one probe over the shield channel. */
  post(request: HoverProbeRequest): void;
  /** Budget for one probe round-trip before it is abandoned and retried. */
  hoverTimeoutMs: number;
  /** Clamp for keyboard candidate-offset adjustments (±limit). */
  offsetLimit: number;
  /** Injectable for tests; defaults to requestAnimationFrame. */
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}

export interface HoverScheduler {
  /** Requests a probe on the next frame; no-ops while one is pending, while
   * capturing, without a point, or when the sent point is still current. */
  schedule(): void;
  /** Pointer moved: reset the candidate offset when the point changed, bump
   * the revision, and schedule. */
  pointerMove(clientX: number, clientY: number): void;
  /** Keyboard roving landed on an anchor: always resets the offset. */
  setAnchor(clientX: number, clientY: number): void;
  /** ArrowUp/ArrowDown candidate cycling at the current point. */
  adjustOffset(delta: number): void;
  /** Capture bookkeeping for a commit at the given point: invalidates any
   * scheduled/pending probe and returns the offset the capture must carry. */
  beginCapture(clientX: number, clientY: number): number;
  /** Drops the point and all pending work (pointer left, hover cleared). */
  clear(): void;
  /** Classifies a preview response; 'accepted' has adopted its candidate
   * offset and the caller should render the rect, then call schedule(). */
  resolvePreview(response: HoverPreviewResponse): HoverPreviewOutcome;
  /** Forces the next schedule() to re-probe the unchanged point (capture
   * settled or timed out, so the page under the cursor may have changed). */
  invalidateSentRevision(): void;
  hasPoint(): boolean;
}

export function createHoverScheduler(deps: HoverSchedulerDeps): HoverScheduler {
  const requestFrame = deps.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));

  let frame: number | null = null;
  let point: { clientX: number; clientY: number } | null = null;
  let candidateOffset = 0;
  let requestSequence = 0;
  let latestRequestId = 0;
  let pointRevision = 0;
  let sentPointRevision = -1;
  let pendingRequestId: number | null = null;
  let pendingPointRevision: number | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearPending = () => {
    if (pendingTimeout !== null) clearTimeout(pendingTimeout);
    pendingTimeout = null;
    pendingRequestId = null;
    pendingPointRevision = null;
  };

  const cancelScheduledFrame = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };

  const schedule = () => {
    if (
      !deps.isEnabled() ||
      deps.isCapturing() ||
      !point ||
      frame !== null ||
      pendingRequestId !== null ||
      sentPointRevision === pointRevision
    ) {
      return;
    }
    frame = requestFrame(() => {
      frame = null;
      if (
        !deps.isEnabled() ||
        deps.isCapturing() ||
        !point ||
        pendingRequestId !== null ||
        sentPointRevision === pointRevision
      ) {
        return;
      }
      latestRequestId = ++requestSequence;
      pendingRequestId = latestRequestId;
      sentPointRevision = pointRevision;
      pendingPointRevision = pointRevision;
      const hoverRequestId = latestRequestId;
      if (pendingTimeout !== null) clearTimeout(pendingTimeout);
      pendingTimeout = setTimeout(() => {
        if (pendingRequestId !== hoverRequestId) return;
        clearPending();
        sentPointRevision = -1;
        schedule();
      }, deps.hoverTimeoutMs);
      deps.post({
        requestId: latestRequestId,
        clientX: point.clientX,
        clientY: point.clientY,
        candidateOffset,
      });
    });
  };

  return {
    schedule,
    pointerMove(clientX, clientY) {
      if (!point || point.clientX !== clientX || point.clientY !== clientY) {
        candidateOffset = 0;
      }
      point = { clientX, clientY };
      pointRevision++;
      schedule();
    },
    setAnchor(clientX, clientY) {
      candidateOffset = 0;
      point = { clientX, clientY };
      pointRevision++;
      schedule();
    },
    adjustOffset(delta) {
      candidateOffset = Math.max(
        -deps.offsetLimit,
        Math.min(candidateOffset + delta, deps.offsetLimit),
      );
      pointRevision++;
      schedule();
    },
    beginCapture(clientX, clientY) {
      if (!point || point.clientX !== clientX || point.clientY !== clientY) {
        candidateOffset = 0;
      }
      point = { clientX, clientY };
      pointRevision++;
      latestRequestId = ++requestSequence;
      cancelScheduledFrame();
      return candidateOffset;
    },
    clear() {
      point = null;
      candidateOffset = 0;
      pointRevision++;
      latestRequestId = ++requestSequence;
      cancelScheduledFrame();
      clearPending();
    },
    resolvePreview(response) {
      if (response.requestId !== pendingRequestId) return 'ignored';
      const responsePointRevision = pendingPointRevision;
      clearPending();
      if (
        deps.isCapturing() ||
        response.requestId !== latestRequestId ||
        responsePointRevision !== pointRevision
      ) {
        return 'stale';
      }
      candidateOffset = response.candidateOffset;
      return 'accepted';
    },
    invalidateSentRevision() {
      sentPointRevision = -1;
    },
    hasPoint() {
      return point !== null;
    },
  };
}

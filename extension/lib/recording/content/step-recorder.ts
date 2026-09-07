import { browser } from 'wxt/browser';
import { describeElement, replayClickWithSuppression } from '../../capture/element-description';
import { createRegionCapture } from '../../capture/region-capture';
import { isOutOfViewport, readRegionScrollSnapshot, readScrollSnapshot } from '../../capture/scroll-snapshot';
import { getHighlightBounds, getVisibleHighlightBounds } from '../../capture/selector/highlight-bounds';
import { isInteractiveElement } from '../../capture/selector/interactive-element';
import {
  type ScrollSnapshot,
  type StepCaptureHandlers,
  createLateClickSuppressor,
  createStepFollowupHandler,
  orchestrateStepCapture,
} from '../../capture/step-capture';
import { type StepGesture, createStepGestureQueue } from '../../capture/step-gesture-queue';
import {
  CAPTURE_FAILSAFE_MS,
  STEP_FOLLOWUP_EVENTS,
  STEP_LATE_CLICK_SUPPRESS_MS,
} from '../content-script-constants';
import {
  type RelayedStepFrameHop,
  STEP_FRAME_CLICK_FAILSAFE_MS,
  createStepFrameRelayLimiter,
  isStepFrameRelayClaimResult,
  isStepFrameRelayMutationResult,
  resolveRelayedStepFrameHop,
  stepFrameClickMessageType,
} from '../frame-relay';
import { isInScrollbarGutter, isPointInAnyScrollGutter } from '../recording-guards';
import { mountRecordingToolbar, type MountedRecordingToolbar } from '../recording-toolbar-host';
import { waitForNextFrame } from '../snapshot-targeting';
import { createStepHoverPreview } from '../step-hover-preview';
import type {
  ClickCapture,
  StepFrameRelayClaimMessage,
  StepFrameRelaySettleMessage,
} from '../../runtime/messages';
import type { CaptureSender } from './capture-sender';
import type { ContentRecordingSession } from './recording-session';
import type { ToolbarChannel } from './toolbar-channel';

export interface StepRecorderDeps {
  session: ContentRecordingSession;
  capture: CaptureSender;
  toolbar: ToolbarChannel;
  /** Toolbar view of the run at mount time; later updates arrive through the
   * entrypoint's recording-state subscription. */
  initialToolbarState: Parameters<MountedRecordingToolbar['update']>[0];
}

/**
 * Installs the step-mode recorder in the top frame: hover preview, the pointer
 * gesture queue, manual region capture, and the authenticated child-frame
 * click relay. Returns the listener uninstaller; the instances it publishes on
 * the session are disposed of by the entrypoint's cleanup.
 */
export function installStepRecorder(deps: StepRecorderDeps): () => void {
  const { session, capture, toolbar, initialToolbarState } = deps;

  const gestureQueue = createStepGestureQueue();
  session.gestureQueue = gestureQueue;
  const lateClickSuppressor = createLateClickSuppressor<Element>(STEP_LATE_CLICK_SUPPRESS_MS);
  // While a capture is in flight the stored rect is pinned to this scroll
  // position, so the screenshot pixels always match it. Null when idle.
  let captureScrollLock: ScrollSnapshot | null = null;
  const lockedScrollElements = new Set<Element>();

  const preview = createStepHoverPreview({
    isPaused: () => session.paused,
    isGestureActive: () => gestureQueue.isBusy(),
    isRegionCaptureActive: () => session.regionCapture?.isActive() ?? false,
  });
  session.hoverPreview = preview;

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
    preview.schedule();
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

  /** Builds the orchestrateStepCapture handler set shared by the local
   * element path and the relayed child-frame path; only the capture and
   * replay actions differ between the two. */
  const makeStepOrchestrationHandlers = (
    gesture: StepGesture,
    scrollTarget: Element,
    actions: Pick<StepCaptureHandlers, 'capture' | 'replay'>,
  ): StepCaptureHandlers => ({
    failsafeMs: CAPTURE_FAILSAFE_MS,
    cancelled: gesture.cancelled,
    readScroll: () => readScrollSnapshot(scrollTarget),
    hidePreview: () => preview.prepareForCapture(),
    capture: actions.capture,
    cancelCapture: async () => {
      gesture.cancel();
      await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId: session.runId, captureId: gesture.captureId });
    },
    endGesture: () => {
      // Capture window closed: stop swallowing page events. The scroll pin
      // stays installed until restoreScroll has copied every ancestor back.
      gesture.release();
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
    replay: actions.replay,
    resumePreview: () => preview.schedule(),
  });

  const startStepRegionCapture = () => {
    if (session.paused || gestureQueue.isBusy() || session.regionCapture?.isActive()) return;
    preview.suspend();
    const captureId = crypto.randomUUID();
    let captureSent = false;
    const origin: ScrollSnapshot = { x: window.scrollX, y: window.scrollY, containers: [] };
    setCaptureScrollLock(origin);

    const controller = createRegionCapture({
      onCapture: async (rect) => {
        captureSent = true;
        // The drag settled on a concrete rect: extend the window-only pin to
        // every scrollable container intersecting it, mirroring the element
        // path, so nested programmatic scrolls cannot shift the pixels while
        // the screenshot is in flight.
        setCaptureScrollLock({ ...readRegionScrollSnapshot(rect), x: origin.x, y: origin.y });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          capture.sendCapture(
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
          await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId: session.runId, captureId });
          console.warn('[frametrail] region capture exceeded its failsafe budget and was cancelled');
        }
      },
      onCancel: async () => {
        if (!captureSent) return;
        await browser.runtime.sendMessage({ type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId: session.runId, captureId });
      },
      onClose: () => {
        if (session.regionCapture === controller) session.regionCapture = null;
        setCaptureScrollLock(null);
        session.toolbar?.setRegionCaptureActive(false);
        preview.schedule();
      },
    });
    session.regionCapture = controller;
    session.toolbar?.setRegionCaptureActive(true);
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

      if (isOutOfViewport(rect)) {
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
      return capture.sendCapture(
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

  const onPointerDown = (event: Event) => {
    const pe = event as PointerEvent;
    if (!pe.isTrusted || pe.button !== 0 || !pe.isPrimary) return;
    // Trusted events are ordered: the previous gesture's trailing click (if
    // any) has already been dispatched before a new trusted press arrives.
    // Disarming here keeps a rapid second click on the same element from
    // being swallowed after the dedup window declines to capture it.
    if (pe.isTrusted) lateClickSuppressor.onTrustedPointerDown();
    if (session.paused || session.regionCapture?.isActive()) return;
    if (pe.target instanceof Element && pe.target.closest('[data-frametrail-recording-toolbar]')) return;

    // A pointerdown in a native scrollbar gutter is a scroll gesture, not a
    // step: leave it untouched so the drag scrolls and no bogus step lands.
    if (isInScrollbarGutter(pe.clientX, pe.clientY, document.documentElement)) return;
    if (isPointInAnyScrollGutter(pe.clientX, pe.clientY)) return;

    // Resolved through the preview so the captured element is exactly the
    // box the highlight was showing when the user pressed.
    const el = preview.resolveTargetAt(pe.clientX, pe.clientY);
    if (!el) return;

    const now = Date.now();
    const clientX = pe.clientX;
    const clientY = pe.clientY;

    // Event dispatch never waits for an async listener. Stop the original
    // gesture synchronously regardless of whether it can start right away
    // or has to wait its turn behind an earlier one still capturing; it is
    // replayed once that turn comes either way.
    pe.preventDefault();
    pe.stopImmediatePropagation();

    gestureQueue.enqueue({
      captureId: crypto.randomUUID(),
      validate: () => el.isConnected,
      onSkipped: () => replayClickWithSuppression(el, lateClickSuppressor),
      start: async (gesture) => {
        preview.suspend();
        const outcome = await orchestrateStepCapture(
          makeStepOrchestrationHandlers(gesture, el, {
            capture: () =>
              captureElement(
                el,
                clientX,
                clientY,
                isInteractiveElement(el) ? 'click' : 'mark',
                now,
                gesture.captureId,
                gesture.isCancelled,
              ),
            replay: () => replayClickWithSuppression(el, lateClickSuppressor),
          }),
        );
        if (outcome === 'timeout') {
          console.warn('[frametrail] capture exceeded its failsafe budget; invalidated it before replaying the click');
        }
      },
    });
  };

  // Clicks inside child frames never bubble into this document. Instrumented
  // child frames authenticate each trusted press with the background, then
  // relay only a one-time token and hop-local geometry through postMessage.
  // This top-frame handler must consume that authorization before capture;
  // page scripts can forge the public hop but cannot mint a valid token.
  const stepFrameClickType = stepFrameClickMessageType(browser.runtime.id);
  const stepFrameRelayLimiter = createStepFrameRelayLimiter();

  /** Runs one relayed hop's CLAIM -> orchestrate -> settle chain. The CLAIM
   * round-trip (and the background's 10s claim TTL it starts) is
   * deliberately made here, at the moment this hop's turn in the queue
   * actually comes, rather than eagerly when the hop first arrived —
   * otherwise a backlog ahead of it would burn down that TTL before it
   * ever gets used. */
  const runRelayedFrameGesture = async (gesture: StepGesture, relayed: RelayedStepFrameHop): Promise<void> => {
    let claimResult: unknown;
    try {
      claimResult = await browser.runtime.sendMessage({
        type: 'FRAME_TRAIL_STEP_FRAME_CLAIM',
        runId: session.runId,
        captureId: relayed.payload.captureId,
        relayToken: relayed.payload.relayToken,
      } satisfies StepFrameRelayClaimMessage);
    } catch {
      gesture.release();
      return;
    }
    if (!isStepFrameRelayClaimResult(claimResult) || !claimResult.ok) {
      gesture.release();
      return;
    }

    let settlementStarted = false;
    const settleRelay = async (replay: boolean) => {
      if (settlementStarted) return;
      settlementStarted = true;
      try {
        const result: unknown = await browser.runtime.sendMessage({
          type: 'FRAME_TRAIL_STEP_FRAME_SETTLE',
          runId: session.runId,
          captureId: relayed.payload.captureId,
          settleToken: claimResult.settleToken,
          replay,
        } satisfies StepFrameRelaySettleMessage);
        if (!isStepFrameRelayMutationResult(result) || !result.ok) {
          console.warn('[frametrail] child-frame relay settlement was rejected');
        }
      } catch {
        // The child frame's local failsafe releases the gesture if the
        // background worker disappears before settlement is delivered.
      }
    };

    try {
      const rect = relayed.rect;
      if (!rect || session.paused || session.regionCapture?.isActive()) {
        gesture.release();
        await settleRelay(false);
        return;
      }
      const now = Date.now();
      preview.suspend();
      let replayConfirmed = false;
      const outcome = await orchestrateStepCapture(
        makeStepOrchestrationHandlers(gesture, relayed.frame, {
          capture: () => {
            // Pin the iframe's scrollable ancestor chain exactly like the
            // element path so the screenshot pixels match the relayed rect.
            setCaptureScrollLock(readScrollSnapshot(relayed.frame));
            return capture.sendCapture(
              rect,
              { text: claimResult.target.text, tagName: claimResult.target.tagName },
              claimResult.target.interactive ? 'click' : 'mark',
              now,
              gesture.captureId,
            );
          },
          replay: () => {
            // Settlement returns over extension runtime directly to the
            // originating child frame, preserving capture-before-replay.
            replayConfirmed = true;
            void settleRelay(true);
          },
        }),
      );
      if (!replayConfirmed) await settleRelay(false);
      if (outcome === 'timeout') {
        console.warn('[frametrail] child-frame capture exceeded its failsafe budget; invalidated it before replaying the click');
      }
    } catch (error) {
      gesture.release();
      await settleRelay(false);
      console.warn('[frametrail] child-frame relay handling failed', error);
    }
  };

  const onStepFrameClickMessage = (event: MessageEvent) => {
    const relayed = resolveRelayedStepFrameHop(event, stepFrameClickType, stepFrameRelayLimiter);
    if (!relayed) return;

    gestureQueue.enqueue({
      captureId: relayed.payload.captureId,
      // The sending child frame armed its own STEP_FRAME_CLICK_FAILSAFE_MS
      // budget the moment ITS gesture began, and nothing here can pause
      // that clock. If this hop has already sat in the backlog long enough
      // to blow that budget, the child has already given up and replayed
      // on its own — attempting a claim now would only earn a rejected
      // settlement for a hop nobody is waiting on anymore.
      validate: () =>
        Boolean(relayed.rect) &&
        !session.paused &&
        !session.regionCapture?.isActive() &&
        Date.now() - relayed.payload.originTimestamp < STEP_FRAME_CLICK_FAILSAFE_MS,
      onSkipped: () => {
        console.warn('[frametrail] skipped a relayed step-frame hop that went stale while queued');
      },
      start: (gesture) => runRelayedFrameGesture(gesture, relayed),
    });
  };

  const onStepFollowup = createStepFollowupHandler(lateClickSuppressor, {
    isActive: () => gestureQueue.isBusy(),
    cancel: () => gestureQueue.cancelActive(),
  });

  window.addEventListener('pointermove', preview.handlers.onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerout', preview.handlers.onPointerOut, { capture: true, passive: true });
  window.addEventListener('pointerleave', preview.handlers.onPointerLeave, { capture: true, passive: true });
  window.addEventListener('scroll', onStepScroll, { capture: true, passive: true });
  window.addEventListener('scrollend', preview.schedule, { capture: true, passive: true });
  window.addEventListener('resize', preview.schedule, { passive: true });
  window.addEventListener('message', onStepFrameClickMessage);
  document.addEventListener('visibilitychange', preview.handlers.onVisibilityChange);
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) {
    document.addEventListener(type, onStepFollowup, { capture: true });
  }

  session.toolbar = mountRecordingToolbar(initialToolbarState, {
    onCommand: toolbar.sendCommand,
    onStartRegionCapture: startStepRegionCapture,
  });

  // The toolbar and hover preview mounted above are shared, module-level
  // resources: the entrypoint's cleanup owns their removal; this
  // uninstaller only detaches listeners.
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    window.removeEventListener('pointermove', preview.handlers.onPointerMove, { capture: true });
    window.removeEventListener('pointerout', preview.handlers.onPointerOut, { capture: true });
    window.removeEventListener('pointerleave', preview.handlers.onPointerLeave, { capture: true });
    window.removeEventListener('scroll', onStepScroll, { capture: true });
    window.removeEventListener('scrollend', preview.schedule, { capture: true });
    window.removeEventListener('resize', preview.schedule);
    window.removeEventListener('message', onStepFrameClickMessage);
    document.removeEventListener('visibilitychange', preview.handlers.onVisibilityChange);
    for (const type of STEP_FOLLOWUP_EVENTS) {
      document.removeEventListener(type, onStepFollowup, { capture: true });
    }
    // Matches the pre-queue behavior for whatever is actively capturing:
    // just cancel it (its own settle path decides what that means) rather
    // than forcing an early resolution. purgePending() is the actual fix
    // here — it replays every queued-but-not-started press (already
    // preventDefault()'d at pointerdown time) without recording it,
    // instead of leaving it to hang.
    gestureQueue.cancelActive();
    gestureQueue.purgePending();
    if (session.gestureQueue === gestureQueue) session.gestureQueue = null;
    lateClickSuppressor.clear();
    setCaptureScrollLock(null);
  };
}

import { browser } from 'wxt/browser';
import {
  collectKeyboardCandidateAnchors,
  installSnapshotFrameProbe,
  type ResolvedSnapshotTarget,
  resolveSnapshotTargetAtPoint,
  waitForNextFrame,
} from '@/lib/recording/snapshot-targeting';
import {
  createStepFrameRelayLimiter,
  findIframeForWindow,
  installSnapshotFrameFreeze,
  installStepFrameRecorder,
  resolveRelayedStepFrameClick,
  respondToStepFrameClick,
  snapshotFrameScrollPingType,
  stepFrameClickMessageType,
} from '@/lib/recording/frame-relay';
import { installRecorderLifecycle } from '@/lib/recording/recorder-lifecycle';
import {
  getHighlightBounds,
  getVisibleHighlightBounds,
  isInteractiveElement,
  resolvePrimaryVisualTarget,
} from '@/lib/capture/selector-utils';
import { describeElement, replayClickWithSuppression } from '@/lib/capture/element-description';
import {
  isOutOfViewport,
  readRegionScrollSnapshot,
  readScrollSnapshot,
} from '@/lib/capture/scroll-snapshot';
import { createSnapshotShield, type SnapshotShield } from '@/lib/recording/snapshot-shield';
import { createStepHoverPreview, type StepHoverPreview } from '@/lib/recording/step-hover-preview';
import { createSnapshotSelectionSet } from '@/lib/recording/snapshot-selection-set';
import {
  createLateClickSuppressor,
  createStepCaptureDedup,
  createStepFollowupHandler,
  orchestrateStepCapture,
  type ScrollSnapshot,
  type StepCaptureHandlers,
} from '@/lib/capture/step-capture';
import {
  isInScrollbarGutter,
  isMatchingSnapshotViewport,
  isPointInAnyScrollGutter,
} from '@/lib/recording/recording-guards';
import {
  snapshotRectKey,
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldPreviewResult,
  type SnapshotShieldRect,
  type SnapshotShieldRegionCaptureMessage,
  type SnapshotShieldSelection,
  type SnapshotShieldControlMessage,
} from '@/lib/recording/snapshot-shield-protocol';
import { featureFlags } from '@/lib/shared/feature-flags';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import {
  createRegionCapture,
  isRegionRectInsideViewport,
  type RegionCapture,
} from '@/lib/capture/region-capture';
import { mountRecordingToolbar, type MountedRecordingToolbar } from '@/lib/recording/recording-toolbar-host';
import {
  isClickCaptureResult,
  isRecordingControlResult,
  isRuntimeBoolean,
  requireRuntimeMessageResult,
} from '@/lib/runtime/runtime-message-result';
import { installRecaptureRecorder } from '@/lib/recording/recapture-recorder';
import {
  CLEANUP_EVENT,
  SNAPSHOT_FREEZE_EVENTS,
  STEP_DEDUP_MS,
  STEP_FOLLOWUP_EVENTS,
  STEP_LATE_CLICK_SUPPRESS_MS,
} from '@/lib/recording/content-script-constants';
import type {
  ClickCapture,
  ClickCaptureResult,
  FrameTrailSnapshotActiveMessage,
  FrameTrailStopMessage,
  RecordingControlMessage,
  RecordingControlResult,
  RecordingState,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
} from '@/lib/runtime/messages';

const INSTANCE_KEY = `__frame_trail_instance_${browser.runtime.id}`;
// Only a genuinely hung capture should hit this; normal-latency captures (even
// throttled) settle well under it, so they never lose the race to the replay.
const CAPTURE_FAILSAFE_MS = 2_000;
const TOOLBAR_COMMAND_TIMEOUT_MS = 15_000;
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
      if (shouldFreezeSnapshot) {
        installSnapshotFrameProbe(runId);
        // The shield only covers the top viewport: before it is ready (and for
        // frame-internal activity in general) each child must freeze itself and
        // report pixel-shifting scrolls upward.
        installSnapshotFrameFreeze();
      }
      return;
    }
    if (isStepMode && window.top !== window) {
      // Child frames capture their own clicks and relay them (with rects
      // mapped hop-by-hop into the top viewport) to the top-frame recorder.
      installStepFrameRecorder(runId, recordingState.phase === 'paused');
      return;
    }
    const snapshotViewportContract = recordingState.snapshotViewport ?? {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    const snapshotDevicePixelRatioContract = recordingState.snapshotDevicePixelRatio ?? window.devicePixelRatio;

    let stepGesture: {
      target: Element;
      captureId: string;
      isCancelled: () => boolean;
      cancel: () => void;
      cancelled: Promise<void>;
    } | null = null;
    let recorderPaused = recordingState.phase === 'paused';
    let snapshotShield: SnapshotShield | null = null;
    let manualRegionCapture: RegionCapture | null = null;
    let recordingToolbar: MountedRecordingToolbar | null = null;
    let snapshotInteractionsActive = false;
    let snapshotInvalidationSent = recordingState.phase === 'invalidated';
    let snapshotDprQuery: MediaQueryList | null = null;
    let hoverPreview: StepHoverPreview | null = null;
    const snapshotSelection = createSnapshotSelectionSet();

    const readSnapshotViewport = (): ClickCapture['viewport'] => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
    const notifySnapshotInvalidated = (force = false) => {
      if (!shouldFreezeSnapshot || !snapshotInteractionsActive || snapshotInvalidationSent) return;
      const viewport = readSnapshotViewport();
      if (
        // A child-frame scroll shifts pixels without moving the top viewport,
        // so a forced invalidation must not be masked by a matching contract.
        !force &&
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

    // The background's itemCount is the single source of truth for how many
    // annotations the current snapshot holds (it resets per snapshot and moves
    // on undo/restore). Deriving labels from it keeps overlay numbering
    // correct even when a capture response is lost after the background
    // already committed the step.
    const readAuthoritativeAnnotationCount = async (): Promise<number | null> => {
      try {
        const state = await getRecordingState();
        return state.operation === 'recording' && state.runId === runId ? state.itemCount : null;
      } catch {
        return null;
      }
    };

    /** Commits one snapshot annotation and returns its authoritative 1-based
     * label, or null when no step was stored. */
    const commitSnapshotAnnotation = async (
      rect: SnapshotShieldRect,
      target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
      captureKind: ClickCapture['captureKind'],
      now: number,
    ): Promise<number | null> => {
      const before = (await readAuthoritativeAnnotationCount()) ?? 0;
      try {
        if (!(await sendCapture(rect, target, 'mark', now, crypto.randomUUID(), captureKind))) return null;
        return (await readAuthoritativeAnnotationCount()) ?? before + 1;
      } catch (error) {
        // The response was lost after the background may already have
        // committed the step; the durable recording state decides which of
        // the two actually happened, so labels cannot drift off-by-one.
        console.warn('[frametrail] snapshot capture response was lost; reconciling with recording state', error);
        const after = await readAuthoritativeAnnotationCount();
        return after !== null && after > before ? after : null;
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
      if (!snapshotInteractionsActive || !target || snapshotSelection.isSelected(target)) {
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
      if (snapshotSelection.isSelected(target)) return null;
      const label = await commitSnapshotAnnotation(target.rect, target, 'element', now);
      if (label === null) return null;
      snapshotSelection.add(target);
      return {
        rect: target.rect,
        label: recordingState.numbered ? label : null,
      };
    };

    const onSnapshotRegion = async (
      message: SnapshotShieldRegionCaptureMessage,
    ): Promise<SnapshotShieldSelection | null> => {
      if (!snapshotInteractionsActive) return null;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (!isRegionRectInsideViewport(message.rect, viewport)) return null;
      if (snapshotSelection.hasRect(message.rect)) return null;

      const target: ResolvedSnapshotTarget = {
        rect: message.rect,
        identity: `region:${snapshotRectKey(message.rect)}`,
        text: '',
        tagName: 'region',
        candidateOffset: 0,
      };
      const label = await commitSnapshotAnnotation(message.rect, target, 'region', Date.now());
      if (label === null) return null;
      if (!snapshotInteractionsActive) return null;
      snapshotSelection.add(target);
      return {
        rect: message.rect,
        label: recordingState.numbered ? label : null,
      };
    };

    const onSnapshotControl = async (
      message: SnapshotShieldControlMessage,
    ): Promise<RecordingControlResult> => {
      const result = await sendToolbarCommand(message.action, message.undoToken);
      if (!result.ok) return result;

      // Undo/restore is DELIBERATELY tracked in three lockstep layers keyed by
      // the same background result: this recorder's selection set (dedup of
      // future clicks), the shield channel's committedSelections
      // (snapshot-shield.ts handleControl), and the shield page's overlay
      // stack (snapshot-shield/overlay.ts undo/commit). All three must pop and
      // push together or duplicate detection and the drawn annotations drift.
      if (message.action === 'UNDO_LAST_CAPTURE') {
        snapshotSelection.undoLast();
      } else if (message.action === 'RESTORE_LAST_CAPTURE') {
        snapshotSelection.restoreUndone();
      }
      return result;
    };

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
      const command = (async () =>
        requireRuntimeMessageResult<RecordingControlResult>(
          await browser.runtime.sendMessage({
            type: action,
            runId,
            ...(undoToken ? { undoToken } : {}),
          } satisfies RecordingControlMessage),
          isRecordingControlResult,
          '錄製服務已中斷，請重新整理頁面後再試一次。',
        ))();
      // A hung background must not wedge the in-page toolbar forever: surface
      // the channel-failure error after the same budget the shield toolbar
      // uses, so controls re-enable and the user sees what went wrong.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          command,
          new Promise<RecordingControlResult>((resolve) => {
            timeout = setTimeout(
              () => resolve({ ok: false, error: '錄製服務已中斷，請重新整理頁面後再試一次。' }),
              TOOLBAR_COMMAND_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        // A late settlement after the timeout must not surface as unhandled.
        command.catch(() => undefined);
      }
    };

    /** Installs the whole step-mode recorder (hover preview, gesture capture,
     * child-frame relay endpoint, toolbar) and returns its uninstaller. */
    const installStepRecorder = (): (() => void) => {
      const stepDedup = createStepCaptureDedup<Element | string>(STEP_DEDUP_MS);
      const lateClickSuppressor = createLateClickSuppressor<Element>(STEP_LATE_CLICK_SUPPRESS_MS);
      // While a capture is in flight the stored rect is pinned to this scroll
      // position, so the screenshot pixels always match it. Null when idle.
      let captureScrollLock: ScrollSnapshot | null = null;
      const lockedScrollElements = new Set<Element>();

      const preview = createStepHoverPreview({
        isPaused: () => recorderPaused,
        isGestureActive: () => stepGesture !== null,
        isRegionCaptureActive: () => manualRegionCapture?.isActive() ?? false,
      });
      hoverPreview = preview;

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

      const shouldCaptureTarget = (key: Element | string, now: number) => stepDedup.shouldCapture(key, now);

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
        gesture: NonNullable<typeof stepGesture>,
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
        replay: actions.replay,
        resumePreview: () => preview.schedule(),
      });

      const startStepRegionCapture = () => {
        if (recorderPaused || stepGesture || manualRegionCapture?.isActive()) return;
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
            preview.schedule();
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
        // Trusted events are ordered: the previous gesture's trailing click (if
        // any) has already been dispatched before a new trusted press arrives.
        // Disarming here keeps a rapid second click on the same element from
        // being swallowed after the dedup window declines to capture it.
        if (pe.isTrusted) lateClickSuppressor.onTrustedPointerDown();
        if (recorderPaused || manualRegionCapture?.isActive()) return;
        if (pe.target instanceof Element && pe.target.closest('[data-frametrail-recording-toolbar]')) return;

        // A pointerdown in a native scrollbar gutter is a scroll gesture, not a
        // step: leave it untouched so the drag scrolls and no bogus step lands.
        if (isInScrollbarGutter(pe.clientX, pe.clientY, document.documentElement)) return;
        if (isPointInAnyScrollGutter(pe.clientX, pe.clientY)) return;

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
        preview.suspend();

        // Event dispatch never waits for an async listener. Stop the original
        // gesture synchronously; it is replayed only after capture finishes.
        pe.preventDefault();
        pe.stopImmediatePropagation();
        const gesture = beginStepGesture(el);

        const outcome = await orchestrateStepCapture(
          makeStepOrchestrationHandlers(gesture, el, {
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
            replay: () => replayClickWithSuppression(el, lateClickSuppressor),
          }),
        );

        if (outcome === 'timeout') {
          console.warn('[frametrail] capture exceeded its failsafe budget; invalidated it before replaying the click');
        }
      };

      // Clicks inside child frames never bubble into this document. Instrumented
      // child frames capture them locally and relay them here with rects already
      // mapped hop-by-hop into the top viewport; this handler records the step
      // and only then confirms the replay back to the originating frame.
      const stepFrameClickType = stepFrameClickMessageType(browser.runtime.id);
      const stepFrameRelayLimiter = createStepFrameRelayLimiter();
      const onStepFrameClickMessage = (event: MessageEvent) => {
        const relayed = resolveRelayedStepFrameClick(event, stepFrameClickType, stepFrameRelayLimiter);
        if (!relayed) return;
        const rect = relayed.rect;
        if (!rect || recorderPaused || manualRegionCapture?.isActive() || stepGesture) {
          respondToStepFrameClick(relayed.port, false);
          return;
        }
        const now = Date.now();
        if (!shouldCaptureTarget(`frame:${snapshotRectKey(rect)}`, now)) {
          // The child swallowed its gesture and replays only on confirmation:
          // deliver the activation without recording a duplicate step.
          respondToStepFrameClick(relayed.port, true);
          return;
        }
        preview.suspend();
        const gesture = beginStepGesture(relayed.frame);
        let replayConfirmed = false;
        void orchestrateStepCapture(
          makeStepOrchestrationHandlers(gesture, relayed.frame, {
            capture: () => {
              // Pin the iframe's scrollable ancestor chain exactly like the
              // element path so the screenshot pixels match the relayed rect.
              setCaptureScrollLock(readScrollSnapshot(relayed.frame));
              return sendCapture(
                rect,
                { text: relayed.payload.text, tagName: relayed.payload.tagName },
                relayed.payload.interactive ? 'click' : 'mark',
                now,
                gesture.captureId,
              );
            },
            replay: () => {
              // The click replays inside the child frame; confirming over the
              // port preserves capture-before-replay ordering across frames.
              replayConfirmed = true;
              respondToStepFrameClick(relayed.port, true);
            },
          }),
        ).then((outcome) => {
          if (!replayConfirmed) respondToStepFrameClick(relayed.port, false);
          if (outcome === 'timeout') {
            console.warn('[frametrail] child-frame capture exceeded its failsafe budget; invalidated it before replaying the click');
          }
        });
      };

      const onStepFollowup = createStepFollowupHandler(lateClickSuppressor, {
        isActive: () => stepGesture !== null,
        cancel: () => stepGesture?.cancel(),
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

      recordingToolbar = mountRecordingToolbar(toToolbarState(recordingState), {
        onCommand: sendToolbarCommand,
        onStartRegionCapture: startStepRegionCapture,
      });

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
        if (stepGesture) {
          stepGesture.cancel();
          stepGesture = null;
        }
        lateClickSuppressor.clear();
        setCaptureScrollLock(null);
      };
    };

    /** Installs the snapshot-mode page instrumentation and returns its
     * uninstaller: freeze listeners while a frozen snapshot is being
     * annotated, or the in-page toolbar while the next snapshot is prepared.
     * The input shield itself is created later, after the cleanup spine
     * exists (its failure handler tears the whole recorder down). */
    const installSnapshotRecorder = (): (() => void) => {
      if (!shouldFreezeSnapshot) {
        // phase === 'preparing-next': the page stays live; only the floating
        // toolbar is injected so the user can create the next snapshot.
        recordingToolbar = mountRecordingToolbar(toToolbarState(recordingState), {
          onCommand: sendToolbarCommand,
        });
        return () => {};
      }

      const onSnapshotFreeze = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const onSnapshotScroll = () => notifySnapshotInvalidated();
      const onSnapshotResize = () => notifySnapshotInvalidated();
      const snapshotScrollPing = snapshotFrameScrollPingType(browser.runtime.id);
      const onSnapshotFramePing = (event: MessageEvent) => {
        if ((event.data as { type?: unknown } | null)?.type !== snapshotScrollPing) return;
        // Only a window that is actually one of this document's iframes may
        // invalidate; page scripts in this frame post with this window as their
        // source and never match.
        if (!findIframeForWindow(event.source)) return;
        notifySnapshotInvalidated(true);
      };
      for (const type of SNAPSHOT_FREEZE_EVENTS) {
        window.addEventListener(type, onSnapshotFreeze, { capture: true, passive: false });
      }
      window.addEventListener('scroll', onSnapshotScroll, { capture: true, passive: true });
      window.addEventListener('resize', onSnapshotResize, { passive: true });
      window.addEventListener('message', onSnapshotFramePing);
      snapshotDprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      snapshotDprQuery.addEventListener('change', onSnapshotDprChange);

      return () => {
        for (const type of SNAPSHOT_FREEZE_EVENTS) {
          window.removeEventListener(type, onSnapshotFreeze, { capture: true });
        }
        window.removeEventListener('scroll', onSnapshotScroll, { capture: true });
        window.removeEventListener('resize', onSnapshotResize);
        window.removeEventListener('message', onSnapshotFramePing);
        snapshotDprQuery?.removeEventListener('change', onSnapshotDprChange);
        snapshotDprQuery = null;
      };
    };

    const uninstallModeRecorder = isStepMode ? installStepRecorder() : installSnapshotRecorder();

    const unsubscribeRecordingState = onRecordingStateChange((state) => {
      if (state.runId !== runId) return;
      const wasPaused = recorderPaused;
      recorderPaused = state.phase === 'paused';
      if (isSnapshotMode) {
        snapshotInteractionsActive = state.phase === 'recording';
        if (state.phase === 'invalidated') snapshotInvalidationSent = true;
      }
      if (recorderPaused) hoverPreview?.suspend();
      else if (wasPaused && isStepMode) {
        // Resume must bring the hover highlight back at the last known pointer
        // position instead of waiting for the next pointer move.
        hoverPreview?.schedule();
        hoverPreview?.armFallback();
      }
      if (state.phase !== 'recording') manualRegionCapture?.cancel('removed');
      recordingToolbar?.update(toToolbarState(state));
      snapshotShield?.updateToolbar(toToolbarState(state));
    });

    // Navigating away freezes this document in the back/forward cache with all
    // recorder listeners intact; the shared lifecycle hands the keep-alive
    // port back before the freeze and only resumes when this run is still the
    // live one.
    const recorderLifecycle = installRecorderLifecycle({
      isRunCurrent: async () => {
        const state = await getRecordingState();
        return state.operation === 'recording' && state.isRecording && state.runId === runId;
      },
      cleanup: () => cleanup(),
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
      return undefined;
    };

    const cleanup = () => {
      uninstallModeRecorder();
      manualRegionCapture?.cancel('removed');
      manualRegionCapture = null;
      snapshotShield?.remove();
      snapshotShield = null;
      recordingToolbar?.remove();
      recordingToolbar = null;
      hoverPreview?.destroy();
      hoverPreview = null;
      document.removeEventListener(CLEANUP_EVENT, cleanup);
      browser.runtime.onMessage.removeListener(onRecorderMessage);
      unsubscribeRecordingState();
      recorderLifecycle.stop();
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
      const readyMessage: import('@/lib/runtime/messages').RecorderReadyMessage = {
        type: 'FRAME_TRAIL_READY',
        runId,
        ...(shouldFreezeSnapshot
          ? {
              snapshotContext: {
                // Must be the exact object used as the local invalidation
                // contract: re-reading the window here would let a scroll
                // between injection and readiness give the background a
                // different baseline than the one this recorder validates
                // against.
                viewport: { ...snapshotViewportContract },
                devicePixelRatio: snapshotDevicePixelRatioContract,
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

    console.log('[frametrail] recorder ready on', location.href);
  },
});

import { browser } from 'wxt/browser';
import {
  CLEANUP_EVENT,
  describeElement,
  collectKeyboardCandidateAnchors,
  isOutOfViewport,
  installSnapshotFrameProbe,
  readScrollSnapshot,
  replayElementClick,
  type ResolvedSnapshotTarget,
  resolveSnapshotTargetAtPoint,
  snapshotRectKey,
  waitForNextFrame,
} from '@/lib/recording/snapshot-targeting';
import { startKeepAlive } from '@/lib/runtime/keep-alive';
import {
  deepElementFromPoint,
  findVisualTargetCandidates,
  getComposedParent,
  getHighlightBounds,
  getVisibleHighlightBounds,
  isInteractiveElement,
  selectVisualTargetCandidate,
} from '@/lib/capture/selector-utils';
import { createSnapshotShield, type SnapshotShield } from '@/lib/recording/snapshot-shield';
import { createStepPreview, type StepPreview } from '@/lib/capture/step-preview';
import { orchestrateStepCapture, type ScrollSnapshot } from '@/lib/capture/step-capture';
import {
  isInScrollableElementGutter,
  isInScrollbarGutter,
  isMatchingSnapshotViewport,
  isPointInsideViewport,
} from '@/lib/recording/recording-guards';
import {
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
  CONTENT_KEEPALIVE_INTERVAL_MS,
  CONTENT_KEEPALIVE_PORT_NAME,
  STEP_FOLLOWUP_EVENTS,
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

const DEDUP_MS = 400;
const INSTANCE_KEY = `__frame_trail_instance_${browser.runtime.id}`;
// Only a genuinely hung capture should hit this; normal-latency captures (even
// throttled) settle well under it, so they never lose the race to the replay.
const CAPTURE_FAILSAFE_MS = 2_000;
const LATE_CLICK_SUPPRESS_MS = 2_000;
const STEP_PREVIEW_FALLBACK_MS = 750;

const SNAPSHOT_FREEZE_EVENTS = [
  'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click',
  'dblclick', 'auxclick', 'contextmenu', 'submit', 'keydown', 'keyup', 'beforeinput', 'wheel', 'touchmove',
] as const;
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
      name: CONTENT_KEEPALIVE_PORT_NAME,
      intervalMs: CONTENT_KEEPALIVE_INTERVAL_MS,
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
      const readyMessage: import('@/lib/runtime/messages').RecorderReadyMessage = {
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

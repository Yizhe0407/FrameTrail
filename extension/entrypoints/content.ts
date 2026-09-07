import { browser } from 'wxt/browser';
import {
  collectKeyboardCandidateAnchors,
  installSnapshotFrameProbe,
  waitForNextFrame,
} from '@/lib/recording/snapshot-targeting';
import {
  installSnapshotFrameFreeze,
  installStepFrameRecorder,
} from '@/lib/recording/frame-relay';
import { installRecorderLifecycle } from '@/lib/recording/recorder-lifecycle';
import { createSnapshotShield } from '@/lib/recording/snapshot-shield';
import { createSnapshotRecorder } from '@/lib/recording/content/snapshot-recorder';
import { featureFlags } from '@/lib/shared/feature-flags';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { isRuntimeBoolean, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { installRecaptureRecorder } from '@/lib/recording/recapture-recorder';
import { createCaptureSender } from '@/lib/recording/content/capture-sender';
import { createContentRecordingSession } from '@/lib/recording/content/recording-session';
import { installStepRecorder } from '@/lib/recording/content/step-recorder';
import { createToolbarChannel } from '@/lib/recording/content/toolbar-channel';
import { CLEANUP_EVENT } from '@/lib/recording/content-script-constants';
import type {
  FrameTrailSnapshotActiveMessage,
  FrameTrailStopMessage,
  SnapshotRecorderFailureMessage,
} from '@/lib/runtime/messages';

const INSTANCE_KEY = `__frame_trail_instance_${browser.runtime.id}`;
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

    const session = createContentRecordingSession({
      runId,
      numbered: recordingState.numbered,
      paused: recordingState.phase === 'paused',
    });
    const capture = createCaptureSender(runId);
    const toolbar = createToolbarChannel(runId);
    const snapshot = createSnapshotRecorder({
      session,
      capture,
      toolbar,
      freezePage: shouldFreezeSnapshot,
      viewportContract: snapshotViewportContract,
      devicePixelRatioContract: snapshotDevicePixelRatioContract,
      initialToolbarState: toolbar.toToolbarState(recordingState),
      invalidatedAtStart: recordingState.phase === 'invalidated',
    });

    const uninstallModeRecorder = isStepMode
      ? installStepRecorder({
          session,
          capture,
          toolbar,
          initialToolbarState: toolbar.toToolbarState(recordingState),
        })
      : snapshot.install();

    const unsubscribeRecordingState = onRecordingStateChange((state) => {
      if (state.runId !== runId) return;
      const wasPaused = session.paused;
      session.paused = state.phase === 'paused';
      if (isSnapshotMode) {
        snapshot.setInteractionsActive(state.phase === 'recording');
        if (state.phase === 'invalidated') snapshot.markInvalidationSent();
      }
      if (session.paused) {
        session.hoverPreview?.suspend();
        // Anything still waiting its turn hasn't started capturing yet, so
        // there is nothing to undo — just let its already-prevented click
        // through without recording it. The gesture actively capturing (if
        // any) is left alone and finishes normally, matching today's pause
        // behavior for it.
        session.gestureQueue?.purgePending();
      } else if (wasPaused && isStepMode) {
        // Resume must bring the hover highlight back at the last known pointer
        // position instead of waiting for the next pointer move.
        session.hoverPreview?.schedule();
        session.hoverPreview?.armFallback();
      }
      if (state.phase !== 'recording') session.regionCapture?.cancel('removed');
      session.toolbar?.update(toolbar.toToolbarState(state));
      session.shield?.updateToolbar(toolbar.toToolbarState(state));
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
        snapshot.setInteractionsActive(true);
        snapshot.notifyInvalidated();
        return Promise.resolve(true);
      }
      return undefined;
    };

    const cleanup = () => {
      uninstallModeRecorder();
      session.regionCapture?.cancel('removed');
      session.regionCapture = null;
      session.shield?.remove();
      session.shield = null;
      session.toolbar?.remove();
      session.toolbar = null;
      session.hoverPreview?.destroy();
      session.hoverPreview = null;
      document.removeEventListener(CLEANUP_EVENT, cleanup);
      browser.runtime.onMessage.removeListener(onRecorderMessage);
      unsubscribeRecordingState();
      recorderLifecycle.stop();
    };
    document.addEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.addListener(onRecorderMessage);

    if (shouldFreezeSnapshot) {
      session.shield = createSnapshotShield(
        snapshot.handlers.onPoint,
        snapshot.handlers.onHover,
        snapshot.handlers.onControl,
        snapshot.handlers.onRegion,
        async () => {
          snapshot.setInteractionsActive(false);
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
        await session.shield.ready;
        session.shield.updateToolbar(toolbar.toToolbarState(recordingState));
        if (featureFlags.snapshotKeyboardNav) {
          // Defer enumeration off the startup path so a large page cannot stall
          // the clean-base handoff (§9.5). The frozen page keeps anchors valid.
          const shield = session.shield;
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

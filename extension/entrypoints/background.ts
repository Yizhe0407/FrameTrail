import { browser, type Browser } from 'wxt/browser';
import {
  StaleCaptureError,
  queueCapture,
  queueClick,
  queueLifecycle,
  queueStateMutation,
  waitForQueuedClicks,
} from '@/lib/recording/background-queues';
import { generateActionDescription } from '@/lib/capture/action-description';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';
import { focusTab } from '@/lib/runtime/navigation';
import {
  isBackgroundMessage,
  isExtensionPageOnlyMessage,
  isTrustedExtensionPageSender,
  isTrustedKeepAliveSender,
  isTrustedRecorderControlSender,
  type RuntimeMessageSenderLike,
} from '@/lib/runtime/background-message-validation';
import {
  CAPTURE_PRESENTATION_CSS,
  waitForCapturePresentationPaint,
  withCapturePresentation,
} from '@/lib/capture/capture-presentation';
import {
  addStep,
  addSteps,
  deleteStep,
  deleteStepsForRun,
  getGuide,
  getStep,
  getSteps,
  resetGuide,
  stepRole,
  type Step,
} from '@/lib/storage/db';
import {
  getCaptureGuardFailure,
  getRecordingTabUpdateAction,
  isMatchingSnapshotViewport,
  isValidSnapshotViewportContext,
} from '@/lib/recording/recording-guards';
import { discardPristineGuide } from '@/lib/storage/db';
import {
  createControlPlane,
  type SnapshotCaptureContext,
} from '@/lib/recording/background/control-plane';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  markCaptureCommitting,
  releaseCapture,
} from '@/lib/recording/background/capture-registry';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import { ACTIVE_OPERATION_MESSAGE, createRecaptureFlow } from '@/lib/recording/background/recapture-flow';
import { createFollowMode } from '@/lib/recording/background/follow-mode';
import {
  EDITOR_ONLY_CONTINUATION_MESSAGE,
  isEditorSenderForSession,
  resolveContinuationTab,
  resolveGuideContinuationSourceUrl,
  RESTRICTED_CONTINUATION_SOURCE_MESSAGE,
  sourcePermissionPreflightSuccess,
} from '@/lib/recording/background/source-tab';
import {
  clearPendingUndoRecord,
  readPendingUndoRecord,
  savePendingUndoRecord,
  type PendingUndoRecord,
} from '@/lib/recording/background/pending-undo-store';
import { KEEPALIVE_PORT_NAME, KEEPALIVE_REJECTED_MESSAGE_TYPE } from '@/lib/runtime/keep-alive';
import { EDITOR_OPEN_FAILED_MESSAGE } from '@/lib/runtime/user-messages';
import { describeBrowserError, isMissingTabError } from '@/lib/runtime/browser-errors';
import { getRecordingState, resetRunStateToIdle, setRecordingState } from '@/lib/storage/storage';
import {
  clearEditorRecovery,
  markEditorOpenFailed,
  needsEditorRecovery,
  RECORDED_TAB_CLOSED_ERROR,
} from '@/lib/recording/recording-recovery';
import type {
  BackgroundMessage,
  CancelStepRecaptureResult,
  ClickCapture,
  ClickCaptureResult,
  FinishResult,
  FocusStepRecaptureSourceResult,
  FrameTrailSnapshotActiveMessage,
  OpenEditorMessage,
  OpenEditorResult,
  PreflightGuideContinuationSourcePermissionErrorCode,
  PreflightGuideContinuationSourcePermissionMessage,
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  ResetGuideMessage,
  ResetGuideResult,
  RecordingControlMessage,
  RecordingControlResult,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
  StartRecordingMessage,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from '@/lib/runtime/messages';
import type { RecordingState, RecoverableRecordingError } from '@/lib/storage/recording-state';

const REBUILD_SNAPSHOT_FAILED_MESSAGE = '無法重建快照，請重試。';
const CREATE_SNAPSHOT_FAILED_MESSAGE = '無法建立新快照，請重試。';

const SNAPSHOT_VIEWPORT_CHANGED_MESSAGE = '畫面尺寸已改變，需建立新快照才能繼續。';
/** Raised when a snapshot annotation arrives from a viewport that no longer
 * matches the anchor's. Typed so handleClick invalidates the run instead of
 * surfacing a per-click error. */
class SnapshotViewportChangedError extends Error {}
/** A snapshot run whose anchor row (or its base image) is gone can never accept
 * another annotation. Settling the whole run once — instead of failing every
 * click — is what makes the state recoverable from the popup. */
const SNAPSHOT_ANCHOR_MISSING_ERROR: RecoverableRecordingError = {
  code: 'SNAPSHOT_ANCHOR_MISSING',
  message: '快照底圖已遺失，這次快照錄製已停止。先前完成的內容仍保留，請重新開始快照錄製。',
};

/** Raised when an annotation arrives for a run whose anchor no longer holds a
 * base image. Typed so handleClick settles the run instead of retrying forever. */
class SnapshotAnchorMissingError extends Error {}
const recorderRuntime = createRecorderRuntime({
  captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }),
  executeRecorderScript: (target) => browser.scripting.executeScript({
    target,
    files: ['/content-scripts/content.js'],
  }),
  sendStopMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
});
let pendingUndo: PendingUndoRecord | null = null;

// Owns the control version, the click gate, the ready gates and the pending
// snapshot context; its claimControl is the one enforcement point of the
// "invalidate synchronously before the first await" contract.
const control = createControlPlane({ discardPendingUndo });

// The recapture flow shares the capture pipeline with step capture; the
// cancellation/commit markers both flows consult live in capture-registry.
const recaptureFlow = createRecaptureFlow({
  control,
  runtime: recorderRuntime,
  captureScreenshotWithGuard,
});

const followMode = createFollowMode({ control, runtime: recorderRuntime });

/**
 * Invalidates the in-memory undo window synchronously (control flows rely on
 * that ordering) and lazily hard-deletes its persisted copy — the last copy of
 * the removed step's screenshot once the window is gone.
 */
function discardPendingUndo(): void {
  pendingUndo = null;
  void clearPendingUndoRecord().catch((error) => {
    console.warn('[frametrail] failed to clear the persisted undo record', error);
  });
}

async function updateRunState(
  runId: string,
  update: (current: RecordingState) => RecordingState,
  expectedControlVersion?: number,
): Promise<boolean> {
  const written = await control.writeStateIf(
    expectedControlVersion ?? null,
    (current) => current.isRecording && current.operation === 'recording' && current.runId === runId,
    update,
  );
  return written !== null;
}

async function setRunError(runId: string, error: string): Promise<void> {
  await updateRunState(runId, (current) => ({
    ...current,
    error,
    recoverableError: { code: 'CAPTURE_FAILED', message: error },
  }));
}

// Deliberately not writeStateIf: the already-invalidated → true answer must
// stay atomic with the claim-and-write, or a racing control could make this
// report false for a run that is in fact invalidated.
async function invalidateSnapshotRun(
  runId: string,
  viewport: ClickCapture['viewport'],
  devicePixelRatio: number,
  expectedControlVersion: number,
): Promise<boolean> {
  return queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      current.isRecording &&
      current.runId === runId &&
      current.mode === 'snapshot' &&
      current.phase === 'invalidated'
    ) {
      return true;
    }
    if (
      expectedControlVersion !== control.controlVersion ||
      !current.isRecording ||
      current.runId !== runId ||
      current.mode !== 'snapshot' ||
      current.phase !== 'recording' ||
      !current.snapshotViewport ||
      current.snapshotDevicePixelRatio == null ||
      isMatchingSnapshotViewport(
        current.snapshotViewport,
        current.snapshotDevicePixelRatio,
        viewport,
        devicePixelRatio,
      )
    ) {
      return false;
    }

    control.claimControl({ discardUndo: true });
    await setRecordingState({
      ...current,
      phase: 'invalidated',
      error: null,
      recoverableError: {
        code: 'SNAPSHOT_VIEWPORT_CHANGED',
        message: SNAPSHOT_VIEWPORT_CHANGED_MESSAGE,
      },
    });
    return true;
  });
}

function stopRunWithError(
  runId: string,
  error: string,
  expectedControlVersion: number,
  recoverableError?: RecoverableRecordingError,
): Promise<void> {
  if (expectedControlVersion !== control.controlVersion) return Promise.resolve();
  const version = control.claimControl({ cancelRecorderGate: true, clearSnapshotContext: true });
  return handleStopRunWithError(runId, error, version, recoverableError);
}

async function handleStopRunWithError(
  runId: string,
  error: string,
  version: number,
  recoverableError?: RecoverableRecordingError,
): Promise<void> {
  // The error-stop shape deliberately differs from resetRunStateToIdle: phase
  // 'error' plus the kept error text drive the popup's recovery flow.
  const stopped = await control.writeStateIf(
    version,
    (state) => state.isRecording && state.runId === runId,
    (state) => ({
      ...state,
      operation: null,
      isRecording: false,
      phase: 'error',
      tabId: null,
      error,
      recoverableError: recoverableError ?? { code: 'RECORDING_STOPPED', message: error },
      groupAnchorId: null,
      runId: null,
      // Error stops never reclaim the auto-created Guide: the recovery flow
      // (完成並開啟編輯器) still targets sessionId and must find it.
      autoCreatedGuideId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    }),
  );
  if (!stopped) return;
  const stoppedState = stopped.previous;
  // Only after the run stopped referencing it: an interruption here leaks an
  // orphan row at worst, never a live run pointing at a deleted anchor.
  await deleteEmptySnapshotAnchorBestEffort(stoppedState);
  await recorderRuntime.stopRecorderInTab(stoppedState.tabId);
}

async function assertCaptureContext(
  expectedControlVersion: number,
  runId: string,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedUrl: string,
): Promise<void> {
  if (expectedControlVersion !== control.controlVersion) {
    throw new StaleCaptureError('Recording control changed before the screenshot could be taken.');
  }
  const state = await getRecordingState();
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  const failure = getCaptureGuardFailure({
    expectedControlVersion,
    currentControlVersion: control.controlVersion,
    runId,
    sessionId,
    tabId,
    expectedUrl,
    state,
    activeTab,
  });
  if (failure === 'stale-run') throw new StaleCaptureError('Recording changed before the screenshot could be taken.');
  // These two surface to the user through setRunError, so they are zh-Hant.
  if (failure === 'inactive-tab') throw new Error('已略過此步驟：錄製分頁已不是目前作用中的分頁。');
  if (failure === 'changed-url') throw new Error('已略過此步驟：頁面在截圖前已變更。');
}

async function persistRecordingSteps(state: RecordingState, steps: Step[]): Promise<void> {
  if (!state.sessionId || !state.runId) throw new StaleCaptureError('Recording is no longer active.');
  await addSteps(steps);
}

/**
 * Removes a snapshot anchor that failed to become (or stay) usable. A
 * published anchor id must be withdrawn from the run state before its row
 * disappears; if the withdrawal cannot be applied, the row is kept (an orphan
 * at worst) so the state never dangles into a deleted anchor.
 */
async function withdrawAnchorThenDelete(
  runId: string,
  anchorId: string,
  version: number,
  anchorPublished: boolean,
): Promise<void> {
  const safeToDelete = !anchorPublished || await updateRunState(
    runId,
    (current) => current.groupAnchorId === anchorId
      ? { ...current, groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null }
      : current,
    version,
  ).catch(() => false);
  if (!safeToDelete) return;
  try {
    await deleteStep(anchorId);
  } catch (cleanupError) {
    console.error(
      '[frametrail] failed to remove incomplete snapshot:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}

async function createAndActivateSnapshotAnchor(
  state: RecordingState,
  tabId: number,
  windowId: number,
  context: SnapshotCaptureContext,
  version: number,
): Promise<string> {
  if (!state.sessionId || !state.runId) throw new StaleCaptureError('Snapshot recording is no longer active.');
  const { sessionId, runId } = state;
  const captureId = crypto.randomUUID();
  let anchorId: string | null = null;
  let anchorPublished = false;

  try {
    const captured = await captureScreenshot(
      { runId, captureId, ...context },
      sessionId,
      tabId,
      windowId,
      version,
    );
    anchorId = crypto.randomUUID();
    const existingSteps = await getSteps(sessionId);
    await persistRecordingSteps(state, [{
      id: anchorId,
      sessionId,
      runId,
      order: existingSteps.length,
      screenshotBlob: captured.blob,
      bounds: null,
      devicePixelRatio: context.devicePixelRatio,
      screenshotScale: captured.scale,
      description: '',
      url: context.url,
      timestamp: context.timestamp,
      groupId: anchorId,
      numbered: state.numbered,
    }]);
    const updated = await updateRunState(
      runId,
      (current) => ({
        ...current,
        groupAnchorId: anchorId,
        snapshotViewport: context.viewport,
        snapshotDevicePixelRatio: context.devicePixelRatio,
        error: null,
        recoverableError: null,
      }),
      version,
    );
    if (!updated) throw new StaleCaptureError('Recording changed while saving the snapshot.');
    anchorPublished = true;

    control.acceptingClicks = true;
    const activateMessage: FrameTrailSnapshotActiveMessage = {
      type: 'FRAME_TRAIL_SNAPSHOT_ACTIVE',
      runId,
    };
    const activated = await browser.tabs.sendMessage(tabId, activateMessage, { frameId: 0 });
    if (activated !== true) {
      throw new Error('Snapshot recorder could not be activated after saving its base image.');
    }
    return anchorId;
  } catch (error) {
    control.acceptingClicks = false;
    if (anchorId) await withdrawAnchorThenDelete(runId, anchorId, version, anchorPublished);
    throw error;
  } finally {
    releaseCapture(captureId);
  }
}

function continuationPreflightFailure(
  code: PreflightGuideContinuationSourcePermissionErrorCode,
  message: string,
): PreflightGuideContinuationSourcePermissionResult {
  return { ok: false, code, message };
}

async function preflightGuideContinuationSourcePermission(
  message: PreflightGuideContinuationSourcePermissionMessage,
  sender: Browser.runtime.MessageSender,
): Promise<PreflightGuideContinuationSourcePermissionResult> {
  if (
    typeof message.sessionId !== 'string' ||
    message.sessionId.trim().length === 0 ||
    !isEditorSenderForSession(sender, message.sessionId)
  ) {
    return continuationPreflightFailure('INVALID_EDITOR', EDITOR_ONLY_CONTINUATION_MESSAGE);
  }
  const sourceUrl = await resolveGuideContinuationSourceUrl(message.sessionId);
  if (!sourceUrl) {
    return continuationPreflightFailure('SOURCE_NOT_FOUND', '這份教學還沒有可接續的來源頁面。');
  }
  return (
    sourcePermissionPreflightSuccess(sourceUrl) ??
    continuationPreflightFailure('RESTRICTED_SOURCE', RESTRICTED_CONTINUATION_SOURCE_MESSAGE)
  );
}

/**
 * `operation: 'recording'` persists across restarts by design so ordinary MV3
 * worker restarts resume seamlessly, but a browser restart reissues tab ids:
 * the recorded tab is gone (or its id names an unrelated page), no recorder is
 * injected anywhere, and the stale single-owner state would make every future
 * start return "already recording" forever. Validate the recorded tab at
 * startup and settle impossible runs the same way a mid-run tab close does —
 * recoverable, captured content kept.
 */
async function recoverInterruptedRecording(): Promise<void> {
  const state = await getRecordingState();
  if (state.operation !== 'recording' || !state.isRecording || !state.runId) return;
  const expectedControlVersion = control.controlVersion;
  const assessment = await assessInterruptedRecording(state);
  if (assessment === 'intact') return;
  const recoverableError = assessment === 'anchor-missing'
    ? SNAPSHOT_ANCHOR_MISSING_ERROR
    : RECORDED_TAB_CLOSED_ERROR;
  await stopRunWithError(
    state.runId,
    recoverableError.message,
    expectedControlVersion,
    recoverableError,
  );
}

type InterruptedRecordingAssessment = 'intact' | 'tab-gone' | 'anchor-missing';

async function assessInterruptedRecording(state: RecordingState): Promise<InterruptedRecordingAssessment> {
  if (state.tabId == null) return 'tab-gone';
  let tab: Browser.tabs.Tab;
  try {
    tab = await browser.tabs.get(state.tabId);
  } catch {
    return 'tab-gone';
  }
  // A live run can read its tab's URL through the activeTab/host grant that
  // started it. After a browser restart those grants are gone or the reissued
  // id shows a browser page, so an unreadable or restricted URL means this
  // run can never capture again. A readable ordinary URL is kept — steps mode
  // legitimately navigates, so a stricter match would kill healthy runs.
  if (isRestrictedUrl(tab.url)) return 'tab-gone';
  if (state.mode === 'snapshot') {
    // A snapshot run only accepts annotations while a valid anchor with a base
    // image exists, so startup validates the anchor exactly like the tab: a
    // run resumed into a click-accepting phase without one would fail every
    // future annotation with a per-click error instead of settling.
    const acceptsAnnotations = state.phase === 'recording' || state.phase === 'finishing';
    if (acceptsAnnotations && !state.groupAnchorId) return 'anchor-missing';
    if (state.groupAnchorId) {
      const anchor = await getStep(state.groupAnchorId);
      if (acceptsAnnotations && !anchor?.screenshotBlob) return 'anchor-missing';
      // Snapshot coordinates belong to one immutable document; a restart that
      // left the tab on any other URL invalidates every further annotation.
      if (anchor && tab.url !== anchor.url) return 'tab-gone';
    }
  }
  return 'intact';
}

/**
 * The in-memory undo window dies with the service worker while its persisted
 * copy survives. Rehydrate the window when the persisted run still matches;
 * otherwise the window is over and the record is hard-deleted — the deferred
 * deletion undoLastCapture's soft delete left to this point.
 */
async function recoverPendingUndo(): Promise<void> {
  const record = await readPendingUndoRecord();
  if (!record) return;
  const state = await getRecordingState();
  const windowStillOpen =
    state.isRecording &&
    state.operation === 'recording' &&
    state.runId === record.runId &&
    state.itemCount === record.expectedItemCount &&
    (state.phase === 'recording' || state.phase === 'paused') &&
    record.expiresAt > Date.now();
  if (!windowStillOpen) {
    await clearPendingUndoRecord();
    return;
  }
  pendingUndo ??= record;
}

/**
 * Every run starts numbered. Numbering is a per-snapshot presentation choice,
 * so the editor owns turning it off where the result is visible; asking before
 * the first capture made the user decide blind. Captures still stamp the run's
 * value onto each step, so turning it off later never rewrites older images.
 */
const RUN_STARTS_NUMBERED = true;

/** The three start-failure writes share one shape: a version-independent error
 * stop that records the requested mode and resets every run-scoped field. */
function startFailureState(
  current: RecordingState,
  mode: StartRecordingMessage['mode'],
  code: string,
  message: string,
): RecordingState {
  return {
    ...current,
    operation: null,
    isRecording: false,
    phase: 'error',
    tabId: null,
    error: message,
    recoverableError: { code, message },
    mode,
    itemCount: 0,
    numbered: RUN_STARTS_NUMBERED,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  };
}

async function startRecording(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
): Promise<StartRecordingResult> {
  const current = await getRecordingState();
  // A global capture operation remains single-owner. Never let a second start
  // invalidate another Guide's recording or one-shot replacement.
  if (current.operation !== null || current.isRecording || recaptureFlow.isStartingRecapture()) {
    return { ok: false, error: ACTIVE_OPERATION_MESSAGE };
  }
  const targetGuide = await getGuide(message.sessionId);
  if (!targetGuide) return { ok: false, error: '找不到要錄製的教學。請回作品庫重新選擇。' };

  let continuationTab: Browser.tabs.Tab | null = null;
  if (message.continuation) {
    const resolved = await resolveContinuationTab(message, sender);
    if (!resolved.ok) return resolved;
    continuationTab = resolved.tab;
  }

  const version = control.claimControl({
    cancelRecorderGate: true,
    clearSnapshotContext: true,
    discardUndo: true,
  });
  await handleStartRecording(message, version, continuationTab);
  const started = await getRecordingState();
  if (
    version === control.controlVersion &&
    started.operation === 'recording' &&
    started.isRecording &&
    started.sessionId === message.sessionId &&
    started.runId
  ) {
    return { ok: true, sessionId: message.sessionId, runId: started.runId };
  }
  return { ok: false, error: started.recoverableError?.message ?? started.error ?? '無法在這個頁面開始錄製。' };
}

async function handleStartRecording(
  message: StartRecordingMessage,
  version: number,
  continuationTab: Browser.tabs.Tab | null = null,
): Promise<void> {
  // Reset waits for all writes from the old run through STOP. START uses the
  // same barrier so an old capture cannot append to the reused session later.
  await waitForQueuedClicks();
  if (version !== control.controlVersion) return;

  const prevState = await getRecordingState();
  const tab = continuationTab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (version !== control.controlVersion) return;

  await recorderRuntime.stopRecorderInTab(prevState.tabId);
  if (version !== control.controlVersion) return;
  if (!tab?.id) {
    await control.writeStateForControl(version, (current) =>
      startFailureState(current, message.mode, 'NO_ACTIVE_TAB', '找不到可錄製的分頁。請開啟一般網站後再試一次。'));
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    await control.writeStateForControl(version, (current) =>
      startFailureState(current, message.mode, 'RESTRICTED_PAGE', '此瀏覽器頁面不允許錄製。'));
    return;
  }

  // Captures read the visible viewport, and snapshot mode captures its base
  // image during startup, so a resumed source tab must reach the foreground
  // before the recorder is injected — not after the run is live.
  if (continuationTab) {
    try {
      await focusTab(tab.id!, tab.windowId);
    } catch (error) {
      console.error('[frametrail] failed to focus the continuation source tab', error);
      await control.writeStateForControl(version, (current) =>
        startFailureState(current, message.mode, 'SOURCE_TAB_FAILED', '無法切換到原始頁面，未開始錄製。'));
      return;
    }
    if (version !== control.controlVersion) return;
  }

  const runId = crypto.randomUUID();
  const startedState = await control.writeStateForControl(version, (current) => ({
    operation: 'recording',
    isRecording: true,
    phase: 'starting',
    sessionId: message.sessionId,
    tabId: tab.id!,
    error: null,
    recoverableError: null,
    mode: message.mode,
    itemCount: 0,
    numbered: RUN_STARTS_NUMBERED,
    groupAnchorId: null,
    runId,
    // Durable (not module state): a MV3 service-worker restart mid-run must
    // not forget that this run's Guide is reclaimable when it ends empty.
    autoCreatedGuideId: message.autoCreatedGuide === true ? message.sessionId : null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
    recapture: null,
    recaptureResult: current.recaptureResult,
  }));
  if (!startedState) return;
  if (startedState.sessionId !== message.sessionId) return;
  if (version !== control.controlVersion) return;

  let startupAnchorId: string | null = null;
  try {
    await control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity: { runId, tabId: tab.id, controlVersion: version },
      // Both modes instrument every accessible frame: snapshot mode for its
      // child-frame probes, step mode so iframe clicks are captured and
      // relayed to the top-frame recorder instead of being silently lost.
      inject: () => recorderRuntime.injectRecorder(tab.id!, true),
      notReadyError: () => new Error('Recorder did not become ready before the startup timeout.'),
      ready: async () => {
        if (version !== control.controlVersion) return;
        if (message.mode === 'snapshot') {
          const context = control.pendingSnapshotContext;
          if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
          if (!startedState.sessionId || tab.windowId == null) throw new Error('Snapshot capture context is incomplete.');
          startupAnchorId = await createAndActivateSnapshotAnchor(
            startedState,
            tab.id!,
            tab.windowId,
            context,
            version,
          );
        }
        await updateRunState(
          runId,
          (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
          version,
        );
        const current = await getRecordingState();
        control.acceptingClicks = current.isRecording && current.runId === runId;
        startupAnchorId = null;
      },
    });
  } catch (err) {
    console.error('[frametrail] failed to inject recorder:', describeBrowserError(err), err);
    // The anchor was already published to the run state, so it must be
    // withdrawn before its row can go.
    if (startupAnchorId) await withdrawAnchorThenDelete(runId, startupAnchorId, version, true);
    if (version !== control.controlVersion) return;
    try {
      await stopRunWithError(runId, '無法在這個頁面開始錄製，請改用一般網站再試一次。', version);
    } catch (recoveryError) {
      control.acceptingClicks = false;
      console.error(
        '[frametrail] failed to persist recording startup failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
  }
}

async function stopRecording(): Promise<void> {
  const current = await getRecordingState();
  if (current.operation !== 'recording' || !current.isRecording) return;
  const version = control.claimControl({
    cancelRecorderGate: true,
    clearSnapshotContext: true,
    discardUndo: true,
  });
  return handleStopRecording(version);
}

interface ValidatedRecorderSender {
  tabId: number;
  state: RecordingState;
  expectedControlVersion: number;
}

/**
 * The shared sender/state guard for messages a recorder content script sends
 * about a live recording run: top-frame sender, run identity, and recorded-tab
 * identity, plus the per-handler legs named in the options. Returns null when
 * any leg fails, so handlers answer untrusted or stale senders uniformly.
 */
async function validateRecorderMessageSender(
  message: { runId: string },
  sender: Browser.runtime.MessageSender,
  opts: {
    /** Snapshot-only handlers reject every other mode. */
    mode?: RecordingState['mode'];
    /** Handlers that must never act during a recapture require the operation. */
    operation?: 'recording';
    /** The startup handshake additionally verifies full sender trust. */
    requireTrustedControlSender?: boolean;
    /** Most handlers reject when control changed during the state read; the
     * invalidation handler defers that check to its atomic state mutation. */
    requireCurrentControlVersion?: boolean;
  } = {},
): Promise<ValidatedRecorderSender | null> {
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) return null;
  const expectedControlVersion = control.controlVersion;
  const state = await getRecordingState();
  if (
    (opts.requireCurrentControlVersion !== false && expectedControlVersion !== control.controlVersion) ||
    !state.isRecording ||
    (opts.operation !== undefined && state.operation !== opts.operation) ||
    state.runId !== message.runId ||
    state.tabId !== tabId ||
    (opts.mode !== undefined && state.mode !== opts.mode) ||
    (opts.requireTrustedControlSender === true && !isTrustedRecorderControlSender(sender, state.tabId))
  ) {
    return null;
  }
  return { tabId, state, expectedControlVersion };
}

async function handleRecorderReady(
  message: Extract<BackgroundMessage, { type: 'FRAME_TRAIL_READY' }>,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  const validated = await validateRecorderMessageSender(message, sender, {
    requireTrustedControlSender: true,
  });
  if (!validated) return false;
  const { tabId, state, expectedControlVersion } = validated;

  const identity = {
    runId: message.runId,
    tabId,
    controlVersion: expectedControlVersion,
  };
  const matchesPendingStartup = control.pendingRecorderReady?.matches(identity) === true;
  const signaled = control.pendingRecorderReady?.signal(identity);
  if (matchesPendingStartup) control.pendingSnapshotContext = message.snapshotContext;

  // Re-injections after navigation have no startup gate; the current run is
  // already accepting clicks and only needs its new listener set validated.
  return (
    matchesPendingStartup ||
    signaled === true ||
    state.phase === 'paused' ||
    state.phase === 'preparing-next' ||
    control.acceptingClicks
  );
}

async function handleSnapshotInvalidated(
  message: SnapshotInvalidatedMessage,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  if (!isValidSnapshotViewportContext(message.viewport, message.devicePixelRatio)) return false;
  const validated = await validateRecorderMessageSender(message, sender, {
    mode: 'snapshot',
    requireCurrentControlVersion: false,
  });
  if (!validated) return false;
  const { state, expectedControlVersion } = validated;
  if (state.phase === 'invalidated') return true;
  return invalidateSnapshotRun(
    message.runId,
    message.viewport,
    message.devicePixelRatio,
    expectedControlVersion,
  );
}


async function handleSnapshotRecorderFailure(
  message: SnapshotRecorderFailureMessage,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  const validated = await validateRecorderMessageSender(message, sender, {
    mode: 'snapshot',
    operation: 'recording',
  });
  if (!validated) return false;
  const { expectedControlVersion } = validated;
  const error = '快照選取介面已中斷；為避免頁面持續被鎖定，這次錄製已安全停止。';
  await stopRunWithError(message.runId, error, expectedControlVersion, {
    code: 'SNAPSHOT_SHIELD_FAILED',
    message: error,
  });
  return true;
}

async function handleStopRecording(version: number): Promise<void> {
  await waitForQueuedClicks();
  if (version !== control.controlVersion) return;
  const current = await getRecordingState();
  if (version !== control.controlVersion) return;
  // Unlike FINISH, STOP keeps any already-surfaced error text visible.
  const state = await control.writeStateForControl(version, (latest) => ({
    ...resetRunStateToIdle(latest),
    error: latest.error,
    recoverableError: latest.recoverableError,
  }));
  if (!state) return;
  // Only after the stop won: deleting first left a live run pointing at a
  // deleted anchor whenever the state write lost to a concurrent control.
  await deleteEmptySnapshotAnchorBestEffort(current);
  await recorderRuntime.stopRecorderInTab(current.tabId);
  // After the anchor cleanup so a zero-annotation snapshot run counts as empty.
  await reclaimAbandonedAutoCreatedGuide(current);
}

/**
 * The popup's 開始錄製 auto-creates a fresh Guide per run (autoCreatedGuideId).
 * When such a run ends with nothing captured, delete that empty shell and clear
 * the selection so aborted runs cannot pile unnamed empty guides up in 作品庫.
 *
 * Deliberately conservative: only guides that are still completely untouched
 * are deleted (discardPristineGuide re-verifies zero steps and empty
 * metadata at delete time), and only runs started with the popup's
 * autoCreatedGuide flag qualify — 作品庫 新增教學 and the editor's 接續錄製
 * never set it, so user-created guides are never touched. Two run endings
 * intentionally keep the guide: FINISH_RECORDING (the editor is about to open
 * it, so deleting would strand that navigation) and error stops (the recovery
 * flow still targets the run's sessionId).
 */
async function reclaimAbandonedAutoCreatedGuide(state: RecordingState): Promise<void> {
  if (!state.autoCreatedGuideId || state.autoCreatedGuideId !== state.sessionId) return;
  try {
    await discardPristineGuide(state.autoCreatedGuideId);
  } catch (error) {
    console.error(
      '[frametrail] failed to reclaim the abandoned auto-created guide:',
      describeBrowserError(error),
      error,
    );
  }
}

async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<string | null> {
  if (state.mode !== 'snapshot' || !state.sessionId || !state.groupAnchorId) return null;
  const steps = await getSteps(state.sessionId);
  const hasAnnotations = steps.some(
    (step) => step.groupId === state.groupAnchorId && stepRole(step) === 'annotation' && step.bounds !== null,
  );
  if (hasAnnotations) return null;
  await deleteStep(state.groupAnchorId);
  return state.groupAnchorId;
}

/** Best-effort variant for run endings: the cleanup runs only after the stop
 * already won its state write, so a failure may leak an orphan row but must
 * never fail the stop itself. */
async function deleteEmptySnapshotAnchorBestEffort(state: RecordingState): Promise<void> {
  try {
    await deleteEmptySnapshotAnchor(state);
  } catch (cleanupError) {
    console.error(
      '[frametrail] failed to remove the empty snapshot anchor:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}

function controlFailure(error: string): RecordingControlResult {
  return { ok: false, error };
}

async function pauseRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const state = await getRecordingState();
  if (
    !state.isRecording ||
    state.runId !== message.runId ||
    state.mode !== 'steps' ||
    state.phase !== 'recording'
  ) {
    return controlFailure('目前無法暫停這次錄製。');
  }
  control.acceptingClicks = false;
  const updated = await updateRunState(message.runId, (current) => ({ ...current, phase: 'paused' }));
  if (!updated) return controlFailure('錄製狀態已改變，請再試一次。');
  return { ok: true };
}

async function resumeRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const state = await getRecordingState();
  if (
    !state.isRecording ||
    state.runId !== message.runId ||
    state.mode !== 'steps' ||
    state.phase !== 'paused'
  ) {
    return controlFailure('目前無法繼續這次錄製。');
  }
  const updated = await updateRunState(message.runId, (current) => ({ ...current, phase: 'recording' }));
  if (!updated) return controlFailure('錄製狀態已改變，請再試一次。');
  control.acceptingClicks = true;
  return { ok: true };
}

async function undoLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
  return queueClick(async () => {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      !state.isRecording ||
      !state.sessionId ||
      !state.runId ||
      state.runId !== message.runId ||
      (state.phase !== 'recording' && state.phase !== 'paused')
    ) {
      return controlFailure('目前沒有可復原的錄製內容。');
    }

    const steps = await getSteps(state.sessionId);
    const last = [...steps]
      .reverse()
      .find((step) => step.runId === message.runId && step.bounds !== null);
    if (!last || state.itemCount === 0) return controlFailure('目前沒有可復原的錄製內容。');

    const nextCount = Math.max(0, state.itemCount - 1);
    const undoRecord = {
      token: crypto.randomUUID(),
      runId: message.runId,
      step: last,
      expectedItemCount: nextCount,
      expiresAt: Date.now() + 5_000,
    };
    // Soft delete: persist a copy before removing the step, because the
    // in-memory window below would otherwise hold the only copy of this
    // screenshot and MV3 may terminate the worker inside the restore window.
    // Best-effort — a persistence failure degrades to memory-only undo.
    try {
      await savePendingUndoRecord(undoRecord);
    } catch (persistError) {
      console.warn('[frametrail] failed to persist the undo window', persistError);
    }
    await deleteStep(last.id);
    const updated = await updateRunState(
      message.runId,
      (current) => ({
        ...current,
        itemCount: nextCount,
        error: null,
        recoverableError: null,
      }),
      expectedControlVersion,
    );
    if (!updated) {
      await addStep(last);
      discardPendingUndo();
      return controlFailure('錄製狀態已變更，未移除內容。');
    }

    pendingUndo = undoRecord;
    return { ok: true, undoToken: undoRecord.token, removedItemNumber: state.itemCount };
  });
}

async function restoreLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
  return queueClick(async () => {
    const undo = pendingUndo;
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      !undo ||
      undo.token !== message.undoToken ||
      undo.runId !== message.runId ||
      undo.expiresAt < Date.now() ||
      !state.isRecording ||
      !state.sessionId ||
      !state.runId ||
      state.runId !== message.runId ||
      state.itemCount !== undo.expectedItemCount ||
      // Same phases undo itself allows: a window rehydrated after a worker
      // restart must not restore into preparing-next/invalidated/finishing.
      (state.phase !== 'recording' && state.phase !== 'paused')
    ) {
      discardPendingUndo();
      return controlFailure('已無法還原這筆內容。');
    }

    await addStep(undo.step);
    const updated = await updateRunState(
      message.runId,
      (current) => ({
        ...current,
        itemCount: current.itemCount + 1,
        error: null,
        recoverableError: null,
      }),
      expectedControlVersion,
    );
    if (!updated) {
      await deleteStep(undo.step.id);
      return controlFailure('錄製狀態已變更，未還原內容。');
    }
    discardPendingUndo();
    return { ok: true };
  });
}

async function prepareNextSnapshot(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const initial = await getRecordingState();
  if (
    !initial.isRecording ||
    !initial.sessionId ||
    initial.runId !== message.runId ||
    initial.mode !== 'snapshot' ||
    initial.phase !== 'recording'
  ) {
    return controlFailure('目前無法建立下一張快照。');
  }

  control.claimControl({ discardUndo: true, bumpVersion: false });
  await waitForQueuedClicks();

  const previous = await queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      !current.isRecording ||
      current.runId !== message.runId ||
      current.mode !== 'snapshot' ||
      current.phase !== 'recording'
    ) {
      return null;
    }
    await setRecordingState({
      ...current,
      phase: 'preparing-next',
      itemCount: 0,
      groupAnchorId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
      error: null,
      recoverableError: null,
    });
    return current;
  });
  if (!previous) return controlFailure('錄製狀態已改變，未建立下一張快照。');

  await deleteEmptySnapshotAnchor(previous);
  try {
    if (previous.tabId == null) throw new Error('Recorded tab is no longer available.');
    // Re-injection tears down the shield instance and mounts the lightweight
    // preparing-next toolbar without installing step-capture listeners.
    // All-frames mirrors the startup injection so stale child-frame recorders
    // are torn down too (children are no-ops in this phase).
    await recorderRuntime.injectRecorder(previous.tabId, true);
  } catch (error) {
    console.error('[frametrail] failed to enter snapshot preparation state', error);
    await setRunError(message.runId, '無法顯示下一張快照控制，請重新載入一般網站後再試一次。');
    return controlFailure('無法準備下一張快照，已保留目前內容。');
  }
  return { ok: true };
}

async function createNextSnapshot(
  message: RecordingControlMessage,
  sourcePhase: 'preparing-next' | 'invalidated' = 'preparing-next',
): Promise<RecordingControlResult> {
  const claimed = await queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      !current.isRecording ||
      !current.sessionId ||
      current.tabId == null ||
      current.runId !== message.runId ||
      current.mode !== 'snapshot' ||
      current.phase !== sourcePhase
    ) {
      return null;
    }
    const version = control.bumpVersion();
    const next: RecordingState = {
      ...current,
      phase: 'starting',
      itemCount: 0,
      groupAnchorId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
      error: null,
      recoverableError: null,
    };
    await setRecordingState(next);
    return { state: next, previous: current, version };
  });
  if (!claimed) return controlFailure('目前無法建立下一張快照。');

  // The version was already bumped inside the claim mutation above; the
  // recorder gate is cancelled here instead of by a manual pre-cancel so the
  // ready-gate helper below can publish its fresh gate into an empty slot.
  control.claimControl({
    cancelRecorderGate: true,
    discardUndo: true,
    clearSnapshotContext: true,
    bumpVersion: false,
  });
  const { state, previous, version } = claimed;

  try {
    const tab = await browser.tabs.get(state.tabId!);
    if (tab.windowId == null || isRestrictedUrl(tab.url)) throw new Error('Snapshot tab cannot be captured.');
    return await control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity: { runId: message.runId, tabId: state.tabId!, controlVersion: version },
      inject: () => recorderRuntime.injectRecorder(state.tabId!, true),
      notReadyError: () => new StaleCaptureError('Snapshot recorder did not become ready.'),
      ready: async () => {
        if (version !== control.controlVersion) {
          throw new StaleCaptureError('Snapshot recorder did not become ready.');
        }
        const context = control.pendingSnapshotContext;
        if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
        await createAndActivateSnapshotAnchor(state, state.tabId!, tab.windowId!, context, version);
        const updated = await updateRunState(
          message.runId,
          (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
          version,
        );
        if (!updated) throw new StaleCaptureError('Recording changed while activating the next snapshot.');
        control.acceptingClicks = true;
        return { ok: true } as const;
      },
    });
  } catch (error) {
    console.error('[frametrail] failed to create next snapshot', error);
    control.acceptingClicks = false;
    const rebuildingInvalidated = sourcePhase === 'invalidated';
    const errorMessage = rebuildingInvalidated ? REBUILD_SNAPSHOT_FAILED_MESSAGE : CREATE_SNAPSHOT_FAILED_MESSAGE;
    if (version === control.controlVersion) {
      await updateRunState(
        message.runId,
        (current) => ({
          ...current,
          phase: sourcePhase,
          itemCount: rebuildingInvalidated ? previous.itemCount : 0,
          groupAnchorId: rebuildingInvalidated ? previous.groupAnchorId : null,
          snapshotViewport: rebuildingInvalidated ? previous.snapshotViewport : null,
          snapshotDevicePixelRatio: rebuildingInvalidated ? previous.snapshotDevicePixelRatio : null,
          error: errorMessage,
          recoverableError: {
            code: rebuildingInvalidated ? 'REBUILD_SNAPSHOT_FAILED' : 'CREATE_SNAPSHOT_FAILED',
            message: errorMessage,
          },
        }),
        version,
      );
      try {
        await recorderRuntime.injectRecorder(state.tabId!, true);
      } catch (reinjectionError) {
        console.error('[frametrail] failed to restore snapshot preparation toolbar', reinjectionError);
      }
    }
    return controlFailure(errorMessage);
  }
}

async function resetGuideLifecycle(message: ResetGuideMessage): Promise<ResetGuideResult> {
  const initial = await getRecordingState();
  if (initial.operation !== null || initial.isRecording || recaptureFlow.isStartingRecapture()) {
    return { ok: false, error: '錄製或補拍期間無法重置教學。' };
  }
  const guide = await getGuide(message.sessionId);
  if (!guide) return { ok: false, error: '找不到要重置的教學。' };

  // Invalidate any in-memory work first, then wait for all already-queued DB
  // writes. Persisted run/session guards remain authoritative after restarts.
  const version = control.claimControl({ cancelRecorderGate: true, discardUndo: true });
  await waitForQueuedClicks();
  const current = await getRecordingState();
  if (version !== control.controlVersion || current.operation !== null || current.isRecording) {
    return { ok: false, error: '錄製狀態已變更，未重置教學。' };
  }
  try {
    const updated = await resetGuide(message.sessionId);
    if (current.sessionId === message.sessionId) {
      // resetRunStateToIdle also nulls autoCreatedGuideId, which this write
      // never set explicitly; with operation already null the field reads as
      // null through state normalization either way.
      await control.writeStateForControl(version, (latest) => latest.sessionId === message.sessionId
        ? resetRunStateToIdle(latest)
        : latest);
    }
    return { ok: true, contentRevision: updated.contentRevision };
  } catch (error) {
    console.error('[frametrail] failed to reset Guide', error);
    return { ok: false, error: '無法重置教學，請重新載入後再試一次。' };
  }
}

async function openOrFocusEditor(result?: FinishResult): Promise<void> {
  const editorBase = browser.runtime.getURL('/editor.html');
  const editorUrl = new URL(editorBase);
  if (result) {
    editorUrl.searchParams.set('sessionId', result.sessionId);
    if (result.entryId) editorUrl.searchParams.set('entryId', result.entryId);
    if (result.groupId) editorUrl.searchParams.set('groupId', result.groupId);
  }

  // Never redirect an editor that may contain an unsaved description for a
  // different Guide. Focus an existing same-Guide editor or open a new tab.
  const editors = await browser.tabs.query({ url: `${editorBase}*` });
  const existing = result
    ? editors.find((tab) => {
        if (tab.id == null || !tab.url) return false;
        try {
          return new URL(tab.url).searchParams.get('sessionId') === result.sessionId;
        } catch {
          return false;
        }
      })
    : editors.find((tab) => tab.id != null && tab.url === editorBase);
  if (existing?.id != null) {
    await focusTab(existing.id, existing.windowId);
    return;
  }
  await browser.tabs.create({ url: editorUrl.href, active: true });
}

async function latestFinishResult(sessionId: string): Promise<FinishResult> {
  const steps = await getSteps(sessionId);
  const items = steps.filter((step) => step.bounds !== null);
  const lastItem = items.at(-1) ?? null;
  return {
    sessionId,
    entryId: lastItem?.groupId ?? lastItem?.id ?? null,
    groupId: lastItem?.groupId ?? null,
    itemCount: items.length,
  };
}

async function openEditorForStoredSession(message: OpenEditorMessage): Promise<OpenEditorResult> {
  const expectedControlVersion = control.controlVersion;
  let state: RecordingState | null = null;
  let targetSessionId = message.sessionId;
  try {
    state = await getRecordingState();
    targetSessionId ??= state.sessionId ?? undefined;
    if (!targetSessionId) {
      await openOrFocusEditor();
      return { ok: true };
    }
    const guide = await getGuide(targetSessionId);
    if (!guide) return { ok: false, error: '找不到這份教學。' };
    // Only a hand-off continues where the capture stopped: finishing a run, or
    // recovering one whose recorded tab went away. Ordinary navigation opens the
    // guide at its first entry — deriving the target from the newest capture
    // made every "open editor" land on the last step.
    const resumesInterruptedRun =
      state.sessionId === targetSessionId && needsEditorRecovery(state.recoverableError);
    const result: FinishResult = resumesInterruptedRun
      ? await latestFinishResult(targetSessionId)
      : { sessionId: targetSessionId, entryId: null, groupId: null, itemCount: 0 };
    if (message.entryId) result.entryId = message.entryId;
    await openOrFocusEditor(result);
    if (state.sessionId === targetSessionId) {
      await control.writeStateForControl(expectedControlVersion, (current) => {
        if (current.sessionId !== targetSessionId) return current;
        return clearEditorRecovery(current);
      });
    }
    return { ok: true };
  } catch (error) {
    console.error('[frametrail] failed to open editor:', describeBrowserError(error), error);
    if (state?.sessionId === targetSessionId) {
      try {
        await control.writeStateForControl(expectedControlVersion, (current) => {
          if (current.sessionId !== targetSessionId) return current;
          return markEditorOpenFailed(current);
        });
      } catch (recoveryError) {
        console.error(
          '[frametrail] failed to persist editor recovery state:',
          describeBrowserError(recoveryError),
          recoveryError,
        );
      }
    }
    return { ok: false, error: EDITOR_OPEN_FAILED_MESSAGE };
  }
}

async function finishRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const startedAtControlVersion = control.controlVersion;
  const initial = await getRecordingState();
  if (
    !initial.isRecording ||
    initial.runId !== message.runId ||
    (initial.phase !== 'recording' &&
      initial.phase !== 'paused' &&
      initial.phase !== 'preparing-next' &&
      initial.phase !== 'invalidated')
  ) {
    return controlFailure(initial.phase === 'finishing' ? '正在完成錄製。' : '這次錄製已經結束。');
  }

  control.claimControl({ discardUndo: true, bumpVersion: false });
  const markedFinishing = await control.writeStateIf(
    startedAtControlVersion,
    (current) =>
      current.isRecording &&
      current.runId === message.runId &&
      (current.phase === 'recording' ||
        current.phase === 'paused' ||
        current.phase === 'preparing-next' ||
        current.phase === 'invalidated'),
    (current) => ({ ...current, phase: 'finishing', error: null, recoverableError: null }),
  );
  if (!markedFinishing) return controlFailure('錄製狀態已改變，請再試一次。');

  await waitForQueuedClicks();
  if (startedAtControlVersion !== control.controlVersion) return controlFailure('錄製狀態已改變。');

  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId || state.runId !== message.runId) {
    return controlFailure('這次錄製已經結束。');
  }
  const steps = await getSteps(state.sessionId);
  const runItems = steps.filter((step) => step.runId === message.runId && step.bounds !== null);
  const lastItem = runItems.at(-1) ?? null;
  const result: FinishResult = {
    sessionId: state.sessionId,
    entryId: lastItem?.groupId ?? lastItem?.id ?? null,
    groupId: lastItem?.groupId ?? null,
    itemCount: runItems.length,
  };

  const version = control.bumpVersion();
  // No reclaim on FINISH even at zero items: openOrFocusEditor below opens
  // this very Guide, and the user reaches it visibly in the editor.
  const stopped = await control.writeStateForControl(version, resetRunStateToIdle);
  if (!stopped) return controlFailure('無法完成錄製，請再試一次。');

  // Only after the finish won the state write: a service-worker death or lost
  // race between an earlier delete and the write used to leave a run in phase
  // 'finishing' whose groupAnchorId pointed at a deleted anchor row.
  await deleteEmptySnapshotAnchorBestEffort(state);
  await recorderRuntime.stopRecorderInTab(state.tabId);
  try {
    await openOrFocusEditor(result);
  } catch (error) {
    console.error('[frametrail] failed to open editor after recording', error);
    await control.writeStateForControl(version, markEditorOpenFailed);
    return { ok: true, finish: result };
  }
  return { ok: true, finish: result };
}

async function discardCurrentRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const startedAtControlVersion = control.controlVersion;
  const initial = await getRecordingState();
  if (
    startedAtControlVersion !== control.controlVersion ||
    !initial.isRecording ||
    !initial.sessionId ||
    initial.runId !== message.runId ||
    initial.phase === 'starting' ||
    initial.phase === 'finishing'
  ) {
    return controlFailure('這次錄製已經結束或無法放棄。');
  }

  const version = control.claimControl({ discardUndo: true });
  await waitForQueuedClicks();

  const state = await getRecordingState();
  if (
    version !== control.controlVersion ||
    !state.isRecording ||
    !state.sessionId ||
    state.runId !== message.runId
  ) {
    return controlFailure('錄製狀態已改變，請再試一次。');
  }

  try {
    await deleteStepsForRun(state.sessionId, message.runId);
    const stopped = await control.writeStateForControl(version, resetRunStateToIdle);
    if (!stopped) return controlFailure('無法放棄錄製，請再試一次。');
    await recorderRuntime.stopRecorderInTab(state.tabId);
    // The run's steps are already deleted, so a popup-created Guide is back to
    // an empty shell here — the exact case the reclaim exists for.
    await reclaimAbandonedAutoCreatedGuide(state);
    return { ok: true };
  } catch (error) {
    console.error('[frametrail] failed to discard current recording', error);
    await control.writeStateForControl(version, (current) => ({
      ...current,
      error: '無法放棄錄製，請再試一次。',
      recoverableError: { code: 'DISCARD_FAILED', message: '無法放棄錄製，請再試一次。' },
    }));
    return controlFailure('無法放棄錄製，請再試一次。');
  }
}

async function handleRecordingControl(
  message: RecordingControlMessage,
  sender?: RuntimeMessageSenderLike,
): Promise<RecordingControlResult> {
  if (sender && !isTrustedExtensionPageSender(sender, browser.runtime.getURL('/'))) {
    const state = await getRecordingState();
    if (
      !state.isRecording ||
      state.runId !== message.runId ||
      !isTrustedRecorderControlSender(sender, state.tabId)
    ) {
      console.warn('[frametrail] rejected an untrusted recorder control message', message.type);
      return controlFailure('目前無法執行這個錄製動作。');
    }
  }

  switch (message.type) {
    case 'PAUSE_RECORDING':
      return pauseRecording(message);
    case 'RESUME_RECORDING':
      return resumeRecording(message);
    case 'UNDO_LAST_CAPTURE':
      return undoLastCapture(message);
    case 'RESTORE_LAST_CAPTURE':
      return restoreLastCapture(message);
    case 'PREPARE_NEXT_SNAPSHOT':
      return prepareNextSnapshot(message);
    case 'CREATE_NEXT_SNAPSHOT':
      return createNextSnapshot(message);
    case 'REBUILD_INVALIDATED_SNAPSHOT':
      return createNextSnapshot(message, 'invalidated');
    case 'DISCARD_CURRENT_RECORDING':
      return discardCurrentRecording(message);
    case 'FINISH_RECORDING':
      return finishRecording(message);
  }
}

/**
 * Routes a configurable browser keyboard shortcut to the active recording's
 * control handlers (UX_PLAN §8.3). Shortcuts carry no runId, so the current
 * authoritative state supplies it; the handlers stay the single source of
 * truth and remain idempotent, so acting in a wrong phase is a safe no-op.
 */
async function handleCommandShortcut(command: string): Promise<void> {
  const state = await getRecordingState();
  if (!state.isRecording || !state.runId) return;
  const runId = state.runId;
  switch (command) {
    case 'toggle-pause':
      // Pause/resume is a steps-mode affordance; snapshot has no pause (§9.2).
      if (state.mode !== 'steps') return;
      if (state.phase === 'recording') {
        await handleRecordingControl({ type: 'PAUSE_RECORDING', runId });
      } else if (state.phase === 'paused') {
        await handleRecordingControl({ type: 'RESUME_RECORDING', runId });
      }
      return;
    case 'undo-last-capture':
      await handleRecordingControl({ type: 'UNDO_LAST_CAPTURE', runId });
      return;
    case 'finish-recording':
      await handleRecordingControl({ type: 'FINISH_RECORDING', runId });
      return;
  }
}

async function captureScreenshotWithGuard(
  message: Pick<ClickCapture, 'viewport' | 'devicePixelRatio' | 'captureId'>,
  tabId: number,
  windowId: number,
  assertContext: () => Promise<void>,
): Promise<{ blob: Blob; scale: number }> {
  return queueCapture(async () => {
    const guard = async () => {
      assertCaptureNotCancelled(message.captureId);
      await assertContext();
      assertCaptureNotCancelled(message.captureId);
    };
    await guard();
    const dataUrl = await withCapturePresentation(
      {
        insert: () => browser.scripting.insertCSS({
          target: { tabId, frameIds: [0] },
          css: CAPTURE_PRESENTATION_CSS,
          origin: 'USER',
        }),
        settle: async () => {
          await browser.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            func: waitForCapturePresentationPaint,
          });
        },
        remove: () => browser.scripting.removeCSS({
          target: { tabId, frameIds: [0] },
          css: CAPTURE_PRESENTATION_CSS,
          origin: 'USER',
        }),
      },
      () => recorderRuntime.captureVisibleTabWithRetry(windowId, guard),
    );
    const blob = await recorderRuntime.dataUrlToBlob(dataUrl);
    const scale = await recorderRuntime.getScreenshotScale(blob, message.viewport, message.devicePixelRatio);
    // Do not persist an image after a stop/cancel/new operation arrives while
    // captureVisibleTab or image decoding is still in flight.
    await guard();
    return { blob, scale };
  });
}

async function captureScreenshot(
  message: Pick<ClickCapture, 'runId' | 'url' | 'viewport' | 'devicePixelRatio' | 'captureId'>,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedControlVersion: number,
): Promise<{ blob: Blob; scale: number }> {
  return captureScreenshotWithGuard(message, tabId, windowId, () =>
    assertCaptureContext(expectedControlVersion, message.runId, sessionId, tabId, windowId, message.url),
  );
}

async function handleSnapshotClick(
  message: ClickCapture,
  sessionId: string,
  state: RecordingState,
  expectedControlVersion: number,
): Promise<void> {
  const anchorId = state.groupAnchorId;

  if (
    state.snapshotViewport &&
    state.snapshotDevicePixelRatio != null &&
    !isMatchingSnapshotViewport(
      state.snapshotViewport,
      state.snapshotDevicePixelRatio,
      message.viewport,
      message.devicePixelRatio,
    )
  ) {
    throw new SnapshotViewportChangedError(
      'Snapshot annotation skipped because the viewport or scroll position changed.',
    );
  }

  // A missing anchor (or one without its base image) can never accept another
  // annotation; the typed error makes handleClick settle the whole run once
  // instead of surfacing the same per-click error forever.
  if (!anchorId) throw new SnapshotAnchorMissingError('Snapshot anchor id is missing from the run state.');
  let existingSteps = await getSteps(sessionId);
  const anchor = existingSteps.find((step) => step.id === anchorId);

  if (!anchor?.screenshotBlob) {
    throw new SnapshotAnchorMissingError('Snapshot anchor row or its base image no longer exists.');
  }
  // This throw message surfaces to the user through setRunError, so zh-Hant.
  if (anchor.url !== message.url) {
    throw new Error('已略過此標註：頁面在底圖拍攝後已變更。');
  }
  if (expectedControlVersion !== control.controlVersion) {
    throw new StaleCaptureError('Recording control changed while saving the annotation.');
  }
  const current = await getRecordingState();
  if (!current.isRecording || current.runId !== message.runId || current.sessionId !== sessionId) {
    throw new StaleCaptureError('Recording changed while saving the annotation.');
  }
  existingSteps = await getSteps(sessionId);
  await persistRecordingSteps(state, [{
    id: crypto.randomUUID(),
    sessionId,
    runId: message.runId,
    order: existingSteps.length,
    bounds: message.rect,
    devicePixelRatio: anchor.devicePixelRatio,
    screenshotScale: anchor.screenshotScale,
    description: generateActionDescription(message),
    url: message.url,
    timestamp: message.timestamp,
    groupId: anchorId,
    numbered: state.numbered,
  }]);
}

function isTrustedRecordedPageSender(
  messageUrl: string,
  sender: Browser.runtime.MessageSender,
  expectedTabId: number,
): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id === expectedTabId &&
    sender.url === messageUrl &&
    sender.tab.url === messageUrl
  );
}

async function handleCancelCapture(
  message: Extract<BackgroundMessage, { type: 'FRAME_TRAIL_CANCEL_CAPTURE' }>,
  sender: Browser.runtime.MessageSender,
): Promise<ClickCaptureResult> {
  const state = await getRecordingState();
  if (
    !state.isRecording ||
    state.operation !== 'recording' ||
    state.runId !== message.runId ||
    sender.frameId !== 0 ||
    sender.tab?.id !== state.tabId
  ) {
    return { ok: false };
  }
  cancelCapture(message.captureId);
  return { ok: true };
}

async function handleClick(
  message: ClickCapture,
  sender: Browser.runtime.MessageSender,
  expectedControlVersion: number,
): Promise<ClickCaptureResult> {
  const rejectBeforeTransaction = (): ClickCaptureResult => {
    releaseCapture(message.captureId);
    return { ok: false };
  };
  if (expectedControlVersion !== control.controlVersion) return rejectBeforeTransaction();
  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId || state.runId !== message.runId) return rejectBeforeTransaction();
  if (state.phase !== 'recording' && state.phase !== 'finishing') return rejectBeforeTransaction();
  if (state.tabId == null || !isTrustedRecordedPageSender(message.url, sender, state.tabId)) {
    return rejectBeforeTransaction();
  }
  const windowId = sender.tab?.windowId;
  const tabId = sender.tab?.id;
  if (windowId == null || tabId == null) return rejectBeforeTransaction();

  try {
    discardPendingUndo();
    if (state.mode === 'snapshot') {
      await handleSnapshotClick(message, state.sessionId, state, expectedControlVersion);
    } else {
      const captured = await captureScreenshot(message, state.sessionId, tabId, windowId, expectedControlVersion);
      const existingSteps = await getSteps(state.sessionId);
      const current = await getRecordingState();
      if (!current.isRecording || current.runId !== message.runId || current.sessionId !== state.sessionId) {
        throw new StaleCaptureError('Recording changed while saving the step.');
      }
      if (expectedControlVersion !== control.controlVersion) {
        throw new StaleCaptureError('Recording control changed while saving the step.');
      }
      assertCaptureNotCancelled(message.captureId);
      // No await may occur between this synchronous commit marker and the
      // persisting write: a cancellation arriving afterwards must not create a
      // half-cancelled transaction that writes a step after the gesture has
      // been replayed.
      markCaptureCommitting(message.captureId);
      await persistRecordingSteps(state, [{
        id: crypto.randomUUID(),
        sessionId: state.sessionId,
        runId: message.runId,
        order: existingSteps.length,
        screenshotBlob: captured.blob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale: captured.scale,
        description: generateActionDescription(message),
        url: message.url,
        timestamp: message.timestamp,
      }]);
    }
    await updateRunState(message.runId, (currentState) => ({
      ...currentState,
      itemCount: currentState.itemCount + 1,
      error: null,
      recoverableError: null,
    }));
    return { ok: true };
  } catch (err) {
    try {
      if (err instanceof SnapshotViewportChangedError) {
        await invalidateSnapshotRun(
          message.runId,
          message.viewport,
          message.devicePixelRatio,
          expectedControlVersion,
        );
      } else if (err instanceof SnapshotAnchorMissingError) {
        // The run can never accept another annotation; settle it once with a
        // recoverable error instead of failing every subsequent click.
        console.error('[frametrail] snapshot anchor is gone; settling the run:', err.message);
        await stopRunWithError(
          message.runId,
          SNAPSHOT_ANCHOR_MISSING_ERROR.message,
          expectedControlVersion,
          SNAPSHOT_ANCHOR_MISSING_ERROR,
        );
      } else if (isMissingTabError(err)) {
        await stopRunWithError(
          message.runId,
          RECORDED_TAB_CLOSED_ERROR.message,
          expectedControlVersion,
          RECORDED_TAB_CLOSED_ERROR,
        );
      } else if (!(err instanceof StaleCaptureError)) {
        const messageText = describeBrowserError(err, '無法擷取並儲存此步驟。');
        console.error(
          '[frametrail] failed to capture/annotate/save step:',
          messageText,
          err,
        );
        await setRunError(message.runId, messageText);
      }
    } catch (recoveryError) {
      control.acceptingClicks = false;
      console.error(
        '[frametrail] failed to persist capture failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
    return { ok: false };
  } finally {
    releaseCapture(message.captureId);
  }
}


async function withMessageFailureFallback<T>(
  operation: Promise<T>,
  label: string,
  fallback: T,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    console.error(`[frametrail] ${label}:`, describeBrowserError(error), error);
    return fallback;
  }
}

export default defineBackground(() => {
  // A worker woken by a capture message from a page whose persisted run is
  // stale (e.g. a bfcache-restored recorder) must not race startup recovery:
  // clicks queue behind this settle so a dead run is retired silently by
  // recovery instead of loudly by the click's own error paths.
  const startupRecovery = (async () => {
    await recaptureFlow.recoverInterruptedRecapture();
    await recoverInterruptedRecording();
  })().catch((error) => {
    console.error('[frametrail] failed to recover an interrupted operation', error);
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isBackgroundMessage(message)) return undefined;
    if (
      isExtensionPageOnlyMessage(message) &&
      !isTrustedExtensionPageSender(sender, browser.runtime.getURL('/'))
    ) {
      console.warn('[frametrail] rejected an untrusted extension control message', message.type);
      return undefined;
    }

    switch (message.type) {
      case 'START_RECORDING':
        return withMessageFailureFallback(
          queueLifecycle(() => startRecording(message, sender)),
          'start recording request failed',
          { ok: false, error: '無法啟動錄製服務，請重新整理頁面後再試一次。' } satisfies StartRecordingResult,
        );
      case 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION':
        return withMessageFailureFallback(
          recaptureFlow.preflightStepRecaptureSourcePermission(message, sender),
          'recapture source preflight failed',
          {
            ok: false,
            code: 'INVALID_EDITOR',
            message: '補拍服務發生錯誤，請重新整理編輯器後再試一次。',
          } satisfies PreflightStepRecaptureSourcePermissionResult,
        );
      case 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION':
        return withMessageFailureFallback(
          preflightGuideContinuationSourcePermission(message, sender),
          'continuation source preflight failed',
          {
            ok: false,
            code: 'INVALID_EDITOR',
            message: '接續錄製服務發生錯誤，請重新整理編輯器後再試一次。',
          } satisfies PreflightGuideContinuationSourcePermissionResult,
        );
      case 'START_STEP_RECAPTURE':
        return withMessageFailureFallback(
          recaptureFlow.startStepRecapture(message, sender),
          'start recapture request failed',
          {
            ok: false,
            code: 'INJECTION_FAILED',
            error: '補拍服務發生錯誤，請再試一次。',
          } satisfies StartStepRecaptureResult,
        );
      case 'CANCEL_STEP_RECAPTURE':
        return withMessageFailureFallback(
          recaptureFlow.cancelStepRecapture(message, sender),
          'cancel recapture request failed',
          { ok: false, error: '取消補拍時發生錯誤，請再試一次。' } satisfies CancelStepRecaptureResult,
        );
      case 'ACK_STEP_RECAPTURE_RESULT':
        return withMessageFailureFallback(
          recaptureFlow.ackStepRecaptureResult(message, sender),
          'recapture result ack failed',
          false,
        );
      case 'FOCUS_STEP_RECAPTURE_SOURCE':
        return withMessageFailureFallback(
          recaptureFlow.focusStepRecaptureSource(message, sender),
          'focus recapture source failed',
          { ok: false, error: '無法切換到補拍分頁，請再試一次。' } satisfies FocusStepRecaptureSourceResult,
        );
      case 'STOP_RECORDING':
        // Currently exercised only by the e2e harness; product surfaces end a
        // run through FINISH_RECORDING or DISCARD_CURRENT_RECORDING.
        return withMessageFailureFallback(
          queueLifecycle(() => stopRecording()),
          'stop recording request failed',
          undefined,
        );
      case 'RESET_GUIDE':
        return withMessageFailureFallback(
          queueLifecycle(() => resetGuideLifecycle(message)),
          'reset guide request failed',
          { ok: false, error: '無法重置教學，請再試一次。' } satisfies ResetGuideResult,
        );
      case 'OPEN_EDITOR':
        return withMessageFailureFallback(
          openEditorForStoredSession(message),
          'open editor request failed',
          { ok: false, error: EDITOR_OPEN_FAILED_MESSAGE } satisfies OpenEditorResult,
        );
      case 'PAUSE_RECORDING':
      case 'RESUME_RECORDING':
      case 'UNDO_LAST_CAPTURE':
      case 'RESTORE_LAST_CAPTURE':
      case 'PREPARE_NEXT_SNAPSHOT':
      case 'CREATE_NEXT_SNAPSHOT':
      case 'REBUILD_INVALIDATED_SNAPSHOT':
      case 'DISCARD_CURRENT_RECORDING':
      case 'FINISH_RECORDING':
        return withMessageFailureFallback(
          handleRecordingControl(message, sender),
          'recording toolbar request failed',
          { ok: false, error: '錄製服務發生錯誤，請重新整理頁面後再試一次。' } satisfies RecordingControlResult,
        );
      case 'SNAPSHOT_INVALIDATED':
        return withMessageFailureFallback(
          handleSnapshotInvalidated(message, sender),
          'snapshot invalidation handling failed',
          false,
        );
      case 'SNAPSHOT_RECORDER_FAILED':
        return withMessageFailureFallback(
          handleSnapshotRecorderFailure(message, sender),
          'snapshot recorder failure recovery failed',
          false,
        );
      case 'FRAME_TRAIL_RECAPTURE_TARGET':
        if (!control.acceptingClicks) {
          return Promise.resolve({ ok: false, status: 'rejected' } satisfies StepRecaptureTargetResult);
        }
        {
          const expectedControlVersion = control.controlVersion;
          return withMessageFailureFallback(
            queueClick(async () => {
              await startupRecovery;
              return recaptureFlow.handleRecaptureTarget(message, sender, expectedControlVersion);
            }),
            'recapture target handling failed',
            { ok: false, status: 'failed' } satisfies StepRecaptureTargetResult,
          );
        }
      case 'FRAME_TRAIL_CLICK':
        if (!control.acceptingClicks) return Promise.resolve({ ok: false } satisfies ClickCaptureResult);
        {
          const expectedControlVersion = control.controlVersion;
          return withMessageFailureFallback(
            queueClick(async () => {
              // The version was read before recovery: if this very message woke
              // the worker over a stale persisted run, recovery settles the run
              // and the bumped version rejects the click silently.
              await startupRecovery;
              return handleClick(message, sender, expectedControlVersion);
            }),
            'capture request failed',
            { ok: false } satisfies ClickCaptureResult,
          );
        }
      case 'FRAME_TRAIL_CANCEL_CAPTURE':
        return withMessageFailureFallback(
          handleCancelCapture(message, sender),
          'capture cancellation failed',
          { ok: false } satisfies ClickCaptureResult,
        );
      case 'FRAME_TRAIL_READY':
        return withMessageFailureFallback(
          handleRecorderReady(message, sender),
          'recorder ready handling failed',
          false,
        );
      case 'FRAME_TRAIL_RECAPTURE_READY':
        return withMessageFailureFallback(
          recaptureFlow.handleRecaptureReady(message, sender),
          'recapture ready handling failed',
          false,
        );
    }
  });

  browser.commands?.onCommand.addListener((command) => {
    void handleCommandShortcut(command).catch((error) => {
      console.error('[frametrail] failed to handle command shortcut', error);
    });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      try {
        port.disconnect();
      } catch {
        // The sender may already have disappeared during authorization.
      }
    };
    // An authoritative rejection tells the client its capture job is over so
    // it tears its UI down, instead of mistaking the disconnect for a worker
    // restart and reconnecting (and waking this worker) forever.
    const reject = () => {
      if (disconnected) return;
      try {
        port.postMessage({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
      } catch {
        // The port may already be gone; the client's give-up cap still applies.
      }
      disconnect();
    };
    const authorize = () => {
      void getRecordingState().then((state) => {
        if (!disconnected && !isTrustedKeepAliveSender(port.sender ?? {}, state)) reject();
      }).catch((error) => {
        // Reading state failed, which says nothing about the sender: drop the
        // port without the rejection message so a healthy recorder reconnects.
        console.error('[frametrail] failed to authorize keep-alive port', error);
        disconnect();
      });
    };
    port.onDisconnect.addListener(() => {
      disconnected = true;
      // A recorded page that navigates hands its port to the back/forward
      // cache, which closes the channel with a runtime.lastError. Reading it
      // here acknowledges the expected disconnect so Chrome stops logging
      // "Unchecked runtime.lastError" for every recorded-page navigation.
      void browser.runtime.lastError;
    });
    port.onMessage.addListener((message) => {
      if (message?.type !== 'heartbeat') {
        reject();
        return;
      }
      authorize();
    });
    authorize();
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void (async () => {
      if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
      // The recapture leg lives with its flow; the listener stays wired here,
      // mirroring follow-mode's listener/logic split.
      if (await recaptureFlow.handleSourceTabUpdated(tabId, changeInfo)) return;
      const expectedControlVersion = control.controlVersion;
      const state = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        !state.isRecording ||
        state.operation !== 'recording' ||
        state.tabId !== tabId ||
        !state.runId
      ) {
        return;
      }
      const runId = state.runId;

      if (state.mode === 'snapshot' && state.phase === 'preparing-next') {
        if (changeInfo.status !== 'complete') return;
        if (isRestrictedUrl(tab.url)) {
          await setRunError(runId, '此頁面無法建立快照；請返回一般網站或完成錄製。');
          return;
        }
        try {
          await recorderRuntime.injectRecorder(tabId, true);
        } catch (err) {
          if (isMissingTabError(err)) {
            await stopRunWithError(
              runId,
              RECORDED_TAB_CLOSED_ERROR.message,
              expectedControlVersion,
              RECORDED_TAB_CLOSED_ERROR,
            );
            return;
          }
          console.error(
            '[frametrail] failed to restore snapshot preparation toolbar after navigation:',
            describeBrowserError(err),
            err,
          );
          await setRunError(runId, '無法在這個頁面顯示錄製控制；請重新載入一般網站後再試一次。');
        }
        return;
      }

      const updateAction = getRecordingTabUpdateAction(state.mode, changeInfo);
      // A snapshot's coordinates belong to one immutable document. Fail closed
      // as soon as that document navigates, and never re-inject merely because a
      // document that was loading at START later reports status=complete.
      if (updateAction === 'stop-snapshot') {
        await stopRunWithError(runId, '錄製已停止，因為快照頁面已變更。', expectedControlVersion);
        return;
      }
      if (updateAction !== 'reinject') return;

      if (isRestrictedUrl(tab.url)) {
        await stopRunWithError(
          runId,
          '錄製已停止，因為新開啟的頁面不允許錄製。',
          expectedControlVersion,
        );
        return;
      }
      try {
        // All-frames mirrors the START injection: step mode instruments every
        // accessible child frame so iframe clicks keep being relayed to the
        // top-frame recorder after a navigation, not silently lost.
        await recorderRuntime.injectRecorder(tabId, true);
      } catch (err) {
        if (isMissingTabError(err)) {
          await stopRunWithError(
            runId,
            RECORDED_TAB_CLOSED_ERROR.message,
            expectedControlVersion,
            RECORDED_TAB_CLOSED_ERROR,
          );
          return;
        }
        console.error(
          '[frametrail] failed to re-inject recorder after navigation:',
          describeBrowserError(err),
          err,
        );
        await stopRunWithError(
          runId,
          '錄製已停止，因為頁面切換後無法載入錄製工具。',
          expectedControlVersion,
        );
      }
    })().catch((error) => {
      console.error('[frametrail] failed to handle recorded tab update', error);
    });
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    followMode.scheduleRecordingFollow(tabId);
  });

  // Cross-window switches raise no tabs.onActivated; follow the newly focused
  // window's active tab instead. WINDOW_ID_NONE (-1) means focus left Chrome.
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return;
    void browser.tabs.query({ active: true, windowId }).then(([tab]) => {
      if (tab?.id != null) followMode.scheduleRecordingFollow(tab.id);
    }).catch((error) => {
      console.warn('[frametrail] failed to inspect the focused window', error);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      if (await recaptureFlow.handleSourceTabRemoved(tabId)) return;
      const expectedControlVersion = control.controlVersion;
      const state = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        !state.isRecording ||
        state.operation !== 'recording' ||
        state.tabId !== tabId ||
        !state.runId
      ) {
        return;
      }
      await stopRunWithError(
        state.runId,
        RECORDED_TAB_CLOSED_ERROR.message,
        expectedControlVersion,
        RECORDED_TAB_CLOSED_ERROR,
      );
    })().catch((error) => {
      console.error('[frametrail] failed to handle recorded tab removal', error);
    });
  });

  // Through the click queue so rehydration is ordered before any queued
  // restore/undo message this startup is already receiving.
  void queueClick(recoverPendingUndo).catch((error) => {
    console.error('[frametrail] failed to recover the undo window', error);
  });
});

import { browser, type Browser } from 'wxt/browser';
import {
  SNAPSHOT_VIEWPORT_CHANGED_MESSAGE,
  SnapshotViewportChangedError,
  StaleCaptureError,
  queueCapture,
  queueClick,
  queueLifecycle,
  queueStateMutation,
  waitForQueuedClicks,
} from '@/lib/recording/background-queues';
import { generateActionDescription } from '@/lib/capture/action-description';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';
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
  deleteStep,
  deleteStepsForRun,
  getEffectiveBounds,
  getGuide,
  getStep,
  getSteps,
  replaceStepCaptureAtomically,
  resetGuide,
  StepRecaptureError,
  type Step,
  type StepRecaptureTarget as DbStepRecaptureTarget,
} from '@/lib/storage/db';
import {
  getCaptureGuardFailure,
  getRecordingTabUpdateAction,
  isMatchingSnapshotViewport,
  isValidSnapshotViewportContext,
} from '@/lib/recording/recording-guards';
import { isTrustedEditorSenderForSession, isTrustedRecaptureSourceSender } from '@/lib/capture/recapture-guards';
import { RecorderReadyGate } from '@/lib/recording/recorder-ready';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import {
  clearPendingUndoRecord,
  readPendingUndoRecord,
  savePendingUndoRecord,
} from '@/lib/recording/background/pending-undo-store';
import { KEEPALIVE_REJECTED_MESSAGE_TYPE } from '@/lib/runtime/keep-alive';
import { describeBrowserError, isMissingTabError } from '@/lib/runtime/browser-errors';
import { waitForTabComplete } from '@/lib/runtime/tab-loading';
import { getRecordingState, setRecordingState } from '@/lib/storage/storage';
import {
  clearEditorRecovery,
  markEditorOpenFailed,
  needsEditorRecovery,
  RECORDED_TAB_CLOSED_ERROR,
} from '@/lib/recording/recording-recovery';
import type {
  AckStepRecaptureResultMessage,
  BackgroundMessage,
  CancelStepRecaptureMessage,
  CancelStepRecaptureResult,
  ClickCapture,
  ClickCaptureResult,
  FinishResult,
  FocusStepRecaptureSourceMessage,
  FocusStepRecaptureSourceResult,
  FrameTrailRecaptureReadyMessage,
  FrameTrailRecaptureTargetMessage,
  FrameTrailSnapshotActiveMessage,
  OpenEditorMessage,
  OpenEditorResult,
  PreflightGuideContinuationSourcePermissionErrorCode,
  PreflightGuideContinuationSourcePermissionMessage,
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionErrorCode,
  PreflightStepRecaptureSourcePermissionMessage,
  PreflightStepRecaptureSourcePermissionResult,
  RecoverableRecordingError,
  ResetGuideMessage,
  ResetGuideResult,
  RecordingControlMessage,
  RecordingControlResult,
  RecordingState,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
  StartRecordingMessage,
  StartRecordingResult,
  StartStepRecaptureMessage,
  StartStepRecaptureResult,
  StepRecaptureResult,
  SourcePermissionPreflightSuccess,
  StepRecaptureTargetResult,
} from '@/lib/runtime/messages';

const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';
const RECORDER_READY_TIMEOUT_MS = 5_000;
/** Every run starts numbered. Numbering is a per-snapshot presentation choice,
 * so the editor owns turning it off where the result is visible; asking before
 * the first capture made the user decide blind. Captures still stamp the run's
 * value onto each step, so turning it off later never rewrites older images. */
const RUN_STARTS_NUMBERED = true;
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
// Control messages invalidate work synchronously, before their first await.
// Persisted runId provides the same protection across service-worker restarts.
let controlVersion = 0;
let acceptingClicks = true;
let pendingRecorderReady: RecorderReadyGate | null = null;
let pendingRecaptureReady: RecorderReadyGate | null = null;
let activeRecaptureCaptureId: string | null = null;
let pendingSnapshotContext: Extract<BackgroundMessage, { type: 'FRAME_TRAIL_READY' }>['snapshotContext'] = undefined;
let pendingUndo:
  | {
      token: string;
      runId: string;
      step: Step;
      expectedItemCount: number;
      expiresAt: number;
    }
  | null = null;

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

const cancelledCaptureIds = new Set<string>();
const committingCaptureIds = new Set<string>();

function cancelCapture(captureId: string): void {
  if (committingCaptureIds.has(captureId)) return;
  cancelledCaptureIds.add(captureId);
  while (cancelledCaptureIds.size > 1_024) {
    const oldest = cancelledCaptureIds.values().next().value as string | undefined;
    if (!oldest) break;
    cancelledCaptureIds.delete(oldest);
  }
}

function assertCaptureNotCancelled(captureId: string): void {
  if (cancelledCaptureIds.has(captureId)) throw new StaleCaptureError('Capture was cancelled before it could be saved.');
}

async function stopRecordingSource(state: RecordingState): Promise<void> {
  await recorderRuntime.stopRecorderInTab(state.tabId);
}

async function updateRunState(
  runId: string,
  update: (current: RecordingState) => RecordingState,
  expectedControlVersion?: number,
): Promise<boolean> {
  return queueStateMutation(async () => {
    if (expectedControlVersion != null && expectedControlVersion !== controlVersion) return false;
    const current = await getRecordingState();
    if (
      (expectedControlVersion != null && expectedControlVersion !== controlVersion) ||
      !current.isRecording ||
      current.operation !== 'recording' ||
      current.runId !== runId
    ) {
      return false;
    }
    await setRecordingState(update(current));
    return true;
  });
}

async function setRunError(runId: string, error: string): Promise<void> {
  await updateRunState(runId, (current) => ({
    ...current,
    error,
    recoverableError: { code: 'CAPTURE_FAILED', message: error },
  }));
}

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
      expectedControlVersion !== controlVersion ||
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

    acceptingClicks = false;
    discardPendingUndo();
    controlVersion++;
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
  if (expectedControlVersion !== controlVersion) return Promise.resolve();
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  const version = ++controlVersion;
  return handleStopRunWithError(runId, error, version, recoverableError);
}

async function handleStopRunWithError(
  runId: string,
  error: string,
  version: number,
  recoverableError?: RecoverableRecordingError,
): Promise<void> {
  const stoppedState = await queueStateMutation(async () => {
    const state = await getRecordingState();
    if (version !== controlVersion || !state.isRecording || state.runId !== runId) return null;
    await setRecordingState({
      ...state,
      operation: null,
      isRecording: false,
      phase: 'error',
      tabId: null,
      error,
      recoverableError: recoverableError ?? { code: 'RECORDING_STOPPED', message: error },
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    });
    return state;
  });
  if (!stoppedState) return;
  // Only after the run stopped referencing it: an interruption here leaks an
  // orphan row at worst, never a live run pointing at a deleted anchor.
  try {
    await deleteEmptySnapshotAnchor(stoppedState);
  } catch (cleanupError) {
    console.error('[frametrail] failed to remove the empty snapshot anchor:', describeBrowserError(cleanupError), cleanupError);
  }
  await stopRecordingSource(stoppedState);
}

async function writeStateForControl(
  version: number,
  update: (current: RecordingState) => RecordingState,
): Promise<RecordingState | null> {
  return queueStateMutation(async () => {
    if (version !== controlVersion) return null;
    const current = await getRecordingState();
    if (version !== controlVersion) return null;
    const next = update(current);
    await setRecordingState(next);
    return next;
  });
}

async function assertCaptureContext(
  expectedControlVersion: number,
  runId: string,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedUrl: string,
): Promise<void> {
  if (expectedControlVersion !== controlVersion) {
    throw new StaleCaptureError('Recording control changed before the screenshot could be taken.');
  }
  const state = await getRecordingState();
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  const failure = getCaptureGuardFailure({
    expectedControlVersion,
    currentControlVersion: controlVersion,
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

type SnapshotCaptureContext = NonNullable<
  Extract<BackgroundMessage, { type: 'FRAME_TRAIL_READY' }>['snapshotContext']
>;

function readPendingSnapshotContext(): SnapshotCaptureContext | undefined {
  return pendingSnapshotContext;
}


async function persistRecordingSteps(
  state: RecordingState,
  steps: Step[],
  _expectedControlVersion: number,
): Promise<void> {
  if (!state.sessionId || !state.runId) throw new StaleCaptureError('Recording is no longer active.');
  for (const step of steps) await addStep(step);
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
    }], version);
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

    acceptingClicks = true;
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
    acceptingClicks = false;
    if (anchorId) {
      // A published anchor id must be withdrawn from the run state before its
      // row disappears; if withdrawal fails, keep the row (an orphan at worst)
      // so the state never dangles into a deleted anchor.
      const removedAnchorId = anchorId;
      const safeToDelete = !anchorPublished || await updateRunState(
        runId,
        (current) => current.groupAnchorId === removedAnchorId
          ? { ...current, groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null }
          : current,
        version,
      ).catch(() => false);
      if (safeToDelete) {
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
    }
    throw error;
  } finally {
    cancelledCaptureIds.delete(captureId);
  }
}

type ValidatedRecaptureTarget = {
  target: DbStepRecaptureTarget;
  entryId: string;
  sourceUrl: string;
};

type StepRecaptureValidationErrorCode = Exclude<
  PreflightStepRecaptureSourcePermissionErrorCode,
  'INVALID_EDITOR' | 'RESTRICTED_SOURCE'
>;

class StepRecaptureStartError extends Error {
  constructor(
    readonly code: StepRecaptureValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StepRecaptureStartError';
  }
}

let startingRecapture = false;

function recaptureFailure(
  code: Exclude<StartStepRecaptureResult, { ok: true }>['code'],
  error: string,
): StartStepRecaptureResult {
  return { ok: false, code, error };
}

function isEditorSenderForSession(sender: Browser.runtime.MessageSender, sessionId: string): boolean {
  return isTrustedEditorSenderForSession(sender, browser.runtime.getURL('/editor.html'), sessionId);
}

function isRecaptureSourceSender(
  sender: Browser.runtime.MessageSender,
  context: NonNullable<RecordingState['recapture']>,
): boolean {
  return isTrustedRecaptureSourceSender(sender, context);
}

function recapturePermissionPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

function sourcePermissionPreflightSuccess(sourceUrl: string): SourcePermissionPreflightSuccess | null {
  const permissionPattern = recapturePermissionPattern(sourceUrl);
  if (!permissionPattern || isRestrictedUrl(sourceUrl)) return null;
  return {
    ok: true,
    sourceUrl,
    sourceOrigin: new URL(sourceUrl).origin,
    permissionPattern,
  };
}

async function validateRecaptureTarget(
  sessionId: string,
  target: StartStepRecaptureMessage['target'],
): Promise<ValidatedRecaptureTarget> {
  if (target.kind === 'single') {
    const step = await getStep(target.stepId);
    if (!step || step.sessionId !== sessionId) {
      throw new StepRecaptureStartError('TARGET_NOT_FOUND', '找不到要補拍的步驟。');
    }
    if (step.groupId || !step.screenshotBlob || !getEffectiveBounds(step)) {
      throw new StepRecaptureStartError('TARGET_CHANGED', '此步驟已變更，請重新整理編輯器後再試一次。');
    }
    return { target, entryId: step.id, sourceUrl: step.url };
  }

  const [anchor, annotation, steps] = await Promise.all([
    getStep(target.anchorId),
    getStep(target.annotationId),
    getSteps(sessionId),
  ]);
  if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
    throw new StepRecaptureStartError('TARGET_NOT_FOUND', '找不到要補拍的快照。');
  }
  if (
    anchor.groupId !== anchor.id ||
    annotation.groupId !== anchor.id ||
    annotation.id === anchor.id ||
    !anchor.screenshotBlob ||
    !getEffectiveBounds(annotation)
  ) {
    throw new StepRecaptureStartError('TARGET_CHANGED', '快照結構已變更，請重新整理編輯器後再試一次。');
  }
  const annotations = steps.filter(
    (step) => step.groupId === anchor.id && step.id !== anchor.id && getEffectiveBounds(step),
  );
  if (annotations.length !== 1 || annotations[0].id !== annotation.id) {
    throw new StepRecaptureStartError(
      'UNSUPPORTED_SNAPSHOT_GROUP',
      '此快照包含多個標註；更換底圖會使其他標註失效，請改用重拍整張快照。',
    );
  }
  return { target, entryId: anchor.id, sourceUrl: anchor.url };
}

/** Where a continuation run resumes: the persisted URL of the Guide's last
 * step. Editors never supply this — a caller-provided URL would let an editor
 * page nominate an arbitrary origin for the permission prompt. */
async function resolveGuideContinuationSourceUrl(sessionId: string): Promise<string | null> {
  const steps = await getSteps(sessionId);
  return steps.length > 0 ? steps[steps.length - 1].url : null;
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
    return continuationPreflightFailure('INVALID_EDITOR', '只能從目前 Guide 的 FrameTrail 編輯器接續錄製。');
  }
  const sourceUrl = await resolveGuideContinuationSourceUrl(message.sessionId);
  if (!sourceUrl) {
    return continuationPreflightFailure('SOURCE_NOT_FOUND', '這份教學還沒有可接續的來源頁面。');
  }
  return (
    sourcePermissionPreflightSuccess(sourceUrl) ??
    continuationPreflightFailure('RESTRICTED_SOURCE', '此來源頁面不允許錄製。')
  );
}

async function findOrCreateSourceTab(
  sourceUrl: string,
  preferredTabId?: number,
): Promise<{ tab: Browser.tabs.Tab; reused: boolean }> {
  if (preferredTabId != null) {
    try {
      const preferred = await browser.tabs.get(preferredTabId);
      if (preferred.id != null && preferred.url === sourceUrl) {
        return { tab: await waitForTabComplete(preferred.id), reused: true };
      }
    } catch {
      // The nominated tab disappeared; fall through to another exact match.
    }
  }
  const tabs = await browser.tabs.query({});
  const exact = tabs.find((tab) => tab.id != null && tab.url === sourceUrl);
  if (exact?.id != null) return { tab: await waitForTabComplete(exact.id), reused: true };
  const created = await browser.tabs.create({ url: sourceUrl, active: false });
  if (created.id == null) throw new Error('Browser did not create a source tab.');
  try {
    return { tab: await waitForTabComplete(created.id), reused: false };
  } catch (error) {
    // Nothing owns this tab yet (no persisted state references it), so a load
    // timeout or removal race must close it here or every attempt leaks a tab.
    await browser.tabs.remove(created.id).catch((cleanupError) => {
      console.warn('[frametrail] failed to close an unloaded source tab', cleanupError);
    });
    throw error;
  }
}

/**
 * Closes a tab findOrCreateSourceTab created while no persisted state owns it
 * yet. Every failure path between creation and the state write that records
 * sourceTabCreated must call this, or each failed attempt leaks a stray tab.
 */
async function discardUncommittedSourceTab(
  source: { tab: Browser.tabs.Tab; reused: boolean },
): Promise<void> {
  if (source.reused || source.tab.id == null) return;
  await browser.tabs.remove(source.tab.id).catch((error) => {
    console.warn('[frametrail] failed to close an unused source tab', error);
  });
}

async function returnToRecaptureEditor(context: RecordingState['recapture']): Promise<void> {
  if (!context) return;
  try {
    await browser.tabs.update(context.editorTabId, { active: true });
    if (context.editorWindowId != null) {
      await browser.windows.update(context.editorWindowId, { focused: true });
    }
    return;
  } catch {
    // The initiating editor was closed. Reuse another editor or recreate it.
  }
  const editorBase = browser.runtime.getURL('/editor.html');
  const [existing] = await browser.tabs.query({ url: `${editorBase}*` });
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  const editorUrl = new URL(editorBase);
  editorUrl.searchParams.set('sessionId', context.sessionId);
  editorUrl.searchParams.set('entryId', context.entryId);
  editorUrl.searchParams.set('recaptureRunId', context.runId);
  await browser.tabs.create({ url: editorUrl.href, active: true });
}

async function settleStepRecapture(
  runId: string,
  status: StepRecaptureResult['status'],
  version: number,
  errorCode?: string,
  message?: string,
): Promise<boolean> {
  const context = await queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      version !== controlVersion ||
      current.operation !== 'recapture' ||
      current.recapture?.runId !== runId
    ) {
      return null;
    }
    const recapture = current.recapture;
    const result: StepRecaptureResult = {
      runId,
      status,
      sessionId: recapture.sessionId,
      entryId: recapture.entryId,
      ...(errorCode ? { errorCode } : {}),
      ...(message ? { message } : {}),
      completedAt: Date.now(),
    };
    await setRecordingState({
      ...current,
      operation: null,
      isRecording: false,
      phase: 'idle',
      tabId: null,
      runId: null,
      recapture: null,
      recaptureResult: result,
      error: status === 'failed' ? message ?? '補拍失敗。' : null,
      recoverableError: null,
    });
    return recapture;
  });
  if (!context) return false;
  activeRecaptureCaptureId = null;
  await recorderRuntime.stopRecorderInTab(context.sourceTabId);
  if (context.sourceTabCreated) {
    await browser.tabs.remove(context.sourceTabId).catch((error) => {
      console.warn('[frametrail] failed to close temporary recapture tab', error);
    });
  }
  try {
    await returnToRecaptureEditor(context);
  } catch (error) {
    console.error('[frametrail] failed to return to editor after recapture', error);
  }
  return true;
}

async function wasRecaptureCommitted(context: NonNullable<RecordingState['recapture']>): Promise<boolean> {
  const ownerId = context.target.kind === 'single' ? context.target.stepId : context.target.anchorId;
  const owner = await getStep(ownerId);
  return owner?.sessionId === context.sessionId && owner.lastCaptureRunId === context.runId;
}

/**
 * MV3 may terminate the service worker between capture and durable result
 * handoff. A persisted capture marker lets startup distinguish a committed
 * replacement from abandoned in-flight work instead of leaving the editor
 * permanently locked in recapture mode.
 */
async function recoverInterruptedRecapture(): Promise<void> {
  const state = await getRecordingState();
  const context = state.recapture;
  if (state.operation !== 'recapture' || !context) return;

  if (context.phase === 'awaiting-target') {
    // Selection mode survives ordinary worker restarts — the injected recorder
    // lives on in the source tab. A browser restart, however, reissues tab
    // ids: the persisted sourceTabId then names nothing or an unrelated page,
    // and the claimed single-owner slot would block every future operation.
    if (await isRecaptureSourceTabIntact(context)) return;
    acceptingClicks = false;
    const version = ++controlVersion;
    await settleStepRecapture(
      context.runId,
      'failed',
      version,
      'SOURCE_TAB_CLOSED',
      '補拍已停止，因為原始分頁已關閉或已變更。原內容未變更。',
    );
    return;
  }

  const committed = context.phase === 'capturing' && await wasRecaptureCommitted(context);
  acceptingClicks = false;
  const version = ++controlVersion;
  if (committed) {
    await settleStepRecapture(context.runId, 'replaced', version);
    return;
  }
  await settleStepRecapture(
    context.runId,
    'failed',
    version,
    'WORKER_RESTARTED',
    '補拍流程曾中斷，原內容未變更；請重新補拍。',
  );
}

async function isRecaptureSourceTabIntact(
  context: NonNullable<RecordingState['recapture']>,
): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(context.sourceTabId);
    // Recapture required a host permission grant for the source origin, so the
    // URL is readable whenever the tab still shows the page selection armed on.
    return tab.url === context.sourceUrl;
  } catch {
    return false;
  }
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
  const expectedControlVersion = controlVersion;
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

function failStepRecapture(
  runId: string,
  errorCode: string,
  message: string,
  expectedControlVersion: number,
): Promise<boolean> {
  if (expectedControlVersion !== controlVersion) return Promise.resolve(false);
  acceptingClicks = false;
  pendingRecaptureReady?.cancel();
  pendingRecaptureReady = null;
  if (activeRecaptureCaptureId) cancelCapture(activeRecaptureCaptureId);
  const version = ++controlVersion;
  return settleStepRecapture(runId, 'failed', version, errorCode, message);
}

async function handleRecaptureReady(
  message: FrameTrailRecaptureReadyMessage,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  const context = (await getRecordingState()).recapture;
  if (
    !context ||
    context.runId !== message.runId ||
    context.phase !== 'starting' ||
    !isRecaptureSourceSender(sender, context) ||
    message.url !== context.sourceUrl
  ) {
    return false;
  }
  return pendingRecaptureReady?.signal({
    runId: message.runId,
    tabId: context.sourceTabId,
    controlVersion,
  }) ?? false;
}

function recapturePreflightFailure(
  code: Exclude<PreflightStepRecaptureSourcePermissionResult, { ok: true }>['code'],
  message: string,
): PreflightStepRecaptureSourcePermissionResult {
  return { ok: false, code, message };
}

async function preflightStepRecaptureSourcePermission(
  message: PreflightStepRecaptureSourcePermissionMessage,
  sender: Browser.runtime.MessageSender,
): Promise<PreflightStepRecaptureSourcePermissionResult> {
  // The message shape (including the target) was already validated by the
  // canonical isBackgroundMessage guard at listener entry; only the trust
  // relationship between this editor and the session remains to check here.
  if (
    typeof message.sessionId !== 'string' ||
    message.sessionId.trim().length === 0 ||
    !isEditorSenderForSession(sender, message.sessionId)
  ) {
    return recapturePreflightFailure('INVALID_EDITOR', '只能從目前 Guide 的 FrameTrail 編輯器驗證補拍來源。');
  }

  let validated: ValidatedRecaptureTarget;
  try {
    validated = await validateRecaptureTarget(message.sessionId, message.target);
  } catch (error) {
    if (error instanceof StepRecaptureStartError) {
      return recapturePreflightFailure(error.code, error.message);
    }
    throw error;
  }

  return (
    sourcePermissionPreflightSuccess(validated.sourceUrl) ??
    recapturePreflightFailure('RESTRICTED_SOURCE', '此來源頁面不允許補拍。')
  );
}

async function handleStartStepRecapture(
  message: StartStepRecaptureMessage,
  sender: Browser.runtime.MessageSender,
  version: number,
): Promise<StartStepRecaptureResult> {
  await waitForQueuedClicks();
  if (version !== controlVersion) return recaptureFailure('ACTIVE_OPERATION', '操作狀態已改變，請再試一次。');

  const editorTab = sender.tab;
  if (!isEditorSenderForSession(sender, message.sessionId) || editorTab?.id == null) {
    return recaptureFailure('INVALID_EDITOR', '只能從 FrameTrail 編輯器啟動補拍。');
  }
  const current = await getRecordingState();
  if (current.operation !== null || current.isRecording) {
    return recaptureFailure('ACTIVE_OPERATION', '目前已有錄製或補拍正在進行。');
  }

  let validated: ValidatedRecaptureTarget;
  try {
    validated = await validateRecaptureTarget(message.sessionId, message.target);
  } catch (error) {
    if (error instanceof StepRecaptureStartError) return recaptureFailure(error.code, error.message);
    throw error;
  }
  const permissionPattern = recapturePermissionPattern(validated.sourceUrl);
  if (!permissionPattern || isRestrictedUrl(validated.sourceUrl)) {
    return recaptureFailure('RESTRICTED_SOURCE', '此來源頁面不允許補拍。');
  }
  const hasPermission = await browser.permissions.contains({ origins: [permissionPattern] });
  if (!hasPermission) {
    return recaptureFailure('HOST_PERMISSION_REQUIRED', '需要先允許 FrameTrail 存取此網站，才能補拍。');
  }

  let source: Awaited<ReturnType<typeof findOrCreateSourceTab>>;
  try {
    source = await findOrCreateSourceTab(validated.sourceUrl, message.preferredTabId);
  } catch (error) {
    console.error('[frametrail] failed to open recapture source tab', error);
    return recaptureFailure('SOURCE_TAB_FAILED', '無法開啟原始頁面。');
  }
  const sourceTab = source.tab;
  if (sourceTab.id == null || sourceTab.windowId == null || sourceTab.url !== validated.sourceUrl) {
    await discardUncommittedSourceTab(source);
    return recaptureFailure('SOURCE_TAB_FAILED', '原始頁面已重新導向，未開始補拍。');
  }
  if (version !== controlVersion) {
    await discardUncommittedSourceTab(source);
    return recaptureFailure('ACTIVE_OPERATION', '操作狀態已改變，請再試一次。');
  }

  const runId = crypto.randomUUID();
  const recapture = {
    runId,
    sessionId: message.sessionId,
    target: validated.target,
    entryId: validated.entryId,
    phase: 'starting' as const,
    editorTabId: editorTab.id,
    editorWindowId: editorTab.windowId ?? null,
    sourceTabId: sourceTab.id,
    sourceWindowId: sourceTab.windowId,
    sourceUrl: validated.sourceUrl,
    sourceTabCreated: !source.reused,
    startedAt: Date.now(),
  };
  const started = await writeStateForControl(version, (state) => ({
    ...state,
    operation: 'recapture',
    isRecording: false,
    phase: 'idle',
    sessionId: message.sessionId,
    tabId: null,
    runId: null,
    error: null,
    recoverableError: null,
    recapture,
    recaptureResult: null,
  }));
  if (!started) {
    await discardUncommittedSourceTab(source);
    return recaptureFailure('ACTIVE_OPERATION', '操作狀態已改變，請再試一次。');
  }

  const readyGate = new RecorderReadyGate(
    { runId, tabId: sourceTab.id, controlVersion: version },
    RECORDER_READY_TIMEOUT_MS,
  );
  pendingRecaptureReady = readyGate;
  try {
    const [, ready] = await Promise.all([recorderRuntime.injectRecorder(sourceTab.id, true), readyGate.promise]);
    if (!ready) throw new Error('Recapture recorder did not become ready before timeout.');
    const activated = await queueStateMutation(async () => {
      const state = await getRecordingState();
      if (
        version !== controlVersion ||
        state.operation !== 'recapture' ||
        state.recapture?.runId !== runId ||
        state.recapture.phase !== 'starting'
      ) {
        return false;
      }
      await setRecordingState({
        ...state,
        recapture: { ...state.recapture, phase: 'awaiting-target' },
      });
      return true;
    });
    if (!activated) throw new StaleCaptureError('Recapture changed during startup.');
    acceptingClicks = true;
    await browser.tabs.update(sourceTab.id, { active: true });
    await browser.windows.update(sourceTab.windowId, { focused: true });
    return { ok: true, runId, tabId: sourceTab.id, reusedTab: source.reused };
  } catch (error) {
    console.error('[frametrail] failed to start recapture recorder', error);
    if (version === controlVersion) {
      await failStepRecapture(runId, 'INJECTION_FAILED', '無法在原始頁面啟動補拍。', version);
    }
    return recaptureFailure('INJECTION_FAILED', '無法在原始頁面啟動補拍。');
  } finally {
    if (pendingRecaptureReady === readyGate) pendingRecaptureReady = null;
    readyGate.cancel();
  }
}

async function startStepRecapture(
  message: StartStepRecaptureMessage,
  sender: Browser.runtime.MessageSender,
): Promise<StartStepRecaptureResult> {
  if (!isEditorSenderForSession(sender, message.sessionId)) {
    return recaptureFailure('INVALID_EDITOR', '只能從目前 Guide 的 FrameTrail 編輯器啟動補拍。');
  }
  if (startingRecapture) return recaptureFailure('ACTIVE_OPERATION', '目前已有補拍正在啟動。');
  startingRecapture = true;
  try {
    const current = await getRecordingState();
    if (current.operation !== null || current.isRecording) {
      return recaptureFailure('ACTIVE_OPERATION', '目前已有錄製或補拍正在進行。');
    }
    acceptingClicks = false;
    pendingRecorderReady?.cancel();
    pendingRecorderReady = null;
    pendingRecaptureReady?.cancel();
    pendingRecaptureReady = null;
    discardPendingUndo();
    const version = ++controlVersion;
    return await handleStartStepRecapture(message, sender, version);
  } finally {
    startingRecapture = false;
  }
}

async function cancelStepRecapture(
  message: CancelStepRecaptureMessage,
  sender: Browser.runtime.MessageSender,
): Promise<CancelStepRecaptureResult> {
  const state = await getRecordingState();
  if (state.recaptureResult?.runId === message.runId) return { ok: true, status: 'already-completed' };
  if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
    return { ok: false, error: '這次補拍已經結束。' };
  }
  const context = state.recapture;
  if (!isEditorSenderForSession(sender, context.sessionId) && !isRecaptureSourceSender(sender, context)) {
    return { ok: false, error: '無效的補拍來源。' };
  }
  const captureId = activeRecaptureCaptureId;
  if (captureId && committingCaptureIds.has(captureId)) {
    await waitForQueuedClicks();
    return { ok: true, status: 'already-completed' };
  }
  acceptingClicks = false;
  pendingRecaptureReady?.cancel();
  pendingRecaptureReady = null;
  if (captureId) cancelCapture(captureId);
  const version = ++controlVersion;
  await waitForQueuedClicks();
  const settled = await settleStepRecapture(message.runId, 'cancelled', version, 'CANCELLED', '已取消補拍，原內容未變更。');
  return settled ? { ok: true, status: 'cancelled' } : { ok: true, status: 'already-completed' };
}

async function ackStepRecaptureResult(
  message: AckStepRecaptureResultMessage,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  if (!isEditorSenderForSession(sender, message.sessionId)) return false;
  return queueStateMutation(async () => {
    const state = await getRecordingState();
    if (
      state.recaptureResult?.runId !== message.runId ||
      state.recaptureResult.sessionId !== message.sessionId
    ) return false;
    await setRecordingState({ ...state, recaptureResult: null });
    return true;
  });
}

async function focusStepRecaptureSource(
  message: FocusStepRecaptureSourceMessage,
  sender: Browser.runtime.MessageSender,
): Promise<FocusStepRecaptureSourceResult> {
  const state = await getRecordingState();
  if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
    return { ok: false, error: '這次補拍已經結束。' };
  }
  if (!isEditorSenderForSession(sender, state.recapture.sessionId)) {
    return { ok: false, error: '無效的編輯器來源。' };
  }
  try {
    await browser.tabs.update(state.recapture.sourceTabId, { active: true });
    await browser.windows.update(state.recapture.sourceWindowId, { focused: true });
    return { ok: true };
  } catch {
    return { ok: false, error: '找不到補拍分頁。' };
  }
}

/**
 * Continuation resolves its own target tab because the editor page cannot be
 * recorded and holds no activeTab grant over the source site. Every precondition
 * recapture enforces applies here too: trusted editor, persisted source URL, an
 * explicit host permission, and an exact-URL tab.
 */
async function resolveContinuationTab(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
): Promise<{ ok: true; tab: Browser.tabs.Tab } | { ok: false; error: string }> {
  if (!isEditorSenderForSession(sender, message.sessionId)) {
    return { ok: false, error: '只能從目前 Guide 的 FrameTrail 編輯器接續錄製。' };
  }
  const sourceUrl = await resolveGuideContinuationSourceUrl(message.sessionId);
  if (!sourceUrl) {
    return { ok: false, error: '這份教學還沒有可接續的來源頁面，請從彈出視窗開始新的錄製。' };
  }
  const permissionPattern = recapturePermissionPattern(sourceUrl);
  if (!permissionPattern || isRestrictedUrl(sourceUrl)) {
    return { ok: false, error: '此來源頁面不允許錄製。' };
  }
  if (!(await browser.permissions.contains({ origins: [permissionPattern] }))) {
    return { ok: false, error: '需要先允許 FrameTrail 存取此網站，才能接續錄製。' };
  }
  try {
    const source = await findOrCreateSourceTab(sourceUrl, message.continuation?.preferredTabId);
    if (source.tab.id == null || source.tab.url !== sourceUrl) {
      await discardUncommittedSourceTab(source);
      return { ok: false, error: '原始頁面已重新導向，未開始錄製。' };
    }
    return { ok: true, tab: source.tab };
  } catch (error) {
    console.error('[frametrail] failed to open continuation source tab', error);
    return { ok: false, error: '無法開啟原始頁面。' };
  }
}

async function startRecording(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
): Promise<StartRecordingResult> {
  const current = await getRecordingState();
  // A global capture operation remains single-owner. Never let a second start
  // invalidate another Guide's recording or one-shot replacement.
  if (current.operation !== null || current.isRecording || startingRecapture) {
    return { ok: false, error: '目前已有錄製或補拍正在進行。' };
  }
  const targetGuide = await getGuide(message.sessionId);
  if (!targetGuide) return { ok: false, error: '找不到要錄製的教學。請回作品庫重新選擇。' };

  let continuationTab: Browser.tabs.Tab | null = null;
  if (message.continuation) {
    const resolved = await resolveContinuationTab(message, sender);
    if (!resolved.ok) return resolved;
    continuationTab = resolved.tab;
  }

  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  discardPendingUndo();
  const version = ++controlVersion;
  await handleStartRecording(message, version, continuationTab);
  const started = await getRecordingState();
  if (
    version === controlVersion &&
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
  if (version !== controlVersion) return;

  const prevState = await getRecordingState();
  const tab = continuationTab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (version !== controlVersion) return;

  await recorderRuntime.stopRecorderInTab(prevState.tabId);
  if (version !== controlVersion) return;
  if (!tab?.id) {
    await writeStateForControl(version, (current) => ({
      ...current,
      operation: null,
      isRecording: false,
      phase: 'error',
      tabId: null,
      error: '找不到可錄製的分頁。請開啟一般網站後再試一次。',
      recoverableError: {
        code: 'NO_ACTIVE_TAB',
        message: '找不到可錄製的分頁。請開啟一般網站後再試一次。',
      },
      mode: message.mode,
      itemCount: 0,
      numbered: RUN_STARTS_NUMBERED,
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    }));
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    await writeStateForControl(version, (current) => ({
      ...current,
      operation: null,
      isRecording: false,
      phase: 'error',
      sessionId: current.sessionId,
      tabId: null,
      error: '此瀏覽器頁面不允許錄製。',
      recoverableError: {
        code: 'RESTRICTED_PAGE',
        message: '此瀏覽器頁面不允許錄製。',
      },
      mode: message.mode,
      itemCount: 0,
      numbered: RUN_STARTS_NUMBERED,
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    }));
    return;
  }

  // Captures read the visible viewport, and snapshot mode captures its base
  // image during startup, so a resumed source tab must reach the foreground
  // before the recorder is injected — not after the run is live.
  if (continuationTab) {
    try {
      await browser.tabs.update(tab.id!, { active: true });
      if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
    } catch (error) {
      console.error('[frametrail] failed to focus the continuation source tab', error);
      await writeStateForControl(version, (current) => ({
        ...current,
        operation: null,
        isRecording: false,
        phase: 'error',
        tabId: null,
        error: '無法切換到原始頁面，未開始錄製。',
        recoverableError: {
          code: 'SOURCE_TAB_FAILED',
          message: '無法切換到原始頁面，未開始錄製。',
        },
        mode: message.mode,
        itemCount: 0,
        numbered: RUN_STARTS_NUMBERED,
        groupAnchorId: null,
        runId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
      }));
      return;
    }
    if (version !== controlVersion) return;
  }

  const runId = crypto.randomUUID();
  const startedState = await writeStateForControl(version, (current) => ({
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
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
    recapture: null,
    recaptureResult: current.recaptureResult,
  }));
  if (!startedState) return;
  if (!startedState.sessionId || startedState.sessionId !== message.sessionId) return;
  if (version !== controlVersion) return;

  const readyGate = new RecorderReadyGate(
    { runId, tabId: tab.id, controlVersion: version },
    RECORDER_READY_TIMEOUT_MS,
  );
  pendingRecorderReady = readyGate;
  let startupAnchorId: string | null = null;
  try {
    const [, recorderReady] = await Promise.all([
      // Both modes instrument every accessible frame: snapshot mode for its
      // child-frame probes, step mode so iframe clicks are captured and
      // relayed to the top-frame recorder instead of being silently lost.
      recorderRuntime.injectRecorder(tab.id, true),
      readyGate.promise,
    ]);
    if (!recorderReady) throw new Error('Recorder did not become ready before the startup timeout.');
    if (version !== controlVersion) return;
    if (message.mode === 'snapshot') {
      const context = pendingSnapshotContext;
      if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
      if (!startedState.sessionId || tab.windowId == null) throw new Error('Snapshot capture context is incomplete.');
      startupAnchorId = await createAndActivateSnapshotAnchor(
        startedState,
        tab.id,
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
    acceptingClicks = current.isRecording && current.runId === runId;
    startupAnchorId = null;
  } catch (err) {
    console.error('[frametrail] failed to inject recorder:', describeBrowserError(err), err);
    if (startupAnchorId) {
      // The anchor was already published to the run state; withdraw it first
      // so no state ever points at a deleted row, and keep the row (an orphan
      // at worst) when the withdrawal cannot be applied.
      const removedAnchorId = startupAnchorId;
      const safeToDelete = await updateRunState(
        runId,
        (current) => current.groupAnchorId === removedAnchorId
          ? { ...current, groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null }
          : current,
        version,
      ).catch(() => false);
      if (safeToDelete) {
        try {
          await deleteStep(startupAnchorId);
        } catch (cleanupError) {
          console.error(
            '[frametrail] failed to remove incomplete snapshot:',
            describeBrowserError(cleanupError),
            cleanupError,
          );
        }
      }
    }
    if (version !== controlVersion) return;
    try {
      await stopRunWithError(runId, '無法在這個頁面開始錄製，請改用一般網站再試一次。', version);
    } catch (recoveryError) {
      acceptingClicks = false;
      console.error(
        '[frametrail] failed to persist recording startup failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
  } finally {
    if (pendingRecorderReady === readyGate) pendingRecorderReady = null;
    pendingSnapshotContext = undefined;
    readyGate.cancel();
  }
}

async function stopRecording(): Promise<void> {
  const current = await getRecordingState();
  if (current.operation !== 'recording' || !current.isRecording) return;
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  discardPendingUndo();
  const version = ++controlVersion;
  return handleStopRecording(version);
}

async function handleRecorderReady(
  message: Extract<BackgroundMessage, { type: 'FRAME_TRAIL_READY' }>,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) return false;
  const expectedControlVersion = controlVersion;
  const state = await getRecordingState();
  if (
    expectedControlVersion !== controlVersion ||
    !state.isRecording ||
    state.runId !== message.runId ||
    state.tabId !== tabId ||
    !isTrustedRecorderControlSender(sender, state.tabId)
  ) {
    return false;
  }

  const identity = {
    runId: message.runId,
    tabId,
    controlVersion: expectedControlVersion,
  };
  const matchesPendingStartup = pendingRecorderReady?.matches(identity) === true;
  const signaled = pendingRecorderReady?.signal(identity);
  if (matchesPendingStartup) pendingSnapshotContext = message.snapshotContext;

  // Re-injections after navigation have no startup gate; the current run is
  // already accepting clicks and only needs its new listener set validated.
  return (
    matchesPendingStartup ||
    signaled === true ||
    state.phase === 'paused' ||
    state.phase === 'preparing-next' ||
    acceptingClicks
  );
}

async function handleSnapshotInvalidated(
  message: SnapshotInvalidatedMessage,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (
    tabId == null ||
    sender.frameId !== 0 ||
    !isValidSnapshotViewportContext(message.viewport, message.devicePixelRatio)
  ) {
    return false;
  }
  const expectedControlVersion = controlVersion;
  const state = await getRecordingState();
  if (
    !state.isRecording ||
    state.runId !== message.runId ||
    state.tabId !== tabId ||
    state.mode !== 'snapshot'
  ) {
    return false;
  }
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
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) return false;
  const expectedControlVersion = controlVersion;
  const state = await getRecordingState();
  if (
    expectedControlVersion !== controlVersion ||
    !state.isRecording ||
    state.operation !== 'recording' ||
    state.runId !== message.runId ||
    state.tabId !== tabId ||
    state.mode !== 'snapshot'
  ) {
    return false;
  }
  const error = '快照選取介面已中斷；為避免頁面持續被鎖定，這次錄製已安全停止。';
  await stopRunWithError(message.runId, error, expectedControlVersion, {
    code: 'SNAPSHOT_SHIELD_FAILED',
    message: error,
  });
  return true;
}

async function handleStopRecording(version: number): Promise<void> {
  await waitForQueuedClicks();
  if (version !== controlVersion) return;
  const current = await getRecordingState();
  if (version !== controlVersion) return;
  const state = await writeStateForControl(version, (latest) => ({
    ...latest,
    operation: null,
    isRecording: false,
    phase: 'idle',
    tabId: null,
    itemCount: 0,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  }));
  if (!state) return;
  // Only after the stop won: deleting first left a live run pointing at a
  // deleted anchor whenever the state write lost to a concurrent control.
  try {
    await deleteEmptySnapshotAnchor(current);
  } catch (cleanupError) {
    console.error('[frametrail] failed to remove the empty snapshot anchor:', describeBrowserError(cleanupError), cleanupError);
  }
  await stopRecordingSource(current);
}

async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<string | null> {
  if (state.mode !== 'snapshot' || !state.sessionId || !state.groupAnchorId) return null;
  const steps = await getSteps(state.sessionId);
  const hasAnnotations = steps.some(
    (step) => step.groupId === state.groupAnchorId && step.id !== state.groupAnchorId && step.bounds !== null,
  );
  if (hasAnnotations) return null;
  await deleteStep(state.groupAnchorId);
  return state.groupAnchorId;
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
  acceptingClicks = false;
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
  acceptingClicks = true;
  return { ok: true };
}

async function undoLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
  return queueClick(async () => {
    const expectedControlVersion = controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== controlVersion ||
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
    const expectedControlVersion = controlVersion;
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

  acceptingClicks = false;
  discardPendingUndo();
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
    const version = ++controlVersion;
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

  acceptingClicks = false;
  discardPendingUndo();
  pendingSnapshotContext = undefined;
  const { state, previous, version } = claimed;
  const readyGate = new RecorderReadyGate(
    { runId: message.runId, tabId: state.tabId!, controlVersion: version },
    RECORDER_READY_TIMEOUT_MS,
  );
  pendingRecorderReady?.cancel();
  pendingRecorderReady = readyGate;

  try {
    const tab = await browser.tabs.get(state.tabId!);
    if (tab.windowId == null || isRestrictedUrl(tab.url)) throw new Error('Snapshot tab cannot be captured.');
    const [, recorderReady] = await Promise.all([
      recorderRuntime.injectRecorder(state.tabId!, true),
      readyGate.promise,
    ]);
    if (!recorderReady || version !== controlVersion) {
      throw new StaleCaptureError('Snapshot recorder did not become ready.');
    }
    const context = readPendingSnapshotContext();
    if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
    await createAndActivateSnapshotAnchor(state, state.tabId!, tab.windowId, context, version);
    const updated = await updateRunState(
      message.runId,
      (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
      version,
    );
    if (!updated) throw new StaleCaptureError('Recording changed while activating the next snapshot.');
    acceptingClicks = true;
    return { ok: true };
  } catch (error) {
    console.error('[frametrail] failed to create next snapshot', error);
    acceptingClicks = false;
    if (version === controlVersion) {
      const rebuildingInvalidated = sourcePhase === 'invalidated';
      const errorMessage = rebuildingInvalidated
        ? '無法重建快照，請重試。'
        : '無法建立新快照，請重試。';
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
    return controlFailure(
      sourcePhase === 'invalidated' ? '無法重建快照，請重試。' : '無法建立新快照，請重試。',
    );
  } finally {
    if (pendingRecorderReady === readyGate) pendingRecorderReady = null;
    pendingSnapshotContext = undefined;
    readyGate.cancel();
  }
}

async function resetGuideLifecycle(message: ResetGuideMessage): Promise<ResetGuideResult> {
  const initial = await getRecordingState();
  if (initial.operation !== null || initial.isRecording || startingRecapture) {
    return { ok: false, error: '錄製或補拍期間無法重置教學。' };
  }
  const guide = await getGuide(message.sessionId);
  if (!guide) return { ok: false, error: '找不到要重置的教學。' };

  // Invalidate any in-memory work first, then wait for all already-queued DB
  // writes. Persisted run/session guards remain authoritative after restarts.
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  discardPendingUndo();
  const version = ++controlVersion;
  await waitForQueuedClicks();
  const current = await getRecordingState();
  if (version !== controlVersion || current.operation !== null || current.isRecording) {
    return { ok: false, error: '錄製狀態已變更，未重置教學。' };
  }
  try {
    const updated = await resetGuide(message.sessionId);
    if (current.sessionId === message.sessionId) {
      await writeStateForControl(version, (latest) => latest.sessionId === message.sessionId
        ? {
            ...latest,
            operation: null,
            isRecording: false,
            phase: 'idle',
            tabId: null,
            error: null,
            recoverableError: null,
            itemCount: 0,
            groupAnchorId: null,
            runId: null,
            snapshotViewport: null,
            snapshotDevicePixelRatio: null,
          }
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
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
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
  const expectedControlVersion = controlVersion;
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
      await writeStateForControl(expectedControlVersion, (current) => {
        if (current.sessionId !== targetSessionId) return current;
        return clearEditorRecovery(current);
      });
    }
    return { ok: true };
  } catch (error) {
    console.error('[frametrail] failed to open editor:', describeBrowserError(error), error);
    if (state?.sessionId === targetSessionId) {
      try {
        await writeStateForControl(expectedControlVersion, (current) => {
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
    return { ok: false, error: '無法開啟編輯器，請再試一次。' };
  }
}

async function finishRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const startedAtControlVersion = controlVersion;
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

  acceptingClicks = false;
  discardPendingUndo();
  const markedFinishing = await queueStateMutation(async () => {
    if (startedAtControlVersion !== controlVersion) return false;
    const current = await getRecordingState();
    if (
      !current.isRecording ||
      current.runId !== message.runId ||
      (current.phase !== 'recording' &&
        current.phase !== 'paused' &&
        current.phase !== 'preparing-next' &&
        current.phase !== 'invalidated')
    ) {
      return false;
    }
    await setRecordingState({ ...current, phase: 'finishing', error: null, recoverableError: null });
    return true;
  });
  if (!markedFinishing) return controlFailure('錄製狀態已改變，請再試一次。');

  await waitForQueuedClicks();
  if (startedAtControlVersion !== controlVersion) return controlFailure('錄製狀態已改變。');

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

  const version = ++controlVersion;
  const stopped = await writeStateForControl(version, (current) => ({
    ...current,
    operation: null,
    isRecording: false,
    phase: 'idle',
    tabId: null,
    itemCount: 0,
    error: null,
    recoverableError: null,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  }));
  if (!stopped) return controlFailure('無法完成錄製，請再試一次。');

  // Only after the finish won the state write: a service-worker death or lost
  // race between an earlier delete and the write used to leave a run in phase
  // 'finishing' whose groupAnchorId pointed at a deleted anchor row.
  try {
    await deleteEmptySnapshotAnchor(state);
  } catch (cleanupError) {
    console.error('[frametrail] failed to remove the empty snapshot anchor:', describeBrowserError(cleanupError), cleanupError);
  }
  await stopRecordingSource(state);
  try {
    await openOrFocusEditor(result);
  } catch (error) {
    console.error('[frametrail] failed to open editor after recording', error);
    await writeStateForControl(version, markEditorOpenFailed);
    return { ok: true, finish: result };
  }
  return { ok: true, finish: result };
}

async function discardCurrentRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const startedAtControlVersion = controlVersion;
  const initial = await getRecordingState();
  if (
    startedAtControlVersion !== controlVersion ||
    !initial.isRecording ||
    !initial.sessionId ||
    initial.runId !== message.runId ||
    initial.phase === 'starting' ||
    initial.phase === 'finishing'
  ) {
    return controlFailure('這次錄製已經結束或無法放棄。');
  }

  acceptingClicks = false;
  discardPendingUndo();
  const version = ++controlVersion;
  await waitForQueuedClicks();

  const state = await getRecordingState();
  if (
    version !== controlVersion ||
    !state.isRecording ||
    !state.sessionId ||
    state.runId !== message.runId
  ) {
    return controlFailure('錄製狀態已改變，請再試一次。');
  }

  try {
    await deleteStepsForRun(state.sessionId, message.runId);
    const stopped = await writeStateForControl(version, (current) => ({
      ...current,
      operation: null,
      isRecording: false,
      phase: 'idle',
      tabId: null,
      itemCount: 0,
      error: null,
      recoverableError: null,
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    }));
    if (!stopped) return controlFailure('無法放棄錄製，請再試一次。');
    await stopRecordingSource(state);
    return { ok: true };
  } catch (error) {
    console.error('[frametrail] failed to discard current recording', error);
    await writeStateForControl(version, (current) => ({
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

async function assertRecaptureCaptureContext(
  expectedControlVersion: number,
  runId: string,
  tabId: number,
  windowId: number,
  expectedUrl: string,
): Promise<void> {
  if (expectedControlVersion !== controlVersion) {
    throw new StaleCaptureError('Recapture control changed before the screenshot could be taken.');
  }
  const state = await getRecordingState();
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  if (
    expectedControlVersion !== controlVersion ||
    state.operation !== 'recapture' ||
    state.recapture?.runId !== runId ||
    state.recapture.sourceTabId !== tabId ||
    state.recapture.sourceWindowId !== windowId ||
    state.recapture.sourceUrl !== expectedUrl
  ) {
    throw new StaleCaptureError('Recapture changed before the screenshot could be taken.');
  }
  if (activeTab?.id !== tabId) throw new Error('補拍失敗：原始頁面已不是目前作用中的分頁。');
  if (activeTab.url !== expectedUrl) throw new Error('補拍失敗：原始頁面已變更。');
}

async function handleRecaptureTarget(
  message: FrameTrailRecaptureTargetMessage,
  sender: Browser.runtime.MessageSender,
  expectedControlVersion: number,
): Promise<StepRecaptureTargetResult> {
  const reject = (status: 'rejected' | 'cancelled' | 'failed', error?: string): StepRecaptureTargetResult => ({
    ok: false,
    status,
    ...(error ? { error } : {}),
  });
  if (expectedControlVersion !== controlVersion) return reject('rejected');
  const state = await getRecordingState();
  const context = state.recapture;
  if (
    state.operation !== 'recapture' ||
    !context ||
    context.runId !== message.runId ||
    context.phase !== 'awaiting-target' ||
    !isRecaptureSourceSender(sender, context) ||
    message.url !== context.sourceUrl
  ) {
    return reject('rejected');
  }
  if (!acceptingClicks || activeRecaptureCaptureId) return reject('rejected');
  const claimed = await queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      expectedControlVersion !== controlVersion ||
      current.operation !== 'recapture' ||
      current.recapture?.runId !== message.runId ||
      current.recapture.phase !== 'awaiting-target'
    ) {
      return false;
    }
    await setRecordingState({
      ...current,
      recapture: { ...current.recapture, phase: 'capturing' },
    });
    return true;
  });
  if (!claimed) return reject('rejected');
  // Claim globals only after both sender and persisted context validation. An
  // old or forged content-script message must not consume the one-shot slot.
  acceptingClicks = false;
  activeRecaptureCaptureId = message.captureId;

  try {
    const captured = await captureScreenshotWithGuard(
      message,
      context.sourceTabId,
      context.sourceWindowId,
      () =>
        assertRecaptureCaptureContext(
          expectedControlVersion,
          message.runId,
          context.sourceTabId,
          context.sourceWindowId,
          context.sourceUrl,
        ),
    );
    assertCaptureNotCancelled(message.captureId);
    const current = await getRecordingState();
    if (
      expectedControlVersion !== controlVersion ||
      current.operation !== 'recapture' ||
      current.recapture?.runId !== message.runId ||
      current.recapture.phase !== 'capturing'
    ) {
      throw new StaleCaptureError('Recapture changed before the replacement transaction.');
    }

    // Synchronous commit marker: cancellation after this point waits for the
    // atomic IndexedDB replacement and reports the completed result.
    committingCaptureIds.add(message.captureId);
    await replaceStepCaptureAtomically(
      context.sessionId,
      context.target,
      {
        screenshotBlob: captured.blob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale: captured.scale,
        url: message.url,
        timestamp: message.timestamp,
      },
      message.runId,
    );
    const version = ++controlVersion;
    await settleStepRecapture(message.runId, 'replaced', version);
    return { ok: true, status: 'replaced' };
  } catch (error) {
    if (error instanceof StaleCaptureError) return reject('cancelled');
    const errorCode = error instanceof StepRecaptureError ? error.code : 'CAPTURE_FAILED';
    const errorMessage =
      error instanceof StepRecaptureError
        ? error.message
        : error instanceof Error
          ? error.message
          : '補拍失敗，原內容未變更。';
    console.error('[frametrail] failed to replace step capture', error);
    if (expectedControlVersion === controlVersion) {
      const version = ++controlVersion;
      await settleStepRecapture(message.runId, 'failed', version, errorCode, errorMessage);
    }
    return reject('failed', errorMessage);
  } finally {
    committingCaptureIds.delete(message.captureId);
    cancelledCaptureIds.delete(message.captureId);
    if (activeRecaptureCaptureId === message.captureId) activeRecaptureCaptureId = null;
  }
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
  if (expectedControlVersion !== controlVersion) {
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
  }], expectedControlVersion);
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
    cancelledCaptureIds.delete(message.captureId);
    return { ok: false };
  };
  if (expectedControlVersion !== controlVersion) return rejectBeforeTransaction();
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
      if (expectedControlVersion !== controlVersion) {
        throw new StaleCaptureError('Recording control changed while saving the step.');
      }
      assertCaptureNotCancelled(message.captureId);
      // No await may occur between this synchronous commit marker and addStep:
      // a cancellation arriving afterwards must not create a half-cancelled
      // transaction that writes a step after the gesture has been replayed.
      committingCaptureIds.add(message.captureId);
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
      }], expectedControlVersion);
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
      acceptingClicks = false;
      console.error(
        '[frametrail] failed to persist capture failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
    return { ok: false };
  } finally {
    committingCaptureIds.delete(message.captureId);
    cancelledCaptureIds.delete(message.captureId);
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
    await recoverInterruptedRecapture();
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
          preflightStepRecaptureSourcePermission(message, sender),
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
          startStepRecapture(message, sender),
          'start recapture request failed',
          {
            ok: false,
            code: 'INJECTION_FAILED',
            error: '補拍服務發生錯誤，請再試一次。',
          } satisfies StartStepRecaptureResult,
        );
      case 'CANCEL_STEP_RECAPTURE':
        return withMessageFailureFallback(
          cancelStepRecapture(message, sender),
          'cancel recapture request failed',
          { ok: false, error: '取消補拍時發生錯誤，請再試一次。' } satisfies CancelStepRecaptureResult,
        );
      case 'ACK_STEP_RECAPTURE_RESULT':
        return withMessageFailureFallback(
          ackStepRecaptureResult(message, sender),
          'recapture result ack failed',
          false,
        );
      case 'FOCUS_STEP_RECAPTURE_SOURCE':
        return withMessageFailureFallback(
          focusStepRecaptureSource(message, sender),
          'focus recapture source failed',
          { ok: false, error: '無法切換到補拍分頁，請再試一次。' } satisfies FocusStepRecaptureSourceResult,
        );
      case 'STOP_RECORDING':
        return withMessageFailureFallback(
          queueLifecycle(() => stopRecording()),
          'stop recording request failed',
          undefined,
        );
      case 'RESET_GUIDE':
        return withMessageFailureFallback(
          queueLifecycle(() => resetGuideLifecycle(message)),
          'reset guide request failed',
          { ok: false, error: '無法重設教學，請再試一次。' } satisfies ResetGuideResult,
        );
      case 'OPEN_EDITOR':
        return withMessageFailureFallback(
          openEditorForStoredSession(message),
          'open editor request failed',
          { ok: false, error: '無法開啟編輯器，請再試一次。' } satisfies OpenEditorResult,
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
        if (!acceptingClicks) {
          return Promise.resolve({ ok: false, status: 'rejected' } satisfies StepRecaptureTargetResult);
        }
        {
          const expectedControlVersion = controlVersion;
          return queueClick(async () => {
            await startupRecovery;
            return handleRecaptureTarget(message, sender, expectedControlVersion);
          });
        }
      case 'FRAME_TRAIL_CLICK':
        if (!acceptingClicks) return Promise.resolve({ ok: false } satisfies ClickCaptureResult);
        {
          const expectedControlVersion = controlVersion;
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
          handleRecaptureReady(message, sender),
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
      const expectedControlVersion = controlVersion;
      const state = await getRecordingState();
      if (
        expectedControlVersion === controlVersion &&
        state.operation === 'recapture' &&
        state.recapture?.sourceTabId === tabId
      ) {
        const context = state.recapture;
        // Startup intentionally waits for the initial document to finish. Once
        // selection is enabled, any navigation invalidates this one-shot job.
        if (
          context.phase !== 'starting' &&
          (changeInfo.status === 'loading' || (changeInfo.url != null && changeInfo.url !== context.sourceUrl))
        ) {
          await failStepRecapture(
            context.runId,
            'SOURCE_NAVIGATED',
            '補拍已停止，因為原始頁面在選取期間發生導覽。原內容未變更。',
            expectedControlVersion,
          );
        }
        return;
      }
      if (
        expectedControlVersion !== controlVersion ||
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

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const expectedControlVersion = controlVersion;
      const state = await getRecordingState();
      if (
        expectedControlVersion === controlVersion &&
        state.operation === 'recapture' &&
        state.recapture?.sourceTabId === tabId
      ) {
        await failStepRecapture(
          state.recapture.runId,
          'SOURCE_TAB_CLOSED',
          '補拍已停止，因為原始分頁已關閉。原內容未變更。',
          expectedControlVersion,
        );
        return;
      }
      if (
        expectedControlVersion !== controlVersion ||
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

import { browser, type Browser } from 'wxt/browser';
import {
  CAPTURE_PRESENTATION_CSS,
  waitForCapturePresentationPaint,
  withCapturePresentation,
} from '@/lib/capture-presentation';
import { addStep, deleteStep, getSteps, type Step } from '@/lib/db';
import {
  getCaptureGuardFailure,
  getRecordingTabUpdateAction,
  isMatchingSnapshotViewport,
} from '@/lib/recording-guards';
import { RecorderReadyGate } from '@/lib/recorder-ready';
import { injectRecorderScript } from '@/lib/recorder-injection';
import { getRecordingState, setRecordingState } from '@/lib/storage';
import type {
  BackgroundMessage,
  ClickCapture,
  ClickCaptureResult,
  FinishResult,
  FrameTrailSnapshotActiveMessage,
  FrameTrailStopMessage,
  RecordingControlMessage,
  RecordingControlResult,
  RecordingState,
  StartRecordingMessage,
} from '@/lib/messages';

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';
const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';
const RECORDER_READY_TIMEOUT_MS = 5_000;
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_CAPTURE_INTERVAL_MS = 500;
let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();
function queueCapture<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    return task();
  };
  const result = captureChain.then(run, run);
  captureChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Serializing the whole click transaction (state read, optional capture and
// DB writes) prevents duplicate snapshot anchors and colliding step orders.
let clickChain: Promise<unknown> = Promise.resolve();
function queueClick<T>(task: () => Promise<T>): Promise<T> {
  const result = clickChain.then(task, task);
  clickChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Control messages invalidate work synchronously, before their first await.
// Persisted runId provides the same protection across service-worker restarts.
let controlVersion = 0;
let acceptingClicks = true;
let pendingRecorderReady: RecorderReadyGate | null = null;
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
// A step gesture can time out in the content script while captureVisibleTab is
// still in flight. Keep cancellation state outside the queued click transaction
// so the background can invalidate that work before it reaches addStep().
const cancelledCaptureIds = new Set<string>();
const committingCaptureIds = new Set<string>();

function cancelCapture(captureId: string): void {
  if (committingCaptureIds.has(captureId)) return;
  cancelledCaptureIds.add(captureId);
  // Bound the set in case a tab disappears before its queued transaction runs.
  while (cancelledCaptureIds.size > 1_024) {
    const oldest = cancelledCaptureIds.values().next().value as string | undefined;
    if (!oldest) break;
    cancelledCaptureIds.delete(oldest);
  }
}

function assertCaptureNotCancelled(captureId: string): void {
  if (cancelledCaptureIds.has(captureId)) {
    throw new StaleCaptureError('Capture was cancelled before it could be saved.');
  }
}

let stateMutationChain: Promise<unknown> = Promise.resolve();
function queueStateMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = stateMutationChain.then(task, task);
  stateMutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

class StaleCaptureError extends Error {}

async function captureVisibleTabWithRetry(
  windowId: number,
  beforeEveryCapture: () => Promise<void>,
  maxRetries = 5,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      // captureVisibleTab always targets the window's active tab. This guard
      // must be adjacent to every actual API call, including quota retries.
      await beforeEveryCapture();
      return await browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 });
    } catch (err) {
      const isQuotaError = err instanceof Error && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      if (!isQuotaError || attempt >= maxRetries) throw err;
      console.warn('[frametrail] captureVisibleTab quota hit, retrying', attempt + 1);
      await sleep(MIN_CAPTURE_INTERVAL_MS * (attempt + 1));
    }
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function getScreenshotScale(screenshot: Blob, viewport: ClickCapture['viewport'], fallback: number): Promise<number> {
  if (viewport.width <= 0 || viewport.height <= 0) return fallback || 1;
  const bitmap = await createImageBitmap(screenshot);
  const horizontalScale = bitmap.width / viewport.width;
  const verticalScale = bitmap.height / viewport.height;
  bitmap.close();
  return Number.isFinite(horizontalScale) && horizontalScale > 0 && Math.abs(horizontalScale - verticalScale) < 0.1
    ? horizontalScale
    : fallback || 1;
}

async function injectRecorder(tabId: number, allFrames = false): Promise<void> {
  await injectRecorderScript(
    (target) => browser.scripting.executeScript({ target, files: [CONTENT_SCRIPT_FILE] }),
    tabId,
    allFrames,
  );
}

async function stopRecorderInTab(tabId: number | null): Promise<void> {
  if (tabId == null) return;
  try {
    const stopMessage: FrameTrailStopMessage = { type: 'FRAME_TRAIL_STOP' };
    await browser.tabs.sendMessage(tabId, stopMessage);
  } catch (err) {
    // A closed/navigated tab has no content listener left to clean up.
    console.warn('[frametrail] failed to send stop message to tab', tabId, err);
  }
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

function stopRunWithError(runId: string, error: string, expectedControlVersion: number): Promise<void> {
  if (expectedControlVersion !== controlVersion) return Promise.resolve();
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  const version = ++controlVersion;
  return handleStopRunWithError(runId, error, version);
}

async function handleStopRunWithError(runId: string, error: string, version: number): Promise<void> {
  const stoppedTabId = await queueStateMutation(async () => {
    const state = await getRecordingState();
    if (version !== controlVersion || !state.isRecording || state.runId !== runId) return null;
    await deleteEmptySnapshotAnchor(state);
    await setRecordingState({
      ...state,
      isRecording: false,
      phase: 'error',
      tabId: null,
      error,
      recoverableError: { code: 'RECORDING_STOPPED', message: error },
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    });
    return state.tabId;
  });
  if (stoppedTabId == null) return;
  await stopRecorderInTab(stoppedTabId);
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
  if (failure === 'inactive-tab') throw new Error('Step skipped because the recorded tab was no longer active.');
  if (failure === 'changed-url') throw new Error('Step skipped because the page changed before the screenshot could be taken.');
}

type SnapshotCaptureContext = NonNullable<
  Extract<BackgroundMessage, { type: 'FRAME_TRAIL_READY' }>['snapshotContext']
>;

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
    await addStep({
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
    });
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
      try {
        await deleteStep(anchorId);
      } catch (cleanupError) {
        console.error('[frametrail] failed to remove incomplete snapshot', cleanupError);
      }
    }
    throw error;
  } finally {
    cancelledCaptureIds.delete(captureId);
  }
}

function startRecording(message: StartRecordingMessage): Promise<void> {
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  pendingUndo = null;
  const version = ++controlVersion;
  return handleStartRecording(message, version);
}

async function handleStartRecording(message: StartRecordingMessage, version: number): Promise<void> {
  // Reset waits for all writes from the old run through STOP. START uses the
  // same barrier so an old capture cannot append to the reused session later.
  await clickChain;
  if (version !== controlVersion) return;

  const prevState = await getRecordingState();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (version !== controlVersion) return;

  await stopRecorderInTab(prevState.tabId);
  if (version !== controlVersion) return;
  if (!tab?.id) {
    await writeStateForControl(version, (current) => ({
      ...current,
      isRecording: false,
      phase: 'error',
      tabId: null,
      error: 'No active tab was found. Open a regular website and try again.',
      recoverableError: {
        code: 'NO_ACTIVE_TAB',
        message: '找不到可錄製的分頁。請開啟一般網站後再試一次。',
      },
      mode: message.mode,
      itemCount: 0,
      numbered: message.numbered,
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
      isRecording: false,
      phase: 'error',
      sessionId: current.sessionId,
      tabId: null,
      error: 'This page cannot be recorded because Chrome blocks scripting on it.',
      recoverableError: {
        code: 'RESTRICTED_PAGE',
        message: '此瀏覽器頁面不允許錄製。',
      },
      mode: message.mode,
      itemCount: 0,
      numbered: message.numbered,
      groupAnchorId: null,
      runId: null,
      snapshotViewport: null,
      snapshotDevicePixelRatio: null,
    }));
    return;
  }

  const runId = crypto.randomUUID();
  const startedState = await writeStateForControl(version, (current) => ({
    isRecording: true,
    phase: 'starting',
    sessionId: current.sessionId ?? crypto.randomUUID(),
    tabId: tab.id!,
    error: null,
    recoverableError: null,
    mode: message.mode,
    itemCount: 0,
    numbered: message.numbered,
    groupAnchorId: null,
    runId,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  }));
  if (!startedState) return;

  const readyGate = new RecorderReadyGate(
    { runId, tabId: tab.id, controlVersion: version },
    RECORDER_READY_TIMEOUT_MS,
  );
  pendingRecorderReady = readyGate;
  let startupAnchorId: string | null = null;
  try {
    const [, recorderReady] = await Promise.all([
      injectRecorder(tab.id, message.mode === 'snapshot'),
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
    console.error('[frametrail] failed to inject recorder', err);
    if (startupAnchorId) {
      try {
        await deleteStep(startupAnchorId);
      } catch (cleanupError) {
        console.error('[frametrail] failed to remove incomplete snapshot', cleanupError);
      }
    }
    if (version !== controlVersion) return;
    await stopRunWithError(runId, 'Failed to start recording on this page. Try a regular website.', version);
  } finally {
    if (pendingRecorderReady === readyGate) pendingRecorderReady = null;
    pendingSnapshotContext = undefined;
    readyGate.cancel();
  }
}

function stopRecording(): Promise<void> {
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
  pendingUndo = null;
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
    state.tabId !== tabId
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

async function handleStopRecording(version: number): Promise<void> {
  await clickChain;
  if (version !== controlVersion) return;
  const current = await getRecordingState();
  const tabId = current.tabId;
  if (version !== controlVersion) return;
  await deleteEmptySnapshotAnchor(current);
  const state = await writeStateForControl(version, (current) => ({
    ...current,
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
  await stopRecorderInTab(tabId);
}

async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<void> {
  if (state.mode !== 'snapshot' || !state.sessionId || !state.groupAnchorId) return;
  const steps = await getSteps(state.sessionId);
  const hasAnnotations = steps.some(
    (step) => step.groupId === state.groupAnchorId && step.id !== state.groupAnchorId && step.bounds !== null,
  );
  if (!hasAnnotations) await deleteStep(state.groupAnchorId);
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

    await deleteStep(last.id);
    const nextCount = Math.max(0, state.itemCount - 1);
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
      return controlFailure('錄製狀態已改變，未移除內容。');
    }

    const token = crypto.randomUUID();
    pendingUndo = {
      token,
      runId: message.runId,
      step: last,
      expectedItemCount: nextCount,
      expiresAt: Date.now() + 5_000,
    };
    return { ok: true, undoToken: token, removedItemNumber: state.itemCount };
  });
}

async function restoreLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
  return queueClick(async () => {
    const undo = pendingUndo;
    const state = await getRecordingState();
    if (
      !undo ||
      undo.token !== message.undoToken ||
      undo.runId !== message.runId ||
      undo.expiresAt < Date.now() ||
      !state.isRecording ||
      state.runId !== message.runId ||
      state.itemCount !== undo.expectedItemCount
    ) {
      pendingUndo = null;
      return controlFailure('已無法還原這筆內容。');
    }

    await addStep(undo.step);
    const updated = await updateRunState(message.runId, (current) => ({
      ...current,
      itemCount: current.itemCount + 1,
      error: null,
      recoverableError: null,
    }));
    if (!updated) {
      await deleteStep(undo.step.id);
      return controlFailure('錄製狀態已改變，未還原內容。');
    }
    pendingUndo = null;
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
  pendingUndo = null;
  await clickChain;

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
    await injectRecorder(previous.tabId);
  } catch (error) {
    console.error('[frametrail] failed to enter snapshot preparation state', error);
    await setRunError(message.runId, '無法顯示下一張快照控制，請重新載入一般網站後再試一次。');
    return controlFailure('無法準備下一張快照，已保留目前內容。');
  }
  return { ok: true };
}

async function createNextSnapshot(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const claimed = await queueStateMutation(async () => {
    const current = await getRecordingState();
    if (
      !current.isRecording ||
      !current.sessionId ||
      current.tabId == null ||
      current.runId !== message.runId ||
      current.mode !== 'snapshot' ||
      current.phase !== 'preparing-next'
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
    return { state: next, version };
  });
  if (!claimed) return controlFailure('目前無法建立下一張快照。');

  acceptingClicks = false;
  pendingUndo = null;
  pendingSnapshotContext = undefined;
  const { state, version } = claimed;
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
      injectRecorder(state.tabId!, true),
      readyGate.promise,
    ]);
    if (!recorderReady || version !== controlVersion) {
      throw new StaleCaptureError('Snapshot recorder did not become ready.');
    }
    const context = pendingSnapshotContext;
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
      await updateRunState(
        message.runId,
        (current) => ({
          ...current,
          phase: 'preparing-next',
          itemCount: 0,
          groupAnchorId: null,
          snapshotViewport: null,
          snapshotDevicePixelRatio: null,
          error: '無法建立新快照，請重試。',
          recoverableError: {
            code: 'CREATE_SNAPSHOT_FAILED',
            message: '無法建立新快照，請重試。',
          },
        }),
        version,
      );
      try {
        await injectRecorder(state.tabId!);
      } catch (reinjectionError) {
        console.error('[frametrail] failed to restore snapshot preparation toolbar', reinjectionError);
      }
    }
    return controlFailure('無法建立新快照，請重試。');
  } finally {
    if (pendingRecorderReady === readyGate) pendingRecorderReady = null;
    pendingSnapshotContext = undefined;
    readyGate.cancel();
  }
}

async function openOrFocusEditor(result: FinishResult): Promise<void> {
  const editorBase = browser.runtime.getURL('/editor.html');
  const editorUrl = new URL(editorBase);
  editorUrl.searchParams.set('sessionId', result.sessionId);
  if (result.entryId) editorUrl.searchParams.set('entryId', result.entryId);
  if (result.groupId) editorUrl.searchParams.set('groupId', result.groupId);

  const [existing] = await browser.tabs.query({ url: `${editorBase}*` });
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true, url: editorUrl.href });
    if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: editorUrl.href, active: true });
}

async function finishRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
  const startedAtControlVersion = controlVersion;
  const initial = await getRecordingState();
  if (
    !initial.isRecording ||
    initial.runId !== message.runId ||
    (initial.phase !== 'recording' && initial.phase !== 'paused' && initial.phase !== 'preparing-next')
  ) {
    return controlFailure(initial.phase === 'finishing' ? '正在完成錄製。' : '這次錄製已經結束。');
  }

  acceptingClicks = false;
  pendingUndo = null;
  const markedFinishing = await queueStateMutation(async () => {
    if (startedAtControlVersion !== controlVersion) return false;
    const current = await getRecordingState();
    if (
      !current.isRecording ||
      current.runId !== message.runId ||
      (current.phase !== 'recording' && current.phase !== 'paused' && current.phase !== 'preparing-next')
    ) {
      return false;
    }
    await setRecordingState({ ...current, phase: 'finishing', error: null, recoverableError: null });
    return true;
  });
  if (!markedFinishing) return controlFailure('錄製狀態已改變，請再試一次。');

  await clickChain;
  if (startedAtControlVersion !== controlVersion) return controlFailure('錄製狀態已改變。');

  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId || state.runId !== message.runId) {
    return controlFailure('這次錄製已經結束。');
  }
  await deleteEmptySnapshotAnchor(state);
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

  await stopRecorderInTab(state.tabId);
  try {
    await openOrFocusEditor(result);
  } catch (error) {
    console.error('[frametrail] failed to open editor after recording', error);
    return { ok: true, finish: result };
  }
  return { ok: true, finish: result };
}

function handleRecordingControl(message: RecordingControlMessage): Promise<RecordingControlResult> {
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
    case 'FINISH_RECORDING':
      return finishRecording(message);
  }
}

async function captureScreenshot(
  message: Pick<ClickCapture, 'runId' | 'url' | 'viewport' | 'devicePixelRatio' | 'captureId'>,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedControlVersion: number,
): Promise<{ blob: Blob; scale: number }> {
  return queueCapture(async () => {
    const guard = async () => {
      assertCaptureNotCancelled(message.captureId);
      await assertCaptureContext(expectedControlVersion, message.runId, sessionId, tabId, windowId, message.url);
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
      () => captureVisibleTabWithRetry(windowId, guard),
    );
    const blob = await dataUrlToBlob(dataUrl);
    const scale = await getScreenshotScale(blob, message.viewport, message.devicePixelRatio);
    // Do not persist a screenshot after STOP/RESET/another START arrived while
    // the image was decoded.
    await guard();
    return { blob, scale };
  });
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
    throw new Error('Snapshot annotation skipped because the viewport or scroll position changed.');
  }

  if (!anchorId) throw new Error('Snapshot annotation skipped because its base image is missing.');
  let existingSteps = await getSteps(sessionId);
  const anchor = existingSteps.find((step) => step.id === anchorId);

  if (!anchor?.screenshotBlob) throw new Error('Snapshot annotation skipped because its base image is missing.');
  if (anchor.url !== message.url) {
    throw new Error('Snapshot annotation skipped because the page changed after its base image was captured.');
  }
  if (expectedControlVersion !== controlVersion) {
    throw new StaleCaptureError('Recording control changed while saving the annotation.');
  }
  const current = await getRecordingState();
  if (!current.isRecording || current.runId !== message.runId || current.sessionId !== sessionId) {
    throw new StaleCaptureError('Recording changed while saving the annotation.');
  }
  existingSteps = await getSteps(sessionId);
  await addStep({
    id: crypto.randomUUID(),
    sessionId,
    runId: message.runId,
    order: existingSteps.length,
    bounds: message.rect,
    devicePixelRatio: anchor.devicePixelRatio,
    screenshotScale: anchor.screenshotScale,
    description: `標記 ${message.text || message.tagName}`,
    url: message.url,
    timestamp: message.timestamp,
    groupId: anchorId,
    numbered: state.numbered,
  });
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
  if (sender.tab?.id !== state.tabId) return rejectBeforeTransaction();
  const windowId = sender.tab?.windowId;
  const tabId = sender.tab?.id;
  if (windowId == null || tabId == null) return rejectBeforeTransaction();

  try {
    pendingUndo = null;
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
      await addStep({
        id: crypto.randomUUID(),
        sessionId: state.sessionId,
        runId: message.runId,
        order: existingSteps.length,
        screenshotBlob: captured.blob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale: captured.scale,
        description: `${message.intent === 'mark' ? '標記' : '點擊'} ${message.text || message.tagName}`,
        url: message.url,
        timestamp: message.timestamp,
      });
    }
    await updateRunState(message.runId, (currentState) => ({
      ...currentState,
      itemCount: currentState.itemCount + 1,
      error: null,
      recoverableError: null,
    }));
    return { ok: true };
  } catch (err) {
    if (!(err instanceof StaleCaptureError)) {
      const messageText = err instanceof Error ? err.message : 'Failed to capture and save this step.';
      console.error('[frametrail] failed to capture/annotate/save step', err);
      await setRunError(message.runId, messageText);
    }
    return { ok: false };
  } finally {
    committingCaptureIds.delete(message.captureId);
    cancelledCaptureIds.delete(message.captureId);
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: BackgroundMessage, sender) => {
    switch (message.type) {
      case 'START_RECORDING':
        return startRecording(message);
      case 'STOP_RECORDING':
        return stopRecording();
      case 'PAUSE_RECORDING':
      case 'RESUME_RECORDING':
      case 'UNDO_LAST_CAPTURE':
      case 'RESTORE_LAST_CAPTURE':
      case 'PREPARE_NEXT_SNAPSHOT':
      case 'CREATE_NEXT_SNAPSHOT':
      case 'FINISH_RECORDING':
        return handleRecordingControl(message);
      case 'FRAME_TRAIL_CLICK':
        if (!acceptingClicks) return Promise.resolve({ ok: false } satisfies ClickCaptureResult);
        {
          const expectedControlVersion = controlVersion;
          return queueClick(() => handleClick(message, sender, expectedControlVersion));
        }
      case 'FRAME_TRAIL_CANCEL_CAPTURE':
        cancelCapture(message.captureId);
        return Promise.resolve({ ok: true } satisfies ClickCaptureResult);
      case 'FRAME_TRAIL_READY':
        return handleRecorderReady(message, sender);
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    port.onMessage.addListener(() => {});
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
    const expectedControlVersion = controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== controlVersion ||
      !state.isRecording ||
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
        await injectRecorder(tabId);
      } catch (err) {
        console.error('[frametrail] failed to restore snapshot preparation toolbar after navigation', err);
        await setRunError(runId, '無法在這個頁面顯示錄製控制；請重新載入一般網站後再試一次。');
      }
      return;
    }

    const updateAction = getRecordingTabUpdateAction(state.mode, changeInfo);
    // A snapshot's coordinates belong to one immutable document. Fail closed
    // as soon as that document navigates, and never re-inject merely because a
    // document that was loading at START later reports status=complete.
    if (updateAction === 'stop-snapshot') {
      await stopRunWithError(runId, 'Recording stopped because the snapshot page changed.', expectedControlVersion);
      return;
    }
    if (updateAction !== 'reinject') return;

    if (isRestrictedUrl(tab.url)) {
      await stopRunWithError(
        runId,
        'Recording stopped because the new page does not allow scripting.',
        expectedControlVersion,
      );
      return;
    }
    try {
      await injectRecorder(tabId);
    } catch (err) {
      console.error('[frametrail] failed to re-inject recorder after navigation', err);
      await stopRunWithError(
        runId,
        'Recording stopped because the recorder could not be loaded after navigation.',
        expectedControlVersion,
      );
    }
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    const expectedControlVersion = controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== controlVersion ||
      !state.isRecording ||
      state.tabId !== tabId ||
      !state.runId
    ) {
      return;
    }
    await stopRunWithError(
      state.runId,
      'Recording stopped because the recorded tab was closed.',
      expectedControlVersion,
    );
  });
});

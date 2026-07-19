import { browser, type Browser } from 'wxt/browser';
import { addStep, deleteStep, getSteps } from '@/lib/db';
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
  FrameTrailStopMessage,
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
  await updateRunState(runId, (current) => ({ ...current, error }));
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
      tabId: null,
      error,
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

function startRecording(message: StartRecordingMessage): Promise<void> {
  acceptingClicks = false;
  pendingRecorderReady?.cancel();
  pendingRecorderReady = null;
  pendingSnapshotContext = undefined;
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
      tabId: null,
      error: 'No active tab was found. Open a regular website and try again.',
      mode: message.mode,
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
      sessionId: current.sessionId,
      tabId: null,
      error: 'This page cannot be recorded because Chrome blocks scripting on it.',
      mode: message.mode,
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
    sessionId: current.sessionId ?? crypto.randomUUID(),
    tabId: tab.id!,
    error: null,
    mode: message.mode,
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

      const captured = await captureScreenshot(
        { runId, ...context },
        startedState.sessionId,
        tab.id,
        tab.windowId,
        version,
      );
      const anchorId = crypto.randomUUID();
      startupAnchorId = anchorId;
      const existingSteps = await getSteps(startedState.sessionId);
      await addStep({
        id: anchorId,
        sessionId: startedState.sessionId,
        order: existingSteps.length,
        screenshotBlob: captured.blob,
        bounds: null,
        devicePixelRatio: context.devicePixelRatio,
        screenshotScale: captured.scale,
        description: '',
        url: context.url,
        timestamp: context.timestamp,
        groupId: anchorId,
        numbered: message.numbered,
      });
      const updated = await updateRunState(
        runId,
        (current) => ({
          ...current,
          groupAnchorId: anchorId,
          snapshotViewport: context.viewport,
          snapshotDevicePixelRatio: context.devicePixelRatio,
          error: null,
        }),
        version,
      );
      if (!updated) {
        await deleteStep(anchorId);
        startupAnchorId = null;
        throw new StaleCaptureError('Recording changed while saving the snapshot.');
      }
    }
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
  return matchesPendingStartup || signaled === true || acceptingClicks;
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
    tabId: null,
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

async function captureScreenshot(
  message: Pick<ClickCapture, 'runId' | 'url' | 'viewport' | 'devicePixelRatio'>,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedControlVersion: number,
): Promise<{ blob: Blob; scale: number }> {
  return queueCapture(async () => {
    const guard = () =>
      assertCaptureContext(expectedControlVersion, message.runId, sessionId, tabId, windowId, message.url);
    const dataUrl = await captureVisibleTabWithRetry(windowId, guard);
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
  if (expectedControlVersion !== controlVersion) return { ok: false };
  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId || state.runId !== message.runId) return { ok: false };
  if (sender.tab?.id !== state.tabId) return { ok: false };
  const windowId = sender.tab?.windowId;
  const tabId = sender.tab?.id;
  if (windowId == null || tabId == null) return { ok: false };

  try {
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
      await addStep({
        id: crypto.randomUUID(),
        sessionId: state.sessionId,
        order: existingSteps.length,
        screenshotBlob: captured.blob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale: captured.scale,
        description: `${message.intent === 'mark' ? '標記' : '點擊'} ${message.text || message.tagName}`,
        url: message.url,
        timestamp: message.timestamp,
      });
      await updateRunState(message.runId, (currentState) => ({ ...currentState, error: null }));
    }
    return { ok: true };
  } catch (err) {
    if (!(err instanceof StaleCaptureError)) {
      const messageText = err instanceof Error ? err.message : 'Failed to capture and save this step.';
      console.error('[frametrail] failed to capture/annotate/save step', err);
      await setRunError(message.runId, messageText);
    }
    return { ok: false };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: BackgroundMessage, sender) => {
    switch (message.type) {
      case 'START_RECORDING':
        return startRecording(message);
      case 'STOP_RECORDING':
        return stopRecording();
      case 'FRAME_TRAIL_CLICK':
        if (!acceptingClicks) return Promise.resolve({ ok: false } satisfies ClickCaptureResult);
        {
          const expectedControlVersion = controlVersion;
          return queueClick(() => handleClick(message, sender, expectedControlVersion));
        }
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

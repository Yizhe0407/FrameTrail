import { browser, type Browser } from 'wxt/browser';
import { addStep, getSteps } from '@/lib/db';
import { getRecordingState, setRecordingState } from '@/lib/storage';
import type { BackgroundMessage, ClickCapture, FrameTrailStopMessage, RecordingState, StartRecordingMessage } from '@/lib/messages';

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';

// Matches the name content.ts opens on browser.runtime.connect.
const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';

// Chrome hard-blocks scripting on these regardless of permissions (Web Store,
// internal chrome:// pages, other extensions' pages, etc.) — check up front
// so we can revert cleanly instead of leaving isRecording stuck on true.
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

// Chrome allows ~2 captureVisibleTab calls/sec per tab. Serialize calls and
// throttle by elapsed time since the last capture (not a flat sleep after
// every one) so a burst of clicks doesn't pile up idle wait time on top of
// idle wait time; retry with backoff as a safety net for whatever bursts
// still slip through.
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

async function captureVisibleTabWithRetry(windowId: number, maxRetries = 5): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      // JPEG is ~5-10x smaller than PNG for screenshots — keeps IndexedDB,
      // the export payload, and PDF embedding fast.
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

/**
 * captureVisibleTab returns bitmap pixels, while DOMRect is in CSS pixels.
 * Measuring the bitmap avoids assuming devicePixelRatio, which changes with
 * browser zoom and can differ from the image Chrome actually returns.
 */
async function getScreenshotScale(screenshot: Blob, viewport: ClickCapture['viewport'], fallback: number): Promise<number> {
  if (viewport.width <= 0 || viewport.height <= 0) return fallback || 1;

  const bitmap = await createImageBitmap(screenshot);
  const horizontalScale = bitmap.width / viewport.width;
  const verticalScale = bitmap.height / viewport.height;
  bitmap.close();

  // Width is the stable dimension for browser screenshots. Keep a plausible
  // fallback for browser UI/cropping cases where the reported dimensions differ.
  return Number.isFinite(horizontalScale) && horizontalScale > 0 && Math.abs(horizontalScale - verticalScale) < 0.1
    ? horizontalScale
    : fallback || 1;
}

async function injectRecorder(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE],
  });
}

async function handleStartRecording(message: StartRecordingMessage): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  console.log('[frametrail] START_RECORDING, active tab:', tab?.id, tab?.url, 'mode:', message.mode);
  if (!tab?.id) {
    console.error('[frametrail] no active tab found, aborting start');
    return;
  }

  // Reuse the existing session (if any) rather than generating a new one —
  // steps must only disappear from the editor on an explicit Reset, and
  // ordinary steps + snapshot groups can freely coexist in one session
  // (see buildStepEntries). groupAnchorId always resets to null here so a
  // fresh snapshot-mode run starts its own new shared image instead of
  // resuming an earlier group's.
  const prevState = await getRecordingState();
  const sessionId = prevState.sessionId ?? crypto.randomUUID();

  if (isRestrictedUrl(tab.url)) {
    console.warn('[frametrail] cannot record restricted page', tab.url);
    await setRecordingState({
      isRecording: false,
      sessionId: prevState.sessionId,
      tabId: null,
      error: 'This page cannot be recorded (Chrome blocks scripting on Web Store / chrome:// pages). Try a regular website.',
      mode: message.mode,
      numbered: message.numbered,
      groupAnchorId: null,
    });
    return;
  }

  await setRecordingState({
    isRecording: true,
    sessionId,
    tabId: tab.id,
    error: null,
    mode: message.mode,
    numbered: message.numbered,
    groupAnchorId: null,
  });

  try {
    await injectRecorder(tab.id);
    console.log('[frametrail] recorder injected into tab', tab.id, 'session', sessionId);
  } catch (err) {
    console.error('[frametrail] failed to inject recorder', err);
    // Keep sessionId — it may already have steps from before this failed
    // start, and only Reset should drop it.
    await setRecordingState({
      isRecording: false,
      sessionId,
      tabId: null,
      error: 'Failed to start recording on this page. Try a regular website.',
      mode: message.mode,
      numbered: message.numbered,
      groupAnchorId: null,
    });
  }
}

async function handleStopRecording(): Promise<void> {
  const state = await getRecordingState();
  await setRecordingState({ ...state, isRecording: false });
  console.log('[frametrail] STOP_RECORDING, session', state.sessionId);

  // Tell the recorder in the recorded tab to tear itself down — otherwise its
  // keep-alive port + 20s heartbeat keep running for as long as the tab stays
  // open, which holds this service worker alive indefinitely. The tab may
  // already be closed or never had the recorder injected (restricted page,
  // injection failure); either way there's nothing to clean up there.
  if (state.tabId != null) {
    try {
      const stopMessage: FrameTrailStopMessage = { type: 'FRAME_TRAIL_STOP' };
      await browser.tabs.sendMessage(state.tabId, stopMessage);
    } catch (err) {
      console.warn('[frametrail] failed to send stop message to tab', state.tabId, err);
    }
  }
}

/** Snapshot mode: every click in the current recording run shares one
 * screenshot — only the run's first click actually captures it (as a fresh
 * anchor step with bounds=null, self-referencing groupId); every later click
 * just records its own box against that same blob, no further
 * captureVisibleTab calls needed. groupAnchorId (persisted in RecordingState)
 * is what makes this resumable across service-worker restarts and what forces
 * a brand-new image at the start of the next recording run. */
async function handleSingleImageClick(
  message: ClickCapture,
  sessionId: string,
  windowId: number,
  state: RecordingState,
): Promise<void> {
  let anchorId = state.groupAnchorId;

  if (!anchorId) {
    anchorId = crypto.randomUUID();
    const newAnchorId = anchorId;
    await queueCapture(async () => {
      const dataUrl = await captureVisibleTabWithRetry(windowId);
      const screenshotBlob = await dataUrlToBlob(dataUrl);
      const screenshotScale = await getScreenshotScale(screenshotBlob, message.viewport, message.devicePixelRatio);
      const existingSteps = await getSteps(sessionId);
      await addStep({
        id: newAnchorId,
        sessionId,
        order: existingSteps.length,
        screenshotBlob,
        bounds: null,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale,
        description: '',
        url: message.url,
        timestamp: message.timestamp,
        groupId: newAnchorId,
        numbered: state.numbered,
      });
    });
    await setRecordingState({ ...state, groupAnchorId: newAnchorId });
  }

  const existingSteps = await getSteps(sessionId);
  const anchor = existingSteps.find((s) => s.id === anchorId)!;
  await addStep({
    id: crypto.randomUUID(),
    sessionId,
    order: existingSteps.length,
    screenshotBlob: anchor.screenshotBlob,
    bounds: message.rect,
    devicePixelRatio: anchor.devicePixelRatio,
    screenshotScale: anchor.screenshotScale,
    description: `點擊 ${message.text || message.tagName}`,
    url: message.url,
    timestamp: message.timestamp,
    groupId: anchorId,
    numbered: state.numbered,
  });
}

async function handleClick(message: ClickCapture, sender: Browser.runtime.MessageSender): Promise<void> {
  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId) return;
  if (sender.tab?.id !== state.tabId) return;

  const windowId = sender.tab?.windowId;
  const tabId = sender.tab?.id;
  if (windowId == null || tabId == null) return;
  const sessionId = state.sessionId;

  // The click's tab may no longer be the front tab by the time this message
  // arrives (fast tab switch, alt-tab away). captureVisibleTab has no tab
  // targeting of its own — it always shoots the window's active tab — so
  // capturing here would silently save a screenshot of the wrong page.
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  if (activeTab?.id !== tabId) {
    console.warn('[frametrail] tab no longer active, skipping step', tabId);
    return;
  }

  try {
    if (state.mode === 'snapshot') {
      await handleSingleImageClick(message, sessionId, windowId, state);
      return;
    }

    await queueCapture(async () => {
      const dataUrl = await captureVisibleTabWithRetry(windowId);
      const screenshotBlob = await dataUrlToBlob(dataUrl);
      const screenshotScale = await getScreenshotScale(screenshotBlob, message.viewport, message.devicePixelRatio);
      const existingSteps = await getSteps(sessionId);

      await addStep({
        id: crypto.randomUUID(),
        sessionId,
        order: existingSteps.length,
        screenshotBlob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale,
        description: `點擊 ${message.text || message.tagName}`,
        url: message.url,
        timestamp: message.timestamp,
      });
    });
  } catch (err) {
    console.error('[frametrail] failed to capture/annotate/save step', err);
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: BackgroundMessage, sender) => {
    switch (message.type) {
      case 'START_RECORDING':
        return handleStartRecording(message);
      case 'STOP_RECORDING':
        return handleStopRecording();
      case 'FRAME_TRAIL_CLICK':
        return handleClick(message, sender);
    }
  });

  // An open port with periodic traffic keeps this worker alive for the whole
  // recording session; without it MV3 reclaims an idle worker and the next
  // click pays a 100-500ms cold-start before its capture fires.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    port.onMessage.addListener(() => {});
  });

  // Re-inject the recorder after each navigation on the tab being recorded (a
  // new document has no listener until we run the content script again).
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    const state = await getRecordingState();
    if (!state.isRecording || state.tabId !== tabId) return;

    if (isRestrictedUrl(tab.url)) {
      console.warn('[frametrail] navigated to restricted page mid-recording, stopping', tab.url);
      await setRecordingState({ ...state, isRecording: false, error: 'Recording stopped: navigated to a page Chrome does not allow scripting on.' });
      return;
    }

    try {
      await injectRecorder(tabId);
    } catch (err) {
      console.error('[frametrail] failed to re-inject recorder after navigation', err);
    }
  });
});

import { MIN_CAPTURE_INTERVAL_MS, sleep } from '../background-queues';
import { injectRecorderScript } from '../recorder-injection';
import type { ClickCapture, FrameTrailStopMessage } from '../../runtime/messages';

export interface RecorderRuntimeDependencies {
  captureVisibleTab: (windowId: number) => Promise<string>;
  executeRecorderScript: (target: { tabId: number; allFrames?: boolean }) => Promise<unknown>;
  sendStopMessage: (tabId: number, message: FrameTrailStopMessage) => Promise<unknown>;
}

/** Browser API adapter shared by recording, insertion, and recapture flows. */
export function createRecorderRuntime({
  captureVisibleTab,
  executeRecorderScript,
  sendStopMessage,
}: RecorderRuntimeDependencies) {
  async function captureVisibleTabWithRetry(
    windowId: number,
    beforeEveryCapture: () => Promise<void>,
    maxRetries = 5,
  ): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        // captureVisibleTab always targets the window's active tab. This guard
        // must be adjacent to every API call, including quota retries.
        await beforeEveryCapture();
        return await captureVisibleTab(windowId);
      } catch (error) {
        const isQuotaError = error instanceof Error && error.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
        if (!isQuotaError || attempt >= maxRetries) throw error;
        console.warn('[frametrail] captureVisibleTab quota hit, retrying', attempt + 1);
        await sleep(MIN_CAPTURE_INTERVAL_MS * (attempt + 1));
      }
    }
  }

  async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    return (await fetch(dataUrl)).blob();
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
    await injectRecorderScript(executeRecorderScript, tabId, allFrames);
  }

  async function stopRecorderInTab(tabId: number | null): Promise<void> {
    if (tabId == null) return;
    try {
      await sendStopMessage(tabId, { type: 'FRAME_TRAIL_STOP' });
    } catch (error) {
      // A closed/navigated tab has no content listener left to clean up.
      console.warn('[frametrail] failed to send stop message to tab', tabId, error);
    }
  }

  return { captureVisibleTabWithRetry, dataUrlToBlob, getScreenshotScale, injectRecorder, stopRecorderInTab };
}

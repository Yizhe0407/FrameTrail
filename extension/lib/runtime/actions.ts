import { browser } from 'wxt/browser';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
  ResetGuideResult,
} from './messages';
import {
  isCancelStepRecaptureResult,
  isFocusStepRecaptureSourceResult,
  isResetGuideResult,
  requireRuntimeMessageResult,
} from './runtime-message-result';

/** Requests an atomic, Guide-targeted reset from the background lifecycle. */
export async function resetSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('找不到要重置的教學。');
  const result = requireRuntimeMessageResult<ResetGuideResult>(
    await browser.runtime.sendMessage({
      type: 'RESET_GUIDE',
      sessionId,
    }),
    isResetGuideResult,
  );
  if (!result.ok) throw new Error(result.error);
}

/** Confirms a delivered recapture result so the background clears the durable
 * handoff. Fire-and-check: delivery failures are the caller's to log. */
export function ackStepRecaptureResult(runId: string, sessionId: string): Promise<unknown> {
  return browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId, sessionId });
}

/** Asks the background to focus the tab a recapture run is working in. */
export async function focusStepRecaptureSource(runId: string): Promise<FocusStepRecaptureSourceResult> {
  return requireRuntimeMessageResult<FocusStepRecaptureSourceResult>(
    await browser.runtime.sendMessage({ type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId }),
    isFocusStepRecaptureSourceResult,
  );
}

/** Asks the background to cancel a recapture run without touching content. */
export async function cancelStepRecapture(runId: string): Promise<CancelStepRecaptureResult> {
  return requireRuntimeMessageResult<CancelStepRecaptureResult>(
    await browser.runtime.sendMessage({ type: 'CANCEL_STEP_RECAPTURE', runId }),
    isCancelStepRecaptureResult,
  );
}

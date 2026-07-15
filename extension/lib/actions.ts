import { browser } from 'wxt/browser';
import { deleteStepsForSession } from './db';
import { setRecordingState, getRecordingState } from './storage';

/** Stops any in-progress recording and discards the current session's steps. */
export async function resetSession(): Promise<void> {
  await browser.runtime.sendMessage({ type: 'STOP_RECORDING' });

  const state = await getRecordingState();
  if (state.sessionId) {
    await deleteStepsForSession(state.sessionId);
  }

  await setRecordingState({
    isRecording: false,
    sessionId: null,
    tabId: null,
    error: null,
    mode: 'multi',
    numbered: true,
    groupAnchorId: null,
  });
}

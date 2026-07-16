import { browser, type Browser } from 'wxt/browser';
import { RECORDING_STATE_KEY, type RecordingState } from './messages';

const DEFAULT_STATE: RecordingState = {
  isRecording: false,
  sessionId: null,
  tabId: null,
  error: null,
  mode: 'steps',
  numbered: true,
  groupAnchorId: null,
};

export async function getRecordingState(): Promise<RecordingState> {
  const result = await browser.storage.local.get(RECORDING_STATE_KEY);
  const stored = result[RECORDING_STATE_KEY] as RecordingState | undefined;
  if (!stored) return DEFAULT_STATE;
  // A state persisted before the mode rename can hold a legacy value
  // ('multi'/'single'); normalize anything unrecognized back to the default.
  if (stored.mode !== 'steps' && stored.mode !== 'snapshot') {
    return { ...stored, mode: DEFAULT_STATE.mode };
  }
  return stored;
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await browser.storage.local.set({ [RECORDING_STATE_KEY]: state });
}

/** Subscribes to recording-state changes; returns an unsubscribe function. */
export function onRecordingStateChange(callback: (state: RecordingState) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[RECORDING_STATE_KEY];
    if (change) callback(change.newValue as RecordingState);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

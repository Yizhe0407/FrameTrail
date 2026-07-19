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
  runId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
};

export function createDefaultRecordingState(): RecordingState {
  return { ...DEFAULT_STATE };
}

export function normalizeRecordingState(stored: Partial<RecordingState> | undefined): RecordingState {
  const normalized = { ...DEFAULT_STATE, ...stored };
  // A state persisted before the mode rename can hold a legacy value
  // ('multi'/'single'); normalize anything unrecognized back to the default.
  return normalized.mode === 'steps' || normalized.mode === 'snapshot'
    ? normalized
    : { ...normalized, mode: DEFAULT_STATE.mode };
}

export async function getRecordingState(): Promise<RecordingState> {
  const result = await browser.storage.local.get(RECORDING_STATE_KEY);
  return normalizeRecordingState(result[RECORDING_STATE_KEY] as Partial<RecordingState> | undefined);
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await browser.storage.local.set({ [RECORDING_STATE_KEY]: state });
}

/** Subscribes to recording-state changes; returns an unsubscribe function. */
export function onRecordingStateChange(callback: (state: RecordingState) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[RECORDING_STATE_KEY];
    if (change) callback(normalizeRecordingState(change.newValue as Partial<RecordingState> | undefined));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

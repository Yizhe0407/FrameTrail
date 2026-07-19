import type { ClickCapture, RecordingMode, RecordingState } from './messages';

export type CaptureGuardFailure = 'stale-run' | 'inactive-tab' | 'changed-url' | null;
export type RecordingTabUpdateAction = 'ignore' | 'reinject' | 'stop-snapshot';

export function getRecordingTabUpdateAction(
  mode: RecordingMode,
  changeInfo: { status?: string; url?: string },
): RecordingTabUpdateAction {
  if (mode === 'snapshot') {
    return changeInfo.status === 'loading' || Boolean(changeInfo.url) ? 'stop-snapshot' : 'ignore';
  }
  return changeInfo.status === 'complete' ? 'reinject' : 'ignore';
}

export function getCaptureGuardFailure(input: {
  expectedControlVersion: number;
  currentControlVersion: number;
  runId: string;
  sessionId: string;
  tabId: number;
  expectedUrl: string;
  state: RecordingState;
  activeTab: { id?: number; url?: string } | undefined;
}): CaptureGuardFailure {
  const { state } = input;
  if (
    input.expectedControlVersion !== input.currentControlVersion ||
    !state.isRecording ||
    state.runId !== input.runId ||
    state.sessionId !== input.sessionId ||
    state.tabId !== input.tabId
  ) {
    return 'stale-run';
  }
  if (input.activeTab?.id !== input.tabId) return 'inactive-tab';
  if (input.activeTab.url && input.activeTab.url !== input.expectedUrl) return 'changed-url';
  return null;
}

export function isMatchingSnapshotViewport(
  expected: ClickCapture['viewport'],
  expectedDevicePixelRatio: number,
  actual: ClickCapture['viewport'],
  actualDevicePixelRatio: number,
): boolean {
  return (
    expected.width === actual.width &&
    expected.height === actual.height &&
    Math.abs(expected.scrollX - actual.scrollX) < 1 &&
    Math.abs(expected.scrollY - actual.scrollY) < 1 &&
    expectedDevicePixelRatio === actualDevicePixelRatio
  );
}

import { describe, expect, it } from 'vitest';
import type { RecordingState } from '@/lib/messages';
import {
  clearEditorRecovery,
  EDITOR_OPEN_FAILED_ERROR,
  markEditorOpenFailed,
  needsEditorRecovery,
  RECORDED_TAB_CLOSED_ERROR,
} from '@/lib/recording-recovery';

const idleState: RecordingState = {
  isRecording: false,
  operation: null,
  recapture: null,
  recaptureResult: null,
  phase: 'idle',
  sessionId: 'session-1',
  tabId: null,
  error: null,
  recoverableError: null,
  mode: 'steps',
  itemCount: 0,
  numbered: true,
  groupAnchorId: null,
  runId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
};

describe('recording recovery state', () => {
  it('recognizes only recovery states that should lead to the editor', () => {
    expect(needsEditorRecovery(RECORDED_TAB_CLOSED_ERROR)).toBe(true);
    expect(needsEditorRecovery(EDITOR_OPEN_FAILED_ERROR)).toBe(true);
    expect(needsEditorRecovery({ code: 'CAPTURE_FAILED', message: 'retry capture' })).toBe(false);
    expect(needsEditorRecovery(null)).toBe(false);
  });

  it('marks an idle completed recording when automatic editor navigation fails', () => {
    expect(markEditorOpenFailed(idleState)).toMatchObject({
      isRecording: false,
      phase: 'error',
      recoverableError: EDITOR_OPEN_FAILED_ERROR,
    });
    expect(markEditorOpenFailed({ ...idleState, isRecording: true, phase: 'recording' })).toMatchObject({
      isRecording: true,
      phase: 'recording',
      recoverableError: null,
    });
  });

  it('clears editor recovery only after a successful retry', () => {
    expect(clearEditorRecovery({
      ...idleState,
      phase: 'error',
      recoverableError: RECORDED_TAB_CLOSED_ERROR,
    })).toMatchObject({ phase: 'idle', error: null, recoverableError: null });
    const unrelated = { ...idleState, recoverableError: { code: 'CAPTURE_FAILED', message: 'retry capture' } };
    expect(clearEditorRecovery(unrelated)).toBe(unrelated);
  });
});

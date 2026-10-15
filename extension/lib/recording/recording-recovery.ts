import type { RecoverableRecordingError, RecordingState } from '../storage/recording-state';
import { t } from '@/lib/shared/i18n';

/** Built on demand so the message is in the locale active when it is raised. */
export function recordedTabClosedError(): RecoverableRecordingError {
  return { code: 'RECORDED_TAB_CLOSED', message: t().runtime.recordingTabClosed };
}

export function editorOpenFailedError(): RecoverableRecordingError {
  return { code: 'EDITOR_OPEN_FAILED', message: t().runtime.editorOpenAfterRecordingFailed };
}

export function needsEditorRecovery(error: RecoverableRecordingError | null): boolean {
  return error?.code === 'RECORDED_TAB_CLOSED' || error?.code === 'EDITOR_OPEN_FAILED';
}

export function markEditorOpenFailed(state: RecordingState): RecordingState {
  if (state.isRecording) return state;
  return {
    ...state,
    phase: 'error',
    error: 'Recording was saved but the editor could not be opened.',
    recoverableError: editorOpenFailedError(),
  };
}

export function clearEditorRecovery(state: RecordingState): RecordingState {
  if (state.isRecording || !needsEditorRecovery(state.recoverableError)) return state;
  return { ...state, phase: 'idle', error: null, recoverableError: null };
}

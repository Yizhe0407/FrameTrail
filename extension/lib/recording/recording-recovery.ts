import type { RecoverableRecordingError, RecordingState } from '../runtime/messages';

export const RECORDED_TAB_CLOSED_ERROR: RecoverableRecordingError = {
  code: 'RECORDED_TAB_CLOSED',
  message: '錄製分頁已關閉。已錄內容仍保留，可完成並開啟編輯器。',
};

export const EDITOR_OPEN_FAILED_ERROR: RecoverableRecordingError = {
  code: 'EDITOR_OPEN_FAILED',
  message: '錄製已儲存，但無法自動開啟編輯器。',
};

export function needsEditorRecovery(error: RecoverableRecordingError | null): boolean {
  return error?.code === RECORDED_TAB_CLOSED_ERROR.code || error?.code === EDITOR_OPEN_FAILED_ERROR.code;
}

export function markEditorOpenFailed(state: RecordingState): RecordingState {
  if (state.isRecording) return state;
  return {
    ...state,
    phase: 'error',
    error: 'Recording was saved but the editor could not be opened.',
    recoverableError: EDITOR_OPEN_FAILED_ERROR,
  };
}

export function clearEditorRecovery(state: RecordingState): RecordingState {
  if (state.isRecording || !needsEditorRecovery(state.recoverableError)) return state;
  return { ...state, phase: 'idle', error: null, recoverableError: null };
}

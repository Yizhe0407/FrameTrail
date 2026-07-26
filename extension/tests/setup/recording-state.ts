import { createDefaultRecordingState, type RecordingState } from '@/lib/storage/recording-state';

/**
 * Builds a RecordingState fixture on top of the production default, so a test
 * only names the fields it actually asserts on and a future RecordingState
 * field costs no test churn.
 */
export function makeRecordingState(overrides: Partial<RecordingState> = {}): RecordingState {
  return { ...createDefaultRecordingState(), ...overrides };
}

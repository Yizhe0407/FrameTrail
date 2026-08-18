import type { RecordingMode } from '@/lib/storage/recording-state';

/**
 * The single vocabulary for the two recording modes.
 *
 * The popup chips, the injected recording toolbar (status, aria-labels,
 * announcements, undo snackbar) and the editor stage header used to name the
 * same two modes three different ways (步驟／快照, 操作流程／單頁標註,
 * 步驟模式／快照模式). Every surface now reads from here.
 *
 * The labels deliberately mirror the internal RecordingMode values so copy and
 * code cannot drift apart again, and they are short enough for the 320px popup
 * segmented control.
 *
 * It lives in lib/recording rather than lib/shared because it depends on the
 * RecordingMode type, which lib/shared may not import (module boundaries).
 */
export interface RecordingModeCopy {
  /** Mode name, shown wherever a surface has to say which mode is in play. */
  label: string;
  /** Counter noun for one captured item, e.g. 3 個步驟 / 2 個標註. */
  itemNoun: string;
}

// Record keeps the mapping total: adding a RecordingMode member without copy is
// a compile error instead of a runtime crash on a failed lookup.
export const RECORDING_MODE_COPY: Record<RecordingMode, RecordingModeCopy> = {
  steps: { label: '步驟', itemNoun: '步驟' },
  snapshot: { label: '快照', itemNoun: '標註' },
};

/** RecordingState carries a typed `mode`, but persisted state can predate a
 * member rename, so keep the historic "anything that is not steps renders as
 * snapshot" fold-down explicit and in one place. */
export function normalizeRecordingMode(mode: RecordingMode): RecordingMode {
  return mode === 'steps' ? 'steps' : 'snapshot';
}

export function recordingModeCopy(mode: RecordingMode): RecordingModeCopy {
  return RECORDING_MODE_COPY[normalizeRecordingMode(mode)];
}

/** e.g. `3 個步驟` — the popup's live summary and the editor stage header count
 * the same items, so they format them the same way. */
export function recordingItemCountLabel(mode: RecordingMode, count: number): string {
  return `${count} 個${recordingModeCopy(mode).itemNoun}`;
}

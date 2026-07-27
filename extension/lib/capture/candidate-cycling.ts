/**
 * Copy for the "resize the selection" affordance, shared by both recorders.
 *
 * The shortcut is invisible without it, but the hint must never cover page
 * content, so it is rendered inside the recording toolbar — the one surface
 * that already occupies its pixels. Snapshot mode binds the bare arrows (its
 * page is frozen); step mode binds Alt+arrows, because the live page still
 * needs plain arrows for scrolling and text entry.
 */

export interface CandidateOffsetRange {
  min: number;
  max: number;
}

export const SNAPSHOT_CYCLE_KEYS = '';
export const STEP_CYCLE_KEYS = 'Alt+';

/**
 * Names only the directions that would actually change the box, and returns
 * null when the point offers a single candidate — advertising a key that does
 * nothing is worse than not advertising it at all.
 */
export function cycleHintLabel(
  candidateOffset: number,
  range: CandidateOffsetRange,
  modifier: string = SNAPSHOT_CYCLE_KEYS,
): string | null {
  const canWiden = candidateOffset < range.max;
  const canNarrow = candidateOffset > range.min;
  if (canWiden && canNarrow) return `${modifier}↑↓ 調整選取範圍`;
  if (canWiden) return `${modifier}↑ 選取更大範圍`;
  if (canNarrow) return `${modifier}↓ 選取更小範圍`;
  return null;
}

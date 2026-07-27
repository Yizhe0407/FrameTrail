/**
 * The "resize the selection" affordance, shared by both recorders.
 *
 * It is exposed as toolbar buttons rather than a hint next to the highlight:
 * a floating hint covers page content, and text alone goes unread. Buttons
 * live in a surface that already occupies its pixels, are what users scan a
 * toolbar for, and give pointer-only users a shortcut-free way in — the label
 * teaches the key binding as a by-product.
 *
 * Snapshot mode binds the bare arrows (its page is frozen); step mode binds
 * Alt+arrows, because the live page still needs plain arrows for scrolling and
 * text entry.
 */

export interface CandidateOffsetRange {
  min: number;
  max: number;
}

export const STEP_CYCLE_MODIFIER = 'Alt+';

/** Whether either direction would change the box at the current offset. */
export function candidateCyclingState(candidateOffset: number, range: CandidateOffsetRange) {
  return { canWiden: candidateOffset < range.max, canNarrow: candidateOffset > range.min };
}

export function cycleActionLabel(direction: 'widen' | 'narrow', modifier = ''): string {
  return direction === 'widen'
    ? `選取更大範圍（${modifier}↑）`
    : `選取更小範圍（${modifier}↓）`;
}

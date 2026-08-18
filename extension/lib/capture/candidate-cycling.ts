/**
 * The "resize the selection" affordance, shared by both recorders.
 *
 * It is exposed as toolbar buttons rather than a hint next to the highlight:
 * a floating hint covers page content, and text alone goes unread. Buttons
 * live in a surface that already occupies its pixels, are what users scan a
 * toolbar for, and give pointer-only users a shortcut-free way in — the label
 * teaches the key binding as a by-product.
 *
 * Both modes bind Alt+arrows and Alt+wheel. Step mode needs the modifier
 * because its page stays live (plain arrows and wheel must keep scrolling and
 * moving the caret), and snapshot mode follows the same binding so there is one
 * shortcut to learn and one label to read. Alt+Up/Alt+Down are unbound in
 * Chrome, unlike Alt+Left/Alt+Right, which navigate history.
 */

export interface CandidateOffsetRange {
  min: number;
  max: number;
}

/** Both recorders gate candidate cycling on Alt with no other modifier. */
export function isCandidateCycleModifier(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey;
}

/** A deliberately small spill zone keeps an explicitly cycled candidate stable
 * while the pointer crosses a one-pixel border or layout gap. It is not used
 * for ordinary hover targeting: only a user's explicit parent/child choice is
 * sticky. */
export const CANDIDATE_LOCK_MARGIN_PX = 6;

export interface CandidateLockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isPointWithinCandidateLock(
  clientX: number,
  clientY: number,
  rect: CandidateLockRect | null,
  margin = CANDIDATE_LOCK_MARGIN_PX,
): boolean {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return (
    clientX >= rect.x - margin &&
    clientX <= rect.x + rect.width + margin &&
    clientY >= rect.y - margin &&
    clientY <= rect.y + rect.height + margin
  );
}

export interface CandidateWheelCycler {
  /** Returns true when the wheel gesture belongs to candidate cycling, even
   * during the short cooldown where no second level should be crossed. */
  handle(deltaX: number, deltaY: number, timeStamp: number): boolean;
  reset(): void;
}

/** Mouse wheels emit one event per notch while trackpads emit a burst. The
 * cooldown keeps one gesture from racing through every ancestor. */
export function createCandidateWheelCycler(
  adjust: (delta: number) => boolean,
  cooldownMs = 120,
): CandidateWheelCycler {
  let lastAdjustedAt = Number.NEGATIVE_INFINITY;

  return {
    handle(deltaX, deltaY, timeStamp) {
      if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaY) <= Math.abs(deltaX)) return false;
      if (
        timeStamp >= lastAdjustedAt &&
        timeStamp - lastAdjustedAt < cooldownMs
      ) {
        return true;
      }
      const adjusted = adjust(deltaY < 0 ? 1 : -1);
      if (adjusted) lastAdjustedAt = timeStamp;
      return adjusted;
    },
    reset() {
      lastAdjustedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** Whether either direction would change the box at the current offset. */
export function candidateCyclingState(candidateOffset: number, range: CandidateOffsetRange) {
  return { canWiden: candidateOffset < range.max, canNarrow: candidateOffset > range.min };
}

/** One label per direction, for both recorders: the binding no longer differs
 * between modes, so neither does the copy that teaches it. */
export function cycleActionLabel(direction: 'widen' | 'narrow'): string {
  return direction === 'widen' ? '選取更大範圍（Alt+↑）' : '選取更小範圍（Alt+↓）';
}

import { describe, expect, it } from 'vitest';
import {
  candidateCyclingState,
  createCandidateWheelCycler,
  cycleActionLabel,
  isPointWithinCandidateLock,
  STEP_CYCLE_MODIFIER,
} from '@/lib/capture/candidate-cycling';

describe('candidateCyclingState', () => {
  it('reports each direction the current offset can still move in', () => {
    expect(candidateCyclingState(0, { min: 0, max: 2 })).toEqual({ canWiden: true, canNarrow: false });
    expect(candidateCyclingState(2, { min: 0, max: 2 })).toEqual({ canWiden: false, canNarrow: true });
    expect(candidateCyclingState(1, { min: 0, max: 2 })).toEqual({ canWiden: true, canNarrow: true });
    // A point with a single candidate offers neither, which is what hides the
    // controls instead of showing two dead buttons.
    expect(candidateCyclingState(0, { min: 0, max: 0 })).toEqual({ canWiden: false, canNarrow: false });
  });
});

describe('cycleActionLabel', () => {
  it('teaches the binding each mode uses', () => {
    expect(cycleActionLabel('widen')).toBe('選取更大範圍（↑）');
    expect(cycleActionLabel('narrow')).toBe('選取更小範圍（↓）');
    // The live page keeps plain arrows, so step mode's label spells out Alt.
    expect(cycleActionLabel('widen', STEP_CYCLE_MODIFIER)).toBe('選取更大範圍（Alt+↑）');
  });
});


describe('candidate intent retention', () => {
  it('keeps a cycled level inside the selected surface and a small spill zone', () => {
    const rect = { x: 20, y: 30, width: 100, height: 40 };
    expect(isPointWithinCandidateLock(20, 30, rect)).toBe(true);
    expect(isPointWithinCandidateLock(14, 24, rect)).toBe(true);
    expect(isPointWithinCandidateLock(13, 24, rect)).toBe(false);
    expect(isPointWithinCandidateLock(50, 50, null)).toBe(false);
  });
});

describe('createCandidateWheelCycler', () => {
  it('maps wheel-up to a wider parent and wheel-down to a narrower child', () => {
    const adjustments: number[] = [];
    const cycler = createCandidateWheelCycler((delta) => {
      adjustments.push(delta);
      return true;
    });

    expect(cycler.handle(0, -100, 100)).toBe(true);
    expect(adjustments).toEqual([1]);
    expect(cycler.handle(0, 100, 250)).toBe(true);
    expect(adjustments).toEqual([1, -1]);
  });

  it('consumes a trackpad burst without racing across several ancestors', () => {
    const adjustments: number[] = [];
    const cycler = createCandidateWheelCycler((delta) => {
      adjustments.push(delta);
      return true;
    });

    expect(cycler.handle(0, -12, 100)).toBe(true);
    expect(cycler.handle(0, -10, 150)).toBe(true);
    expect(cycler.handle(0, -8, 190)).toBe(true);
    expect(adjustments).toEqual([1]);
    expect(cycler.handle(0, -8, 221)).toBe(true);
    expect(adjustments).toEqual([1, 1]);
  });

  it('ignores horizontal gestures and leaves a dead-end wheel to the caller', () => {
    const cycler = createCandidateWheelCycler(() => false);
    expect(cycler.handle(20, 10, 100)).toBe(false);
    expect(cycler.handle(0, 100, 200)).toBe(false);
  });
});

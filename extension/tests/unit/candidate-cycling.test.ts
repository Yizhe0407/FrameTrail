import { describe, expect, it } from 'vitest';
import {
  candidateCyclingState,
  cycleActionLabel,
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

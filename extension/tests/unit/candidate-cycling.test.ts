import { describe, expect, it } from 'vitest';
import { cycleHintLabel, STEP_CYCLE_KEYS } from '@/lib/capture/candidate-cycling';

describe('cycleHintLabel', () => {
  it('names only the directions that would change the box', () => {
    expect(cycleHintLabel(0, { min: 0, max: 2 })).toBe('↑ 選取更大範圍');
    expect(cycleHintLabel(2, { min: 0, max: 2 })).toBe('↓ 選取更小範圍');
    expect(cycleHintLabel(1, { min: 0, max: 2 })).toBe('↑↓ 調整選取範圍');
    expect(cycleHintLabel(-1, { min: -1, max: 1 })).toBe('↑ 選取更大範圍');
  });

  it('stays silent when the point offers a single box', () => {
    expect(cycleHintLabel(0, { min: 0, max: 0 })).toBeNull();
  });

  it('spells out the modifier step mode binds', () => {
    // The live page keeps plain arrows for scrolling and text entry, so the
    // hint has to teach the modifier too.
    expect(cycleHintLabel(0, { min: 0, max: 1 }, STEP_CYCLE_KEYS)).toBe('Alt+↑ 選取更大範圍');
    expect(cycleHintLabel(1, { min: 0, max: 2 }, STEP_CYCLE_KEYS)).toBe('Alt+↑↓ 調整選取範圍');
  });
});

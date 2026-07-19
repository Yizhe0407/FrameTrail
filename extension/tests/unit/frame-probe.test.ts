import { describe, expect, it } from 'vitest';
import { classifyFrameProbeOutcome } from '@/lib/frame-probe';

describe('classifyFrameProbeOutcome', () => {
  it('falls back only when the frame transport times out', () => {
    expect(classifyFrameProbeOutcome(null, true)).toEqual({ kind: 'fallback' });
    expect(classifyFrameProbeOutcome(null, false)).toEqual({ kind: 'empty' });
    expect(classifyFrameProbeOutcome({ id: 'button' }, false)).toEqual({
      kind: 'target',
      target: { id: 'button' },
    });
  });
});

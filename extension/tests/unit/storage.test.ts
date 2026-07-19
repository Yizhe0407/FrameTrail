import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { createDefaultRecordingState, normalizeRecordingState } from '@/lib/storage';

describe('recording state normalization', () => {
  it('returns an independent complete default after storage is cleared', () => {
    const first = normalizeRecordingState(undefined);
    const second = createDefaultRecordingState();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('keeps current fields while replacing a legacy recording mode', () => {
    const normalized = normalizeRecordingState({
      sessionId: 'session-1',
      mode: 'multi' as never,
    });

    expect(normalized.sessionId).toBe('session-1');
    expect(normalized.mode).toBe('steps');
  });
});

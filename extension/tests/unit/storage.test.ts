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

  it('normalizes a valid recapture operation without treating it as ordinary recording', () => {
    const normalized = normalizeRecordingState({
      operation: 'recapture',
      isRecording: false,
      recapture: {
        runId: 'recapture-1',
        sessionId: 'session-1',
        target: { kind: 'single', stepId: 'step-1' },
        entryId: 'step-1',
        phase: 'awaiting-target',
        editorTabId: 10,
        editorWindowId: 2,
        sourceTabId: 11,
        sourceWindowId: 3,
        sourceUrl: 'https://example.com/page',
        sourceTabCreated: false,
        startedAt: 123,
      },
    });

    expect(normalized.operation).toBe('recapture');
    expect(normalized.isRecording).toBe(false);
    expect(normalized.phase).toBe('idle');
    expect(normalized.recapture?.target).toEqual({ kind: 'single', stepId: 'step-1' });
  });

  it('fails closed when a persisted recapture context is incomplete', () => {
    const normalized = normalizeRecordingState({
      operation: 'recapture',
      recapture: { runId: 'missing-fields' } as never,
    });

    expect(normalized.operation).toBeNull();
    expect(normalized.recapture).toBeNull();
  });

  it('keeps only structurally valid durable recapture results', () => {
    const valid = normalizeRecordingState({
      recaptureResult: {
        runId: 'run-1',
        status: 'replaced',
        sessionId: 'session-1',
        entryId: 'step-1',
        completedAt: 456,
      },
    });
    const invalid = normalizeRecordingState({
      recaptureResult: { runId: 'run-1', status: 'unknown' } as never,
    });

    expect(valid.recaptureResult?.status).toBe('replaced');
    expect(invalid.recaptureResult).toBeNull();
  });

});

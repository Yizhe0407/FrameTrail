import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { normalizeRecordingState } from '@/lib/storage/storage';

const validInsertion = {
  anchorEntryId: 'anchor-1',
  side: 'before' as const,
  runBlockIds: ['capture-1', 'capture-2'],
  sourceUrl: 'https://example.com/source',
  sourceTabCreated: true,
  startedAt: 123,
};

describe('durable insertion recording state', () => {
  it('preserves a valid restart context and clones its run id list', () => {
    const storedIds = [...validInsertion.runBlockIds];
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'guide-a',
      tabId: 5,
      runId: 'run-a',
      insertion: { ...validInsertion, runBlockIds: storedIds },
    });

    expect(normalized.operation).toBe('recording');
    expect(normalized.insertion).toEqual(validInsertion);
    expect(normalized.insertion?.runBlockIds).not.toBe(storedIds);
  });

  it.each([
    { ...validInsertion, runBlockIds: ['capture-1', 'capture-1'] },
    { ...validInsertion, side: 'middle' },
    { ...validInsertion, anchorEntryId: '' },
    { ...validInsertion, sourceUrl: '' },
    { ...validInsertion, sourceUrl: 'javascript:alert(1)' },
    { ...validInsertion, sourceUrl: 'https://user:secret@example.com/source' },
    { ...validInsertion, startedAt: Number.NaN },
  ])('fails closed for malformed persisted insertion context %#', (insertion) => {
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'guide-a',
      tabId: 5,
      runId: 'run-a',
      insertion: insertion as never,
    });

    expect(normalized.operation).toBeNull();
    expect(normalized.isRecording).toBe(false);
    expect(normalized.insertion).toBeNull();
  });

  it('does not leak insertion state into ordinary recording or recapture operations', () => {
    const ordinary = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      insertion: null,
    });
    const recapture = normalizeRecordingState({
      operation: 'recapture',
      insertion: validInsertion,
      recapture: {
        runId: 'recapture-1',
        sessionId: 'guide-a',
        target: { kind: 'single', stepId: 'step-1' },
        entryId: 'step-1',
        phase: 'awaiting-target',
        editorTabId: 1,
        editorWindowId: 1,
        sourceTabId: 2,
        sourceWindowId: 1,
        sourceUrl: 'https://example.com/source',
        sourceTabCreated: false,
        startedAt: 1,
      },
    });

    expect(ordinary.insertion).toBeNull();
    expect(recapture.insertion).toBeNull();
  });

  it.each([
    { field: 'editorTabId', value: -1 },
    { field: 'editorWindowId', value: -1 },
    { field: 'sourceTabId', value: -1 },
    { field: 'sourceWindowId', value: -1 },
    { field: 'sourceUrl', value: 'javascript:alert(1)' },
    { field: 'sourceUrl', value: 'https://user:secret@example.com/source' },
  ])('fails closed for an unsafe persisted recapture $field', ({ field, value }) => {
    const recapture = {
      runId: 'recapture-1',
      sessionId: 'guide-a',
      target: { kind: 'single' as const, stepId: 'step-1' },
      entryId: 'step-1',
      phase: 'awaiting-target' as const,
      editorTabId: 1,
      editorWindowId: 1,
      sourceTabId: 2,
      sourceWindowId: 1,
      sourceUrl: 'https://example.com/source',
      sourceTabCreated: false,
      startedAt: 1,
      [field]: value,
    };
    const normalized = normalizeRecordingState({ operation: 'recapture', recapture });

    expect(normalized.operation).toBeNull();
    expect(normalized.recapture).toBeNull();
  });

});

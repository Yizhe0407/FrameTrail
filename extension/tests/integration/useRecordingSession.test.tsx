// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let listener: ((state: any) => void) | null = null;
  return {
    getRecordingState: vi.fn(),
    getSteps: vi.fn(),
    onRecordingStateChange: vi.fn((callback: (state: any) => void) => {
      listener = callback;
      return vi.fn();
    }),
    emit(state: any) {
      listener?.(state);
    },
    resetListener() {
      listener = null;
    },
  };
});

vi.mock('@/lib/storage', () => ({
  createDefaultRecordingState: () => ({
    isRecording: false,
    phase: 'idle',
    sessionId: null,
    tabId: null,
    error: null,
    recoverableError: null,
    mode: 'steps',
    itemCount: 0,
    numbered: true,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
    operation: null,
    recapture: null,
    recaptureResult: null,
  }),
  getRecordingState: mocks.getRecordingState,
  onRecordingStateChange: mocks.onRecordingStateChange,
}));
vi.mock('@/lib/db', () => ({ getSteps: mocks.getSteps }));

import { reconcileSteps, useRecordingSession } from '@/lib/useRecordingSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function state(sessionId: string) {
  return {
    isRecording: true,
    phase: 'recording',
    sessionId,
    tabId: 1,
    error: null,
    recoverableError: null,
    mode: 'steps',
    itemCount: 0,
    numbered: true,
    groupAnchorId: null,
  };
}

beforeEach(() => {
  mocks.getRecordingState.mockReset();
  mocks.getSteps.mockReset();
  mocks.onRecordingStateChange.mockClear();
  mocks.resetListener();
});

describe('useRecordingSession', () => {
  it('does not let a stale initial storage read replace a newer change event', async () => {
    const initial = deferred<ReturnType<typeof state>>();
    mocks.getRecordingState.mockReturnValue(initial.promise);
    mocks.getSteps.mockResolvedValue([{ id: 'new-step' }]);
    const { result } = renderHook(() => useRecordingSession());

    act(() => mocks.emit(state('new-session')));
    await waitFor(() => expect(result.current.sessionId).toBe('new-session'));

    await act(async () => {
      initial.resolve(state('old-session'));
      await initial.promise;
    });

    expect(result.current.sessionId).toBe('new-session');
  });

  it('does not let old session steps replace a newer session result', async () => {
    const oldSteps = deferred<any[]>();
    const newSteps = deferred<any[]>();
    mocks.getRecordingState.mockResolvedValue(state('old-session'));
    mocks.getSteps.mockImplementation((sessionId: string) =>
      sessionId === 'old-session' ? oldSteps.promise : newSteps.promise,
    );
    const { result } = renderHook(() => useRecordingSession());
    await waitFor(() => expect(result.current.sessionId).toBe('old-session'));

    act(() => mocks.emit(state('new-session')));
    await act(async () => {
      newSteps.resolve([{ id: 'new-step' }]);
      await newSteps.promise;
    });
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'new-step' }]));

    await act(async () => {
      oldSteps.resolve([{ id: 'old-step' }]);
      await oldSteps.promise;
    });

    expect(result.current.steps).toEqual([{ id: 'new-step' }]);
  });

  it('不會讓缺少 sessionId 的編輯器退回顯示其他錄製中的 Guide', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step` }]);

    const { result } = renderHook(() => useRecordingSession(null));

    await waitFor(() => expect(result.current.recording.sessionId).toBe('recording-session'));
    expect(result.current.sessionId).toBeNull();
    expect(result.current.steps).toEqual([]);
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
  });

  it('uses an explicit editor session as the authoritative step source', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step` }]);

    const { result } = renderHook(() => useRecordingSession('url-session'));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step' }]));
    expect(result.current.sessionId).toBe('url-session');
    expect(result.current.recording.sessionId).toBe('recording-session');

    act(() => mocks.emit(state('other-recording-session')));
    await waitFor(() => expect(result.current.recording.sessionId).toBe('other-recording-session'));
    expect(result.current.sessionId).toBe('url-session');
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
    expect(mocks.getSteps).not.toHaveBeenCalledWith('other-recording-session');
  });

  it('refreshes the explicit Guide after same-session recording-state events', async () => {
    let revision = 1;
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step-${revision}` }]);

    const { result } = renderHook(() => useRecordingSession('url-session'));
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step-1' }]));

    revision = 2;
    act(() => mocks.emit(state('recording-session')));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step-2' }]));
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
  });

  it('protects explicit URL session changes from stale IndexedDB responses', async () => {
    const oldSteps = deferred<any[]>();
    const newSteps = deferred<any[]>();
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation((sessionId: string) =>
      sessionId === 'old-url-session' ? oldSteps.promise : newSteps.promise,
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useRecordingSession(sessionId),
      { initialProps: { sessionId: 'old-url-session' } },
    );
    await waitFor(() => expect(mocks.getSteps).toHaveBeenCalledWith('old-url-session'));

    rerender({ sessionId: 'new-url-session' });
    await act(async () => {
      newSteps.resolve([{ id: 'new-url-step' }]);
      await newSteps.promise;
    });
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'new-url-step' }]));

    await act(async () => {
      oldSteps.resolve([{ id: 'old-url-step' }]);
      await oldSteps.promise;
    });

    expect(result.current.sessionId).toBe('new-url-session');
    expect(result.current.steps).toEqual([{ id: 'new-url-step' }]);
  });
});

describe('reconcileSteps', () => {
  it('retains immutable screenshot Blob wrappers across IndexedDB refreshes', () => {
    const previousBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const previous = [{ id: 'anchor', screenshotBlob: previousBlob, description: 'before' }] as any[];
    const next = [{ id: 'anchor', screenshotBlob: refreshedBlob, description: 'after' }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.description).toBe('after');
  });

  it('applies manual-bound and privacy metadata changes without replacing the Blob', () => {
    const previousBlob = new Blob(['same'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same'], { type: 'image/jpeg' });
    const previous = [{
      id: 'step',
      screenshotBlob: previousBlob,
      captureRevision: 1,
      manualBounds: null,
      redactions: [],
    }] as any[];
    const next = [{
      ...previous[0],
      screenshotBlob: refreshedBlob,
      manualBounds: { x: 10, y: 20, width: 30, height: 40 },
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      redactionReviewRequired: true,
    }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled).not.toBe(previous[0]);
    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.manualBounds).toEqual(next[0].manualBounds);
    expect(reconciled.redactions).toEqual(next[0].redactions);
    expect(reconciled.redactionReviewRequired).toBe(true);
  });

  it('uses the replacement Blob when captureRevision changes', () => {
    const previousBlob = new Blob(['before'], { type: 'image/jpeg' });
    const replacementBlob = new Blob(['after'], { type: 'image/jpeg' });
    const previous = [{ id: 'step', screenshotBlob: previousBlob, captureRevision: 2 }] as any[];
    const next = [{ id: 'step', screenshotBlob: replacementBlob, captureRevision: 3 }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(replacementBlob);
    expect(reconciled.captureRevision).toBe(3);
  });

  it('retains the existing Blob for metadata-only refreshes at the same captureRevision', () => {
    const previousBlob = new Blob(['same'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same'], { type: 'image/jpeg' });
    const previous = [{ id: 'step', screenshotBlob: previousBlob, captureRevision: 4, description: 'before' }] as any[];
    const next = [{ id: 'step', screenshotBlob: refreshedBlob, captureRevision: 4, description: 'after' }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.description).toBe('after');
  });

  it('returns the previous objects and array when a poll contains no changes', () => {
    const previousBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const previous = [
      {
        id: 'anchor',
        sessionId: 'session',
        order: 0,
        screenshotBlob: previousBlob,
        bounds: null,
        devicePixelRatio: 2,
        screenshotScale: 2,
        description: '',
        url: 'https://example.com',
        timestamp: 1,
        groupId: 'anchor',
        numbered: true,
      },
    ];
    const next = [{ ...previous[0], screenshotBlob: refreshedBlob }];

    const reconciled = reconcileSteps(previous, next);

    expect(reconciled).toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
  });
});

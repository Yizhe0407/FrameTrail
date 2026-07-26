import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/runtime/messages';
import type { Step } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
  getGuide: vi.fn(),
  getStep: vi.fn(),
  getSteps: vi.fn(),
  addStep: vi.fn(),
  deleteStep: vi.fn(),
  getRecordingState: vi.fn(),
  setRecordingState: vi.fn(),
  permissionsContains: vi.fn(),
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
  tabsGet: vi.fn(),
  tabsUpdate: vi.fn(),
  tabsRemove: vi.fn(),
  tabsSendMessage: vi.fn(),
  windowsUpdate: vi.fn(),
  executeScript: vi.fn(),
  savePendingUndoRecord: vi.fn(),
  readPendingUndoRecord: vi.fn(),
  clearPendingUndoRecord: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      onMessage: {
        addListener: (listener: typeof mocks.messageListener) => {
          mocks.messageListener = listener;
        },
      },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    commands: { onCommand: { addListener: vi.fn() } },
    permissions: { contains: mocks.permissionsContains, request: vi.fn() },
    tabs: {
      captureVisibleTab: vi.fn(),
      create: mocks.tabsCreate,
      get: mocks.tabsGet,
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: mocks.tabsQuery,
      remove: mocks.tabsRemove,
      sendMessage: mocks.tabsSendMessage,
      update: mocks.tabsUpdate,
    },
    windows: { update: mocks.windowsUpdate },
    scripting: {
      executeScript: mocks.executeScript,
      insertCSS: vi.fn(),
      removeCSS: vi.fn(),
    },
  },
}));

vi.mock('@/lib/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/db')>();
  return {
    ...actual,
    getGuide: mocks.getGuide,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
    addStep: mocks.addStep,
    deleteStep: mocks.deleteStep,
  };
});

vi.mock('@/lib/storage/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/storage')>();
  return {
    ...actual,
    getRecordingState: mocks.getRecordingState,
    setRecordingState: mocks.setRecordingState,
  };
});

vi.mock('@/lib/recording/background/pending-undo-store', () => ({
  savePendingUndoRecord: mocks.savePendingUndoRecord,
  readPendingUndoRecord: mocks.readPendingUndoRecord,
  clearPendingUndoRecord: mocks.clearPendingUndoRecord,
}));

const idleState: RecordingState = {
  operation: null,
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
  recapture: null,
  recaptureResult: null,
};

function recordingState(overrides: Partial<RecordingState> = {}): RecordingState {
  return {
    ...idleState,
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'guide-a',
    tabId: 4,
    runId: 'run-1',
    ...overrides,
  };
}

function awaitingTargetState(): RecordingState {
  return {
    ...idleState,
    operation: 'recapture',
    recapture: {
      runId: 'recapture-1',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
      entryId: 'step-1',
      phase: 'awaiting-target',
      editorTabId: 7,
      editorWindowId: 3,
      sourceTabId: 11,
      sourceWindowId: 5,
      sourceUrl: 'https://persisted.example/path',
      sourceTabCreated: true,
      startedAt: 1,
    },
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'guide-a',
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: 'https://persisted.example/path',
    timestamp: 1,
    ...overrides,
  };
}

async function importBackground(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  await import('@/entrypoints/background');
}

async function flushAsyncWork(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  mocks.getRecordingState.mockResolvedValue(idleState);
  mocks.setRecordingState.mockResolvedValue(undefined);
  mocks.getSteps.mockResolvedValue([]);
  mocks.addStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.tabsRemove.mockResolvedValue(undefined);
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

describe('service-worker startup recovery for recording runs', () => {
  it('settles a persisted run whose recorded tab no longer exists', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 4.'));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          isRecording: false,
          phase: 'error',
          tabId: null,
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('settles a persisted run whose tab id now names a restricted page', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'chrome://newtab/' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('keeps a run whose recorded tab is still intact', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'https://example.com/flow' });

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(4));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('settles a snapshot run whose tab no longer shows the anchor document', async () => {
    mocks.getRecordingState.mockResolvedValue(
      recordingState({ mode: 'snapshot', groupAnchorId: 'anchor-1' }),
    );
    mocks.getStep.mockResolvedValue(step({ id: 'anchor-1', groupId: 'anchor-1', url: 'https://a.example/page' }));
    mocks.getSteps.mockResolvedValue([
      step({ id: 'anchor-1', groupId: 'anchor-1', url: 'https://a.example/page' }),
      step({ id: 'mark-1', groupId: 'anchor-1', url: 'https://a.example/page' }),
    ]);
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'https://b.example/other' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          phase: 'error',
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });
});

describe('service-worker startup recovery for awaiting-target recaptures', () => {
  it('fails a recapture whose source tab is gone and closes out its state', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 11.'));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          recapture: null,
          recaptureResult: expect.objectContaining({
            runId: 'recapture-1',
            status: 'failed',
            errorCode: 'SOURCE_TAB_CLOSED',
          }),
        }),
      );
    });
  });

  it('fails a recapture whose source tab navigated away from the armed page', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockResolvedValue({ id: 11, url: 'https://elsewhere.example/' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          recaptureResult: expect.objectContaining({ status: 'failed', errorCode: 'SOURCE_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('keeps an awaiting-target recapture whose source tab is intact', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockResolvedValue({ id: 11, url: 'https://persisted.example/path' });

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(11));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('recapture source tab leak cleanup', () => {
  const editorSender = {
    frameId: 0,
    url: 'chrome-extension://extension-id/editor.html?sessionId=guide-a',
    tab: { id: 7, windowId: 3, url: 'chrome-extension://extension-id/editor.html?sessionId=guide-a' },
  };

  it('closes a created source tab when the exact-URL recheck fails after load', async () => {
    mocks.getStep.mockResolvedValue(step());
    mocks.getSteps.mockResolvedValue([step()]);
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([]);
    mocks.tabsCreate.mockResolvedValue({ id: 42 });
    // The created tab finished loading on a redirected URL.
    mocks.tabsGet.mockResolvedValue({
      id: 42,
      windowId: 5,
      status: 'complete',
      url: 'https://redirected.example/elsewhere',
    });

    await importBackground();
    const result = await mocks.messageListener?.({
      type: 'START_STEP_RECAPTURE',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
    }, editorSender);

    expect(result).toMatchObject({ ok: false, code: 'SOURCE_TAB_FAILED' });
    expect(mocks.tabsRemove).toHaveBeenCalledWith(42);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('undo window persistence across worker restarts', () => {
  it('persists the removed step before deleting it from the guide', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 1 }));
    mocks.getSteps.mockResolvedValue([step({ runId: 'run-1' })]);

    await importBackground();
    const result = await mocks.messageListener?.(
      { type: 'UNDO_LAST_CAPTURE', runId: 'run-1' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    ) as { ok: boolean; undoToken?: string };

    expect(result).toMatchObject({ ok: true });
    expect(mocks.savePendingUndoRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        expectedItemCount: 0,
        step: expect.objectContaining({ id: 'step-1' }),
      }),
    );
    expect(mocks.deleteStep).toHaveBeenCalledWith('step-1');
    const saveOrder = mocks.savePendingUndoRecord.mock.invocationCallOrder[0];
    const deleteOrder = mocks.deleteStep.mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(deleteOrder);
  });

  it('rehydrates a persisted undo window at startup so restore still works', async () => {
    const record = {
      token: 'undo-token',
      runId: 'run-1',
      step: step({ runId: 'run-1' }),
      expectedItemCount: 0,
      expiresAt: Date.now() + 5_000,
    };
    mocks.readPendingUndoRecord.mockResolvedValue(record);
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 0 }));

    await importBackground();
    const result = await mocks.messageListener?.(
      { type: 'RESTORE_LAST_CAPTURE', runId: 'run-1', undoToken: 'undo-token' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.addStep).toHaveBeenCalledWith(record.step);
    expect(mocks.clearPendingUndoRecord).toHaveBeenCalled();
  });

  it('hard-deletes an expired persisted undo window at startup', async () => {
    mocks.readPendingUndoRecord.mockResolvedValue({
      token: 'undo-token',
      runId: 'run-1',
      step: step({ runId: 'run-1' }),
      expectedItemCount: 0,
      expiresAt: Date.now() - 1,
    });
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 0 }));

    await importBackground();

    await vi.waitFor(() => expect(mocks.clearPendingUndoRecord).toHaveBeenCalled());
    expect(mocks.addStep).not.toHaveBeenCalled();
  });
});

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
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
  tabsGet: vi.fn(),
  tabsUpdate: vi.fn(),
  tabsSendMessage: vi.fn(),
  windowsUpdate: vi.fn(),
  executeScript: vi.fn(),
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
    permissions: { contains: vi.fn(), request: vi.fn() },
    tabs: {
      captureVisibleTab: vi.fn(),
      create: mocks.tabsCreate,
      get: mocks.tabsGet,
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: mocks.tabsQuery,
      remove: vi.fn(),
      sendMessage: mocks.tabsSendMessage,
      update: mocks.tabsUpdate,
    },
    windows: { onFocusChanged: { addListener: vi.fn() }, update: mocks.windowsUpdate },
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
  savePendingUndoRecord: vi.fn(),
  readPendingUndoRecord: mocks.readPendingUndoRecord,
  clearPendingUndoRecord: mocks.clearPendingUndoRecord,
}));

const PAGE_URL = 'https://site.example/page';

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
  autoCreatedGuideId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
  recapture: null,
  recaptureResult: null,
};

function snapshotState(overrides: Partial<RecordingState> = {}): RecordingState {
  return {
    ...idleState,
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'guide-a',
    tabId: 4,
    runId: 'run-1',
    mode: 'snapshot',
    groupAnchorId: 'anchor-1',
    ...overrides,
  };
}

function anchorStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'anchor-1',
    sessionId: 'guide-a',
    runId: 'run-1',
    order: 0,
    screenshotBlob: new Blob(['base-image']),
    bounds: null,
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: '',
    url: PAGE_URL,
    timestamp: 1,
    groupId: 'anchor-1',
    numbered: true,
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

const recordedPageSender = {
  frameId: 0,
  url: PAGE_URL,
  tab: { id: 4, windowId: 6, url: PAGE_URL },
};

function clickMessage(): Record<string, unknown> {
  return {
    type: 'FRAME_TRAIL_CLICK',
    captureKind: 'element',
    captureId: 'capture-1',
    runId: 'run-1',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 2,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    text: 'Save',
    tagName: 'BUTTON',
    intent: 'mark',
    url: PAGE_URL,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  mocks.getRecordingState.mockResolvedValue(idleState);
  mocks.setRecordingState.mockResolvedValue(undefined);
  mocks.getStep.mockResolvedValue(undefined);
  mocks.getSteps.mockResolvedValue([]);
  mocks.addStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 6, url: PAGE_URL });
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue({ id: 99 });
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

describe('startup recovery validates the snapshot anchor', () => {
  it('settles a run recovered into phase recording whose anchor row is gone', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(undefined);

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          isRecording: false,
          phase: 'error',
          groupAnchorId: null,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a run whose anchor row lost its base image', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep({ screenshotBlob: undefined }));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a snapshot run recovered into phase recording without an anchor id', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState({ groupAnchorId: null }));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a run interrupted mid-finish after its empty anchor was deleted', async () => {
    // finishRecording used to delete the empty anchor before the final state
    // write; a service-worker death in between persisted phase 'finishing'
    // with a groupAnchorId whose row is gone — a zombie that accepted clicks.
    mocks.getRecordingState.mockResolvedValue(snapshotState({ phase: 'finishing' }));
    mocks.getStep.mockResolvedValue(undefined);

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          phase: 'error',
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('keeps a healthy snapshot run whose anchor and base image are intact', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());

    await importBackground();
    await vi.waitFor(() => expect(mocks.getStep).toHaveBeenCalledWith('anchor-1'));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('keeps a preparing-next run, whose anchor is legitimately absent', async () => {
    mocks.getRecordingState.mockResolvedValue(
      snapshotState({ phase: 'preparing-next', groupAnchorId: null }),
    );

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(4));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('a click that wakes the worker over a stale persisted run', () => {
  it('queues behind startup recovery, which settles the run silently instead of the in-click anchor settle', async () => {
    // The user's bfcache-restored recorder fires a click that wakes the
    // service worker. Startup recovery must win: the run is settled once by
    // recovery and the click is rejected quietly — never the louder
    // "snapshot anchor is gone; settling the run" in-click path.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let releaseTabGet!: (tab: { id: number; windowId: number; url: string }) => void;
    mocks.tabsGet.mockImplementation(() => new Promise((resolve) => {
      releaseTabGet = resolve;
    }));
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(undefined);
    mocks.getSteps.mockResolvedValue([]);

    await importBackground();
    // Recovery is still blocked on tabs.get when the click arrives.
    const pendingClick = mocks.messageListener?.(clickMessage(), recordedPageSender) as Promise<unknown>;
    releaseTabGet({ id: 4, windowId: 6, url: PAGE_URL });

    expect(await pendingClick).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({
        isRecording: false,
        phase: 'error',
        recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
      }),
    );
    expect(mocks.setRecordingState).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('snapshot anchor is gone'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe('annotation clicks against a run whose anchor disappeared mid-run', () => {
  it('settles the run once with a recoverable error instead of a per-click error', async () => {
    // Recovery sees a healthy anchor at startup; the row disappears afterwards
    // (e.g. deleted through the editor while the run was still live).
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());
    mocks.getSteps.mockResolvedValue([]);

    await importBackground();
    await flushAsyncWork();
    mocks.setRecordingState.mockClear();

    const result = await mocks.messageListener?.(clickMessage(), recordedPageSender);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: null,
        isRecording: false,
        phase: 'error',
        groupAnchorId: null,
        runId: null,
        recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
      }),
    );
    // The recorder in the tab is torn down so the user is not left clicking
    // into a shield whose run is already broken.
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'FRAME_TRAIL_STOP' });
  });
});

describe('empty-anchor cleanup ordering in finishRecording', () => {
  it('deletes the empty anchor only after the run state stopped referencing it', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());
    mocks.getSteps.mockResolvedValue([anchorStep()]);

    await importBackground();
    await flushAsyncWork();
    mocks.setRecordingState.mockClear();
    mocks.deleteStep.mockClear();

    const result = await mocks.messageListener?.(
      { type: 'FINISH_RECORDING', runId: 'run-1' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.deleteStep).toHaveBeenCalledWith('anchor-1');
    const stopWriteIndex = mocks.setRecordingState.mock.calls.findIndex(
      ([state]) => (state as RecordingState).isRecording === false,
    );
    expect(stopWriteIndex).toBeGreaterThanOrEqual(0);
    const stopOrder = mocks.setRecordingState.mock.invocationCallOrder[stopWriteIndex];
    const deleteOrder = mocks.deleteStep.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(deleteOrder);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () => {
  const { makeBackgroundBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makeBackgroundBrowserMock({
      onMessage: (listener) => {
        mocks.messageListener = listener;
      },
      permissionsContains: mocks.permissionsContains,
      tabsCreate: mocks.tabsCreate,
      tabsGet: mocks.tabsGet,
      tabsQuery: mocks.tabsQuery,
      tabsRemove: mocks.tabsRemove,
      tabsSendMessage: mocks.tabsSendMessage,
      tabsUpdate: mocks.tabsUpdate,
      windowsUpdate: mocks.windowsUpdate,
      executeScript: mocks.executeScript,
    }),
  };
});

vi.mock('@/lib/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/db')>();
  return {
    ...actual,
    getGuide: mocks.getGuide,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
    addStep: mocks.addStep,
    // Background persists captures through the batched write; route it to the
    // same per-step mock so existing addStep assertions keep observing rows.
    addSteps: async (steps: readonly unknown[]) => {
      for (const step of steps) await mocks.addStep(step);
    },
    deleteStep: mocks.deleteStep,
    deleteStepsForRun: mocks.deleteStepsForRun,
    discardPristineGuide: mocks.discardPristineGuide,
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

// The reclaim guard itself (only pristine shells are deleted) is covered by
// tests/integration/db-pristine-guide.test.ts; here only the routing matters:
// which run endings hand the guide to it and which never do.

vi.mock('@/lib/recording/background/pending-undo-store', () => ({
  savePendingUndoRecord: mocks.savePendingUndoRecord,
  readPendingUndoRecord: mocks.readPendingUndoRecord,
  clearPendingUndoRecord: mocks.clearPendingUndoRecord,
}));

function recordingState(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'guide-a',
    tabId: 4,
    runId: 'run-1',
    ...overrides,
  });
}

let storedState: RecordingState;

const RECORDED_TAB = { id: 4, windowId: 1, active: true, url: 'https://example.com/flow' };
const EXTENSION_PAGE_SENDER = { url: 'chrome-extension://extension-id/popup.html' };

async function dispatch(message: unknown): Promise<unknown> {
  const result = await mocks.messageListener?.(message, EXTENSION_PAGE_SENDER);
  await flushAsyncWork();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  storedState = recordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.deleteStepsForRun.mockResolvedValue(undefined);
  mocks.discardPristineGuide.mockResolvedValue(true);
  mocks.tabsGet.mockResolvedValue(RECORDED_TAB);
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue({ id: 77, windowId: 1 });
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('empty auto-created guide reclamation at run end', () => {
  it('reclaims the popup-created guide when STOP ends the run', async () => {
    storedState = recordingState({ autoCreatedGuideId: 'guide-a' });
    await importBackground();
    await flushAsyncWork();

    await dispatch({ type: 'STOP_RECORDING' });

    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-a');
    expect(storedState.isRecording).toBe(false);
    expect(storedState.autoCreatedGuideId).toBeNull();
  });

  it('never reclaims on STOP for a run into a user-chosen guide (no flag)', async () => {
    await importBackground();
    await flushAsyncWork();

    await dispatch({ type: 'STOP_RECORDING' });

    expect(storedState.isRecording).toBe(false);
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });

  it('ignores a flag that does not match the run\'s own guide', async () => {
    storedState = recordingState({ autoCreatedGuideId: 'guide-other' });
    await importBackground();
    await flushAsyncWork();

    await dispatch({ type: 'STOP_RECORDING' });

    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });

  it('reclaims after 放棄 (DISCARD) removed the run\'s steps', async () => {
    storedState = recordingState({ autoCreatedGuideId: 'guide-a' });
    await importBackground();
    await flushAsyncWork();

    const result = await dispatch({ type: 'DISCARD_CURRENT_RECORDING', runId: 'run-1' });

    expect(result).toEqual({ ok: true });
    expect(mocks.deleteStepsForRun).toHaveBeenCalledWith('guide-a', 'run-1');
    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-a');
  });

  it('keeps the guide on FINISH even at zero items: the editor is about to open it', async () => {
    storedState = recordingState({ autoCreatedGuideId: 'guide-a' });
    await importBackground();
    await flushAsyncWork();

    const result = await dispatch({ type: 'FINISH_RECORDING', runId: 'run-1' });

    expect(result).toMatchObject({ ok: true, finish: { sessionId: 'guide-a', itemCount: 0 } });
    // The finish must still navigate to the (kept) guide.
    expect(mocks.tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('sessionId=guide-a') }),
    );
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () => {
  const { makeBackgroundBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makeBackgroundBrowserMock({
      onMessage: (listener) => {
        mocks.messageListener = listener;
      },
      onTabActivated: (listener) => {
        mocks.tabActivatedListener = listener;
      },
      onWindowFocusChanged: (listener) => {
        mocks.windowFocusListener = listener;
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

/** The durable state the mocked storage serves; setRecordingState writes it so
 * follow-mode's read-validate-write cycle behaves like the real store. */
let storedState: RecordingState;

const RECORDED_TAB = { id: 4, windowId: 1, active: false, url: 'https://example.com/flow' };
const OTHER_TAB = { id: 9, windowId: 2, active: true, url: 'https://other.example/page' };

async function activateTab(tabId: number): Promise<void> {
  mocks.tabActivatedListener?.({ tabId, windowId: 2 });
  await vi.advanceTimersByTimeAsync(300);
  await flushAsyncWork();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.messageListener = null;
  mocks.tabActivatedListener = null;
  mocks.windowFocusListener = null;
  storedState = recordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.tabsGet.mockImplementation(async (tabId: number) => {
    if (tabId === OTHER_TAB.id) return OTHER_TAB;
    if (tabId === RECORDED_TAB.id) return RECORDED_TAB;
    throw new Error(`No tab with id: ${tabId}.`);
  });
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('follow-the-active-tab recording (steps mode)', () => {
  it('moves the run to an eligible activated tab: state first, then inject, then stop the old recorder', async () => {
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(9);
    expect(storedState.runId).toBe('run-1');
    expect(storedState.isRecording).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, allFrames: true } }),
    );
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'FRAME_TRAIL_STOP' });
    // READY validation reads state.tabId, so the state write must precede the
    // injection, and the old recorder must only stop after the new one is in.
    const stateWriteOrder = mocks.setRecordingState.mock.invocationCallOrder[0];
    const injectOrder = mocks.executeScript.mock.invocationCallOrder[0];
    const stopOrder = mocks.tabsSendMessage.mock.invocationCallOrder[0];
    expect(stateWriteOrder).toBeLessThan(injectOrder);
    expect(injectOrder).toBeLessThan(stopOrder);
  });

  it('debounces rapid switches: only the tab still active after the pause is followed', async () => {
    const THIRD_TAB = { id: 12, windowId: 2, active: true, url: 'https://third.example/app' };
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === THIRD_TAB.id) return THIRD_TAB;
      if (tabId === OTHER_TAB.id) return { ...OTHER_TAB, active: false };
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    mocks.tabActivatedListener?.({ tabId: 9, windowId: 2 });
    await vi.advanceTimersByTimeAsync(100);
    mocks.tabActivatedListener?.({ tabId: 12, windowId: 2 });
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(storedState.tabId).toBe(12);
    expect(mocks.executeScript).toHaveBeenCalledTimes(1);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 12, allFrames: true } }),
    );
  });

  it('stays on the previous tab when a restricted or extension tab is activated', async () => {
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 9) return { id: 9, windowId: 2, active: true, url: 'chrome://settings/' };
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
  });

  it('keeps single-tab behavior when the <all_urls> grant is absent', async () => {
    mocks.permissionsContains.mockResolvedValue(false);
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(mocks.permissionsContains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(storedState.tabId).toBe(4);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('never follows for a snapshot run', async () => {
    storedState = recordingState({ mode: 'snapshot', groupAnchorId: 'anchor-1' });
    mocks.getStep.mockResolvedValue({
      id: 'anchor-1',
      sessionId: 'guide-a',
      groupId: 'anchor-1',
      url: 'https://example.com/flow',
      screenshotBlob: new Blob(['image']),
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('abandons a stale follow when the run changes between the read and the state mutation', async () => {
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 9) {
        // A concurrent control settles the old run while the follow is still
        // validating its target tab; the serialized mutation must notice.
        storedState = recordingState({ runId: 'run-2', tabId: 4 });
        return OTHER_TAB;
      }
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(storedState.runId).toBe('run-2');
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('follows the focused window\'s active tab on cross-window switches', async () => {
    mocks.tabsQuery.mockResolvedValue([OTHER_TAB]);
    await importBackground();
    await flushAsyncWork();

    mocks.windowFocusListener?.(2);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).toHaveBeenCalledWith({ active: true, windowId: 2 });
    expect(storedState.tabId).toBe(9);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, allFrames: true } }),
    );
  });

  it('ignores focus leaving the browser entirely (WINDOW_ID_NONE)', async () => {
    await importBackground();
    await flushAsyncWork();

    mocks.windowFocusListener?.(-1);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(storedState.tabId).toBe(4);
  });

  it('hands the run back to the previous tab when injection into the new tab fails', async () => {
    silenceIntentionalErrorLogs();
    mocks.executeScript.mockRejectedValue(new Error('Cannot access contents of the page.'));
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(storedState.isRecording).toBe(true);
    // The previous tab's recorder was never stopped, so no stop message and no
    // user-facing error: the run simply stays where it was.
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(storedState.error).toBeNull();
  });

  it('does nothing when the activated tab is the recorded tab itself', async () => {
    await importBackground();
    await flushAsyncWork();

    await activateTab(4);

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
  });
});

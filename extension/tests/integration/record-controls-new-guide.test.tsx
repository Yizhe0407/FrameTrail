// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  createGuide: vi.fn(),
  getGuide: vi.fn(),
  discardPristineGuide: vi.fn(),
}));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makePopupBrowserMock({
      sendMessage: mocks.sendMessage,
      tabsQuery: mocks.query,
      storageGet: mocks.storageGet,
      storageSet: mocks.storageSet,
    }),
  };
});
// Only the storage primitives are mocked: the real guide-actions transaction
// (create → send → verify → rollback with the live-run probe) runs under test.
vi.mock('@/lib/storage/guide-repository', () => ({
  createGuide: mocks.createGuide,
  getGuide: mocks.getGuide,
  discardPristineGuide: mocks.discardPristineGuide,
}));

import RecordControls from '@/components/popup/RecordControls';
import { RECORDING_STATE_KEY } from '@/lib/storage/recording-state';
import { ACTIVE_GUIDE_ID_KEY } from '@/lib/storage/storage';
import { makeRecordingState } from '../setup/recording-state';

const IDLE_RECORDING = makeRecordingState();

const SELECTED_GUIDE_WITH_CONTENT = {
  id: 'guide-old',
  title: '既有教學',
  entryCount: 3,
  stepCount: 3,
};

/** Marks `guide` as the current UI selection. */
function selectGuideInStorage(guide: { id: string } & Record<string, unknown>) {
  mocks.storageGet.mockResolvedValue({ [ACTIVE_GUIDE_ID_KEY]: guide.id });
  mocks.getGuide.mockImplementation(async (id: string) => (id === guide.id ? guide : undefined));
}

beforeEach(() => {
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.storageGet.mockResolvedValue({});
  mocks.storageSet.mockResolvedValue(undefined);
  mocks.getGuide.mockResolvedValue(undefined);
  mocks.createGuide.mockResolvedValue({ id: 'guide-new' });
  mocks.discardPristineGuide.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'guide-new', runId: 'run-1' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('popup start always records into a fresh guide', () => {
  it('creates a new guide even when a guide with content is already selected', async () => {
    selectGuideInStorage(SELECTED_GUIDE_WITH_CONTENT);
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(mocks.createGuide).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'guide-new',
      mode: 'steps',
      autoCreatedGuide: true,
    });
    expect(mocks.storageSet).toHaveBeenCalledWith({ [ACTIVE_GUIDE_ID_KEY]: 'guide-new' });
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });

  it('rolls back the fresh guide and restores the previous selection when start fails', async () => {
    silenceIntentionalErrorLogs();
    selectGuideInStorage(SELECTED_GUIDE_WITH_CONTENT);
    mocks.sendMessage.mockResolvedValue({ ok: false, error: '此頁面不允許錄製。' });
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    expect((await screen.findByRole('alert')).textContent).toContain('此頁面不允許錄製');
    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-new');
    // The pre-start selection is put back so the aborted attempt is invisible.
    expect(mocks.storageSet).toHaveBeenLastCalledWith({ [ACTIVE_GUIDE_ID_KEY]: 'guide-old' });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('keeps the fresh guide when the run actually started but the response was lost', async () => {
    silenceIntentionalErrorLogs();
    // A malformed transport response with a genuinely live run: rolling the
    // guide back would strand the recording, so the probe must veto it.
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.storageGet.mockResolvedValue({
      [RECORDING_STATE_KEY]: {
        ...IDLE_RECORDING,
        operation: 'recording',
        isRecording: true,
        phase: 'recording',
        sessionId: 'guide-new',
        tabId: 7,
        runId: 'run-1',
      },
    });
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await screen.findByRole('alert');
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });

  // The idle popup never shows which guide it is about to record into, so it
  // cannot usefully explain the new-guide-per-recording model either. The hint
  // and the guide-summary read that only decided whether to show it are gone;
  // the idle form now offers the mode chips and the start button alone.
  it('does not read the selected guide just to narrate the data model', async () => {
    selectGuideInStorage(SELECTED_GUIDE_WITH_CONTENT);
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    expect(screen.queryByText(/接續錄製/)).toBeNull();
    expect(mocks.getGuide).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '開始錄製' })).toBeTruthy();
  });
});

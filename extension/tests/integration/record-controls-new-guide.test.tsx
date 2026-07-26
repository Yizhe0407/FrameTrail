// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  storageGet: vi.fn(),
  createAndSelectGuide: vi.fn(),
  getSelectedGuide: vi.fn(),
  discardUntouchedGuide: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://frame${path}`,
      sendMessage: mocks.sendMessage,
    },
    tabs: { query: mocks.query },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn(),
    },
    storage: { local: { get: mocks.storageGet, set: vi.fn(), remove: vi.fn() } },
  },
}));
vi.mock('@/lib/guide/guide-actions', () => ({
  createAndSelectGuide: mocks.createAndSelectGuide,
  getSelectedGuide: mocks.getSelectedGuide,
  discardUntouchedGuide: mocks.discardUntouchedGuide,
}));

import RecordControls from '@/components/popup/RecordControls';
import { RECORDING_STATE_KEY, type RecordingState } from '@/lib/runtime/messages';

const IDLE_RECORDING: RecordingState = {
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

const SELECTED_GUIDE_WITH_CONTENT = {
  id: 'guide-old',
  title: '既有教學',
  entryCount: 3,
  stepCount: 3,
};

const NEW_GUIDE_HINT = /每次錄製都會建立新教學/;

beforeEach(() => {
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.storageGet.mockResolvedValue({});
  mocks.getSelectedGuide.mockResolvedValue(null);
  mocks.createAndSelectGuide.mockResolvedValue({ id: 'guide-new' });
  mocks.discardUntouchedGuide.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'guide-new', runId: 'run-1' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('popup start always records into a fresh guide', () => {
  it('creates a new guide even when a guide with content is already selected', async () => {
    mocks.getSelectedGuide.mockResolvedValue(SELECTED_GUIDE_WITH_CONTENT);
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(mocks.createAndSelectGuide).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'guide-new',
      mode: 'steps',
      autoCreatedGuide: true,
    });
    expect(mocks.discardUntouchedGuide).not.toHaveBeenCalled();
  });

  it('rolls back the fresh guide and restores the previous selection when start fails', async () => {
    silenceIntentionalErrorLogs();
    mocks.getSelectedGuide.mockResolvedValue(SELECTED_GUIDE_WITH_CONTENT);
    mocks.sendMessage.mockResolvedValue({ ok: false, error: '此頁面不允許錄製。' });
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    expect((await screen.findByRole('alert')).textContent).toContain('此頁面不允許錄製');
    expect(mocks.discardUntouchedGuide).toHaveBeenCalledExactlyOnceWith('guide-new', 'guide-old');
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
    expect(mocks.discardUntouchedGuide).not.toHaveBeenCalled();
  });

  it('explains the new-guide model when the selected guide already has content', async () => {
    mocks.getSelectedGuide.mockResolvedValue(SELECTED_GUIDE_WITH_CONTENT);
    render(<RecordControls recording={IDLE_RECORDING} />);

    expect(await screen.findByText(NEW_GUIDE_HINT)).toBeTruthy();
  });

  it('stays quiet about the new-guide model when nothing with content is selected', async () => {
    mocks.getSelectedGuide.mockResolvedValue({ id: 'guide-empty', entryCount: 0, stepCount: 0 });
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.getSelectedGuide).toHaveBeenCalled());

    expect(screen.queryByText(NEW_GUIDE_HINT)).toBeNull();
  });
});

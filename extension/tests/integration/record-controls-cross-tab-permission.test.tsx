// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  ensureSelectedGuide: vi.fn(),
  permissionsContains: vi.fn(),
  permissionsRequest: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://frame${path}`,
      sendMessage: mocks.sendMessage,
    },
    tabs: { query: mocks.query },
    permissions: { contains: mocks.permissionsContains, request: mocks.permissionsRequest },
    storage: { local: { get: mocks.storageGet, set: mocks.storageSet, remove: mocks.storageRemove } },
  },
}));
vi.mock('@/lib/guide/guide-actions', () => ({ ensureSelectedGuide: mocks.ensureSelectedGuide }));

import RecordControls from '@/components/popup/RecordControls';
import { CROSS_TAB_DECLINE_STORAGE_KEY } from '@/lib/runtime/cross-tab-recording';
import type { RecordingState } from '@/lib/runtime/messages';

const ALL_URLS = { origins: ['<all_urls>'] };
const HINT_TEXT = /目前僅錄製單一分頁/;
const ENABLE_BUTTON = '啟用跨分頁錄製';

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
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
  recapture: null,
  recaptureResult: null,
};

/** Renders the idle form and waits for the mount probes to settle. */
async function renderIdleControls() {
  render(<RecordControls recording={IDLE_RECORDING} />);
  await waitFor(() => expect(mocks.permissionsContains).toHaveBeenCalled());
  await waitFor(() => expect(mocks.storageGet).toHaveBeenCalled());
}

async function clickStartAndWaitForSend(times: number) {
  fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(times));
}

beforeEach(() => {
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.ensureSelectedGuide.mockResolvedValue({ id: 'guide-a' });
  mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'guide-a', runId: 'run-1' });
  mocks.permissionsContains.mockResolvedValue(false);
  mocks.permissionsRequest.mockResolvedValue(true);
  mocks.storageGet.mockResolvedValue({});
  mocks.storageSet.mockResolvedValue(undefined);
  mocks.storageRemove.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('cross-tab permission ask at recording start', () => {
  it('asks for the grant on the first steps start, before touching the active tab', async () => {
    await renderIdleControls();
    // Only the ordering of the start-click work matters, not the mount probe.
    mocks.query.mockClear();

    await clickStartAndWaitForSend(1);

    expect(mocks.permissionsRequest).toHaveBeenCalledExactlyOnceWith(ALL_URLS);
    expect(mocks.query).toHaveBeenCalled();
    // Firefox invariant: permissions.request must be the first await of the
    // click handler, ahead of the tabs.query pre-flight.
    expect(mocks.permissionsRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[0],
    );
  });

  it('remembers a decline, keeps recording single-tab, and never asks again', async () => {
    mocks.permissionsRequest.mockResolvedValue(false);
    await renderIdleControls();

    await clickStartAndWaitForSend(1);

    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
    expect(mocks.storageSet).toHaveBeenCalledExactlyOnceWith({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: {
        version: 1,
        declined: true,
        declinedAt: expect.any(Number),
      },
    });

    await clickStartAndWaitForSend(2);
    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
  });

  it('does not ask again in a later session once the decline flag is stored', async () => {
    mocks.storageGet.mockResolvedValue({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: { version: 1, declined: true, declinedAt: 123 },
    });
    await renderIdleControls();

    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('skips the ask entirely when the grant is already present', async () => {
    mocks.permissionsContains.mockResolvedValue(true);
    await renderIdleControls();

    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('never asks for the grant when starting a snapshot run', async () => {
    await renderIdleControls();

    fireEvent.click(screen.getByRole('radio', { name: '快照' }));
    expect(screen.queryByText(HINT_TEXT)).toBeNull();

    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('offers an inline enable link even after a decline; a grant clears the flag and the hint', async () => {
    mocks.storageGet.mockResolvedValue({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: { version: 1, declined: true, declinedAt: 123 },
    });
    await renderIdleControls();

    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ENABLE_BUTTON }));

    await waitFor(() => expect(screen.queryByText(HINT_TEXT)).toBeNull());
    expect(mocks.permissionsRequest).toHaveBeenCalledExactlyOnceWith(ALL_URLS);
    expect(mocks.storageRemove).toHaveBeenCalledExactlyOnceWith(CROSS_TAB_DECLINE_STORAGE_KEY);
    // The affordance is an opt-in, never a recording trigger.
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the quiet hint when the inline enable link is declined', async () => {
    mocks.permissionsRequest.mockResolvedValue(false);
    await renderIdleControls();

    fireEvent.click(screen.getByRole('button', { name: ENABLE_BUTTON }));

    await waitFor(() => expect(mocks.storageSet).toHaveBeenCalled());
    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
    // The decline is remembered, so the next start proceeds without an ask.
    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
  });
});

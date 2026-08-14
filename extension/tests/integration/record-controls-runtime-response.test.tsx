// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  createGuide: vi.fn(),
  getGuide: vi.fn(),
  discardPristineGuide: vi.fn(),
}));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return { browser: makePopupBrowserMock({ sendMessage: mocks.sendMessage, tabsQuery: mocks.query }) };
});
// Only the storage primitives are mocked; the real guide-actions flow runs.
vi.mock('@/lib/storage/guide-repository', () => ({
  createGuide: mocks.createGuide,
  getGuide: mocks.getGuide,
  discardPristineGuide: mocks.discardPristineGuide,
}));

import RecordControls from '@/components/popup/RecordControls';
import { makeRecordingState } from '../setup/recording-state';

const IDLE_RECORDING = makeRecordingState();

beforeEach(() => {
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.createGuide.mockResolvedValue({ id: 'guide-a' });
  mocks.getGuide.mockResolvedValue(undefined);
  mocks.discardPristineGuide.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('record controls runtime responses', () => {
  it.each([
    ['missing', null],
    ['incomplete success', { ok: true, sessionId: 'guide-a' }],
    ['malformed failure', { ok: false, error: 503 }],
  ])('shows a transport error for a %s START_RECORDING response', async (_case, response) => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockResolvedValue(response);
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^開始/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法連接錄製服務');
    expect(onStarted).not.toHaveBeenCalled();
  });
});

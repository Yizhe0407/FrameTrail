// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  ensureSelectedGuide: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://frame${path}`,
      sendMessage: mocks.sendMessage,
    },
    tabs: { query: mocks.query },
    permissions: {
      contains: vi.fn(),
      request: vi.fn(),
    },
  },
}));
vi.mock('@/lib/guide-actions', () => ({ ensureSelectedGuide: mocks.ensureSelectedGuide }));

import RecordControls from '@/components/RecordControls';
import type { RecordingState } from '@/lib/messages';

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
  insertion: null,
  recapture: null,
  recaptureResult: null,
};

beforeEach(() => {
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.ensureSelectedGuide.mockResolvedValue({ id: 'guide-a' });
  mocks.sendMessage.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('record controls runtime responses', () => {
  it('shows a transport error instead of reading ok from a null START_RECORDING response', async () => {
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始' }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法連接錄製服務');
  });
});

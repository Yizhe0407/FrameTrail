// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const runtime = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime,
  },
}));

vi.mock('@/lib/guide/guide-actions', () => ({
  ensureSelectedGuide: vi.fn().mockResolvedValue({ id: 'guide-selected' }),
}));
vi.mock('@/lib/storage/guide-repository', () => ({
  getGuide: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/recording/use-recording-session', () => ({
  useRecordingSession: () => ({
    recording: { phase: 'idle' },
    sessionId: 'guide-current',
    isRecording: false,
    steps: [],
    error: null,
    recoverableError: null,
  }),
}));
vi.mock('@/components/popup/RecordControls', () => ({
  default: ({ onOpenEditor }: { onOpenEditor: () => void }) => (
    <button type="button" onClick={onOpenEditor}>編輯器</button>
  ),
}));
vi.mock('@/components/shared/ResetButton', () => ({ default: () => <button type="button">重設</button> }));

import PopupApp from '@/entrypoints/popup/App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  runtime.sendMessage.mockResolvedValue({ ok: true });
  vi.spyOn(window, 'close').mockImplementation(() => {});
});

describe('popup editor open', () => {
  it('resolves and sends the selected Guide id when opening the editor', async () => {
    render(<PopupApp />);

    fireEvent.click(screen.getByRole('button', { name: '編輯器' }));

    await waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'OPEN_EDITOR',
      sessionId: 'guide-selected',
    }));
  });

  it('shows a recoverable error when the background returns no editor response', async () => {
    silenceIntentionalErrorLogs();
    runtime.sendMessage.mockResolvedValue(undefined);
    render(<PopupApp />);

    fireEvent.click(screen.getByRole('button', { name: '編輯器' }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法連接編輯器服務');
    expect(window.close).not.toHaveBeenCalled();
  });
});

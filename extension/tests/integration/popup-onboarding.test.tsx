// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const runtime = vi.hoisted(() => ({ sendMessage: vi.fn() }));

const onboarding = vi.hoisted(() => ({
  shouldShowOnboarding: vi.fn(),
  markOnboardingComplete: vi.fn(),
  openLocalPracticePage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime,
  },
}));

vi.mock('@/lib/runtime/onboarding', () => onboarding);
vi.mock('@/lib/guide/guide-actions', () => ({
  ensureSelectedGuide: vi.fn().mockResolvedValue({ id: 'guide-selected' }),
}));
vi.mock('@/lib/storage/db', () => ({
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
  onboarding.shouldShowOnboarding.mockResolvedValue(false);
  onboarding.markOnboardingComplete.mockResolvedValue(undefined);
  onboarding.openLocalPracticePage.mockResolvedValue(undefined);
  vi.spyOn(window, 'close').mockImplementation(() => {});
});

describe('popup onboarding wiring', () => {
  it('opens onboarding on the first popup visit and marks it complete', async () => {
    onboarding.shouldShowOnboarding.mockResolvedValue(true);
    render(<PopupApp />);

    expect(await screen.findByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '我知道了' }));

    await waitFor(() => expect(onboarding.markOnboardingComplete).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeNull();
  });

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

  it('persists completion when the guide is dismissed without a footer action', async () => {
    onboarding.shouldShowOnboarding.mockResolvedValue(true);
    onboarding.markOnboardingComplete.mockClear();
    render(<PopupApp />);

    expect(await screen.findByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '關閉' }));

    await waitFor(() => expect(onboarding.markOnboardingComplete).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeNull();
  });

  it('lets first-time users launch the selected local practice mode', async () => {
    const calls: string[] = [];
    onboarding.markOnboardingComplete.mockImplementation(async () => { calls.push('complete'); });
    onboarding.openLocalPracticePage.mockImplementation(async (mode: string) => { calls.push(`practice:${mode}`); });
    onboarding.shouldShowOnboarding.mockResolvedValue(true);
    render(<PopupApp />);

    fireEvent.click(await screen.findByRole('button', { name: '練習單頁標註' }));

    await waitFor(() => expect(onboarding.openLocalPracticePage).toHaveBeenCalledWith('snapshot'));
    expect(calls).toEqual(['complete', 'practice:snapshot']);
    expect(window.close).toHaveBeenCalledOnce();
  });
});

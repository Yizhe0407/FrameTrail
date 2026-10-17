// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

// PopupApp renders ResetButton, which uses the shadcn Tooltip and requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  resetSession: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));
vi.mock('@/lib/project/project-actions', () => ({ ensureSelectedProject: vi.fn() }));
vi.mock('@/lib/storage/project-repository', () => ({ getProject: mocks.getProject }));
vi.mock('@/lib/storage/change-notifier', () => ({
  subscribeProjectsChanged: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock('@/lib/runtime/actions', () => ({
  openLibrary: vi.fn(),
  openSettings: vi.fn(),
  resetSession: mocks.resetSession,
}));
// The last recording went into project B; the picker below chooses project A.
vi.mock('@/lib/recording/use-recording-session', () => ({
  useRecordingSession: () => ({
    recording: { phase: 'idle' },
    sessionId: 'project-b',
    isRecording: false,
    steps: [],
    error: null,
    recoverableError: null,
  }),
}));
vi.mock('@/components/popup/RecordControls', () => ({
  default: ({ onTargetProjectChange }: { onTargetProjectChange: (id: string | null) => void }) => (
    <>
      <button type="button" onClick={() => onTargetProjectChange('project-a')}>選 A</button>
      <button type="button" onClick={() => onTargetProjectChange(null)}>選新專案</button>
    </>
  ),
}));

import PopupApp from '@/entrypoints/popup/App';

const PROJECTS: Record<string, { id: string; title: string; entryCount: number; stepCount: number }> = {
  'project-a': { id: 'project-a', title: '專案 A', entryCount: 3, stepCount: 3 },
  'project-b': { id: 'project-b', title: '專案 B', entryCount: 9, stepCount: 9 },
};

function resetButton() {
  return screen.getByRole('button', { name: '重置目前錄製' }) as HTMLButtonElement;
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.resetSession.mockReset().mockResolvedValue(undefined);
  mocks.getProject.mockReset().mockImplementation(async (id: string) => PROJECTS[id]);
});

afterEach(cleanup);

describe('popup reset target', () => {
  it('is disabled while the picker is on 新專案, even if the last recording has content', async () => {
    render(<PopupApp />);
    expect(resetButton().disabled).toBe(true);
    expect(mocks.getProject).not.toHaveBeenCalledWith('project-b');
  });

  it('resets the project picked in 錄到哪裡 and names it in the dialog', async () => {
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: '選 A' }));
    await waitFor(() => expect(resetButton().disabled).toBe(false));

    fireEvent.click(resetButton());
    const dialog = await screen.findByRole('dialog', { name: '重置「專案 A」？' });
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '重置')!);

    await waitFor(() => expect(mocks.resetSession).toHaveBeenCalledWith('project-a'));
    expect(mocks.resetSession).not.toHaveBeenCalledWith('project-b');
  });

  it('disables 重置 after a successful reset', async () => {
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: '選 A' }));
    await waitFor(() => expect(resetButton().disabled).toBe(false));

    fireEvent.click(resetButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '重置')!);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resetButton().disabled).toBe(true);
  });

  it('disables 重置 when the project is deleted elsewhere while the popup is open', async () => {
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: '選 A' }));
    await waitFor(() => expect(resetButton().disabled).toBe(false));

    mocks.getProject.mockResolvedValue(undefined);
    act(() => mocks.listeners.forEach((listener) => listener()));

    await waitFor(() => expect(resetButton().disabled).toBe(true));
  });

  it('gives the popup one main landmark and one h1', () => {
    render(<PopupApp />);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

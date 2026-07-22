// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnboardingDialog from '@/components/OnboardingDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OnboardingDialog', () => {
  it('presents an accessible, self-contained explanation of both modes and local privacy', () => {
    render(<OnboardingDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '兩種錄製模式' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '完整模式' })).toBeTruthy();
    expect(screen.getByText('操作流程')).toBeTruthy();
    expect(screen.getByText(/每次選取記成獨立步驟圖/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '精簡模式' })).toBeTruthy();
    expect(screen.getByText('單頁標註')).toBeTruthy();
    expect(screen.getByText(/同一張乾淨底圖加入多個標註/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '如何復原與完成' })).toBeTruthy();
    expect(screen.getByText(/復原上一個/)).toBeTruthy();
    expect(screen.getAllByText(/完成並新增快照/)).toHaveLength(2);
    expect(screen.getByRole('heading', { name: '內容只留在本機' })).toBeTruthy();
    expect(screen.getByText(/不會上傳到外部服務/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '關閉' })).toBeTruthy();
    expect(document.querySelector('a, iframe, img')).toBeNull();
  });

  it('exposes the selected recording mode to the practice callback and closes after it starts', async () => {
    const onOpenChange = vi.fn();
    const onStartPractice = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingDialog
        open
        onOpenChange={onOpenChange}
        onStartPractice={onStartPractice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '練習完整模式' }));

    await waitFor(() => expect(onStartPractice).toHaveBeenCalledWith('steps'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers a separate snapshot practice action', async () => {
    const onStartPractice = vi.fn().mockResolvedValue(undefined);
    render(<OnboardingDialog open onOpenChange={vi.fn()} onStartPractice={onStartPractice} />);

    fireEvent.click(screen.getByRole('button', { name: '練習精簡模式' }));

    await waitFor(() => expect(onStartPractice).toHaveBeenCalledWith('snapshot'));
  });

  it('marks onboarding complete before launching local practice', async () => {
    const calls: string[] = [];
    const onComplete = vi.fn(() => { calls.push('complete'); });
    const onStartPractice = vi.fn(() => { calls.push('practice'); });
    const onOpenChange = vi.fn(() => { calls.push('close'); });
    render(
      <OnboardingDialog
        open
        onOpenChange={onOpenChange}
        onComplete={onComplete}
        onStartPractice={onStartPractice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '練習精簡模式' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onStartPractice).toHaveBeenCalledWith('snapshot');
    expect(calls).toEqual(['complete', 'practice', 'close']);
  });

  it('runs the completion callback before requesting close', async () => {
    const calls: string[] = [];
    const onComplete = vi.fn(async () => {
      calls.push('complete');
    });
    const onOpenChange = vi.fn(() => {
      calls.push('close');
    });
    render(<OnboardingDialog open onOpenChange={onOpenChange} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole('button', { name: '我知道了' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(calls).toEqual(['complete', 'close']);
  });

  it('keeps the dialog open and announces an action failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onOpenChange = vi.fn();
    const onStartPractice = vi.fn().mockRejectedValue(new Error('practice unavailable'));
    render(
      <OnboardingDialog
        open
        onOpenChange={onOpenChange}
        onStartPractice={onStartPractice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '練習完整模式' }));

    expect((await screen.findByRole('alert')).textContent).toBe('無法開始，請再試一次。');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

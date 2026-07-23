// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnboardingDialog from '@/components/popup/OnboardingDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OnboardingDialog', () => {
  it('explains the actual recording-to-export workflow and when to use each recording mode', () => {
    render(<OnboardingDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '歡迎使用 FrameTrail' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '四步完成一份教學' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '錄製' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '編輯' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '遮罩' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '匯出' })).toBeTruthy();
    expect(screen.getByText(/完成錄製後開啟編輯器/)).toBeTruthy();
    expect(screen.getByText(/在「調整圖片」加入敏感資訊遮罩/)).toBeTruthy();
    expect(screen.getByText(/從「發佈教學」下載、複製或列印/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '先選錄製方式' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '操作流程' })).toBeTruthy();
    expect(screen.getByText(/依實際點選順序建立多張步驟圖/)).toBeTruthy();
    expect(screen.getByText(/跨頁、表單與連續操作/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '單頁標註' })).toBeTruthy();
    expect(screen.getByText(/對同一張圖加入多個標註/)).toBeTruthy();
    expect(screen.getByText(/畫面導覽、欄位總覽與介面說明/)).toBeTruthy();
    expect(screen.getByText(/預覽、複製與匯出會先被限制/)).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: '練習操作流程' }));

    await waitFor(() => expect(onStartPractice).toHaveBeenCalledWith('steps'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers a separate snapshot practice action', async () => {
    const onStartPractice = vi.fn().mockResolvedValue(undefined);
    render(<OnboardingDialog open onOpenChange={vi.fn()} onStartPractice={onStartPractice} />);

    fireEvent.click(screen.getByRole('button', { name: '練習單頁標註' }));

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

    fireEvent.click(screen.getByRole('button', { name: '練習單頁標註' }));

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

    fireEvent.click(screen.getByRole('button', { name: '練習操作流程' }));

    expect((await screen.findByRole('alert')).textContent).toBe('無法開始，請再試一次。');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

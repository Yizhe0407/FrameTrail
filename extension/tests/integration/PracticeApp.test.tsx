// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PracticeApp from '@/entrypoints/practice/App';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('local practice page', () => {
  it('shows the selected local practice mode and safe practice targets', () => {
    window.history.replaceState({}, '', '/practice.html?mode=snapshot');
    render(<PracticeApp />);

    expect(screen.getByRole('heading', { name: '精簡模式：單頁標註' })).toBeTruthy();
    expect(screen.getByText(/沒有外部連結、沒有網路請求/)).toBeTruthy();
    expect(screen.getByText(/不會被 FrameTrail 捕捉、保存或上傳/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '練習點擊' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '任意輸入一段練習文字（不會保存）' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '我已確認這只是本機練習' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '選取快照目標' })).toBeTruthy();
    expect(document.querySelector('a, iframe, img, form')).toBeNull();
  });

  it('allows safe click and checkbox practice without persisting typed input', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<PracticeApp />);

    const input = screen.getByRole('textbox', { name: '任意輸入一段練習文字（不會保存）' });
    fireEvent.change(input, { target: { value: '僅供練習的文字' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我已確認這只是本機練習' }));
    fireEvent.click(screen.getByRole('button', { name: '練習點擊' }));

    expect((input as HTMLInputElement).value).toBe('僅供練習的文字');
    expect((screen.getByRole('checkbox', { name: '我已確認這只是本機練習' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('已練習點擊按鈕。');
    expect(setItem).not.toHaveBeenCalled();
  });
});

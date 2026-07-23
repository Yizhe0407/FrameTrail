// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resetSession: vi.fn() }));

vi.mock('@/lib/runtime/actions', () => ({ resetSession: mocks.resetSession }));

import ResetButton from '@/components/shared/ResetButton';

beforeEach(() => {
  mocks.resetSession.mockReset();
  mocks.resetSession.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('ResetButton', () => {
  async function confirmReset() {
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    const dialog = await screen.findByRole('dialog', { name: '重置目前錄製？' });
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '重置');
    if (!confirmButton) throw new Error('找不到確認重置按鈕');
    fireEvent.click(confirmButton);
  }

  it('awaits the reset completion callback before leaving the pending state', async () => {
    let finishRefresh: (() => void) | undefined;
    const onReset = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));

    render(<ResetButton hasSteps sessionId="guide-1" onReset={onReset} />);
    await confirmReset();

    await waitFor(() => expect(mocks.resetSession).toHaveBeenCalledWith('guide-1'));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '處理中' }).hasAttribute('disabled')).toBe(true);

    finishRefresh?.();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重置目前錄製？' })).toBeNull());
  });

  it('does not refresh when the reset fails and exposes a recoverable error', async () => {
    mocks.resetSession.mockRejectedValueOnce(new Error('failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onReset = vi.fn();

    render(<ResetButton hasSteps sessionId="guide-1" onReset={onReset} />);
    await confirmReset();

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('重置失敗'));
    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '重置目前錄製？' })).toBeTruthy();
    consoleError.mockRestore();
  });
});

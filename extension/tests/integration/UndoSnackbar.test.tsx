// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UndoSnackbar from '@/components/editor/UndoSnackbar';

describe('UndoSnackbar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('auto-dismisses after five idle seconds', () => {
    const onDismiss = vi.fn();
    render(
      <UndoSnackbar message="已刪除步驟 1" onUndo={vi.fn()} onDismiss={onDismiss} />,
    );

    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('suspends auto-dismiss while the restore is pending and restarts afterwards', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <UndoSnackbar message="已刪除步驟 1" pending={false} onUndo={vi.fn()} onDismiss={onDismiss} />,
    );

    // The user clicks 還原 just before the timer fires: the snackbar must not
    // unmount mid-operation.
    act(() => vi.advanceTimersByTime(4_800));
    rerender(
      <UndoSnackbar message="已刪除步驟 1" pending onUndo={vi.fn()} onDismiss={onDismiss} />,
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('還原中')).toBeTruthy();

    // Once the operation settles, the timer restarts from zero.
    rerender(
      <UndoSnackbar message="已刪除步驟 1" pending={false} onUndo={vi.fn()} onDismiss={onDismiss} />,
    );
    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

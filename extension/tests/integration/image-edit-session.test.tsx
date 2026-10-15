// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { historyReducer, initialHistory, useImageEditSession } from '@/lib/editor/image-edit-session';
import type { ImageEditItem } from '@/lib/editor/image-edit-items';

const item = (id: string, x = 0): ImageEditItem => ({ id, kind: 'redaction', bounds: { x, y: 0, width: 10, height: 10 } });

describe('historyReducer', () => {
  it('undoes and redoes, and a new change drops the redo branch', () => {
    const a = [item('a')];
    const b = [item('a'), item('b')];
    const c = [item('c')];
    let history = historyReducer(initialHistory(a), { type: 'commit', items: b });
    history = historyReducer(history, { type: 'undo' });
    expect(history.present).toBe(a);
    history = historyReducer(history, { type: 'redo' });
    expect(history.present).toBe(b);
    history = historyReducer(history, { type: 'undo' });
    history = historyReducer(history, { type: 'commit', items: c });
    expect(history.future).toEqual([]);
    expect(historyReducer(history, { type: 'redo' })).toBe(history);
  });

  it('ignores a commit of the identical list', () => {
    const history = initialHistory([item('a')]);
    expect(historyReducer(history, { type: 'commit', items: history.present })).toBe(history);
  });
});

describe('useImageEditSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows changes immediately and saves them once after the debounce', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageEditSession({ initialItems: [], persist, debounceMs: 500 }));

    act(() => result.current.commit([item('a')]));
    expect(result.current.items).toHaveLength(1);
    act(() => result.current.commit([item('a'), item('b')]));
    expect(persist).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toHaveLength(2);
  });

  it('never runs two saves at once and writes edits made during a save', async () => {
    let release: () => void = () => undefined;
    const calls: number[] = [];
    let running = 0;
    const persist = vi.fn(async (items: ImageEditItem[]) => {
      running += 1;
      expect(running).toBe(1);
      calls.push(items.length);
      if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      running -= 1;
    });
    const { result } = renderHook(() => useImageEditSession({ initialItems: [], persist, debounceMs: 100 }));

    act(() => result.current.commit([item('a')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(calls).toEqual([1]);

    act(() => result.current.commit([item('a'), item('b')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(calls).toEqual([1]);

    await act(async () => { release(); await result.current.flush(); });
    expect(calls).toEqual([1, 2]);
  });

  it('flush resolves once everything shown is written, and reports a failed write', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageEditSession({ initialItems: [], persist }));

    act(() => result.current.commit([item('a')]));
    await act(async () => { await expect(result.current.flush()).rejects.toThrow('disk'); });
    expect(result.current.saveFailed).toBe(true);

    await act(async () => { await result.current.flush(); });
    expect(result.current.saveFailed).toBe(false);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('writes pending edits when the editor closes', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useImageEditSession({ initialItems: [], persist, debounceMs: 10_000 }));

    act(() => result.current.commit([item('a')]));
    unmount();
    await vi.advanceTimersByTimeAsync(0);

    expect(persist).toHaveBeenCalledTimes(1);
  });
});

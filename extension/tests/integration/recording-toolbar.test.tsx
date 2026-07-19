// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: { get: mocks.get, set: mocks.set } },
  },
}));

import RecordingToolbar, { type RecordingToolbarState } from '@/components/RecordingToolbar';
import { RECORDING_TOOLBAR_CORNER_KEY } from '@/lib/recording-toolbar-position';

const state: RecordingToolbarState = {
  runId: 'run-1',
  mode: 'steps',
  phase: 'recording',
  itemCount: 2,
  error: null,
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.get.mockResolvedValue({ [RECORDING_TOOLBAR_CORNER_KEY]: 'bottom-right' });
  mocks.set.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('recording toolbar', () => {
  it('moves between corners by keyboard and persists the preference', async () => {
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    const positionControl = screen.getByRole('button', { name: /拖曳或使用方向鍵移動/ });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(RECORDING_TOOLBAR_CORNER_KEY));

    fireEvent.keyDown(positionControl, { key: 'ArrowUp' });

    expect(mocks.set).toHaveBeenCalledWith({ [RECORDING_TOOLBAR_CORNER_KEY]: 'top-right' });
    expect(screen.getByText('錄製控制已移到右上角')).toBeTruthy();
  });

  it('requires confirmation before discarding the current recording', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={state} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('button', { name: '更多錄製動作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '放棄這次錄製' }));
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '更多錄製動作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '放棄這次錄製' }));
    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('moves collapse into the overflow menu and preserves a meaningful compact status', () => {
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多錄製動作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '收合控制器' }));

    expect(screen.getByRole('button', { name: /操作流程錄製中，2 筆/ })).toBeTruthy();
  });
});

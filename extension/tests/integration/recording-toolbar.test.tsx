// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension' },
    storage: { local: { get: mocks.get, set: mocks.set } },
  },
}));

import RecordingToolbar, { type RecordingToolbarState } from '@/lib/recording/recording-toolbar';
import { RECORDING_TOOLBAR_CORNER_KEY } from '@/lib/recording/recording-toolbar-position';

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

    fireEvent.click(screen.getByRole('button', { name: '放棄這次錄製' }));
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '放棄這次錄製' }));
    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('starts an accessible region capture and exposes its active state', () => {
    const onStartRegionCapture = vi.fn();
    const { rerender } = render(
      <RecordingToolbar
        state={state}
        onCommand={vi.fn()}
        onStartRegionCapture={onStartRegionCapture}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '裁切擷取區域' }));
    expect(onStartRegionCapture).toHaveBeenCalledOnce();

    rerender(
      <RecordingToolbar
        state={state}
        onCommand={vi.fn()}
        onStartRegionCapture={onStartRegionCapture}
        regionCaptureActive
      />,
    );
    const activeButton = screen.getByRole('button', { name: '區域擷取進行中' });
    expect((activeButton as HTMLButtonElement).disabled).toBe(true);
    expect(activeButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('區域擷取中')).toBeTruthy();
    expect(screen.getByText('區域擷取已啟動，請在畫面上拖曳選取範圍')).toBeTruthy();
  });

  it('keeps collapse directly available and preserves a meaningful compact status', () => {
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '收合控制器' }));

    expect(screen.getByRole('button', { name: /錄製中，步驟，2 筆；展開錄製控制/ })).toBeTruthy();
  });

  // The 更多 menu only ever rendered in the invalidated shell, where its
  // collapse item was gated off — so it held exactly one action. Discard now
  // sits directly in that row.
  it('offers discard directly in the invalidated shell, with no overflow menu', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(
      <RecordingToolbar
        state={{ ...state, mode: 'snapshot', phase: 'invalidated' }}
        onCommand={onCommand}
      />,
    );

    expect(screen.queryByRole('button', { name: '更多錄製動作' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: '保留並重建' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '放棄這次錄製' }));
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
  });

  it('names the recording mode with the shared vocabulary in the snapshot undo snackbar', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true, undoToken: 'undo-1', removedItemNumber: 1 });
    render(<RecordingToolbar state={{ ...state, mode: 'snapshot' }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('button', { name: '復原上一個' }));

    // The snackbar and the live-region announcement now read the item noun from
    // the same map, so both say 標註 rather than one of them saying 步驟.
    expect(await screen.findAllByText('已移除標註 1')).toHaveLength(2);
  });
});

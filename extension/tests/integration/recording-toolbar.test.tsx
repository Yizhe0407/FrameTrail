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
  it('names the existing project the run appends to, and nothing for a new project', () => {
    const { rerender } = render(<RecordingToolbar state={{ ...state, projectTitle: '既有教學' }} onCommand={vi.fn()} />);
    expect(screen.getByText('既有教學').getAttribute('title')).toBe('新步驟會加到「既有教學」');
    expect(screen.getByRole('button', { name: /拖曳移動/ }).getAttribute('aria-label')).toContain('新步驟會加到「既有教學」');
    rerender(<RecordingToolbar state={{ ...state, projectTitle: null }} onCommand={vi.fn()} />);
    expect(screen.queryByText('既有教學')).toBeNull();
  });

  it('offers the position control as drag-only: arrow keys do not move it', async () => {
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    const positionControl = screen.getByRole('button', { name: /拖曳移動/ });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(RECORDING_TOOLBAR_CORNER_KEY));
    expect(positionControl.getAttribute('aria-label')).not.toContain('方向鍵');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      fireEvent.keyDown(positionControl, { key });
    }

    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('requires confirmation before discarding the current recording', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={state} onCommand={onCommand} />);

    const openDiscard = () => {
      fireEvent.click(screen.getByRole('button', { name: '更多' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '放棄錄製' }));
    };
    openDiscard();
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();

    openDiscard();
    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('starts a region capture from the menu and exposes its active state', () => {
    const onStartRegionCapture = vi.fn();
    const { rerender } = render(
      <RecordingToolbar state={state} onCommand={vi.fn()} onStartRegionCapture={onStartRegionCapture} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '框選區域' }));
    expect(onStartRegionCapture).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();

    rerender(
      <RecordingToolbar state={state} onCommand={vi.fn()} onStartRegionCapture={onStartRegionCapture} regionCaptureActive />,
    );
    expect(screen.getByRole('button', { name: /區域擷取中/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect((screen.getByRole('menuitem', { name: '區域擷取進行中' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('區域擷取已啟動，請在畫面上拖曳選取範圍')).toBeTruthy();
  });

  it('collapses from the menu and keeps a meaningful compact status', () => {
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '收合控制器' }));

    expect(screen.getByRole('button', { name: /錄製中，2 步；展開錄製控制/ })).toBeTruthy();
  });

  // The 更多 menu held exactly one action in the invalidated shell; discard now sits directly in that row.
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

  it('switches from steps to snapshot without a confirmation', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={state} onCommand={onCommand} />);

    expect(screen.getByRole('radio', { name: '步驟' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '標註' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_SNAPSHOT_MODE', undefined));
  });

  it('switches a snapshot with no annotations to steps immediately', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={{ ...state, mode: 'snapshot', itemCount: 0 }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('radio', { name: '步驟' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_STEPS_MODE', undefined));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leaves a snapshot that already has annotations without asking, keeping what was marked', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={{ ...state, mode: 'snapshot', itemCount: 2 }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('radio', { name: '步驟' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_STEPS_MODE', undefined));
  });

  it('shows one icon-and-count status per state, with the full wording as its label', () => {
    const { rerender } = render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /錄製中，2 步/ })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, phase: 'paused' }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /已暫停，2 步/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '繼續錄製' })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'recording' }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /標註中，2 處/ })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /待擷取/ })).toBeTruthy();
  });

  it('walks a snapshot through capture, next and finish with one main button per state', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      <RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={onCommand} />,
    );
    expect(screen.getByText('先把頁面操作到位，再按「擷取」凍結畫面。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '復原上一個' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '擷取' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('CREATE_NEXT_SNAPSHOT', undefined));

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'recording', itemCount: 1 }} onCommand={onCommand} />);
    expect(screen.queryByRole('button', { name: '擷取' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一張' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('PREPARE_NEXT_SNAPSHOT', undefined));

    // Finish is always the same control, whatever the state, and never doubles as another action.
    fireEvent.click(screen.getByRole('button', { name: '結束' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('FINISH_RECORDING', undefined));
  });

  it('finishes from the waiting state too', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    render(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: '結束' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('FINISH_RECORDING', undefined));
  });
});

describe('recording toolbar layout', () => {
  /** jsdom has no layout, so the measured rectangles are supplied: the toolbar's right edge and its last child's. */
  function stubWidths(lastChildRight: number, toolbarRight: number) {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const right = this.classList.contains('ft-toolbar') ? toolbarRight : lastChildRight;
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, width: right, height: 0, right, toJSON: () => ({}) } as DOMRect;
    });
    return () => spy.mockRestore();
  }

  it('stays on one row while its content fits', () => {
    const restore = stubWidths(590, 600);
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('toolbar', { hidden: true }).hasAttribute('data-compact')).toBe(false);
    restore();
  });

  it('stacks only when the single row would overflow, whatever the language', () => {
    const restore = stubWidths(700, 600);
    render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('toolbar', { hidden: true }).hasAttribute('data-compact')).toBe(true);
    restore();
  });
});

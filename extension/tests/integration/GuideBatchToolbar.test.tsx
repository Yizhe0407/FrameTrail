// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuideBatchToolbar, { type GuideBatchToolbarProps } from '@/components/GuideBatchToolbar';

function createProps(overrides: Partial<GuideBatchToolbarProps> = {}): GuideBatchToolbarProps {
  return {
    selectedEntryIds: ['entry-2', 'entry-3'],
    visibleEntryIds: ['entry-1', 'entry-2', 'entry-3'],
    activeEntryId: 'entry-2',
    snapshotNumberingEnabled: true,
    onSelectAllVisible: vi.fn(),
    onClearSelection: vi.fn(),
    onDeleteSelected: vi.fn(),
    onMoveSelectedToStart: vi.fn(),
    onMoveSelectedToEnd: vi.fn(),
    onCopyActiveEntry: vi.fn(),
    onSetSnapshotNumbering: vi.fn(),
    onAddSectionBefore: vi.fn(),
    ...overrides,
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe('GuideBatchToolbar', () => {
  it('以繁體中文渲染已選數量與可存取的批次操作', () => {
    render(<GuideBatchToolbar {...createProps()} />);

    expect(screen.getByRole('region', { name: '批次操作列' })).toBeTruthy();
    expect(screen.getByText('已選 2 個')).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(button('刪除已選的項目（危險操作）').className).toContain('bg-red-700');
    expect(button('快照編號：開').getAttribute('aria-pressed')).toBe('true');
  });

  it('將每個批次操作交給 callback，並傳遞必要的目前資料', async () => {
    const props = createProps();
    render(<GuideBatchToolbar {...props} />);

    fireEvent.click(button('全選目前可見的項目'));
    await waitFor(() => expect(props.onSelectAllVisible).toHaveBeenCalledWith(['entry-1', 'entry-2', 'entry-3']));

    fireEvent.click(button('清除多重選取'));
    await waitFor(() => expect(props.onClearSelection).toHaveBeenCalledOnce());

    fireEvent.click(button('刪除已選的項目（危險操作）'));
    await waitFor(() => expect(props.onDeleteSelected).toHaveBeenCalledWith(['entry-2', 'entry-3']));

    fireEvent.click(button('將已選項目移到開頭'));
    await waitFor(() => expect(props.onMoveSelectedToStart).toHaveBeenCalledWith(['entry-2', 'entry-3']));

    fireEvent.click(button('將已選項目移到結尾'));
    await waitFor(() => expect(props.onMoveSelectedToEnd).toHaveBeenCalledWith(['entry-2', 'entry-3']));

    fireEvent.click(button('複製目前 active 項目'));
    await waitFor(() => expect(props.onCopyActiveEntry).toHaveBeenCalledWith('entry-2'));

    fireEvent.click(button('快照編號：開'));
    await waitFor(() => expect(props.onSetSnapshotNumbering).toHaveBeenCalledWith(false));

    fireEvent.click(button('在第一個選取項目前新增章節'));
    await waitFor(() => expect(props.onAddSectionBefore).toHaveBeenCalledWith('entry-2'));
  });

  it('在外部 busy 或本地 async 操作期間停用所有按鈕並避免重複送出', async () => {
    let resolveDelete: (() => void) | undefined;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const onDeleteSelected = vi.fn(() => deletePending);
    const props = createProps({ onDeleteSelected });
    const { rerender } = render(<GuideBatchToolbar {...props} />);

    const deleteButton = button('刪除已選的項目（危險操作）');
    fireEvent.click(deleteButton);
    expect(onDeleteSelected).toHaveBeenCalledOnce();
    expect(screen.getByText('正在處理批次操作，請稍候。')).toBeTruthy();
    expect(screen.getAllByRole('button').every((control) => (control as HTMLButtonElement).disabled)).toBe(true);

    fireEvent.click(deleteButton);
    expect(onDeleteSelected).toHaveBeenCalledOnce();

    resolveDelete?.();
    await waitFor(() => expect(deleteButton.disabled).toBe(false));

    rerender(<GuideBatchToolbar {...props} busy />);
    expect(screen.getAllByRole('button').every((control) => (control as HTMLButtonElement).disabled)).toBe(true);
  });

  it('沒有選取項目時不渲染', () => {
    const { container } = render(<GuideBatchToolbar {...createProps({ selectedEntryIds: [] })} />);
    expect(container.firstChild).toBeNull();
  });
});

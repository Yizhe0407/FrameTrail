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

function openMoreActions() {
  fireEvent.click(screen.getByText('更多操作'));
}

afterEach(() => {
  cleanup();
});

describe('GuideBatchToolbar', () => {
  it('以緊湊的情境列呈現已選數量，並把低頻操作收進原生 details', () => {
    render(<GuideBatchToolbar {...createProps()} />);

    expect(screen.getByRole('region', { name: '批次操作列' })).toBeTruthy();
    expect(screen.getByText('已選取 2 個步驟')).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');

    const details = screen.getByText('更多操作').closest('details');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(button('刪除已選步驟（危險操作）').closest('details')).toBeNull();
    expect(button('刪除已選步驟（危險操作）').className).toContain('text-red-700');

    openMoreActions();
    expect(details?.open).toBe(true);
    expect(button('顯示標註編號').getAttribute('aria-pressed')).toBe('true');
  });

  it('將主要與展開後的每個批次操作交給既有 callback，並傳遞目前資料', async () => {
    const props = createProps();
    render(<GuideBatchToolbar {...props} />);

    fireEvent.click(button('結束多選'));
    await waitFor(() => expect(props.onClearSelection).toHaveBeenCalledOnce());

    openMoreActions();
    fireEvent.click(button('將已選步驟移至開頭'));
    await waitFor(() => expect(props.onMoveSelectedToStart).toHaveBeenCalledWith(['entry-2', 'entry-3']));

    fireEvent.click(button('將已選步驟移至結尾'));
    await waitFor(() => expect(props.onMoveSelectedToEnd).toHaveBeenCalledWith(['entry-2', 'entry-3']));

    fireEvent.click(button('在已選步驟前新增章節'));
    await waitFor(() => expect(props.onAddSectionBefore).toHaveBeenCalledWith('entry-2'));

    fireEvent.click(button('選取左側目前顯示的所有步驟'));
    await waitFor(() => expect(props.onSelectAllVisible).toHaveBeenCalledWith(['entry-1', 'entry-2', 'entry-3']));

    fireEvent.click(button('複製目前開啟的步驟'));
    await waitFor(() => expect(props.onCopyActiveEntry).toHaveBeenCalledWith('entry-2'));

    fireEvent.click(button('顯示標註編號'));
    await waitFor(() => expect(props.onSetSnapshotNumbering).toHaveBeenCalledWith(false));

    fireEvent.click(button('刪除已選步驟（危險操作）'));
    await waitFor(() => expect(props.onDeleteSelected).toHaveBeenCalledWith(['entry-2', 'entry-3']));
  });

  it('在外部 busy 或本地 async 操作期間停用所有操作並避免重複送出', async () => {
    let resolveDelete: (() => void) | undefined;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const onDeleteSelected = vi.fn(() => deletePending);
    const props = createProps({ onDeleteSelected });
    const { rerender } = render(<GuideBatchToolbar {...props} />);

    const deleteButton = button('刪除已選步驟（危險操作）');
    fireEvent.click(deleteButton);
    expect(onDeleteSelected).toHaveBeenCalledOnce();
    expect(screen.getByText('正在處理，請稍候。')).toBeTruthy();
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

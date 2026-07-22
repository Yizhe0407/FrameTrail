// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuideSectionHeading, {
  type GuideSectionHeadingProps,
} from '@/components/GuideSectionHeading';

function createProps(overrides: Partial<GuideSectionHeadingProps> = {}): GuideSectionHeadingProps {
  return {
    section: {
      id: 'section-1',
      title: '開始使用',
      startEntryId: 'entry-1',
    },
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe('GuideSectionHeading', () => {
  it('以繁體中文顯示可存取的二級章節標題與操作', () => {
    render(<GuideSectionHeading {...createProps()} />);

    const section = screen.getByRole('region', { name: '章節：開始使用' });
    expect(section).toBeTruthy();
    expect(screen.getByRole('heading', { name: '開始使用', level: 2 })).toBeTruthy();
    expect(button('重新命名')).toBeTruthy();
    expect(button('刪除')).toBeTruthy();
  });

  it('以 Enter 儲存去除空白後、最多 200 字的章節名稱', async () => {
    const onRename = vi.fn();
    render(<GuideSectionHeading {...createProps({ onRename })} />);

    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    fireEvent.change(input, { target: { value: `  ${'新'.repeat(205)}  ` } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('section-1', '新'.repeat(200));
    });
    expect(screen.queryByRole('textbox', { name: '章節名稱' })).toBeNull();
  });

  it('以 Escape 取消重新命名且不呼叫 callback', () => {
    const onRename = vi.fn();
    render(<GuideSectionHeading {...createProps({ onRename })} />);

    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    fireEvent.change(input, { target: { value: '不應儲存' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '開始使用', level: 2 })).toBeTruthy();
  });

  it('不會在空白名稱 blur 時意外提交', () => {
    const onRename = vi.fn();
    render(<GuideSectionHeading {...createProps({ onRename })} />);

    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('章節名稱不可為空白');
  });

  it('直接將刪除交給 callback，不使用元件內確認流程', async () => {
    const onDelete = vi.fn();
    render(<GuideSectionHeading {...createProps({ onDelete })} />);

    fireEvent.click(button('刪除'));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('section-1'));
  });

  it('在外部 busy 與本地 async 操作期間停用控制項並避免重複送出', async () => {
    let resolveDelete: (() => void) | undefined;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const onDelete = vi.fn(() => deletePending);
    const { rerender } = render(<GuideSectionHeading {...createProps({ onDelete })} />);

    const deleteButton = button('刪除');
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(button('重新命名').disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);

    resolveDelete?.();
    await waitFor(() => expect(deleteButton.disabled).toBe(false));

    rerender(<GuideSectionHeading {...createProps({ busy: true })} />);
    expect(button('重新命名').disabled).toBe(true);
    expect(button('刪除').disabled).toBe(true);
  });
});

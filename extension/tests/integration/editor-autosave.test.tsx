// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateStep: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ updateStep: mocks.updateStep }));

import DescriptionField from '@/components/DescriptionField';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor-autosave';
import { readDescriptionDrafts, writeDescriptionDraft } from '@/lib/editor-draft-journal';
import type { Step } from '@/lib/db';

function makeStep(): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/jpeg' }),
    bounds: null,
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
  };
}

function FlushButton() {
  const { flushAll } = useEditorSaveRegistry();
  return <button onClick={() => void flushAll()}>匯出前儲存</button>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.updateStep.mockReset();
  mocks.updateStep.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('editor description autosave', () => {
  it('debounces writes and exposes stable dirty, saving, and saved states', async () => {
    const pending = deferred();
    mocks.updateStep.mockReturnValueOnce(pending.promise);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '新的說明' } });
    expect(screen.getByText('尚未儲存')).toBeTruthy();
    act(() => vi.advanceTimersByTime(649));
    expect(mocks.updateStep).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.updateStep).toHaveBeenCalledWith('step-1', { description: '新的說明' });
    expect(screen.getByText('正在儲存')).toBeTruthy();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.getByText('已儲存')).toBeTruthy();
  });

  it('serializes text entered during a pending write so the latest draft wins', async () => {
    const firstWrite = deferred();
    mocks.updateStep.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '第一版' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
    });
    fireEvent.change(field, { target: { value: '最後版本' } });

    await act(async () => {
      firstWrite.resolve();
      await firstWrite.promise;
      await Promise.resolve();
    });

    expect(mocks.updateStep.mock.calls).toEqual([
      ['step-1', { description: '第一版' }],
      ['step-1', { description: '最後版本' }],
    ]);
    expect(screen.getByDisplayValue('最後版本')).toBeTruthy();
    expect(screen.getByText('已儲存')).toBeTruthy();
  });

  it('flushes immediately for a parent operation before the debounce expires', async () => {
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
        <FlushButton />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '匯出內容' } });
    fireEvent.click(screen.getByRole('button', { name: '匯出前儲存' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateStep).toHaveBeenCalledTimes(1);
    expect(mocks.updateStep).toHaveBeenCalledWith('step-1', { description: '匯出內容' });
    expect(screen.getByText('已儲存')).toBeTruthy();
  });

  it('retains a failed draft and saves it when the user retries', async () => {
    const saveError = new Error('temporary write failure');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.updateStep.mockRejectedValueOnce(saveError).mockResolvedValue(undefined);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '保留這段草稿' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue('保留這段草稿')).toBeTruthy();
    expect(screen.getByText('無法儲存，草稿已保留；請重試。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateStep).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue('保留這段草稿')).toBeTruthy();
    expect(screen.getByText('已儲存')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('restores a synchronously journaled draft after an interrupted close and commits it on reopen', async () => {
    const interruptedWrite = deferred();
    mocks.updateStep.mockReturnValueOnce(interruptedWrite.promise).mockResolvedValue(undefined);
    const first = render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '關閉前最後輸入' } });
    first.unmount();

    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );
    expect(screen.getByDisplayValue('關閉前最後輸入')).toBeTruthy();
    expect(screen.getByText('尚未儲存')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateStep).toHaveBeenLastCalledWith('step-1', { description: '關閉前最後輸入' });
    expect(screen.getByText('已儲存')).toBeTruthy();
  });

  it('does not silently overwrite a newer external value when a foreign legacy draft exists', async () => {
    const firstStep = makeStep();
    localStorage.setItem(
      'frametrail:editor-description-draft:v1:session-1:step-1',
      JSON.stringify({
        version: 1,
        stepId: 'step-1',
        sessionId: 'session-1',
        baseDescription: '',
        description: '關閉前草稿',
        updatedAt: Date.now(),
      }),
    );
    render(
      <EditorSaveProvider>
        <DescriptionField step={{ ...firstStep, description: '其他分頁的新內容' }} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    expect(screen.getByDisplayValue('其他分頁的新內容')).toBeTruthy();
    expect(screen.getByText('關閉前草稿')).toBeTruthy();
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.updateStep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '載入草稿 1' }));
    expect(screen.getByDisplayValue('關閉前草稿')).toBeTruthy();
    expect(screen.getByText('已載入其他分頁的草稿；請確認內容後按重試才會覆寫已儲存內容。')).toBeTruthy();
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.updateStep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateStep).toHaveBeenCalledWith('step-1', { description: '關閉前草稿' });
  });

  it('lets the user choose among concurrent tab drafts and discard only one candidate', () => {
    const now = Date.now();
    const base = makeStep();
    writeDescriptionDraft(base, '分頁 A 草稿', 'foreign-a', localStorage, now);
    writeDescriptionDraft(base, '分頁 B 草稿', 'foreign-b', localStorage, now + 1);
    render(
      <EditorSaveProvider>
        <DescriptionField step={base} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    expect(screen.getByText('找到 2 份其他分頁或先前版本的草稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '載入草稿 2' }));
    expect(screen.getByDisplayValue('分頁 A 草稿')).toBeTruthy();
    expect(mocks.updateStep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '捨棄草稿 1' }));
    expect(screen.queryByText('分頁 B 草稿')).toBeNull();
    expect(screen.getByDisplayValue('分頁 A 草稿')).toBeTruthy();
    expect(readDescriptionDrafts(base, 'observer', localStorage, now + 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writerId: 'foreign-a', description: '分頁 A 草稿' }),
      ]),
    );
    expect(readDescriptionDrafts(base, 'observer', localStorage, now + 2)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ writerId: 'foreign-b' })]),
    );
  });

  it('clears matching copies after commit but preserves a differing alternate tab draft', async () => {
    const now = Date.now();
    const base = makeStep();
    writeDescriptionDraft(base, '要提交的版本', 'foreign-a', localStorage, now + 2);
    writeDescriptionDraft(base, '要提交的版本', 'foreign-b', localStorage, now + 1);
    writeDescriptionDraft(base, '替代版本', 'foreign-c', localStorage, now);
    render(
      <EditorSaveProvider>
        <DescriptionField step={base} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '載入草稿 1' }));
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateStep).toHaveBeenCalledWith('step-1', { description: '要提交的版本' });
    expect(screen.getAllByText('要提交的版本')).toHaveLength(1); // textarea only; matching recovery cards were cleared
    expect(screen.getByText('替代版本')).toBeTruthy();
    expect(readDescriptionDrafts({ ...base, description: '要提交的版本' }, 'observer', localStorage, now + 3)).toEqual([
      expect.objectContaining({ writerId: 'foreign-c', description: '替代版本' }),
    ]);
  });

  it('keeps a newer journal entry while an older IndexedDB write is pending', async () => {
    const firstWrite = deferred();
    mocks.updateStep.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );
    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '第一版' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
    });
    fireEvent.change(field, { target: { value: '最後版' } });

    await act(async () => {
      firstWrite.resolve();
      await firstWrite.promise;
      await Promise.resolve();
    });
    expect(localStorage.length).toBe(0);
    expect(mocks.updateStep.mock.calls.at(-1)).toEqual(['step-1', { description: '最後版' }]);
  });

  it('treats refresh failure after an IndexedDB commit as saved data', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn().mockRejectedValue(new Error('refresh failed'))} />
      </EditorSaveProvider>,
    );
    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '已寫入資料庫' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('已儲存')).toBeTruthy();
    expect(localStorage.length).toBe(0);
    warning.mockRestore();
  });

});

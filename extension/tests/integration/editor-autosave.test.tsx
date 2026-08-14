// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  saveStepDescription: vi.fn(),
}));

vi.mock('@/lib/storage/step-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/step-repository')>();
  return { ...actual, saveStepDescription: mocks.saveStepDescription };
});

import DescriptionField from '@/components/editor/DescriptionField';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { readDescriptionDrafts, writeDescriptionDraft } from '@/lib/editor/editor-draft-journal';
import { StepDescriptionConflictError, StepNotFoundError } from '@/lib/storage/step-repository';
import { type Step } from '@/lib/storage/models';

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
  mocks.saveStepDescription.mockReset();
  mocks.saveStepDescription.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('editor description autosave', () => {
  it('debounces writes while keeping save state out of the description UI', async () => {
    const pending = deferred();
    mocks.saveStepDescription.mockReturnValueOnce(pending.promise);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '新的說明' } });
    expect(screen.queryByText('尚未儲存')).toBeNull();
    act(() => vi.advanceTimersByTime(649));
    expect(mocks.saveStepDescription).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '新的說明', '');
    expect(screen.queryByText('正在儲存')).toBeNull();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('serializes text entered during a pending write so the latest draft wins', async () => {
    const firstWrite = deferred();
    mocks.saveStepDescription.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
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

    expect(mocks.saveStepDescription.mock.calls).toEqual([
      ['step-1', '第一版', ''],
      ['step-1', '最後版本', '第一版'],
    ]);
    expect(screen.getByDisplayValue('最後版本')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
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

    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(1);
    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '匯出內容', '');
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('retains a failed draft and saves it when the user retries', async () => {
    const saveError = new Error('temporary write failure');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.saveStepDescription.mockRejectedValueOnce(saveError).mockResolvedValue(undefined);
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
    expect(screen.queryByText('無法儲存，草稿已保留；請重試。')).toBeNull();

    fireEvent.blur(field);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue('保留這段草稿')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
    consoleError.mockRestore();
  });

  it('restores a synchronously journaled draft after an interrupted close and commits it on reopen', async () => {
    const interruptedWrite = deferred();
    mocks.saveStepDescription.mockReturnValueOnce(interruptedWrite.promise).mockResolvedValue(undefined);
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
    expect(screen.queryByText('尚未儲存')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.saveStepDescription).toHaveBeenLastCalledWith('step-1', '關閉前最後輸入', '');
    expect(screen.queryByText('已儲存')).toBeNull();
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
    expect(mocks.saveStepDescription).not.toHaveBeenCalled();

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
    fireEvent.click(screen.getByRole('button', { name: '確認覆寫草稿 1' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '要提交的版本', '');
    expect(screen.getAllByText('要提交的版本')).toHaveLength(1); // textarea only; matching recovery cards were cleared
    expect(screen.getByText('替代版本')).toBeTruthy();
    expect(readDescriptionDrafts({ ...base, description: '要提交的版本' }, 'observer', localStorage, now + 3)).toEqual([
      expect.objectContaining({ writerId: 'foreign-c', description: '替代版本' }),
    ]);
  });

  it('keeps a newer journal entry while an older IndexedDB write is pending', async () => {
    const firstWrite = deferred();
    mocks.saveStepDescription.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
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
    expect(mocks.saveStepDescription.mock.calls.at(-1)).toEqual(['step-1', '最後版', '第一版']);
  });

  it('keeps the journal record when the step row disappeared before the save', async () => {
    // The pre-unmount flush also logs the intentional StepNotFoundError.
    silenceIntentionalErrorLogs();
    mocks.saveStepDescription.mockRejectedValue(new StepNotFoundError('step-1'));
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '刪除後仍要保留的輸入' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '刪除後仍要保留的輸入', '');
    // A silent no-op used to report success here, clearing the journal and
    // destroying the typed text. The typed error must leave it recoverable.
    expect(readDescriptionDrafts(makeStep(), 'observer', localStorage)).toContainEqual(
      expect.objectContaining({ description: '刪除後仍要保留的輸入' }),
    );
    expect(screen.getByDisplayValue('刪除後仍要保留的輸入')).toBeTruthy();
  });

  it('rebases on a cross-tab description commit and blocks saving until confirmed', async () => {
    mocks.saveStepDescription
      .mockRejectedValueOnce(new StepDescriptionConflictError('step-1', '', '另一分頁版本'))
      .mockResolvedValue(undefined);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '本機版本' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('本機版本')).toBeTruthy();
    // The local text stays journaled against the winning tab's baseline.
    expect(readDescriptionDrafts({ ...makeStep(), description: '另一分頁版本' }, 'observer', localStorage)).toContainEqual(
      expect.objectContaining({ description: '本機版本' }),
    );

    // Last-write-wins is now blocked: further typing and blurs stay local.
    fireEvent.change(field, { target: { value: '本機版本二' } });
    fireEvent.blur(field);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(1);
  });

  it('flushes to IndexedDB immediately when the synchronous journal rejects the draft', async () => {
    // Longer than the journal accepts, so writeDescriptionDraft returns false;
    // IndexedDB is then the only durable destination and must not wait for a
    // blur or unmount.
    const oversized = 'x'.repeat(100_001);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} onChange={vi.fn()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: oversized } });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', oversized, '');
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
    expect(screen.queryByText('已儲存')).toBeNull();
    expect(localStorage.length).toBe(0);
    warning.mockRestore();
  });

});

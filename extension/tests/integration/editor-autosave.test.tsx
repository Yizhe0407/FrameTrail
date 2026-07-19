// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateStep: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ updateStep: mocks.updateStep }));

import DescriptionField from '@/components/DescriptionField';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor-autosave';
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
    expect(screen.getByText('無法儲存，請重試。')).toBeTruthy();

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
});

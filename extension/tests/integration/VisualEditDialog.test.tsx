// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VisualEditDialog from '@/components/VisualEditDialog';
import type { StepEntry } from '@/lib/db';

const entry: StepEntry = {
  kind: 'single',
  step: {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/png' }),
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    screenshotScale: 1,
    description: 'step',
    url: 'https://example.com/page',
    timestamp: 1,
  },
};

describe('VisualEditDialog', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:visual-editor');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function loadEditorImage() {
    const image = screen.getByRole('img', { name: '待編輯的步驟截圖' });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 200 },
      naturalHeight: { configurable: true, value: 100 },
    });
    act(() => fireEvent.load(image));
  }

  it('adds an opaque mask, supports precise geometry, and emits one atomic commit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<VisualEditDialog entry={entry} open onOpenChange={vi.fn()} onSave={onSave} />);
    loadEditorImage();

    fireEvent.click(screen.getByRole('button', { name: '新增遮罩' }));
    expect(document.querySelector('rect[fill="#334155"]')?.getAttribute('fill-opacity')).toBe('1');
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存修改' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const commit = onSave.mock.calls[0][0];
    expect(commit.updates).toEqual([
      { id: 'step-1', changes: { manualBounds: null } },
      {
        id: 'step-1',
        expectedCaptureRevision: 0,
        changes: {
          redactionReviewRequired: false,
          redactions: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              kind: 'solid',
              bounds: { x: 25, y: 40, width: 60, height: 12 },
            },
          ],
        },
      },
    ]);
    expect(commit.restoreUpdates).toEqual([
      { id: 'step-1', changes: { manualBounds: null } },
      {
        id: 'step-1',
        expectedCaptureRevision: 0,
        changes: { redactions: [], redactionReviewRequired: false },
      },
    ]);
  });

  it('keeps the two editing tools clear and updates the canvas guidance', () => {
    render(<VisualEditDialog entry={entry} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByRole('group', { name: '編輯工具' })).toBeTruthy();
    expect(screen.getByText('拖曳要隱藏的資訊以新增遮罩；點選現有遮罩即可移動或調整大小。')).toBeTruthy();
    expect(screen.getByText('還沒有遮罩')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '框選' }));
    expect(screen.getByText('拖曳圖片以重新設定框選範圍；點選框選後可移動或調整大小。')).toBeTruthy();
  });

  it('keeps dirty edits when the user declines the close confirmation', () => {
    const onOpenChange = vi.fn();
    render(<VisualEditDialog entry={entry} open onOpenChange={onOpenChange} onSave={vi.fn()} />);
    loadEditorImage();

    fireEvent.click(screen.getByRole('button', { name: /框選範圍/ }));
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.getByRole('dialog', { name: '捨棄未儲存的修改？' })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('12');

    const discardDialog = screen.getByRole('dialog', { name: '捨棄未儲存的修改？' });
    fireEvent.click(discardDialog.querySelector('button')!);
  });


  it('fails closed until the image and overlays are ready and exposes toggle state', () => {
    render(<VisualEditDialog entry={entry} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    const image = screen.getByRole('img', { name: '待編輯的步驟截圖' });
    const save = screen.getByRole('button', { name: '儲存修改' });
    expect(image.className).toContain('invisible');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '框選' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '遮罩' }).getAttribute('aria-pressed')).toBe('true');

    loadEditorImage();
    expect(image.className).not.toContain('invisible');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /框選範圍/ }));
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '12' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not close an unchanged editor when the save shortcut is pressed', () => {
    const onOpenChange = vi.fn();
    render(<VisualEditDialog entry={entry} open onOpenChange={onOpenChange} onSave={vi.fn()} />);
    loadEditorImage();

    fireEvent.keyDown(screen.getByRole('group', { name: /框選與遮罩畫布/ }), {
      key: 's',
      ctrlKey: true,
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
  it('requires explicit confirmation after recapture and clears the privacy review flag', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const reviewEntry: StepEntry = {
      kind: 'single',
      step: {
        ...entry.step,
        redactions: [{ id: 'existing-mask', kind: 'solid', bounds: { x: 5, y: 6, width: 7, height: 8 } }],
        redactionReviewRequired: true,
      },
    };
    render(<VisualEditDialog entry={reviewEntry} open onOpenChange={vi.fn()} onSave={onSave} />);
    loadEditorImage();

    const save = screen.getByRole('button', { name: '確認並儲存' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].updates).toContainEqual({
      id: 'step-1',
      expectedCaptureRevision: 0,
      changes: {
        redactions: [{ id: 'existing-mask', kind: 'solid', bounds: { x: 5, y: 6, width: 7, height: 8 } }],
        redactionReviewRequired: false,
      },
    });
  });

});

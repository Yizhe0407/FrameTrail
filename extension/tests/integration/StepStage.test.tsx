// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotStep, Step, StepEntry } from '@/lib/storage/db';
import type { VisualEditCommit } from '@/components/editor/VisualEditDialog';

const visualEditDialogSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/editor/HighlightThumbnail', () => ({ default: () => null }));
vi.mock('@/components/editor/MultiHighlightThumbnail', () => ({ default: () => null }));
vi.mock('@/components/editor/DescriptionField', () => ({ default: () => null }));
vi.mock('@/components/editor/AnnotationList', () => ({ default: () => null }));
vi.mock('@/components/editor/StepActions', () => ({ default: () => null }));
vi.mock('@/components/editor/VisualEditDialog', () => ({
  default: (props: { open: boolean }) => {
    visualEditDialogSpy(props);
    return props.open ? <div role="dialog" aria-label="VisualEditDialog" /> : null;
  },
}));

import StepStage from '@/components/editor/StepStage';

type VisualDialogProps = {
  open: boolean;
  onSave: (commit: VisualEditCommit) => Promise<void>;
};

interface StageOptions {
  entry?: StepEntry;
  editingDisabled?: boolean;
  onEditVisuals?: (commit: VisualEditCommit) => Promise<void>;
  onSetNumbered?: (entryId: string, next: boolean) => Promise<void>;
  onZoom?: () => void;
}

function makeStep(changes: Partial<Step> = {}): Step {
  return {
    id: 'annotation-1',
    sessionId: 'session-1',
    order: 1,
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.test',
    timestamp: 0,
    groupId: 'group-1',
    numbered: true,
    ...changes,
  };
}

function groupEntry(anchorChanges: Partial<ScreenshotStep> = {}): StepEntry {
  return {
    kind: 'group',
    anchor: {
      ...makeStep({ id: 'group-1', order: 0, bounds: null }),
      screenshotBlob: new Blob(['image']),
      ...anchorChanges,
    } as ScreenshotStep,
    annotations: [makeStep()],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stage({
  entry = groupEntry(),
  editingDisabled = false,
  onEditVisuals = vi.fn().mockResolvedValue(undefined),
  onSetNumbered = vi.fn().mockResolvedValue(undefined),
  onZoom = vi.fn(),
}: StageOptions = {}) {
  return (
    <StepStage
      entry={entry}
      index={0}
      onChange={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onDeleteAnnotation={vi.fn().mockResolvedValue(undefined)}
      onZoom={onZoom}
      onReorderAnnotations={vi.fn().mockResolvedValue(undefined)}
      onEditVisuals={onEditVisuals}
      onRecapture={vi.fn().mockResolvedValue(undefined)}
      onSetNumbered={onSetNumbered}
      editingDisabled={editingDisabled}
    />
  );
}

function renderStage(options: StageOptions = {}) {
  return render(stage(options));
}

function latestVisualDialogProps(): VisualDialogProps {
  return visualEditDialogSpy.mock.calls.at(-1)?.[0] as VisualDialogProps;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  visualEditDialogSpy.mockClear();
});

describe('StepStage numbered snapshots', () => {
  it('submits the parent atomic callback only once while the update is pending', async () => {
    const pending = deferred();
    const onSetNumbered = vi.fn().mockReturnValue(pending.promise);
    renderStage({ onSetNumbered });

    const toggle = screen.getByRole('switch', { name: '顯示編號' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(onSetNumbered).toHaveBeenCalledOnce();
    expect(onSetNumbered).toHaveBeenCalledWith('group-1', false);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('正在儲存編號設定')).toBeTruthy();

    pending.resolve();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows the existing failure message when the parent callback rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSetNumbered = vi.fn().mockRejectedValue(new Error('write failed'));
    renderStage({ onSetNumbered });

    fireEvent.click(screen.getByRole('switch', { name: '顯示編號' }));

    expect((await screen.findByRole('alert')).textContent).toContain('編號設定儲存失敗，請再試一次。');
    expect(onSetNumbered).toHaveBeenCalledOnce();
    expect((screen.getByRole('switch', { name: '顯示編號' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not submit when editing is disabled', () => {
    const onSetNumbered = vi.fn().mockResolvedValue(undefined);
    renderStage({ onSetNumbered, editingDisabled: true });

    const toggle = screen.getByRole('switch', { name: '顯示編號' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);

    expect(onSetNumbered).not.toHaveBeenCalled();
  });
});

describe('StepStage visual editing lock', () => {
  it('closes an open visual editor when editing becomes disabled', () => {
    const onEditVisuals = vi.fn().mockResolvedValue(undefined);
    const options = { onEditVisuals };
    const view = renderStage(options);

    fireEvent.click(screen.getByRole('button', { name: '調整圖片' }));
    expect(screen.getByRole('dialog', { name: 'VisualEditDialog' })).toBeTruthy();

    view.rerender(stage({ ...options, editingDisabled: true }));

    expect(screen.queryByRole('dialog', { name: 'VisualEditDialog' })).toBeNull();
    expect(latestVisualDialogProps().open).toBe(false);
  });

  it('disables the privacy-review image action while editing is disabled', () => {
    const onZoom = vi.fn();
    renderStage({
      entry: groupEntry({ redactionReviewRequired: true }),
      editingDisabled: true,
      onZoom,
    });

    const imageAction = screen.getByRole('button', { name: '確認敏感資訊遮罩' });
    expect((imageAction as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(imageAction);

    expect(screen.queryByRole('dialog', { name: 'VisualEditDialog' })).toBeNull();
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('does not call onEditVisuals when a scheduled dialog save runs after editing is disabled', async () => {
    const onEditVisuals = vi.fn().mockResolvedValue(undefined);
    const options = { onEditVisuals };
    const view = renderStage(options);

    fireEvent.click(screen.getByRole('button', { name: '調整圖片' }));
    const scheduledSave = latestVisualDialogProps().onSave;

    view.rerender(stage({ ...options, editingDisabled: true }));
    await scheduledSave({ updates: [], restoreUpdates: [] });

    expect(onEditVisuals).not.toHaveBeenCalled();
  });
});

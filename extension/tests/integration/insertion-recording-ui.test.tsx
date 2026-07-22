// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InsertionRecordingActions, { insertionTargetForEntry } from '@/components/InsertionRecordingActions';
import type { Step, StepEntry } from '@/lib/db';

function baseStep(id: string, url = `https://example.com/${id}`): Step {
  return {
    id,
    sessionId: 'guide-a',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/jpeg' }),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url,
    timestamp: 1,
  };
}

afterEach(cleanup);

describe('InsertionRecordingActions', () => {
  it('resolves ordinary and complete snapshot entries to their stable entry image owner', () => {
    const single: StepEntry = { kind: 'single', step: baseStep('single-step') as Step & { screenshotBlob: Blob } };
    const anchor = { ...baseStep('snapshot-anchor'), groupId: 'snapshot-anchor', bounds: null } as Step & {
      screenshotBlob: Blob;
    };
    const group: StepEntry = {
      kind: 'group',
      anchor,
      annotations: [{ ...baseStep('annotation'), groupId: anchor.id, screenshotBlob: undefined }],
    };

    expect(insertionTargetForEntry(single)).toEqual({ anchorEntryId: 'single-step' });
    expect(insertionTargetForEntry(group)).toEqual({ anchorEntryId: 'snapshot-anchor' });
  });

  it('starts before/after insertion with the selected mode and Traditional Chinese controls', () => {
    const onStart = vi.fn();
    render(<InsertionRecordingActions onStart={onStart} />);

    fireEvent.click(screen.getByText('在這個步驟附近新增內容'));
    fireEvent.click(screen.getByRole('button', { name: '在前方補錄' }));
    expect(onStart).toHaveBeenLastCalledWith('before', 'steps', false);

    fireEvent.change(screen.getByLabelText('補錄模式'), { target: { value: 'snapshot' } });
    expect(screen.getByLabelText('標註顯示順序編號')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('標註顯示順序編號'));
    fireEvent.click(screen.getByRole('button', { name: '在後方補錄' }));
    expect(onStart).toHaveBeenLastCalledWith('after', 'snapshot', false);
  });

  it('prevents duplicate starts while pending or disabled', () => {
    const onStart = vi.fn();
    const { rerender } = render(<InsertionRecordingActions pending onStart={onStart} />);
    fireEvent.click(screen.getByText('在這個步驟附近新增內容'));
    expect((screen.getByRole('button', { name: '在前方補錄' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<InsertionRecordingActions disabled onStart={onStart} />);
    expect((screen.getByRole('button', { name: '在後方補錄' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
  });
});

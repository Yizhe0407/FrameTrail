// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGuideStructureSnapshot: vi.fn(),
  reorderGuideEntriesAtomically: vi.fn(),
}));

vi.mock('@/lib/storage/db', () => {
  class GuideContentConflictError extends Error {
    constructor(
      public readonly guideId: string,
      public readonly expectedRevision: number,
      public readonly actualRevision: number,
    ) {
      super('Guide content changed before the operation was committed.');
      this.name = 'GuideContentConflictError';
    }
  }
  return {
    GuideContentConflictError,
    entryId: (entry: { kind: string; step?: { id: string }; anchor?: { id: string } }) =>
      (entry.kind === 'single' ? entry.step!.id : entry.anchor!.id),
    getGuideStructureSnapshot: mocks.getGuideStructureSnapshot,
    reorderGuideEntriesAtomically: mocks.reorderGuideEntriesAtomically,
    addGuideSectionAtomically: vi.fn(),
    deleteGuideAnnotationAtomically: vi.fn(),
    deleteGuideEntriesAtomically: vi.fn(),
    deleteGuideSectionAtomically: vi.fn(),
    renameGuideSectionAtomically: vi.fn(),
    reorderGuideAnnotationsAtomically: vi.fn(),
    restoreGuideAnnotationAtomically: vi.fn(),
    restoreGuideEntriesAtomically: vi.fn(),
    setGuideEntriesNumberedAtomically: vi.fn(),
  };
});

import { useGuideMutations } from '@/components/editor/use-guide-mutations';

const singleEntry = (id: string) => ({ kind: 'single', step: { id } }) as never;
const entries = [singleEntry('s1'), singleEntry('s2')];
const reordered = [entries[1], entries[0]];
const guide = { id: 'g1', contentRevision: 1, sections: [] } as never;

function renderMutations(overrides: Record<string, unknown> = {}) {
  const options = {
    sessionId: 'g1',
    guide,
    entries,
    selectedEntryId: null,
    beginDataOperation: vi.fn(() => true),
    endDataOperation: vi.fn(),
    setOptimisticEntries: vi.fn(),
    flushDescriptions: vi.fn().mockResolvedValue(undefined),
    refreshEditorData: vi.fn().mockResolvedValue(null),
    adoptGuide: vi.fn(),
    requireSelectedEntry: vi.fn(),
    setSelectedEntryId: vi.fn(),
    setZoomOpen: vi.fn(),
    setOperationError: vi.fn(),
    undoAction: null,
    offerUndo: vi.fn(),
    clearUndo: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useGuideMutations(options as never));
  return { result, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getGuideStructureSnapshot.mockResolvedValue({
    guide: { contentRevision: 1, sections: [] },
    entryIds: ['s1', 's2'],
    entries,
  });
  mocks.reorderGuideEntriesAtomically.mockResolvedValue({
    guide: { contentRevision: 2 },
    previousEntryIds: ['s1', 's2'],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runGuideMutation (via handleReorderEntries)', () => {
  it('commits, reloads, and offers undo on the happy path', async () => {
    const { result, options } = renderMutations();

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.setOptimisticEntries).toHaveBeenCalledTimes(1);
    expect(options.setOptimisticEntries).toHaveBeenCalledWith(reordered);
    expect(options.refreshEditorData).toHaveBeenCalledTimes(1);
    expect(options.offerUndo).toHaveBeenCalledTimes(1);
    expect(options.setOperationError).toHaveBeenCalledWith(null);
    expect(options.setOperationError).not.toHaveBeenCalledWith(expect.stringContaining('失敗'));
    expect(options.endDataOperation).toHaveBeenCalledTimes(1);
  });

  it('keeps the committed optimistic entries and reports only the reload when the CAS succeeded but the follow-up reload failed', async () => {
    const refreshEditorData = vi.fn().mockRejectedValue(new Error('reload boom'));
    const { result, options } = renderMutations({ refreshEditorData });

    await act(() => result.current.handleReorderEntries(reordered));

    // The mutation committed, so the optimistic list (which now matches the
    // stored order) must not be rolled back to the pre-mutation order.
    expect(options.setOptimisticEntries).toHaveBeenCalledTimes(1);
    expect(options.setOptimisticEntries).toHaveBeenCalledWith(reordered);
    // Reload-specific message — not the「操作失敗」wording of the CAS path.
    expect(options.setOperationError).toHaveBeenLastCalledWith('已儲存，但重新載入畫面失敗，請重新整理。');
    expect(options.setOperationError).not.toHaveBeenCalledWith('步驟排序失敗，已重新載入目前資料。');
    // The committed operation still offers its undo and releases the lock.
    expect(options.offerUndo).toHaveBeenCalledTimes(1);
    expect(options.endDataOperation).toHaveBeenCalledTimes(1);
  });

  it('still rolls back optimistic entries and reloads when the mutation itself failed', async () => {
    mocks.reorderGuideEntriesAtomically.mockRejectedValue(new Error('cas boom'));
    const { result, options } = renderMutations();

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.setOptimisticEntries).toHaveBeenNthCalledWith(1, reordered);
    expect(options.setOptimisticEntries).toHaveBeenNthCalledWith(2, entries);
    expect(options.setOperationError).toHaveBeenLastCalledWith('步驟排序失敗，已重新載入目前資料。');
    expect(options.refreshEditorData).toHaveBeenCalledTimes(1);
    expect(options.offerUndo).not.toHaveBeenCalled();
    expect(options.endDataOperation).toHaveBeenCalledTimes(1);
  });
});

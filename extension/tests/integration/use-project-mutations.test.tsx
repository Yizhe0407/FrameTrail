// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectStructureSnapshot: vi.fn(),
  reorderProjectEntriesAtomically: vi.fn(),
}));

vi.mock('@/lib/storage/project-structure', () => {
  class ProjectContentConflictError extends Error {
    constructor(
      public readonly projectId: string,
      public readonly expectedRevision: number,
      public readonly actualRevision: number,
    ) {
      super('Project content changed before the operation was committed.');
      this.name = 'ProjectContentConflictError';
    }
  }
  return {
    ProjectContentConflictError,
    getProjectStructureSnapshot: mocks.getProjectStructureSnapshot,
    reorderProjectEntriesAtomically: mocks.reorderProjectEntriesAtomically,
    addProjectSectionAtomically: vi.fn(),
    deleteProjectAnnotationAtomically: vi.fn(),
    deleteProjectEntriesAtomically: vi.fn(),
    deleteProjectSectionAtomically: vi.fn(),
    renameProjectSectionAtomically: vi.fn(),
    reorderProjectAnnotationsAtomically: vi.fn(),
    restoreProjectAnnotationAtomically: vi.fn(),
    restoreProjectEntriesAtomically: vi.fn(),
    setProjectEntriesNumberedAtomically: vi.fn(),
  };
});

import { useProjectMutations } from '@/components/editor/use-project-mutations';

const singleEntry = (id: string) => ({ kind: 'single', step: { id } }) as never;
const entries = [singleEntry('s1'), singleEntry('s2')];
const reordered = [entries[1], entries[0]];
const project = { id: 'g1', contentRevision: 1, sections: [] } as never;

function renderMutations(overrides: Record<string, unknown> = {}) {
  const options = {
    sessionId: 'g1',
    project,
    entries,
    selectedEntryId: null,
    beginDataOperation: vi.fn(() => true),
    endDataOperation: vi.fn(),
    setOptimisticEntries: vi.fn(),
    flushDescriptions: vi.fn().mockResolvedValue(undefined),
    refreshEditorData: vi.fn().mockResolvedValue(null),
    adoptProject: vi.fn(),
    requireSelectedEntry: vi.fn(),
    setSelectedEntryId: vi.fn(),
    setZoomOpen: vi.fn(),
    setOperationError: vi.fn(),
    undoAction: null,
    offerUndo: vi.fn(),
    takeUndo: vi.fn(() => null),
    returnUndo: vi.fn(),
    finalizeUndo: vi.fn(),
    clearUndo: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useProjectMutations(options as never));
  return { result, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getProjectStructureSnapshot.mockResolvedValue({
    project: { contentRevision: 1, sections: [] },
    entryIds: ['s1', 's2'],
    entries,
  });
  mocks.reorderProjectEntriesAtomically.mockResolvedValue({
    project: { contentRevision: 2 },
    previousEntryIds: ['s1', 's2'],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runProjectMutation (via handleReorderEntries)', () => {
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
    mocks.reorderProjectEntriesAtomically.mockRejectedValue(new Error('cas boom'));
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

describe('a pending undo when another mutation runs (single-level undo)', () => {
  const earlier = { id: 1, message: '已刪除步驟 3', projectId: 'g1', expectedRevision: 1, restore: vi.fn() };

  it('hands the earlier undo to the new one, which says it is now final', async () => {
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.offerUndo).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }), 'g1', earlier);
    expect(options.finalizeUndo).not.toHaveBeenCalled();
    expect(options.returnUndo).not.toHaveBeenCalled();
  });

  it('announces the earlier undo as final when the new mutation offers none', async () => {
    const renameProjectSectionAtomically = (await import('@/lib/storage/project-structure')).renameProjectSectionAtomically as ReturnType<typeof vi.fn>;
    renameProjectSectionAtomically.mockResolvedValue({ project: { contentRevision: 2 } });
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.renameSection('section-1', '新名稱'));

    expect(options.offerUndo).not.toHaveBeenCalled();
    expect(options.finalizeUndo).toHaveBeenCalledWith(earlier);
  });

  it('hands the earlier undo back when the new mutation failed', async () => {
    mocks.reorderProjectEntriesAtomically.mockRejectedValue(new Error('cas boom'));
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.returnUndo).toHaveBeenCalledWith(earlier);
    expect(options.finalizeUndo).not.toHaveBeenCalled();
  });
});

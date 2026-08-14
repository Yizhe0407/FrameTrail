import {
  equalIds,
  type PendingUndoAction,
  type UndoAction,
} from '@/lib/editor/editor-app-model';
import {
  addGuideSectionAtomically,
  deleteGuideAnnotationAtomically,
  deleteGuideEntriesAtomically,
  deleteGuideSectionAtomically,
  entryId,
  getGuideStructureSnapshot,
  GuideContentConflictError,
  renameGuideSectionAtomically,
  reorderGuideAnnotationsAtomically,
  reorderGuideEntriesAtomically,
  restoreGuideAnnotationAtomically,
  restoreGuideEntriesAtomically,
  setGuideEntriesNumberedAtomically,
  type Guide,
  type GuideStructureSnapshot,
  type Step,
  type StepEntry,
} from '@/lib/storage/db';

interface UseGuideMutationsOptions {
  sessionId: string | null;
  guide: Guide | null;
  /** The rendered (optimistic-first) entry list. */
  entries: StepEntry[];
  selectedEntryId: string | null;
  beginDataOperation: (label: string) => boolean;
  endDataOperation: () => void;
  setOptimisticEntries: (entries: StepEntry[] | null) => void;
  flushDescriptions: () => Promise<void>;
  refreshEditorData: () => Promise<GuideStructureSnapshot | null>;
  /** Publishes the fresh Guide a successful compare-and-swap returned. */
  adoptGuide: (guide: Guide | null) => void;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setSelectedEntryId: (id: string | null) => void;
  setZoomOpen: (open: boolean) => void;
  setOperationError: (message: string | null) => void;
  undoAction: UndoAction | null;
  offerUndo: (pending: PendingUndoAction, guideId: string) => void;
  clearUndo: () => void;
}

/**
 * The editor's structural mutations. Every one of them follows the same
 * verified sequence — take the data lock, flush pending descriptions, read a
 * fresh canonical snapshot, compare-and-swap against that snapshot's revision,
 * reload, then offer an undo — with optimistic entry swaps rolled back before
 * the reload whenever the round-trip fails.
 */
export function useGuideMutations({
  sessionId,
  guide,
  entries,
  selectedEntryId,
  beginDataOperation,
  endDataOperation,
  setOptimisticEntries,
  flushDescriptions,
  refreshEditorData,
  adoptGuide,
  requireSelectedEntry,
  setSelectedEntryId,
  setZoomOpen,
  setOperationError,
  undoAction,
  offerUndo,
  clearUndo,
}: UseGuideMutationsOptions) {
  function showStructureMutationError(operation: string, mutationError: unknown): void {
    console.error(`${operation}失敗`, mutationError);
    setOperationError(
      mutationError instanceof GuideContentConflictError
        ? '內容已在其他操作中變更。為避免覆蓋較新的資料，這次操作未套用，畫面已重新載入。'
        : `${operation}失敗，已重新載入目前資料。`,
    );
  }

  /**
   * Every structural edit shares one shape: take the data lock, flush pending
   * descriptions, read a fresh canonical snapshot, apply a compare-and-swap
   * against that snapshot's revision, reload, then offer an undo. Only the
   * middle step differs, so `mutate` is the whole per-operation payload and the
   * lock/flush/reload/error contract lives here once.
   *
   * `optimistic` swaps the rendered entry list before the round-trip and puts
   * the previous list back if anything fails. `rethrow` is for callers whose
   * child component renders its own inline failure state.
   */
  async function runGuideMutation({
    label,
    errorLabel,
    optimistic,
    rethrow = false,
    mutate,
  }: {
    label: string;
    errorLabel: string;
    optimistic?: { next: StepEntry[]; previous: StepEntry[] };
    rethrow?: boolean;
    mutate: (snapshot: GuideStructureSnapshot, guideId: string) => Promise<PendingUndoAction | void>;
  }): Promise<void> {
    if (!sessionId || !beginDataOperation(label)) return;
    clearUndo();
    setOperationError(null);
    if (optimistic) setOptimisticEntries(optimistic.next);
    try {
      let undo: PendingUndoAction | void;
      try {
        await flushDescriptions();
        const snapshot = await getGuideStructureSnapshot(sessionId);
        undo = await mutate(snapshot, sessionId);
      } catch (mutationError) {
        if (optimistic) setOptimisticEntries(optimistic.previous);
        showStructureMutationError(errorLabel, mutationError);
        try {
          await refreshEditorData();
        } catch (refreshError) {
          console.error(`${errorLabel}失敗後重新載入資料失敗`, refreshError);
        } finally {
          if (!optimistic) setOptimisticEntries(null);
        }
        if (rethrow) throw mutationError;
        return;
      }
      // The compare-and-swap committed, so a failed follow-up reload must not
      // roll back the (now accurate) optimistic entries or report the
      // operation itself as failed — only that the screen may be stale.
      try {
        await refreshEditorData();
      } catch (reloadError) {
        console.error(`${errorLabel}成功後重新載入資料失敗`, reloadError);
        setOperationError('已儲存，但重新載入畫面失敗，請重新整理。');
      }
      if (undo) offerUndo(undo, sessionId);
    } finally {
      endDataOperation();
    }
  }

  async function handleReorderEntries(newEntries: StepEntry[]) {
    if (!guide) return;
    const previousEntries = entries;
    const expectedRevision = guide.contentRevision;
    await runGuideMutation({
      label: '正在儲存步驟順序…',
      errorLabel: '步驟排序',
      optimistic: { next: newEntries, previous: previousEntries },
      mutate: async (snapshot, guideId) => {
        if (!equalIds(snapshot.entryIds, previousEntries.map(entryId))) {
          throw new GuideContentConflictError(guideId, expectedRevision, snapshot.guide.contentRevision);
        }
        const result = await reorderGuideEntriesAtomically(
          guideId,
          newEntries.map(entryId),
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        return {
          message: '已更新步驟順序',
          expectedRevision: result.guide.contentRevision,
          restore: () => reorderGuideEntriesAtomically(
            guideId,
            result.previousEntryIds,
            result.guide.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    requireSelectedEntry(anchorId);
    const previousEntries = entries;
    const previousGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
    );
    if (!previousGroup) throw new Error('找不到要排序的快照。');
    const nextEntries = previousEntries.map((entry) => (
      entry.kind === 'group' && entry.anchor.id === anchorId ? { ...entry, annotations: reordered } : entry
    ));
    await runGuideMutation({
      label: '正在儲存標註順序…',
      errorLabel: '標註排序',
      optimistic: { next: nextEntries, previous: previousEntries },
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const freshGroup = snapshot.entries.find(
          (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
        );
        if (!freshGroup || !equalIds(
          freshGroup.annotations.map((annotation) => annotation.id),
          previousGroup.annotations.map((annotation) => annotation.id),
        )) {
          throw new GuideContentConflictError(
            guideId,
            guide?.contentRevision ?? snapshot.guide.contentRevision,
            snapshot.guide.contentRevision,
          );
        }
        const result = await reorderGuideAnnotationsAtomically(
          guideId,
          anchorId,
          reordered.map((annotation) => annotation.id),
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        return {
          message: '已更新標註順序',
          expectedRevision: result.guide.contentRevision,
          restoreSelectionId: anchorId,
          restore: () => reorderGuideAnnotationsAtomically(
            guideId,
            anchorId,
            result.previousAnnotationIds,
            result.guide.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function deleteEntry() {
    const currentEntryId = entryId(requireSelectedEntry());
    await runGuideMutation({
      label: '正在刪除步驟…',
      errorLabel: '步驟刪除',
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const deletingEntry = snapshot.entries.find((entry) => entryId(entry) === currentEntryId);
        if (!deletingEntry) throw new Error('步驟內容已變更，無法安全刪除。');
        const deletingIndex = snapshot.entryIds.indexOf(currentEntryId);
        const result = await deleteGuideEntriesAtomically(
          guideId,
          [currentEntryId],
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        const nextIndex = Math.min(Math.max(deletingIndex, 0), result.entryIds.length - 1);
        setSelectedEntryId(nextIndex >= 0 ? result.entryIds[nextIndex] : null);
        setZoomOpen(false);
        const deletedSteps = deletingEntry.kind === 'single'
          ? [deletingEntry.step]
          : [deletingEntry.anchor, ...deletingEntry.annotations];
        return {
          message: `已刪除步驟 ${deletingIndex + 1}`,
          expectedRevision: result.guide.contentRevision,
          restoreSelectionId: currentEntryId,
          restore: () => restoreGuideEntriesAtomically(
            guideId,
            deletedSteps,
            snapshot.entryIds,
            snapshot.guide.sections,
            result.guide.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleDeleteAnnotation(step: Step) {
    const currentEntry = requireSelectedEntry(step.groupId);
    if (currentEntry.kind !== 'group') throw new Error('只有快照標註可以個別刪除。');
    const groupId = step.groupId;
    if (!groupId) return;
    const previousEntries = entries;
    const deletingGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === groupId,
    );
    const annotationIndex = deletingGroup?.annotations.findIndex((annotation) => annotation.id === step.id) ?? -1;
    const nextEntries = previousEntries.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== groupId) return [entry];
      if (entry.annotations.length === 1) return [];
      return [{ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== step.id) }];
    });
    await runGuideMutation({
      label: '正在刪除標註…',
      errorLabel: '標註刪除',
      optimistic: { next: nextEntries, previous: previousEntries },
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const result = await deleteGuideAnnotationAtomically(
          guideId,
          groupId,
          step.id,
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        if (result.removedEntry) {
          const previousIndex = result.previousEntryIds.indexOf(groupId);
          const nextIndex = Math.min(Math.max(previousIndex, 0), result.entryIds.length - 1);
          setSelectedEntryId(nextIndex >= 0 ? result.entryIds[nextIndex] : null);
          setZoomOpen(false);
        }
        const deletedAnnotation = result.deletedSteps.find((deleted) => deleted.id === step.id);
        if (!deletedAnnotation) throw new Error('刪除標註後缺少可還原資料。');
        const restoredIndex = result.previousAnnotationIds.indexOf(step.id);
        return {
          message: `已刪除標註 ${(restoredIndex >= 0 ? restoredIndex : annotationIndex) + 1}`,
          expectedRevision: result.guide.contentRevision,
          restoreSelectionId: groupId,
          restore: result.removedEntry
            ? () => restoreGuideEntriesAtomically(
                guideId,
                result.deletedSteps,
                result.previousEntryIds,
                result.previousSections,
                result.guide.contentRevision,
              ).then(() => undefined)
            : () => restoreGuideAnnotationAtomically(
                guideId,
                groupId,
                deletedAnnotation,
                result.previousAnnotationIds,
                result.guide.contentRevision,
              ).then(() => undefined),
        };
      },
    });
  }

  async function setEntriesNumbered(entryIdsToUpdate: readonly string[], numbered: boolean) {
    if (entryIdsToUpdate.length === 0) return;
    await runGuideMutation({
      label: '正在儲存快照編號設定…',
      errorLabel: '快照編號設定',
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const selectedIds = new Set(entryIdsToUpdate);
        const previousValues = new Set(
          snapshot.entries
            .filter((entry): entry is Extract<StepEntry, { kind: 'group' }> => (
              entry.kind === 'group' && selectedIds.has(entry.anchor.id)
            ))
            .map((entry) => entry.anchor.numbered ?? false),
        );
        const result = await setGuideEntriesNumberedAtomically(
          guideId,
          entryIdsToUpdate,
          numbered,
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        // A mixed selection has no single value to restore, and a no-op change
        // has nothing to undo.
        const previousValue = previousValues.size === 1 ? [...previousValues][0] : undefined;
        if (result.affectedEntryIds.length === 0 || previousValue === undefined || previousValue === numbered) return;
        return {
          message: `已${numbered ? '開啟' : '關閉'}快照編號`,
          expectedRevision: result.guide.contentRevision,
          restoreSelectionId: selectedEntryId ?? undefined,
          restore: () => setGuideEntriesNumberedAtomically(
            guideId,
            result.affectedEntryIds,
            previousValue,
            result.guide.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function renameSection(sectionId: string, title: string) {
    await runGuideMutation({
      label: '正在重新命名章節…',
      errorLabel: '章節重新命名',
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const result = await renameGuideSectionAtomically(
          guideId,
          sectionId,
          title,
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
      },
    });
  }

  async function deleteSection(sectionId: string) {
    await runGuideMutation({
      label: '正在刪除章節…',
      errorLabel: '刪除章節',
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const deletedSection = snapshot.guide.sections.find((section) => section.id === sectionId);
        const result = await deleteGuideSectionAtomically(
          guideId,
          sectionId,
          snapshot.guide.contentRevision,
        );
        adoptGuide(result.guide);
        if (!deletedSection) return;
        // A section's display position derives from its start entry, so
        // re-creating it with the same start entry and title puts it back
        // exactly where it was.
        return {
          message: `已刪除章節「${deletedSection.title}」`,
          expectedRevision: result.guide.contentRevision,
          restore: () => addGuideSectionAtomically(
            guideId,
            deletedSection.startEntryId,
            deletedSection.title,
            result.guide.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleUndo() {
    if (!undoAction || !beginDataOperation('正在還原…')) return;
    setOperationError(null);
    try {
      const snapshot = await getGuideStructureSnapshot(undoAction.guideId);
      if (snapshot.guide.contentRevision !== undoAction.expectedRevision) {
        throw new GuideContentConflictError(
          undoAction.guideId,
          undoAction.expectedRevision,
          snapshot.guide.contentRevision,
        );
      }
      await undoAction.restore();
      await refreshEditorData();
      if (undoAction.restoreSelectionId) {
        setSelectedEntryId(undoAction.restoreSelectionId);
      }
      clearUndo();
    } catch (undoError) {
      console.error('還原編輯操作失敗', undoError);
      clearUndo();
      setOperationError(
        undoError instanceof GuideContentConflictError
          ? '內容已在其他操作中變更，因此無法安全還原舊版本。'
          : '無法還原，請再試一次。',
      );
      await refreshEditorData().catch((refreshError) => console.error('還原失敗後重新載入資料失敗', refreshError));
    } finally {
      endDataOperation();
    }
  }

  return {
    handleReorderEntries,
    handleReorderAnnotations,
    deleteEntry,
    handleDeleteAnnotation,
    setEntriesNumbered,
    renameSection,
    deleteSection,
    handleUndo,
  };
}

import {
  equalIds,
  type PendingUndoAction,
  type UndoAction,
} from '@/lib/editor/editor-app-model';
import { addGuideSectionAtomically, deleteGuideAnnotationAtomically, deleteGuideEntriesAtomically, deleteGuideSectionAtomically, getGuideStructureSnapshot, GuideContentConflictError, renameGuideSectionAtomically, reorderGuideAnnotationsAtomically, reorderGuideEntriesAtomically, restoreGuideAnnotationAtomically, restoreGuideEntriesAtomically, setGuideEntriesNumberedAtomically, type GuideStructureSnapshot } from '@/lib/storage/guide-structure';
import { entryId, type Guide, type Step, type StepEntry } from '@/lib/storage/models';
import { t, type Messages } from '@/lib/shared/i18n';

/** A structural edit with its own progress/failure copy in the i18n catalog. */
type GuideMutationOperation = Exclude<keyof Messages['editor']['mutations'], 'conflict' | 'reloadFailed'>;

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
 * The editor's structural mutations: each takes the data lock, flushes pending descriptions, reads a
 * fresh snapshot, compare-and-swaps against its revision, reloads, then offers an undo — rolling back
 * any optimistic entry swap first if the round-trip fails.
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
  function showStructureMutationError(operation: GuideMutationOperation, mutationError: unknown): void {
    console.error(`[frametrail] guide mutation failed: ${operation}`, mutationError);
    setOperationError(
      mutationError instanceof GuideContentConflictError
        ? t().editor.mutations.conflict
        : t().editor.mutations[operation].failed,
    );
  }

  /**
   * Shared lock/flush/reload/error contract for every structural edit; only `mutate` (the compare-and-swap
   * step) differs per operation. `optimistic` swaps the rendered entry list before the round-trip and
   * restores it on failure. `rethrow` is for callers whose child component renders its own inline failure state.
   */
  async function runGuideMutation({
    operation,
    optimistic,
    rethrow = false,
    mutate,
  }: {
    /** Names the operation's progress and failure copy in the i18n catalog. */
    operation: GuideMutationOperation;
    optimistic?: { next: StepEntry[]; previous: StepEntry[] };
    rethrow?: boolean;
    mutate: (snapshot: GuideStructureSnapshot, guideId: string) => Promise<PendingUndoAction | void>;
  }): Promise<void> {
    if (!sessionId || !beginDataOperation(t().editor.mutations[operation].pending)) return;
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
        showStructureMutationError(operation, mutationError);
        try {
          await refreshEditorData();
        } catch (refreshError) {
          console.error(`[frametrail] reload after failed ${operation} failed`, refreshError);
        } finally {
          if (!optimistic) setOptimisticEntries(null);
        }
        if (rethrow) throw mutationError;
        return;
      }
      // The compare-and-swap committed, so a failed reload must not roll back the now-accurate
      // optimistic entries or report the operation itself as failed — only that the screen may be stale.
      try {
        await refreshEditorData();
      } catch (reloadError) {
        console.error(`[frametrail] reload after ${operation} failed`, reloadError);
        setOperationError(t().editor.mutations.reloadFailed);
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
      operation: 'reorderSteps',
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
          message: t().editor.mutations.reorderSteps.done,
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
    if (!previousGroup) throw new Error(t().editor.mutations.reorderAnnotations.groupMissing);
    const nextEntries = previousEntries.map((entry) => (
      entry.kind === 'group' && entry.anchor.id === anchorId ? { ...entry, annotations: reordered } : entry
    ));
    await runGuideMutation({
      operation: 'reorderAnnotations',
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
          message: t().editor.mutations.reorderAnnotations.done,
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
      operation: 'deleteStep',
      rethrow: true,
      mutate: async (snapshot, guideId) => {
        const deletingEntry = snapshot.entries.find((entry) => entryId(entry) === currentEntryId);
        if (!deletingEntry) throw new Error(t().editor.mutations.deleteStep.changed);
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
          message: t().editor.mutations.deleteStep.done(deletingIndex + 1),
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
    if (currentEntry.kind !== 'group') throw new Error(t().editor.mutations.deleteAnnotation.notSnapshot);
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
      operation: 'deleteAnnotation',
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
        if (!deletedAnnotation) throw new Error(t().editor.mutations.deleteAnnotation.restoreDataMissing);
        const restoredIndex = result.previousAnnotationIds.indexOf(step.id);
        return {
          message: t().editor.mutations.deleteAnnotation.done((restoredIndex >= 0 ? restoredIndex : annotationIndex) + 1),
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
      operation: 'numbering',
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
        // A mixed selection has no single value to restore, and a no-op change has nothing to undo.
        const previousValue = previousValues.size === 1 ? [...previousValues][0] : undefined;
        if (result.affectedEntryIds.length === 0 || previousValue === undefined || previousValue === numbered) return;
        return {
          message: t().editor.mutations.numbering.done(numbered),
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
      operation: 'renameSection',
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
      operation: 'deleteSection',
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
        // A section's display position derives from its start entry, so re-creating it with the
        // same start entry and title puts it back exactly where it was.
        return {
          message: t().editor.mutations.deleteSection.done(deletedSection.title),
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
    if (!undoAction || !beginDataOperation(t().editor.undo.inProgress)) return;
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
      console.error('[frametrail] failed to undo editor operation', undoError);
      clearUndo();
      setOperationError(
        undoError instanceof GuideContentConflictError
          ? t().editor.undo.conflict
          : t().editor.undo.failed,
      );
      await refreshEditorData().catch((refreshError) => console.error('[frametrail] reload after failed undo failed', refreshError));
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

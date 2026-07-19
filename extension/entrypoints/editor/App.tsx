import { useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import {
  buildStepEntries,
  deleteStepsAndReorder,
  entryId,
  flattenEntries,
  reorderSteps,
  type Step,
  type StepEntry,
} from '@/lib/db';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/EditorHeader';
import StepRail from '@/components/StepRail';
import StepStage from '@/components/StepStage';
import EmptyState from '@/components/EmptyState';
import Lightbox from '@/components/Lightbox';
import ConfirmationDialog from '@/components/ConfirmationDialog';

function App() {
  const { sessionId, isRecording, steps, error, refresh } = useRecordingSession();
  const dbEntries = useMemo(() => buildStepEntries(steps), [steps]);

  // Optimistic entries state: when a drag reorder happens we update this
  // immediately so the UI reflects the new order without waiting for the DB
  // round-trip.  It resets to null whenever the canonical DB entries change
  // (new steps arrive, deletion completes, etc.) so we always converge to
  // the source of truth.
  const [optimisticEntries, setOptimisticEntries] = useState<StepEntry[] | null>(null);
  const [dataOperation, setDataOperation] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  useEffect(() => {
    if (!dataOperation) setOptimisticEntries(null);
  }, [dbEntries, dataOperation]);
  const entries = optimisticEntries ?? dbEntries;

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [entryPendingDelete, setEntryPendingDelete] = useState<StepEntry | null>(null);

  // Keep the selection valid as entries come and go (new steps while
  // recording, deletions, reorders) — default to the first entry and fall
  // back to it whenever the previously-selected one disappears.
  useEffect(() => {
    setSelectedEntryId((current) => {
      if (entries.length === 0) return null;
      return entries.some((entry) => entryId(entry) === current) ? current : entryId(entries[0]);
    });
  }, [entries]);

  const selectedIndex = entries.findIndex((e) => entryId(e) === selectedEntryId);
  const selectedEntry: StepEntry | undefined = selectedIndex === -1 ? undefined : entries[selectedIndex];

  async function persistReorder(newEntries: StepEntry[], previousEntries: StepEntry[], operation: string) {
    if (!sessionId || dataOperation || isRecording) return;
    setOptimisticEntries(newEntries);
    setDataOperation(operation);
    setOperationError(null);
    try {
      await reorderSteps(sessionId, flattenEntries(newEntries));
      await refresh();
    } catch (err) {
      console.error('儲存步驟順序失敗', err);
      setOptimisticEntries(previousEntries);
      setOperationError('排序儲存失敗，已回復原本順序。請再試一次。');
      try {
        await refresh();
      } catch (refreshError) {
        console.error('排序失敗後重新讀取步驟失敗', refreshError);
      }
    } finally {
      setDataOperation(null);
    }
  }

  async function handleReorderEntries(newEntries: StepEntry[]) {
    await persistReorder(newEntries, entries, '正在儲存步驟順序…');
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    const previousEntries = entries;
    const newEntries = previousEntries.map((e) =>
      e.kind === 'group' && e.anchor.id === anchorId ? { ...e, annotations: reordered } : e,
    );
    await persistReorder(newEntries, previousEntries, '正在儲存標注順序…');
  }

  function requestDeleteEntry() {
    if (!selectedEntry || dataOperation || isRecording) return;
    setEntryPendingDelete(selectedEntry);
  }

  async function confirmDeleteEntry() {
    if (!entryPendingDelete || dataOperation || isRecording) return;
    const deletingEntry = entryPendingDelete;
    const deletingId = entryId(deletingEntry);
    const previousEntries = entries;
    const deletingIndex = previousEntries.findIndex((entry) => entryId(entry) === deletingId);
    const remaining = previousEntries.filter((e) => entryId(e) !== deletingId);

    setOptimisticEntries(remaining);
    setDataOperation('正在刪除步驟…');
    setOperationError(null);
    try {
      if (!sessionId) throw new Error('Cannot delete a step without an active session.');
      const deletedIds =
        deletingEntry.kind === 'single'
          ? [deletingEntry.step.id]
          : [deletingEntry.anchor.id, ...deletingEntry.annotations.map((step) => step.id)];
      await deleteStepsAndReorder(sessionId, deletedIds, flattenEntries(remaining));
      const nextIndex = Math.min(Math.max(deletingIndex, 0), remaining.length - 1);
      setSelectedEntryId(nextIndex >= 0 ? entryId(remaining[nextIndex]) : null);
      setZoomOpen(false);
      setEntryPendingDelete(null);
      await refresh();
    } catch (err) {
      console.error('刪除步驟失敗', err);
      setOperationError('步驟刪除失敗，已重新載入目前資料。');
      try {
        await refresh();
      } finally {
        setOptimisticEntries(null);
      }
      throw err;
    } finally {
      setDataOperation(null);
    }
  }

  async function handleDeleteAnnotation(step: Step) {
    if (dataOperation || isRecording) return;
    const previousEntries = entries;
    const deletingGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> =>
        entry.kind === 'group' && entry.anchor.id === step.groupId,
    );
    const removesEmptyGroup = deletingGroup?.annotations.length === 1;
    const nextEntries = previousEntries.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== step.groupId) return [entry];
      if (removesEmptyGroup) return [];
      return [{ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== step.id) }];
    });

    setOptimisticEntries(nextEntries);
    setDataOperation('正在刪除標注…');
    setOperationError(null);
    try {
      if (!sessionId) throw new Error('Cannot delete an annotation without an active session.');
      await deleteStepsAndReorder(
        sessionId,
        removesEmptyGroup ? [step.id, deletingGroup!.anchor.id] : [step.id],
        flattenEntries(nextEntries),
      );
      await refresh();
    } catch (err) {
      console.error('刪除標注失敗', err);
      setOperationError('標注刪除失敗，已重新載入目前資料。');
      try {
        await refresh();
      } finally {
        setOptimisticEntries(null);
      }
      throw err;
    } finally {
      setDataOperation(null);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <EditorHeader isRecording={isRecording} steps={steps} />
      {(error || operationError) && (
        <div className="border-b border-stone-200 bg-stone-50 px-7 py-3 dark:border-stone-700 dark:bg-stone-900">
          <Alert variant={error || operationError ? 'destructive' : 'default'}>
            <AlertCircle />
            <AlertDescription>{error ?? operationError}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {entries.length === 0 || !selectedEntry ? (
          <EmptyState />
        ) : (
          <>
            <StepRail
              entries={entries}
              selectedEntryId={selectedEntryId}
              onSelect={setSelectedEntryId}
              onReorder={handleReorderEntries}
              reorderDisabled={isRecording || dataOperation !== null}
            />
            <StepStage
              key={entryId(selectedEntry)}
              entry={selectedEntry}
              index={selectedIndex}
              onChange={refresh}
              onDelete={async () => requestDeleteEntry()}
              onDeleteAnnotation={handleDeleteAnnotation}
              onZoom={() => setZoomOpen(true)}
              onReorderAnnotations={(reordered) => handleReorderAnnotations(entryId(selectedEntry), reordered)}
              editingDisabled={isRecording || dataOperation !== null}
            />
          </>
        )}
      </div>
      <Lightbox
        entries={entries}
        index={zoomOpen ? selectedIndex : null}
        onClose={() => setZoomOpen(false)}
        onNavigate={(i) => setSelectedEntryId(entryId(entries[i]))}
      />
      <ConfirmationDialog
        open={entryPendingDelete !== null}
        title="刪除步驟？"
        description="圖片、說明與所有標注將永久刪除，且無法復原。"
        confirmLabel="刪除步驟"
        pending={dataOperation === '正在刪除步驟…'}
        onOpenChange={(open) => !open && setEntryPendingDelete(null)}
        onConfirm={confirmDeleteEntry}
      />
    </div>
  );
}

export default App;

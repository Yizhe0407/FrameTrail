import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, ExternalLink, X } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import {
  buildStepEntries,
  deleteStepsAndReorder,
  entryId,
  flattenEntries,
  getSteps,
  reorderSteps,
  restoreStepsAndReorder,
  StepUpdateConflictError,
  updateStepsAtomically,
  type Step,
  type StepEntry,
} from '@/lib/db';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor-autosave';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/EditorHeader';
import StepRail from '@/components/StepRail';
import StepStage from '@/components/StepStage';
import EmptyState from '@/components/EmptyState';
import Lightbox from '@/components/Lightbox';
import UndoSnackbar from '@/components/UndoSnackbar';
import type { VisualEditCommit } from '@/components/VisualEditDialog';
import { Button } from '@/components/ui/button';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
  StartStepRecaptureResult,
  StepRecaptureTarget,
} from '@/lib/messages';

interface UndoAction {
  id: number;
  message: string;
  restoreSelectionId?: string;
  restore: () => Promise<void>;
}

function EditorApp() {
  const { sessionId, tabId, steps, error, refresh, recording } = useRecordingSession();
  const operationActive = recording.operation !== null;
  const ordinaryRecordingActive = recording.operation === 'recording';
  const { flushAll } = useEditorSaveRegistry();
  const dbEntries = useMemo(() => buildStepEntries(steps), [steps]);

  // Optimistic entries state: when a drag reorder happens we update this
  // immediately so the UI reflects the new order without waiting for the DB
  // round-trip.  It resets to null whenever the canonical DB entries change
  // (new steps arrive, deletion completes, etc.) so we always converge to
  // the source of truth.
  const [optimisticEntries, setOptimisticEntries] = useState<StepEntry[] | null>(null);
  const [dataOperation, setDataOperation] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const undoSequence = useRef(0);
  const handledRecaptureResult = useRef<string | null>(null);
  useEffect(() => {
    if (!dataOperation) setOptimisticEntries(null);
  }, [dbEntries, dataOperation]);
  const entries = optimisticEntries ?? dbEntries;

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const requestedEntryId = useMemo(() => new URLSearchParams(window.location.search).get('entryId'), []);
  const appliedRequestedEntry = useRef(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    if (operationActive) setUndoAction(null);
  }, [operationActive]);

  useEffect(() => {
    const result = recording.recaptureResult;
    if (!result || handledRecaptureResult.current === result.runId) return;
    handledRecaptureResult.current = result.runId;
    void (async () => {
      try {
        await refresh();
        setSelectedEntryId(result.entryId);
        setZoomOpen(false);
        setOperationError(result.status === 'failed' ? result.message ?? '補拍失敗，原本內容未變更。' : null);
        setOperationNotice(
          result.status === 'replaced'
            ? '補拍完成；原步驟的說明與順序已保留。若原圖有遮罩，已保留為待確認狀態；確認前會封鎖預覽、複製與匯出。'
            : result.status === 'cancelled'
              ? '已取消補拍，原本內容未變更。'
              : null,
        );
      } finally {
        await browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId: result.runId }).catch((ackError) => {
          console.warn('確認補拍結果失敗', ackError);
        });
      }
    })();
  }, [recording.recaptureResult, refresh]);

  // Keep the selection valid as entries come and go (new steps while
  // recording, deletions, reorders) — default to the first entry and fall
  // back to it whenever the previously-selected one disappears.
  useEffect(() => {
    setSelectedEntryId((current) => {
      if (entries.length === 0) return null;
      return entries.some((entry) => entryId(entry) === current) ? current : entryId(entries[0]);
    });
  }, [entries]);

  useEffect(() => {
    if (appliedRequestedEntry.current || !requestedEntryId) return;
    if (!entries.some((entry) => entryId(entry) === requestedEntryId)) return;
    appliedRequestedEntry.current = true;
    setSelectedEntryId(requestedEntryId);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#frametrail-editor-title')?.focus());
  }, [entries, requestedEntryId]);

  const selectedIndex = entries.findIndex((e) => entryId(e) === selectedEntryId);
  const selectedEntry: StepEntry | undefined = selectedIndex === -1 ? undefined : entries[selectedIndex];

  async function flushDescriptions(): Promise<void> {
    try {
      await flushAll();
    } catch (saveError) {
      console.error('完成編輯器操作前儲存說明失敗', saveError);
      setOperationError('尚有說明無法儲存。請重試後再繼續。');
      throw saveError;
    }
  }

  async function selectEntry(id: string) {
    if (id === selectedEntryId || dataOperation) return;
    try {
      await flushDescriptions();
      setOperationError(null);
      setSelectedEntryId(id);
    } catch {
      // Keep the current field mounted so its unsaved draft remains available.
    }
  }

  async function stepsForExport(): Promise<Step[]> {
    await flushDescriptions();
    return sessionId ? getSteps(sessionId) : steps;
  }

  async function persistReorder(newEntries: StepEntry[], previousEntries: StepEntry[], operation: string) {
    if (!sessionId || dataOperation || operationActive) return;
    await flushDescriptions();
    setUndoAction(null);
    setOptimisticEntries(newEntries);
    setDataOperation(operation);
    setOperationError(null);
    try {
      await reorderSteps(sessionId, flattenEntries(newEntries));
      await refresh();
      setUndoAction({
        id: ++undoSequence.current,
        message: operation.includes('標注') ? '已更新標註順序' : '已更新步驟順序',
        restore: () => reorderSteps(sessionId, flattenEntries(previousEntries)),
      });
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
    try {
      await persistReorder(newEntries, entries, '正在儲存步驟順序…');
    } catch {
      // flushDescriptions already exposes the actionable save error.
    }
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    const previousEntries = entries;
    const newEntries = previousEntries.map((e) =>
      e.kind === 'group' && e.anchor.id === anchorId ? { ...e, annotations: reordered } : e,
    );
    try {
      await persistReorder(newEntries, previousEntries, '正在儲存標注順序…');
    } catch {
      // flushDescriptions already exposes the actionable save error.
    }
  }

  async function deleteEntry() {
    if (!selectedEntry || dataOperation || operationActive) return;
    await flushDescriptions();
    const deletingEntry = selectedEntry;
    const deletingId = entryId(deletingEntry);
    const previousEntries = entries;
    const deletingIndex = previousEntries.findIndex((entry) => entryId(entry) === deletingId);
    const remaining = previousEntries.filter((e) => entryId(e) !== deletingId);

    setUndoAction(null);
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
      await refresh();
      const deletedSteps =
        deletingEntry.kind === 'single'
          ? [deletingEntry.step]
          : [deletingEntry.anchor, ...deletingEntry.annotations];
      setUndoAction({
        id: ++undoSequence.current,
        message: `已刪除步驟 ${deletingIndex + 1}`,
        restoreSelectionId: deletingId,
        restore: () => restoreStepsAndReorder(sessionId, deletedSteps, flattenEntries(previousEntries)),
      });
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
    if (dataOperation || operationActive) return;
    await flushDescriptions();
    const previousEntries = entries;
    const deletingGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> =>
        entry.kind === 'group' && entry.anchor.id === step.groupId,
    );
    const removesEmptyGroup = deletingGroup?.annotations.length === 1;
    const annotationIndex = deletingGroup?.annotations.findIndex((annotation) => annotation.id === step.id) ?? -1;
    const nextEntries = previousEntries.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== step.groupId) return [entry];
      if (removesEmptyGroup) return [];
      return [{ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== step.id) }];
    });

    setUndoAction(null);
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
      const deletedSteps = removesEmptyGroup ? [deletingGroup!.anchor, step] : [step];
      setUndoAction({
        id: ++undoSequence.current,
        message: `已刪除標註 ${annotationIndex + 1}`,
        restoreSelectionId: deletingGroup?.anchor.id,
        restore: () => restoreStepsAndReorder(sessionId, deletedSteps, flattenEntries(previousEntries)),
      });
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

  async function ensureRecapturePermission(sourceUrl: string): Promise<void> {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('此來源頁面無法補拍；目前僅支援一般 HTTP/HTTPS 網頁。');
    }
    // Invoke request directly from the button activation. Awaiting autosave or
    // permissions.contains first can consume the transient user gesture that
    // Chrome requires for an optional-permission prompt.
    const granted = await browser.permissions.request({ origins: [`${parsed.origin}/*`] });
    if (!granted) throw new Error('需要允許存取來源網站，才能回到該頁面補拍。');
  }

  async function handleRecapture() {
    if (!selectedEntry || !sessionId || dataOperation || operationActive) return;
    const imageOwner = selectedEntry.kind === 'single' ? selectedEntry.step : selectedEntry.anchor;
    const target: StepRecaptureTarget =
      selectedEntry.kind === 'single'
        ? { kind: 'single', stepId: selectedEntry.step.id }
        : selectedEntry.annotations.length === 1
          ? {
              kind: 'snapshot-singleton',
              anchorId: selectedEntry.anchor.id,
              annotationId: selectedEntry.annotations[0].id,
            }
          : (() => {
              throw new Error('此快照包含多個標註；更換底圖會使其他框選失效，請重新製作整張快照。');
            })();

    // permissions.request must be invoked before autosave consumes the click's
    // transient user activation.
    await ensureRecapturePermission(imageOwner.url);
    await flushDescriptions();
    setOperationError(null);
    setOperationNotice(null);
    const result = (await browser.runtime.sendMessage({
      type: 'START_STEP_RECAPTURE',
      sessionId,
      target,
    })) as StartStepRecaptureResult;
    if (!result.ok) throw new Error(result.error);
  }

  async function focusRecaptureSource() {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    const result = (await browser.runtime.sendMessage({
      type: 'FOCUS_STEP_RECAPTURE_SOURCE',
      runId,
    })) as FocusStepRecaptureSourceResult;
    if (!result.ok) setOperationError(result.error ?? '找不到補拍分頁。');
  }

  async function cancelRecapture() {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    const result = (await browser.runtime.sendMessage({
      type: 'CANCEL_STEP_RECAPTURE',
      runId,
    })) as CancelStepRecaptureResult;
    if (!result.ok) setOperationError(result.error ?? '無法取消補拍，請再試一次。');
  }

  async function handleVisualEdit(commit: VisualEditCommit) {
    if (!sessionId) throw new Error('找不到目前的錄製工作階段，修改尚未儲存。');
    if (dataOperation || operationActive) {
      throw new Error('目前有其他操作進行中，修改尚未儲存。');
    }
    await flushDescriptions();
    setUndoAction(null);
    setDataOperation('正在儲存框選與遮罩…');
    setOperationError(null);
    try {
      await updateStepsAtomically(sessionId, commit.updates);
      await refresh();
      setUndoAction({
        id: ++undoSequence.current,
        message: '已更新框選與敏感資訊遮罩',
        restoreSelectionId: selectedEntry ? entryId(selectedEntry) : undefined,
        restore: () => updateStepsAtomically(sessionId, commit.restoreUpdates),
      });
    } catch (editError) {
      console.error('儲存框選與遮罩失敗', editError);
      setOperationError(
        editError instanceof StepUpdateConflictError
          ? '圖片已在其他操作中更新，請重新開啟「修正／遮罩」確認新圖片。'
          : '框選或遮罩儲存失敗，請再試一次。',
      );
      throw editError;
    } finally {
      setDataOperation(null);
    }
  }

  async function handleUndo() {
    if (!undoAction || dataOperation || operationActive) return;
    setDataOperation('正在還原…');
    setOperationError(null);
    try {
      await undoAction.restore();
      await refresh();
      if (undoAction.restoreSelectionId) setSelectedEntryId(undoAction.restoreSelectionId);
      setUndoAction(null);
    } catch (undoError) {
      console.error('還原編輯操作失敗', undoError);
      setOperationError('無法還原，請再試一次。');
    } finally {
      setDataOperation(null);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <EditorHeader operationActive={operationActive} operation={recording.operation} steps={steps} onBeforeExport={stepsForExport} />
      {recording.operation === 'recapture' && recording.recapture && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-7 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="font-medium">
            {recording.recapture.phase === 'capturing' ? '正在擷取新的步驟圖片…' : '請到來源網頁選取要補拍的目標。'}
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void focusRecaptureSource()}>
              <ExternalLink />回到補拍分頁
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void cancelRecapture()}>
              <X />取消補拍
            </Button>
          </div>
        </div>
      )}
      {operationNotice && (
        <div role="status" className="border-b border-lime-200 bg-lime-50 px-4 py-3 text-sm text-lime-900 sm:px-7 dark:border-lime-900 dark:bg-lime-950/30 dark:text-lime-100">
          {operationNotice}
        </div>
      )}
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
          <EmptyState isRecording={ordinaryRecordingActive} recordingTabId={tabId} />
        ) : (
          <>
            <StepRail
              entries={entries}
              selectedEntryId={selectedEntryId}
              onSelect={(id) => void selectEntry(id)}
              onReorder={handleReorderEntries}
              reorderDisabled={operationActive || dataOperation !== null}
            />
            <StepStage
              key={entryId(selectedEntry)}
              entry={selectedEntry}
              index={selectedIndex}
              onChange={refresh}
              onDelete={deleteEntry}
              onDeleteAnnotation={handleDeleteAnnotation}
              onZoom={() => setZoomOpen(true)}
              onReorderAnnotations={(reordered) => handleReorderAnnotations(entryId(selectedEntry), reordered)}
              onEditVisuals={handleVisualEdit}
              onRecapture={handleRecapture}
              editingDisabled={operationActive || dataOperation !== null}
            />
          </>
        )}
      </div>
      <Lightbox
        entries={entries}
        index={zoomOpen ? selectedIndex : null}
        onClose={() => setZoomOpen(false)}
        onNavigate={(i) => void selectEntry(entryId(entries[i]))}
      />
      {undoAction && (
        <UndoSnackbar
          key={undoAction.id}
          message={undoAction.message}
          pending={dataOperation !== null}
          aboveMobileRail={entries.length > 0}
          onUndo={() => void handleUndo()}
          onDismiss={() => setUndoAction(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <EditorSaveProvider>
      <EditorApp />
    </EditorSaveProvider>
  );
}

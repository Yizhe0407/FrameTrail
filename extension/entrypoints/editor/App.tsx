import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, ExternalLink, X } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/useRecordingSession';
import { useEditorGuideData } from '@/lib/editor/use-editor-guide-data';
import {
  EMPTY_STEP_ENTRIES,
  entrySteps,
  equalIds,
  stepMatchesVisualBaseline,
  type PreparedCapturePermission,
  type UndoAction,
} from '@/lib/editor/editor-app-model';
import {
  addGuideSectionAtomically,
  deleteGuideAnnotationAtomically,
  deleteGuideEntriesAtomically,
  deleteGuideSectionAtomically,
  duplicateGuideEntryAtomically,
  entryId,
  getGuideStructureSnapshot,
  getGuide,
  GuideContentConflictError,
  moveGuideEntriesAtomically,
  renameGuideSectionAtomically,
  reorderGuideAnnotationsAtomically,
  reorderGuideEntriesAtomically,
  restoreGuideAnnotationAtomically,
  restoreGuideEntriesAtomically,
  setGuideEntriesNumberedAtomically,
  StepUpdateConflictError,
  updateGuide,
  updateGuideVisualsAtomically,
  type Guide,
  type GuideStructureSnapshot,
  type Step,
  type StepEntry,
} from '@/lib/storage/db';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/editor/EditorHeader';
import StepRail from '@/components/editor/StepRail';
import StepStage from '@/components/editor/StepStage';
import GuideBatchToolbar from '@/components/editor/GuideBatchToolbar';
import EmptyState from '@/components/shared/EmptyState';
import Lightbox from '@/components/editor/Lightbox';
import UndoSnackbar from '@/components/editor/UndoSnackbar';
import PublishGuideDialog from '@/components/editor/PublishGuideDialog';
import type { VisualEditCommit } from '@/components/editor/VisualEditDialog';
import { Button } from '@/components/ui/button';
import { exportImagesAsZip } from '@/lib/export/export-images';
import { getEditorSessionIdFromUrl } from '@/lib/runtime/navigation';
import { useEditorEntryWorkspace } from '@/lib/editor/use-editor-entry-workspace';
import type {
  CancelStepRecaptureResult,
  PreflightStepRecaptureSourcePermissionResult,
  FocusStepRecaptureSourceResult,
  StartStepRecaptureResult,
  StepRecaptureTarget,
} from '@/lib/runtime/messages';
import {
  isCancelStepRecaptureResult,
  isFocusStepRecaptureSourceResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isStartStepRecaptureResult,
  requireRuntimeMessageResult,
} from '@/lib/runtime/runtime-message-result';

function EditorApp() {
  const viewedSessionId = useMemo(() => getEditorSessionIdFromUrl(window.location.href), []);
  const { sessionId, tabId, steps, error, dataError, refresh, recording } = useRecordingSession(viewedSessionId);
  const {
    guide,
    setGuide,
    canonicalSnapshot,
    setCanonicalSnapshot,
    guideLoadState,
    setGuideLoadState,
  } = useEditorGuideData(sessionId, steps);
  const operationBelongsToViewedGuide = Boolean(sessionId && recording.sessionId === sessionId);
  const operationActive = operationBelongsToViewedGuide && recording.operation !== null;
  const ordinaryRecordingActive = operationBelongsToViewedGuide && recording.operation === 'recording';
  const { flushAll } = useEditorSaveRegistry();
  const dbEntries = canonicalSnapshot?.entries ?? EMPTY_STEP_ENTRIES;


  // Optimistic entries state: when a drag reorder happens we update this
  // immediately so the UI reflects the new order without waiting for the DB
  // round-trip.  It resets to null whenever the canonical DB entries change
  // (new steps arrive, deletion completes, etc.) so we always converge to
  // the source of truth.
  const [optimisticEntries, setOptimisticEntries] = useState<StepEntry[] | null>(null);
  const [dataOperation, setDataOperation] = useState<string | null>(null);
  const dataOperationLock = useRef(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [preparedPermission, setPreparedPermission] = useState<PreparedCapturePermission | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);
  const permissionFlowLock = useRef(false);
  const permissionFlowGeneration = useRef(0);
  const permissionFlowEntryId = useRef<string | null>(null);
  const permissionFlowSessionId = useRef<string | null>(null);
  const permissionFlowActive = preparedPermission !== null || permissionPending;
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const undoSequence = useRef(0);
  const handledRecaptureResult = useRef<string | null>(null);
  useEffect(() => {
    if (!dataOperation) setOptimisticEntries(null);
  }, [dbEntries, dataOperation]);
  const entries = optimisticEntries ?? dbEntries;
  const {
    collapseSelection,
    entrySelection,
    multipleEntriesSelected,
    orderedSelectedEntryIds,
    publishOpen,
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setEntrySelection,
    setPublishOpen,
    setZoomOpen,
    snapshotNumberingEnabled,
    selectAllVisible,
    selectEntry,
    visibleEntries,
    visibleEntryIds,
    zoomOpen,
  } = useEditorEntryWorkspace({
    entries,
    flushDescriptions,
    isSelectionBlocked: () => dataOperationLock.current || permissionPending,
    onSelectionInteraction: () => {
      if (permissionFlowLock.current) clearPreparedPermission();
    },
    onSelectionSaved: () => setOperationError(null),
  });

  useEffect(() => {
    const flowEntryId = permissionFlowEntryId.current;
    if (!flowEntryId) return;
    if (
      flowEntryId !== selectedEntryId ||
      permissionFlowSessionId.current !== sessionId ||
      multipleEntriesSelected
    ) {
      clearPreparedPermission();
    }
  }, [multipleEntriesSelected, selectedEntryId, sessionId]);

  useEffect(() => {
    setUndoAction((current) => {
      if (!current) return null;
      if (
        operationActive ||
        !guide ||
        current.guideId !== guide.id ||
        current.expectedRevision !== guide.contentRevision
      ) {
        return null;
      }
      return current;
    });
  }, [guide, operationActive]);

  useEffect(() => {
    const result = recording.recaptureResult;
    if (!result || result.sessionId !== sessionId || handledRecaptureResult.current === result.runId) return;
    handledRecaptureResult.current = result.runId;
    void (async () => {
      try {
        await refresh();
        setEntrySelection({ activeId: result.entryId, selectedIds: new Set([result.entryId]), anchorId: result.entryId });
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
        await browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId: result.runId, sessionId: result.sessionId }).catch((ackError) => {
          console.warn('確認補拍結果失敗', ackError);
        });
      }
    })();
  }, [recording.recaptureResult, refresh, sessionId]);

  async function flushDescriptions(): Promise<void> {
    try {
      await flushAll();
    } catch (saveError) {
      console.error('完成編輯器操作前儲存說明失敗', saveError);
      setOperationError('尚有說明無法儲存。請重試後再繼續。');
      throw saveError;
    }
  }

  function beginDataOperation(label: string): boolean {
    if (dataOperationLock.current || permissionFlowLock.current || operationActive) return false;
    dataOperationLock.current = true;
    setDataOperation(label);
    return true;
  }

  function endDataOperation(): void {
    dataOperationLock.current = false;
    setDataOperation(null);
  }

  function requireSingleSelectedEntry(expectedEntryId?: string): StepEntry {
    if (
      orderedSelectedEntryIds.length !== 1 ||
      !selectedEntry ||
      orderedSelectedEntryIds[0] !== entryId(selectedEntry) ||
      (expectedEntryId !== undefined && expectedEntryId !== entryId(selectedEntry))
    ) {
      throw new Error('單筆編輯只允許在單選狀態執行。');
    }
    return selectedEntry;
  }

  async function refreshEditorData(): Promise<Guide | null> {
    await refresh();
    if (!sessionId) {
      setGuide(null);
      setCanonicalSnapshot(null);
      setGuideLoadState('missing');
      return null;
    }
    try {
      const snapshot = await getGuideStructureSnapshot(sessionId);
      setGuide(snapshot.guide);
      setCanonicalSnapshot(snapshot);
      setGuideLoadState('ready');
      return snapshot.guide;
    } catch (refreshError) {
      const latestGuide = await getGuide(sessionId).catch(() => undefined);
      setGuide(latestGuide ?? null);
      setCanonicalSnapshot(null);
      setGuideLoadState(latestGuide ? 'invalid' : 'missing');
      throw refreshError;
    }
  }

  function showStructureMutationError(operation: string, mutationError: unknown): void {
    console.error(`${operation}失敗`, mutationError);
    setOperationError(
      mutationError instanceof GuideContentConflictError
        ? '教學內容已在其他操作中變更。為避免覆蓋較新的資料，這次操作未套用，畫面已重新載入。'
        : `${operation}失敗，已重新載入目前資料。`,
    );
  }

  async function persistEntryReorder(newEntries: StepEntry[], previousEntries: StepEntry[], operation: string) {
    if (!sessionId || !guide || !beginDataOperation(operation)) return;
    setUndoAction(null);
    setOptimisticEntries(newEntries);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const previousEntryIds = previousEntries.map(entryId);
      if (!equalIds(snapshot.entryIds, previousEntryIds)) {
        throw new GuideContentConflictError(
          sessionId,
          guide.contentRevision,
          snapshot.guide.contentRevision,
        );
      }
      const result = await reorderGuideEntriesAtomically(
        sessionId,
        newEntries.map(entryId),
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
      setUndoAction({
        id: ++undoSequence.current,
        message: operation.includes('標注') ? '已更新標註順序' : '已更新步驟順序',
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restore: () => reorderGuideEntriesAtomically(
          sessionId,
          result.previousEntryIds,
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (err) {
      showStructureMutationError('步驟排序', err);
      setOptimisticEntries(previousEntries);
      try {
        await refreshEditorData();
      } catch (refreshError) {
        console.error('排序失敗後重新讀取步驟失敗', refreshError);
      }
    } finally {
      endDataOperation();
    }
  }

  async function handleReorderEntries(newEntries: StepEntry[]) {
    try {
      await persistEntryReorder(newEntries, entries, '正在儲存步驟順序…');
    } catch {
      // flushDescriptions already exposes the actionable save error.
    }
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    requireSingleSelectedEntry(anchorId);
    if (!sessionId || !beginDataOperation('正在儲存標注順序…')) return;
    const previousEntries = entries;
    const previousGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
    );
    if (!previousGroup) {
      endDataOperation();
      throw new Error('找不到要排序的快照。');
    }
    const newEntries = previousEntries.map((entry) => (
      entry.kind === 'group' && entry.anchor.id === anchorId ? { ...entry, annotations: reordered } : entry
    ));
    setUndoAction(null);
    setOptimisticEntries(newEntries);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const freshGroup = snapshot.entries.find(
        (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
      );
      if (!freshGroup || !equalIds(
        freshGroup.annotations.map((annotation) => annotation.id),
        previousGroup.annotations.map((annotation) => annotation.id),
      )) {
        throw new GuideContentConflictError(
          sessionId,
          guide?.contentRevision ?? snapshot.guide.contentRevision,
          snapshot.guide.contentRevision,
        );
      }
      const result = await reorderGuideAnnotationsAtomically(
        sessionId,
        anchorId,
        reordered.map((annotation) => annotation.id),
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
      setUndoAction({
        id: ++undoSequence.current,
        message: '已更新標註順序',
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: anchorId,
        restore: () => reorderGuideAnnotationsAtomically(
          sessionId,
          anchorId,
          result.previousAnnotationIds,
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (reorderError) {
      setOptimisticEntries(previousEntries);
      showStructureMutationError('標註排序', reorderError);
      await refreshEditorData().catch((refreshError) => console.error('重新讀取標註排序失敗', refreshError));
      throw reorderError;
    } finally {
      endDataOperation();
    }
  }

  async function deleteSelectedEntries(entryIdsToDelete: readonly string[]) {
    const label = entryIdsToDelete.length > 1 ? '正在刪除已選步驟…' : '正在刪除步驟…';
    if (!sessionId || entryIdsToDelete.length === 0 || !beginDataOperation(label)) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const deletingIds = new Set(entryIdsToDelete);
      const deletingEntries = snapshot.entries.filter((entry) => deletingIds.has(entryId(entry)));
      if (deletingEntries.length !== deletingIds.size) throw new Error('選取內容已變更，無法安全刪除。');
      const firstDeletingIndex = snapshot.entryIds.findIndex((id) => deletingIds.has(id));
      const result = await deleteGuideEntriesAtomically(
        sessionId,
        entryIdsToDelete,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      const nextIndex = Math.min(Math.max(firstDeletingIndex, 0), result.entryIds.length - 1);
      const nextActiveId = nextIndex >= 0 ? result.entryIds[nextIndex] : null;
      setEntrySelection({
        activeId: nextActiveId,
        selectedIds: new Set(nextActiveId ? [nextActiveId] : []),
        anchorId: nextActiveId,
      });
      setZoomOpen(false);
      await refreshEditorData();
      const deletedSteps = deletingEntries.flatMap(entrySteps);
      setUndoAction({
        id: ++undoSequence.current,
        message: entryIdsToDelete.length > 1 ? `已刪除 ${entryIdsToDelete.length} 個項目` : `已刪除步驟 ${firstDeletingIndex + 1}`,
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: entryIdsToDelete[0],
        restore: () => restoreGuideEntriesAtomically(
          sessionId,
          deletedSteps,
          snapshot.entryIds,
          snapshot.guide.sections,
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (err) {
      showStructureMutationError('步驟刪除', err);
      try {
        await refreshEditorData();
      } finally {
        setOptimisticEntries(null);
      }
      throw err;
    } finally {
      endDataOperation();
    }
  }

  async function deleteEntry() {
    const currentEntry = requireSingleSelectedEntry();
    await deleteSelectedEntries([entryId(currentEntry)]);
  }

  async function handleDeleteAnnotation(step: Step) {
    const currentEntry = requireSingleSelectedEntry(step.groupId);
    if (currentEntry.kind !== 'group') throw new Error('只有快照標註可以個別刪除。');
    if (!sessionId || !step.groupId || !beginDataOperation('正在刪除標注…')) return;
    const previousEntries = entries;
    const deletingGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => (
        entry.kind === 'group' && entry.anchor.id === step.groupId
      ),
    );
    const annotationIndex = deletingGroup?.annotations.findIndex((annotation) => annotation.id === step.id) ?? -1;
    const nextEntries = previousEntries.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== step.groupId) return [entry];
      if (entry.annotations.length === 1) return [];
      return [{ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== step.id) }];
    });

    setUndoAction(null);
    setOptimisticEntries(nextEntries);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await deleteGuideAnnotationAtomically(
        sessionId,
        step.groupId,
        step.id,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      if (result.removedEntry) {
        const previousIndex = result.previousEntryIds.indexOf(step.groupId);
        const nextIndex = Math.min(Math.max(previousIndex, 0), result.entryIds.length - 1);
        const nextActiveId = nextIndex >= 0 ? result.entryIds[nextIndex] : null;
        setEntrySelection({
          activeId: nextActiveId,
          selectedIds: new Set(nextActiveId ? [nextActiveId] : []),
          anchorId: nextActiveId,
        });
        setZoomOpen(false);
      }
      await refreshEditorData();
      const deletedAnnotation = result.deletedSteps.find((deleted) => deleted.id === step.id);
      if (!deletedAnnotation) throw new Error('刪除標註後缺少可還原資料。');
      setUndoAction({
        id: ++undoSequence.current,
        message: `已刪除標註 ${(result.previousAnnotationIds.indexOf(step.id) >= 0 ? result.previousAnnotationIds.indexOf(step.id) : annotationIndex) + 1}`,
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: step.groupId,
        restore: result.removedEntry
          ? () => restoreGuideEntriesAtomically(
              sessionId,
              result.deletedSteps,
              result.previousEntryIds,
              result.previousSections,
              result.guide.contentRevision,
            ).then(() => undefined)
          : () => restoreGuideAnnotationAtomically(
              sessionId,
              step.groupId!,
              deletedAnnotation,
              result.previousAnnotationIds,
              result.guide.contentRevision,
            ).then(() => undefined),
      });
    } catch (deleteError) {
      setOptimisticEntries(previousEntries);
      showStructureMutationError('標註刪除', deleteError);
      await refreshEditorData().catch((refreshError) => console.error('重新讀取標註刪除結果失敗', refreshError));
      throw deleteError;
    } finally {
      endDataOperation();
    }
  }

  async function moveSelectedEntries(entryIdsToMove: readonly string[], destination: 'start' | 'end') {
    const label = destination === 'start' ? '正在移到開頭…' : '正在移到結尾…';
    if (!sessionId || entryIdsToMove.length === 0 || !beginDataOperation(label)) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await moveGuideEntriesAtomically(
        sessionId,
        entryIdsToMove,
        destination,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
      setUndoAction({
        id: ++undoSequence.current,
        message: destination === 'start' ? '已將選取項目移到開頭' : '已將選取項目移到結尾',
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: entryIdsToMove[0],
        restore: () => reorderGuideEntriesAtomically(
          sessionId,
          snapshot.entryIds,
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (mutationError) {
      showStructureMutationError('移動步驟', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('移動失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  async function duplicateActiveEntry(activeEntryId: string) {
    if (!sessionId || !beginDataOperation('正在複製步驟…')) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await duplicateGuideEntryAtomically(
        sessionId,
        activeEntryId,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      setEntrySelection({
        activeId: result.createdEntryId,
        selectedIds: new Set([result.createdEntryId]),
        anchorId: result.createdEntryId,
      });
      await refreshEditorData();
      setUndoAction({
        id: ++undoSequence.current,
        message: '已複製目前項目',
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: activeEntryId,
        restore: () => deleteGuideEntriesAtomically(
          sessionId,
          [result.createdEntryId],
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (mutationError) {
      showStructureMutationError('複製步驟', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('複製失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  async function setEntriesNumbered(entryIdsToUpdate: readonly string[], numbered: boolean) {
    if (!sessionId || entryIdsToUpdate.length === 0 || !beginDataOperation('正在儲存快照編號設定…')) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const selectedIds = new Set(entryIdsToUpdate);
      const previousValues = new Set(
        snapshot.entries
          .filter((entry): entry is Extract<StepEntry, { kind: 'group' }> => (
            entry.kind === 'group' && selectedIds.has(entry.anchor.id)
          ))
          .map((entry) => entry.anchor.numbered ?? false),
      );
      const result = await setGuideEntriesNumberedAtomically(
        sessionId,
        entryIdsToUpdate,
        numbered,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
      const previousValue = previousValues.size === 1 ? [...previousValues][0] : undefined;
      if (result.affectedEntryIds.length > 0 && previousValue !== undefined && previousValue !== numbered) {
        setUndoAction({
          id: ++undoSequence.current,
          message: `已${numbered ? '開啟' : '關閉'}快照編號`,
          guideId: sessionId,
          expectedRevision: result.guide.contentRevision,
          restoreSelectionId: selectedEntryId ?? undefined,
          restore: () => setGuideEntriesNumberedAtomically(
            sessionId,
            result.affectedEntryIds,
            previousValue,
            result.guide.contentRevision,
          ).then(() => undefined),
        });
      }
    } catch (mutationError) {
      showStructureMutationError('快照編號設定', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('編號設定失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  async function addSectionBefore(startEntryId: string) {
    if (!sessionId || !beginDataOperation('正在新增章節…')) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await addGuideSectionAtomically(
        sessionId,
        startEntryId,
        `章節 ${snapshot.guide.sections.length + 1}`,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
    } catch (mutationError) {
      showStructureMutationError('新增章節', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('新增章節失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  async function renameSection(sectionId: string, title: string) {
    if (!sessionId || !beginDataOperation('正在重新命名章節…')) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await renameGuideSectionAtomically(
        sessionId,
        sectionId,
        title,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
    } catch (mutationError) {
      showStructureMutationError('章節重新命名', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('章節重新命名失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  async function deleteSection(sectionId: string) {
    if (!sessionId || !beginDataOperation('正在刪除章節…')) return;
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const result = await deleteGuideSectionAtomically(
        sessionId,
        sectionId,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
    } catch (mutationError) {
      showStructureMutationError('刪除章節', mutationError);
      await refreshEditorData().catch((refreshError) => console.error('刪除章節失敗後重新載入資料失敗', refreshError));
      throw mutationError;
    } finally {
      endDataOperation();
    }
  }

  function validatePreparedPermissionSource(
    sourceOrigin: string,
    permissionPattern: string,
  ): void {
    let parsed: URL;
    try {
      parsed = new URL(sourceOrigin);
    } catch {
      throw new Error('來源網站授權資料無效，已停止操作。');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== sourceOrigin ||
      permissionPattern !== `${parsed.origin}/*`
    ) {
      throw new Error('來源網站授權資料不符合安全規則，已停止操作。');
    }
  }

  function clearPreparedPermission(): void {
    permissionFlowGeneration.current += 1;
    permissionFlowLock.current = false;
    permissionFlowEntryId.current = null;
    permissionFlowSessionId.current = null;
    setPreparedPermission(null);
    setPermissionPending(false);
  }

  function beginPermissionPreflight(entryIdToPrepare: string): number | null {
    if (
      !sessionId ||
      dataOperationLock.current ||
      permissionFlowLock.current ||
      operationActive
    ) return null;
    const generation = permissionFlowGeneration.current + 1;
    permissionFlowGeneration.current = generation;
    permissionFlowLock.current = true;
    permissionFlowEntryId.current = entryIdToPrepare;
    permissionFlowSessionId.current = sessionId;
    setPreparedPermission(null);
    setPermissionPending(true);
    setOperationError(null);
    setOperationNotice(null);
    return generation;
  }

  function finishPermissionPreflight(generation: number, prepared: PreparedCapturePermission | null): void {
    if (permissionFlowGeneration.current !== generation) return;
    setPermissionPending(false);
    if (prepared) {
      setPreparedPermission(prepared);
      return;
    }
    permissionFlowLock.current = false;
    permissionFlowEntryId.current = null;
    permissionFlowSessionId.current = null;
  }

  async function confirmPreparedPermission(): Promise<void> {
    const prepared = preparedPermission;
    if (
      !prepared ||
      !sessionId ||
      permissionPending ||
      !permissionFlowLock.current ||
      permissionFlowSessionId.current !== sessionId
    ) return;

    requireSingleSelectedEntry(prepared.entryId);
    validatePreparedPermissionSource(prepared.sourceOrigin, prepared.permissionPattern);
    const generation = permissionFlowGeneration.current;
    setPermissionPending(true);
    setOperationError(null);
    setOperationNotice(null);

    try {
      // This must remain the first asynchronous browser API in this explicit
      // confirmation click so Chromium preserves transient user activation.
      const granted = await browser.permissions.request({ origins: [prepared.permissionPattern] });
      if (permissionFlowGeneration.current !== generation) return;
      if (!granted) throw new Error('需要允許存取來源網站，才能回到該頁面錄製。');

      await flushDescriptions();
      if (permissionFlowGeneration.current !== generation) return;
      const result = requireRuntimeMessageResult<StartStepRecaptureResult>(
        await browser.runtime.sendMessage({
          type: 'START_STEP_RECAPTURE',
          sessionId,
          target: prepared.action.target,
        }),
        isStartStepRecaptureResult,
      );
      if (!result.ok) throw new Error(result.error);
    } catch (permissionError) {
      console.error('授權並啟動來源錄製失敗', permissionError);
      if (permissionFlowGeneration.current === generation) {
        setOperationError(
          permissionError instanceof Error
            ? permissionError.message
            : '無法啟動來源錄製；現有內容未變更，請再試一次。',
        );
      }
    } finally {
      if (permissionFlowGeneration.current === generation) clearPreparedPermission();
    }
  }

  async function handleRecapture(): Promise<void> {
    if (!sessionId || dataOperationLock.current || permissionFlowLock.current || operationActive) return;
    const currentEntry = requireSingleSelectedEntry();
    const target: StepRecaptureTarget =
      currentEntry.kind === 'single'
        ? { kind: 'single', stepId: currentEntry.step.id }
        : currentEntry.annotations.length === 1
          ? {
              kind: 'snapshot-singleton',
              anchorId: currentEntry.anchor.id,
              annotationId: currentEntry.annotations[0].id,
            }
          : (() => {
              throw new Error('此快照包含多個標註；更換底圖會使其他框選失效，請重新製作整張快照。');
            })();
    const targetEntryId = entryId(currentEntry);
    const generation = beginPermissionPreflight(targetEntryId);
    if (generation == null) return;
    let prepared: PreparedCapturePermission | null = null;
    try {
      const result = requireRuntimeMessageResult<PreflightStepRecaptureSourcePermissionResult>(
        await browser.runtime.sendMessage({
          type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
          sessionId,
          target,
        }),
        isPreflightStepRecaptureSourcePermissionResult,
      );
      if (!result.ok) throw new Error(result.message);
      validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
      prepared = {
        sourceOrigin: result.sourceOrigin,
        permissionPattern: result.permissionPattern,
        entryId: targetEntryId,
        action: { kind: 'recapture', target },
      };
    } catch (recaptureError) {
      console.error('檢查補拍來源失敗', recaptureError);
      if (permissionFlowGeneration.current === generation) {
        setOperationError(
          recaptureError instanceof Error
            ? recaptureError.message
            : '無法安全確認補拍來源；原本內容未變更。',
        );
      }
    } finally {
      finishPermissionPreflight(generation, prepared);
    }
  }

  async function focusRecaptureSource() {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    try {
      const result = requireRuntimeMessageResult<FocusStepRecaptureSourceResult>(
        await browser.runtime.sendMessage({
          type: 'FOCUS_STEP_RECAPTURE_SOURCE',
          runId,
        }),
        isFocusStepRecaptureSourceResult,
      );
      if (!result.ok) setOperationError(result.error ?? '找不到補拍分頁。');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '找不到補拍分頁。');
    }
  }

  async function cancelRecapture() {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    try {
      const result = requireRuntimeMessageResult<CancelStepRecaptureResult>(
        await browser.runtime.sendMessage({
          type: 'CANCEL_STEP_RECAPTURE',
          runId,
        }),
        isCancelStepRecaptureResult,
      );
      if (!result.ok) setOperationError(result.error ?? '無法取消補拍，請再試一次。');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '無法取消補拍，請再試一次。');
    }
  }

  async function handleVisualEdit(commit: VisualEditCommit) {
    if (!sessionId) throw new Error('找不到目前的錄製工作階段，修改尚未儲存。');
    requireSingleSelectedEntry();
    if (!beginDataOperation('正在儲存框選與遮罩…')) {
      throw new Error('目前有其他操作進行中，修改尚未儲存。');
    }
    setUndoAction(null);
    setOperationError(null);
    try {
      await flushDescriptions();
      const snapshot = await getGuideStructureSnapshot(sessionId);
      const freshSteps = new Map(snapshot.entries.flatMap(entrySteps).map((step) => [step.id, step]));
      for (const restoreUpdate of commit.restoreUpdates) {
        const current = freshSteps.get(restoreUpdate.id);
        if (!current || !stepMatchesVisualBaseline(current, restoreUpdate.changes)) {
          throw new GuideContentConflictError(
            sessionId,
            guide?.contentRevision ?? snapshot.guide.contentRevision,
            snapshot.guide.contentRevision,
          );
        }
      }
      const strictUpdates = commit.updates.map((update) => {
        if (update.expectedCaptureRevision === undefined) {
          throw new TypeError('圖片修改缺少擷取版本，已拒絕儲存。');
        }
        return { ...update, expectedCaptureRevision: update.expectedCaptureRevision };
      });
      const result = await updateGuideVisualsAtomically(
        sessionId,
        strictUpdates,
        snapshot.guide.contentRevision,
      );
      setGuide(result.guide);
      await refreshEditorData();
      const committedById = new Map(result.steps.map((step) => [step.id, step]));
      const undoUpdates = commit.restoreUpdates.map((update) => ({
        ...update,
        expectedCaptureRevision: committedById.get(update.id)?.captureRevision ?? 0,
      }));
      setUndoAction({
        id: ++undoSequence.current,
        message: '已更新框選與敏感資訊遮罩',
        guideId: sessionId,
        expectedRevision: result.guide.contentRevision,
        restoreSelectionId: selectedEntry ? entryId(selectedEntry) : undefined,
        restore: () => updateGuideVisualsAtomically(
          sessionId,
          undoUpdates,
          result.guide.contentRevision,
        ).then(() => undefined),
      });
    } catch (editError) {
      console.error('儲存框選與遮罩失敗', editError);
      setOperationError(
        editError instanceof StepUpdateConflictError || editError instanceof GuideContentConflictError
          ? '圖片或教學內容已在其他操作中更新，請重新開啟「調整圖片」確認最新內容。'
          : '框選或遮罩儲存失敗，請再試一次。',
      );
      throw editError;
    } finally {
      endDataOperation();
    }
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
        setEntrySelection({
          activeId: undoAction.restoreSelectionId,
          selectedIds: new Set([undoAction.restoreSelectionId]),
          anchorId: undoAction.restoreSelectionId,
        });
      }
      setUndoAction(null);
    } catch (undoError) {
      console.error('還原編輯操作失敗', undoError);
      setUndoAction(null);
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

  async function publicationEntries(signal: AbortSignal) {
    if (!sessionId) throw new Error('找不到要發佈的教學。');
    if (!beginDataOperation('正在準備發佈內容…')) {
      throw new Error('目前有其他資料操作進行中，請稍後再發佈。');
    }
    try {
      await flushDescriptions();
      if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
      const snapshot = await getGuideStructureSnapshot(sessionId);
      if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
      setGuide(snapshot.guide);
      setCanonicalSnapshot(snapshot);
      return {
        entries: snapshot.entries,
        metadata: {
          title: snapshot.guide.title,
          description: snapshot.guide.description,
          filename: snapshot.guide.title,
          sections: snapshot.guide.sections,
        },
      };
    } finally {
      endDataOperation();
    }
  }

  async function setSelectedEntryNumbered(id: string, numbered: boolean): Promise<void> {
    requireSingleSelectedEntry(id);
    await setEntriesNumbered([id], numbered);
  }

  async function exportImages(signal: AbortSignal): Promise<void> {
    const publication = await publicationEntries(signal);
    const stepsToExport = publication.entries.flatMap((entry) =>
      entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations],
    );
    await exportImagesAsZip(stepsToExport, undefined, signal);
  }

  return (
    <div className="flex h-screen flex-col">
      <EditorHeader
        operationActive={operationActive}
        editingDisabled={dataOperation !== null || permissionFlowActive}
        operation={recording.operation}
        steps={steps}
        sessionId={sessionId}
        guideTitle={guide?.title}
        onRenameGuide={guide ? async (title) => {
          if (permissionFlowLock.current || dataOperationLock.current || operationActive) {
            throw new Error('目前有其他操作進行中。');
          }
          const updated = await updateGuide(guide.id, { title });
          setGuide(updated);
        } : undefined}
        onOpenPublish={() => { if (!permissionFlowLock.current) setPublishOpen(true); }}
        onReset={async () => { await refreshEditorData(); }}
      />
      {operationBelongsToViewedGuide && recording.operation === 'recapture' && recording.recapture && (
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
      {preparedPermission && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-7 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <div className="min-w-0 flex-1">
            <span className="font-medium">即將連線至來源網站：</span>{' '}
            <span className="break-all font-mono text-xs">{preparedPermission.sourceOrigin}</span>
            <p className="mt-1 text-xs opacity-80">
              FrameTrail 只會要求這個網站的存取權，且會在開始前由背景程序再次核對目前儲存的來源。
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={permissionPending}
              onClick={clearPreparedPermission}
            >
              <X />取消
            </Button>
            <Button
              size="sm"
              disabled={permissionPending}
              onClick={() => void confirmPreparedPermission()}
            >
              {permissionPending ? '正在授權…' : '允許並開始'}
            </Button>
          </div>
        </div>
      )}
      {operationNotice && (
        <div role="status" className="border-b border-lime-200 bg-lime-50 px-4 py-3 text-sm text-lime-900 sm:px-7 dark:border-lime-900 dark:bg-lime-950/30 dark:text-lime-100">
          {operationNotice}
        </div>
      )}
      {(error || dataError || operationError) && (
        <div className="border-b border-stone-200 bg-stone-50 px-7 py-3 dark:border-stone-700 dark:bg-stone-900">
          <Alert variant={error || dataError || operationError ? 'destructive' : 'default'}>
            <AlertCircle />
            <AlertDescription>{error ?? dataError ?? operationError}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {guideLoadState === 'loading' ? (
          <main role="status" className="flex min-w-0 flex-1 items-center justify-center p-8 text-sm text-stone-500 dark:text-stone-400">
            正在讀取教學…
          </main>
        ) : guideLoadState === 'missing' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="max-w-md text-stone-600 dark:text-stone-300">
              <AlertCircle className="mx-auto mb-3 size-8" aria-hidden="true" />
              <h2 className="font-semibold text-stone-900 dark:text-stone-100">找不到這份教學</h2>
              <p className="mt-2 text-sm">
                {viewedSessionId
                  ? '這份教學可能已被刪除或網址已失效。為避免顯示其他錄製內容，編輯器不會自動切換到別份教學。'
                  : '編輯器網址缺少教學識別碼。請從 FrameTrail 作品庫重新開啟教學。'}
              </p>
            </div>
          </main>
        ) : guideLoadState === 'invalid' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="max-w-md text-stone-600 dark:text-stone-300">
              <AlertCircle className="mx-auto mb-3 size-8" aria-hidden="true" />
              <h2 className="font-semibold text-stone-900 dark:text-stone-100">教學結構需要修復</h2>
              <p className="mt-2 text-sm">
                為避免遺漏、拆散或覆蓋步驟，FrameTrail 已停止載入與發佈這份教學。請先從作品庫匯出備份，再重新開啟或復原內容。
              </p>
            </div>
          </main>
        ) : entries.length === 0 ? (
          <EmptyState isRecording={ordinaryRecordingActive} recordingTabId={tabId} />
        ) : (
          <>
            <StepRail
              entries={visibleEntries}
              selectedEntryId={selectedEntryId}
              selectedEntryIds={entrySelection.selectedIds}
              sections={guide?.sections}
              onSelect={(id, modifiers) => void selectEntry(id, modifiers)}
              onSelectAllVisible={() => void selectAllVisible()}
              onCollapseSelection={collapseSelection}
              onRenameSection={renameSection}
              onDeleteSection={deleteSection}
              onReorder={handleReorderEntries}
              reorderDisabled={operationActive || dataOperation !== null || permissionFlowActive || multipleEntriesSelected}
            />
            {selectedEntry ? (
              <div className="flex min-w-0 flex-1 flex-col">
                {multipleEntriesSelected && <GuideBatchToolbar
                  selectedEntryIds={orderedSelectedEntryIds}
                  visibleEntryIds={visibleEntryIds}
                  activeEntryId={selectedEntryId}
                  snapshotNumberingEnabled={snapshotNumberingEnabled}
                  busy={operationActive || dataOperation !== null || permissionFlowActive}
                  onSelectAllVisible={() => selectAllVisible()}
                  onClearSelection={collapseSelection}
                  onDeleteSelected={deleteSelectedEntries}
                  onMoveSelectedToStart={(ids) => moveSelectedEntries(ids, 'start')}
                  onMoveSelectedToEnd={(ids) => moveSelectedEntries(ids, 'end')}
                  onCopyActiveEntry={duplicateActiveEntry}
                  onSetSnapshotNumbering={(enabled) => setEntriesNumbered(orderedSelectedEntryIds, enabled)}
                  onAddSectionBefore={addSectionBefore}
                />}
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
                  onSetNumbered={setSelectedEntryNumbered}
                  editingDisabled={operationActive || dataOperation !== null || permissionFlowActive || multipleEntriesSelected}
                />
              </div>
            ) : (
              <main className="flex min-w-0 flex-1 items-center justify-center p-8 pb-36 text-center lg:pb-8">
                <div className="max-w-sm text-stone-600 dark:text-stone-300">
                  <h2 className="font-semibold text-stone-900 dark:text-stone-100">尚未選擇步驟</h2>
                  <p className="mt-2 text-sm">請從左側步驟列表選擇要編輯的內容。</p>
                </div>
              </main>
            )}
          </>
        )}
      </div>
      <Lightbox
        entries={visibleEntries}
        index={zoomOpen ? selectedIndex : null}
        onClose={() => setZoomOpen(false)}
        onNavigate={(i) => void selectEntry(entryId(visibleEntries[i]))}
      />
      <PublishGuideDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        getGuideEntries={publicationEntries}
        metadata={{
          title: guide?.title,
          description: guide?.description,
          filename: guide?.title,
          sections: guide?.sections,
        }}
        onExportImages={exportImages}
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

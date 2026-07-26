import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import toast from 'react-hot-toast';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/useRecordingSession';
import { useEditorGuideData } from '@/lib/editor/use-editor-guide-data';
import { EMPTY_STEP_ENTRIES } from '@/lib/editor/editor-app-model';
import {
  entryId,
  getGuideStructureSnapshot,
  getGuide,
  updateGuide,
  type Guide,
  type StepEntry,
} from '@/lib/storage/db';
import { DraftConfirmationRequiredError, EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/editor/EditorHeader';
import StepRail from '@/components/editor/StepRail';
import StepStage from '@/components/editor/StepStage';
import AppToaster from '@/components/shared/AppToaster';
import EmptyState from '@/components/shared/EmptyState';
import Lightbox from '@/components/editor/Lightbox';
import StepStepper from '@/components/editor/StepStepper';
import RecaptureProgressDialog from '@/components/editor/RecaptureProgressDialog';
import SourcePermissionDialog from '@/components/editor/SourcePermissionDialog';
import UndoSnackbar from '@/components/editor/UndoSnackbar';
import PublishGuideDialog from '@/components/editor/PublishGuideDialog';
import { usePermissionFlow } from '@/components/editor/use-permission-flow';
import { useGuideUndo } from '@/components/editor/use-guide-undo';
import { useGuideMutations } from '@/components/editor/use-guide-mutations';
import { exportImagesAsZip } from '@/lib/export/export-images';
import { throwIfAborted } from '@/lib/shared/abort';
import { getEditorSessionIdFromUrl } from '@/lib/runtime/navigation';
import { useEditorEntryWorkspace } from '@/lib/editor/use-editor-entry-workspace';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
} from '@/lib/runtime/messages';
import {
  isCancelStepRecaptureResult,
  isFocusStepRecaptureSourceResult,
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
  const recaptureActive = operationBelongsToViewedGuide && recording.operation === 'recapture' && recording.recapture !== null;
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
  const handledRecaptureResult = useRef<string | null>(null);
  useEffect(() => {
    if (!dataOperation) setOptimisticEntries(null);
  }, [dbEntries, dataOperation]);
  const entries = optimisticEntries ?? dbEntries;

  const {
    preparedPermission,
    permissionPending,
    permissionFlowActive,
    continueElsewherePending,
    continueElsewhereError,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
  } = usePermissionFlow({
    sessionId,
    operationActive,
    isDataOperationLocked: () => dataOperationLock.current,
    flushDescriptions,
    requireSelectedEntry,
    setOperationError,
  });

  const {
    publishOpen,
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setPublishOpen,
    setSelectedEntryId,
    setZoomOpen,
    selectEntry,
    visibleEntries,
    zoomOpen,
  } = useEditorEntryWorkspace({
    entries,
    flushDescriptions,
    isSelectionBlocked: () => dataOperationLock.current || permissionPending || continueElsewherePending,
    onSelectionInteraction: () => {
      if (isPermissionFlowLocked()) clearPreparedPermission();
    },
    onSelectionSaved: () => setOperationError(null),
  });

  useEffect(() => {
    syncWithSelection(selectedEntryId, sessionId);
  }, [syncWithSelection, selectedEntryId, sessionId]);

  // A lightbox with no entry to show must not stay armed: if every entry
  // disappears while zoomed (deletion elsewhere, Guide reload), leaving
  // `zoomOpen` true would pop the lightbox open unexpectedly as soon as
  // entries reappear.
  useEffect(() => {
    if (!selectedEntry) setZoomOpen(false);
  }, [selectedEntry, setZoomOpen]);

  const { undoAction, offerUndo, clearUndo } = useGuideUndo({ guide, operationActive });

  useEffect(() => {
    const result = recording.recaptureResult;
    if (!result || result.sessionId !== sessionId || handledRecaptureResult.current === result.runId) return;
    handledRecaptureResult.current = result.runId;
    void (async () => {
      try {
        await refresh();
        setSelectedEntryId(result.entryId);
        setZoomOpen(false);
        setOperationError(result.status === 'failed' ? result.message ?? '補拍失敗，原本內容未變更。' : null);
        if (result.status === 'replaced') {
          toast.success('補拍完成；原步驟的說明與順序已保留。原有圖片遮罩已清除。');
        } else if (result.status === 'cancelled') {
          toast('已取消補拍，原本內容未變更。');
        }
      } catch (presentError) {
        // The run itself already settled in storage; only presenting its
        // outcome failed. The result is stamped handled above, so surface the
        // failure instead of silently dropping it.
        console.error('顯示補拍結果失敗', presentError);
        setOperationError('補拍結果已儲存，但畫面更新失敗。請重新整理頁面查看最新內容。');
      } finally {
        await browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId: result.runId, sessionId: result.sessionId }).catch((ackError) => {
          console.warn('確認補拍結果失敗', ackError);
        });
      }
    })();
  }, [recording.recaptureResult, refresh, sessionId, setSelectedEntryId, setZoomOpen]);

  async function flushDescriptions(): Promise<void> {
    try {
      await flushAll();
    } catch (saveError) {
      console.error('完成編輯器操作前儲存說明失敗', saveError);
      // A pending draft confirmation carries its own user-facing zh-Hant
      // message explaining what to confirm; only genuine save failures get
      // the generic retry wording.
      setOperationError(
        saveError instanceof DraftConfirmationRequiredError
          ? saveError.message
          : '尚有說明無法儲存。請重試後再繼續。',
      );
      throw saveError;
    }
  }

  function beginDataOperation(label: string): boolean {
    if (dataOperationLock.current || isPermissionFlowLocked() || operationActive) return false;
    dataOperationLock.current = true;
    setDataOperation(label);
    return true;
  }

  function endDataOperation(): void {
    dataOperationLock.current = false;
    setDataOperation(null);
  }

  function requireSelectedEntry(expectedEntryId?: string): StepEntry {
    if (!selectedEntry || (expectedEntryId !== undefined && expectedEntryId !== entryId(selectedEntry))) {
      throw new Error('找不到目前選取的步驟。');
    }
    return selectedEntry;
  }

  // `selectEntry` propagates genuine save failures (it only swallows the
  // pending-confirmation case itself). `flushDescriptions` usually surfaced
  // its own message already, so only fill the banner in when nothing did.
  function selectEntrySafely(id: string): void {
    void selectEntry(id).catch((selectionError) => {
      console.error('切換步驟失敗', selectionError);
      setOperationError((current) => current ?? '切換步驟失敗：儲存目前說明時發生錯誤，請再試一次。');
    });
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

  const {
    handleReorderEntries,
    handleReorderAnnotations,
    deleteEntry,
    handleDeleteAnnotation,
    setEntriesNumbered,
    renameSection,
    deleteSection,
    handleUndo,
  } = useGuideMutations({
    sessionId,
    guide,
    entries,
    selectedEntryId,
    beginDataOperation,
    endDataOperation,
    setOptimisticEntries,
    flushDescriptions,
    refreshEditorData,
    setGuide,
    requireSelectedEntry,
    setSelectedEntryId,
    setZoomOpen,
    setOperationError,
    undoAction,
    offerUndo,
    clearUndo,
  });

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

  async function publicationEntries(signal: AbortSignal) {
    if (!sessionId) throw new Error('找不到要發佈的教學。');
    if (!beginDataOperation('正在準備發佈內容…')) {
      throw new Error('目前有其他資料操作進行中，請稍後再發佈。');
    }
    try {
      await flushDescriptions();
      throwIfAborted(signal);
      const snapshot = await getGuideStructureSnapshot(sessionId);
      throwIfAborted(signal);
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
    requireSelectedEntry(id);
    await setEntriesNumbered([id], numbered);
  }

  async function exportImages(signal: AbortSignal): Promise<void> {
    const publication = await publicationEntries(signal);
    const stepsToExport = publication.entries.flatMap((entry) =>
      entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations],
    );
    await exportImagesAsZip(stepsToExport, undefined, signal);
  }

  // Rejects rather than reporting through `operationError`: the caller owns an
  // input whose displayed value must roll back to the stored one, so it needs
  // the failure, not just a page-level banner.
  async function updateGuideMetadata(changes: { title?: string; tags?: string[] }): Promise<void> {
    if (!guide) throw new Error('找不到要編輯的教學。');
    if (isPermissionFlowLocked() || dataOperationLock.current || operationActive) {
      throw new Error('目前有其他操作進行中，請稍後再修改。');
    }
    const updated = await updateGuide(guide.id, changes);
    setGuide(updated);
  }

  return (
    <div className="flex h-screen flex-col">
      <AppToaster />
      <EditorHeader
        operationActive={operationActive}
        editingDisabled={dataOperation !== null || permissionFlowActive}
        operation={recording.operation}
        steps={steps}
        sessionId={sessionId}
        onOpenPublish={() => { if (!isPermissionFlowLocked()) setPublishOpen(true); }}
        onReset={async () => { await refreshEditorData(); }}
      />
      <RecaptureProgressDialog
        open={recaptureActive}
        phase={recording.recapture?.phase ?? 'awaiting-target'}
        error={recaptureActive ? operationError : null}
        onFocusSource={() => void focusRecaptureSource()}
        onCancel={() => void cancelRecapture()}
      />
      <SourcePermissionDialog
        open={preparedPermission !== null}
        sourceOrigin={preparedPermission?.source.kind === 'origin' ? preparedPermission.source.sourceOrigin : ''}
        actionLabel={preparedPermission?.action.kind === 'continuation' ? '接續錄製' : '補拍'}
        pending={permissionPending}
        onContinueElsewhere={
          preparedPermission?.action.kind === 'continuation'
            ? () => void confirmContinueElsewhere()
            : undefined
        }
        continueElsewherePending={continueElsewherePending}
        continueElsewhereError={continueElsewhereError}
        sourceUnavailableReason={
          preparedPermission?.source.kind === 'unavailable' ? preparedPermission.source.reason : null
        }
        onCancel={clearPreparedPermission}
        onConfirm={() => void confirmPreparedPermission()}
      />
      {(error || dataError || (operationError && !recaptureActive)) && (
        <div className="border-b border-border bg-card px-7 py-3">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error ?? dataError ?? operationError}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1 pb-32 lg:pb-0">
        {guideLoadState === 'loading' ? (
          <main role="status" className="flex min-w-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            正在讀取教學…
          </main>
        ) : guideLoadState === 'missing' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="max-w-md text-muted-foreground">
              <AlertCircle className="mx-auto mb-3 size-8" aria-hidden="true" />
              <h2 className="font-semibold text-foreground">找不到這份教學</h2>
              <p className="mt-2 text-sm">
                {viewedSessionId
                  ? '這份教學可能已被刪除或網址已失效。為避免顯示其他錄製內容，編輯器不會自動切換到別份教學。'
                  : '編輯器網址缺少教學識別碼。請從 FrameTrail 作品庫重新開啟教學。'}
              </p>
            </div>
          </main>
        ) : guideLoadState === 'invalid' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="max-w-md text-muted-foreground">
              <AlertCircle className="mx-auto mb-3 size-8" aria-hidden="true" />
              <h2 className="font-semibold text-foreground">教學結構需要修復</h2>
              <p className="mt-2 text-sm">
                為避免遺漏、拆散或覆蓋步驟，FrameTrail 已停止載入與發佈這份教學。請先從作品庫匯出可編輯檔案，再重新開啟或復原內容。
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
              sections={guide?.sections}
              onSelect={selectEntrySafely}
              onRenameSection={renameSection}
              onDeleteSection={deleteSection}
              onReorder={handleReorderEntries}
              onContinueRecording={() => void handleContinueRecording()}
              reorderDisabled={operationActive || dataOperation !== null || permissionFlowActive}
            />
            {selectedEntry ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <StepStage
                  key={entryId(selectedEntry)}
                  entry={selectedEntry}
                  index={selectedIndex}
                  guideTitle={guide?.title}
                  guideTags={guide?.tags}
                  onTitleChange={(title) => updateGuideMetadata({ title })}
                  onTagsChange={(tags) => updateGuideMetadata({ tags })}
                  onChange={refresh}
                  onDelete={deleteEntry}
                  onDeleteAnnotation={handleDeleteAnnotation}
                  onZoom={() => setZoomOpen(true)}
                  onReorderAnnotations={(reordered) => handleReorderAnnotations(entryId(selectedEntry), reordered)}
                  onRecapture={handleRecapture}
                  onSetNumbered={setSelectedEntryNumbered}
                  editingDisabled={operationActive || dataOperation !== null || permissionFlowActive}
                />
                {visibleEntries.length > 1 && (
                  <StepStepper
                    current={selectedIndex + 1}
                    total={visibleEntries.length}
                    onPrev={() => selectEntrySafely(entryId(visibleEntries[selectedIndex - 1]))}
                    onNext={() => selectEntrySafely(entryId(visibleEntries[selectedIndex + 1]))}
                  />
                )}
              </div>
            ) : (
              <main className="flex min-w-0 flex-1 items-center justify-center p-8 pb-36 text-center lg:pb-8">
                <div className="max-w-sm text-muted-foreground">
                  <h2 className="font-semibold text-foreground">尚未選擇步驟</h2>
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
        onNavigate={(i) => selectEntrySafely(entryId(visibleEntries[i]))}
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
      {dataOperation && (
        <div
          role="status"
          className={`pointer-events-none fixed bottom-4 left-4 z-50 flex min-h-9 items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-[var(--shadow-menu)] ${entries.length > 0 ? 'max-lg:bottom-36' : ''}`}
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span className="min-w-0 truncate">{dataOperation}</span>
        </div>
      )}
      {undoAction && (
        <UndoSnackbar
          key={undoAction.id}
          message={undoAction.message}
          pending={dataOperation !== null}
          aboveMobileRail={entries.length > 0}
          onUndo={() => void handleUndo()}
          onDismiss={clearUndo}
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

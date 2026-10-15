import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, Library, Loader2 } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/use-recording-session';
import { useEditorGuideData } from '@/lib/editor/use-editor-guide-data';
import { EMPTY_STEP_ENTRIES } from '@/lib/editor/editor-app-model';
import { entryId, type StepEntry } from '@/lib/storage/models';
import { updateGuide } from '@/lib/storage/guide-repository';
import { type GuideStructureSnapshot } from '@/lib/storage/guide-structure';
import { DraftConfirmationRequiredError, EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/editor/EditorHeader';
import StepRail from '@/components/editor/StepRail';
import StepStage from '@/components/editor/StepStage';
import AppToaster from '@/components/shared/AppToaster';
import EmptyState from '@/components/shared/EmptyState';
import Mascot from '@/components/shared/Mascot';
import { Button } from '@/components/ui/button';
import Lightbox from '@/components/editor/Lightbox';
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
import { useEditorHandoff } from '@/lib/editor/use-editor-handoff';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import { t } from '@/lib/shared/i18n';
import {
  ackStepRecaptureResult,
  cancelStepRecapture,
  focusStepRecaptureSource,
  openLibrary,
} from '@/lib/runtime/actions';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
} from '@/lib/runtime/messages';
import { reportError } from '@/components/shared/report-error';

function EditorApp() {
  const viewedSessionId = useMemo(() => getEditorSessionIdFromUrl(window.location.href), []);
  const { sessionId, tabId, steps, error, dataError, refresh, recording } = useRecordingSession(viewedSessionId);
  const {
    guide,
    canonicalSnapshot,
    guideLoadState,
    reload,
    adoptGuide,
  } = useEditorGuideData(sessionId, steps);
  const operationBelongsToViewedGuide = Boolean(sessionId && recording.sessionId === sessionId);
  const operationActive = operationBelongsToViewedGuide && recording.operation !== null;
  const ordinaryRecordingActive = operationBelongsToViewedGuide && recording.operation === 'recording';
  const recaptureActive = operationBelongsToViewedGuide && recording.operation === 'recapture' && recording.recapture !== null;
  const { flushAll } = useEditorSaveRegistry();
  const dbEntries = canonicalSnapshot?.entries ?? EMPTY_STEP_ENTRIES;


  // Optimistic reorder state: shows the new order immediately, then resets to
  // null once the canonical DB entries change so we converge to the source of truth.
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
    continuationTabs,
    selectedContinuationTabId,
    selectContinuationTab,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    openContinueElsewhere,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
    continuationMode,
    setContinuationMode,
  } = usePermissionFlow({
    sessionId,
    operationActive,
    isDataOperationLocked: () => dataOperationLock.current,
    flushDescriptions,
    requireSelectedEntry,
    setOperationError,
    lastEntryMode: entries.at(-1)?.kind === 'group' ? 'snapshot' : 'steps',
  });

  const [publishOpen, setPublishOpen] = useState(false);
  const {
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setSelectedEntryId,
    setZoomOpen,
    selectEntry,
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

  // The two halves of "there is only ever one editor tab": register this page
  // with the background, and answer its handoff when asked to open a Guide already open here.
  useExtensionPageRegistration();
  useEditorHandoff({ viewedSessionId: sessionId, flushDescriptions, selectEntry });

  // A lightbox with no entry to show must not stay armed, or it would pop open
  // unexpectedly once entries reappear (e.g. after a deletion or Guide reload).
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
        setOperationError(result.status === 'failed' ? result.message ?? t().editor.recaptureFailed : null);
        if (result.status === 'replaced') {
          toast.success(t().editor.recaptureReplaced);
        } else if (result.status === 'cancelled') {
          toast(t().editor.recaptureCancelled);
        }
      } catch (presentError) {
        // The run already settled in storage; only presenting its outcome failed,
        // so surface that instead of silently dropping it.
        console.error('[stepmark] failed to present the recapture result', presentError);
        setOperationError(t().editor.recapturePresentFailed);
      } finally {
        await ackStepRecaptureResult(result.runId, result.sessionId).catch((ackError) => {
          console.warn('[stepmark] failed to acknowledge the recapture result', ackError);
        });
      }
    })();
  }, [recording.recaptureResult, refresh, sessionId, setSelectedEntryId, setZoomOpen]);

  async function flushDescriptions(): Promise<void> {
    try {
      await flushAll();
    } catch (saveError) {
      console.error('[stepmark] failed to save descriptions before an editor operation', saveError);
      // A pending draft confirmation carries its own user-facing message; only
      // genuine save failures get the generic retry wording.
      setOperationError(
        saveError instanceof DraftConfirmationRequiredError
          ? saveError.message
          : t().editor.descriptionSaveRetry,
      );
      throw saveError;
    }
  }

  /** Leaving the tab for another page is safe only once every description is
   * saved; a failure is already in the banner, so the editor just stays. */
  async function leaveEditor(): Promise<boolean> {
    try {
      await flushDescriptions();
      return true;
    } catch {
      return false;
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
      throw new Error(t().editor.selectedEntryMissing);
    }
    return selectedEntry;
  }

  // `selectEntry` propagates genuine save failures (it swallows only the
  // pending-confirmation case); fill the banner only when nothing else already surfaced one.
  function selectEntrySafely(id: string): void {
    void selectEntry(id).catch((selectionError) => {
      console.error('[stepmark] failed to switch steps', selectionError);
      setOperationError((current) => current ?? t().editor.selectFailed);
    });
  }

  // Load/fallback semantics live in useEditorGuideData; this only prepends the
  // recording-session refresh so steps and structure move together.
  async function refreshEditorData(): Promise<GuideStructureSnapshot | null> {
    await refresh();
    return reload();
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
    adoptGuide,
    requireSelectedEntry,
    setSelectedEntryId,
    setZoomOpen,
    setOperationError,
    undoAction,
    offerUndo,
    clearUndo,
  });

  /** Shared shape of the two recapture controls: resolve the live run id,
   * send the typed control message, and surface any failure in the dialog. */
  async function runRecaptureControl(
    label: string,
    send: (runId: string) => Promise<FocusStepRecaptureSourceResult | CancelStepRecaptureResult>,
    fallback: string,
  ): Promise<void> {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    try {
      const result = await send(runId);
      if (!result.ok) setOperationError(result.error ?? fallback);
    } catch (error) {
      setOperationError(reportError(label, error, fallback));
    }
  }

  const focusRecaptureSource = () =>
    runRecaptureControl('[stepmark] failed to focus the recapture tab', focusStepRecaptureSource, t().editor.recaptureTabMissing);

  const cancelRecapture = () =>
    runRecaptureControl('[stepmark] failed to cancel recapture', cancelStepRecapture, t().editor.recaptureCancelFailed);

  async function publicationEntries(signal: AbortSignal) {
    if (!sessionId) throw new Error(t().editor.publishTargetMissing);
    if (!beginDataOperation(t().editor.preparingPublication)) {
      throw new Error(t().editor.publishBusy);
    }
    try {
      await flushDescriptions();
      throwIfAborted(signal);
      const snapshot = await reload();
      if (!snapshot) throw new Error(t().editor.publishTargetMissing);
      throwIfAborted(signal);
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

  // Rejects instead of reporting through `operationError`: the caller's input
  // must roll back to the stored value, so it needs the failure directly.
  async function updateGuideMetadata(changes: { title?: string; tags?: string[] }): Promise<void> {
    if (!guide) throw new Error(t().editor.editTargetMissing);
    if (isPermissionFlowLocked() || dataOperationLock.current || operationActive) {
      throw new Error(t().editor.editBusy);
    }
    const updated = await updateGuide(guide.id, changes);
    adoptGuide(updated);
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
        guideTitle={guide?.title ?? null}
        guideActionsAvailable={guideLoadState !== 'missing'}
        beforeNavigate={leaveEditor}
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
        actionLabel={preparedPermission?.action.kind === 'continuation' ? t().editor.continuationAction : t().editor.recaptureAction}
        pending={permissionPending}
        onContinueElsewhere={
          preparedPermission?.action.kind === 'continuation'
            ? () => void openContinueElsewhere()
            : undefined
        }
        continueElsewherePending={continueElsewherePending}
        continueElsewhereError={continueElsewhereError}
        continuationTabs={continuationTabs}
        selectedContinuationTabId={selectedContinuationTabId}
        onSelectContinuationTab={selectContinuationTab}
        onConfirmContinueElsewhere={() => void confirmContinueElsewhere()}
        sourceUnavailableReason={
          preparedPermission?.source.kind === 'unavailable' ? preparedPermission.source.reason : null
        }
        continuationMode={preparedPermission?.action.kind === 'continuation' ? continuationMode : undefined}
        onContinuationModeChange={setContinuationMode}
        onCancel={clearPreparedPermission}
        onConfirm={() => void confirmPreparedPermission()}
      />
      {(error || dataError || (operationError && !recaptureActive)) && (
        <div className="border-b-2 border-border bg-card px-3 py-3 sm:px-7">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error ?? dataError ?? operationError}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1 pb-32 lg:pb-0">
        {guideLoadState === 'loading' ? (
          <main role="status" className="flex min-w-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {t().editor.loading}
          </main>
        ) : guideLoadState === 'missing' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="flex max-w-md flex-col items-center text-muted-foreground">
              <Mascot className="mb-4 size-16" />
              <h2 className="text-lg font-bold text-foreground">{t().editor.missingTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed">
                {viewedSessionId
                  ? t().editor.missingDeleted
                  : t().editor.missingId}
              </p>
              <Button variant="outline" className="mt-5" onClick={() => void openLibrary()}>
                <Library />{t().common.backToLibrary}
              </Button>
            </div>
          </main>
        ) : guideLoadState === 'invalid' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="flex max-w-md flex-col items-center text-muted-foreground">
              <span className="mb-4 flex size-14 items-center justify-center rounded-full border-2 border-border bg-warning-soft">
                <AlertCircle className="size-6 text-foreground" aria-hidden="true" />
              </span>
              <h2 className="text-lg font-bold text-foreground">{t().editor.invalidTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed">
                {t().editor.invalidBody}
              </p>
            </div>
          </main>
        ) : entries.length === 0 ? (
          <EmptyState isRecording={ordinaryRecordingActive} recordingTabId={tabId} />
        ) : (
          <>
            <StepRail
              entries={entries}
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
            ) : (
              <main className="flex min-w-0 flex-1 items-center justify-center p-8 pb-36 text-center lg:pb-8">
                <div className="max-w-sm text-muted-foreground">
                  <h2 className="text-lg font-bold text-foreground">{t().editor.noSelectionTitle}</h2>
                  <p className="mt-2 text-sm">{t().editor.noSelectionBody}</p>
                </div>
              </main>
            )}
          </>
        )}
      </div>
      <Lightbox
        entries={entries}
        index={zoomOpen ? selectedIndex : null}
        onClose={() => setZoomOpen(false)}
        onNavigate={(i) => selectEntrySafely(entryId(entries[i]))}
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
          className={`pointer-events-none fixed bottom-4 left-4 z-50 flex min-h-9 items-center gap-2 rounded-full border-2 border-border bg-card px-3.5 py-1.5 text-xs font-bold text-foreground ${entries.length > 0 ? 'max-lg:bottom-36' : ''}`}
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

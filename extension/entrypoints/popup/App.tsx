import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, Library } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/use-recording-session';
import { Alert, AlertDescription } from '@/components/ui/alert';
import OpenEditorButton from '@/components/popup/OpenEditorButton';
import RecordControls from '@/components/popup/RecordControls';
import ResetButton from '@/components/shared/ResetButton';
import { Button, buttonVariants } from '@/components/ui/button';
import BrandMark from '@/components/shared/BrandMark';
import { cn } from '@/lib/shared/utils';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import type { OpenEditorResult } from '@/lib/runtime/messages';
import { openLibrary } from '@/lib/runtime/actions';
import { ensureSelectedGuide } from '@/lib/guide/guide-actions';
import { getGuide } from '@/lib/storage/guide-repository';
import { reportError } from '@/components/shared/report-error';
import { isOpenEditorResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { t } from '@/lib/shared/i18n';

function App() {
  // Opts out of step reads: the full hook re-fetches every step (screenshot
  // Blobs included) on each state change, which a 320px popup never shows.
  const { recording, isRecording, sessionId, error, recoverableError, dataError } =
    useRecordingSession(undefined, { withSteps: false });
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  // Whether the reset target holds any content. `recording.itemCount` cannot answer
  // this since it's per-run and zeroed on finish; the guide row's counts are metadata-only.
  const [hasGuideContent, setHasGuideContent] = useState(false);
  const editorRecovery = needsEditorRecovery(recoverableError);

  useEffect(() => {
    if (!sessionId) {
      setHasGuideContent(false);
      return;
    }
    let active = true;
    void getGuide(sessionId)
      .then((guide) => {
        if (active) setHasGuideContent(Boolean(guide) && (guide!.entryCount > 0 || guide!.stepCount > 0));
      })
      .catch((readError) => {
        // Fail open: the confirm dialog and background guard still protect the
        // action, while failing closed would strand a real reset need.
        console.error('[frametrail] failed to read guide summary', readError);
        if (active) setHasGuideContent(true);
      });
    return () => {
      active = false;
    };
    // phase re-runs the read after a run finishes and bumps the counts.
  }, [sessionId, recording.phase]);

  async function openLibraryView() {
    setEditorOpenError(null);
    try {
      await openLibrary();
      window.close();
    } catch (navigationError) {
      console.error('[frametrail] failed to open library', navigationError);
      setEditorOpenError(t().popup.libraryOpenFailed);
    }
  }

  async function openEditor() {
    if (openingEditor) return;
    setOpeningEditor(true);
    setEditorOpenError(null);
    try {
      // Recovery must return to the operation owner; normal navigation resolves the
      // current UI selection afresh so an idle popup never opens a guide-less editor.
      const targetSessionId = editorRecovery
        ? sessionId
        : (await ensureSelectedGuide()).id;
      const result = requireRuntimeMessageResult<OpenEditorResult>(
        await browser.runtime.sendMessage({
          type: 'OPEN_EDITOR',
          sessionId: targetSessionId ?? undefined,
        }),
        isOpenEditorResult,
        t().popup.editorServiceUnavailable,
      );
      if (!result.ok) {
        setEditorOpenError(result.error);
        return;
      }
      window.close();
    } catch (openError) {
      setEditorOpenError(
        reportError('[frametrail] failed to request editor navigation', openError, t().runtime.editorOpenFailed),
      );
    } finally {
      setOpeningEditor(false);
    }
  }

  function handleStarted() {
    window.close();
  }

  return (
    <div className="flex w-[320px] flex-col gap-4 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <BrandMark />
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full border-2 px-2.5 py-0.5 text-xs font-bold',
            recording.phase === 'starting'
              ? 'border-border bg-tamago text-on-accent'
              : isRecording
                ? 'border-recording bg-danger-soft text-danger'
                : 'border-border bg-secondary text-foreground',
          )}
        >
          {isRecording && recording.phase !== 'starting' && (
            <span className="size-1.5 rounded-full bg-recording" aria-hidden="true" />
          )}
          {recording.phase === 'starting' ? t().popup.status.starting : isRecording ? t().popup.status.recording : t().popup.status.idle}
        </span>
      </div>

      {(editorOpenError || recoverableError?.message || error || dataError) && !isRecording && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{editorOpenError ?? recoverableError?.message ?? error ?? dataError}</AlertDescription>
        </Alert>
      )}

      <RecordControls
        recording={recording}
        onStarted={handleStarted}
        onOpenEditor={openEditor}
        openingEditor={openingEditor}
      />

      {/* Hidden while a run is live: RecordControls already offers the editor as
          its secondary exit, and a mid-recording reset would fail anyway. */}
      {!editorRecovery && !isRecording && <div className="h-0.5 w-full rounded-full bg-border-soft" aria-hidden="true" />}

      {!editorRecovery && !isRecording && (
        <div className="flex flex-col gap-2">
          <OpenEditorButton
            label={t().common.openEditor}
            pending={openingEditor}
            onOpen={openEditor}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={() => void openLibraryView()} className="w-full">
              <Library />{t().common.library}
            </Button>
            <ResetButton hasSteps={hasGuideContent} sessionId={sessionId} variant="outline" className="h-8 w-full px-3 text-[13px]" />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

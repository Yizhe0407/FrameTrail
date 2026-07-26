import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, Library, Loader2, PencilLine } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/useRecordingSession';
import { Alert, AlertDescription } from '@/components/ui/alert';
import RecordControls from '@/components/popup/RecordControls';
import ResetButton from '@/components/shared/ResetButton';
import { Button } from '@/components/ui/button';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import type { OpenEditorResult, RecordingMode } from '@/lib/runtime/messages';
import { openLibrary } from '@/lib/runtime/navigation';
import { ensureSelectedGuide } from '@/lib/guide/guide-actions';
import { getGuide } from '@/lib/storage/db';
import OnboardingDialog from '@/components/popup/OnboardingDialog';
import { markOnboardingComplete, openLocalPracticePage, shouldShowOnboarding } from '@/lib/runtime/onboarding';
import { isOpenEditorResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';

function App() {
  // The popup renders state fields only, so it opts out of step reads: the
  // full hook re-fetches every step (screenshot Blobs included) on each state
  // change plus a periodic reconcile tick, which a 320px popup never shows.
  const { recording, isRecording, sessionId, error, recoverableError, dataError } =
    useRecordingSession(undefined, { withSteps: false });
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Whether the reset target holds any content. `recording.itemCount` cannot
  // answer this: it is per-run and zeroed when a run finishes, while the guide
  // row's denormalized counts are a metadata-only read (no screenshot Blobs).
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
        // Fail open: the confirm dialog and the background guard still protect
        // the action, while failing closed would strand a real reset need.
        console.error('[frametrail] failed to read guide summary', readError);
        if (active) setHasGuideContent(true);
      });
    return () => {
      active = false;
    };
    // phase re-runs the read after a run finishes and bumps the counts.
  }, [sessionId, recording.phase]);

  useEffect(() => {
    let active = true;

    void shouldShowOnboarding()
      .then((show) => {
        if (active) setOnboardingOpen(show);
      })
      .catch((onboardingError) => {
        // If local storage is temporarily unavailable, prefer showing the
        // self-contained guide over silently hiding first-run help.
        console.error('[frametrail] failed to read onboarding state', onboardingError);
        if (active) setOnboardingOpen(true);
      });

    return () => {
      active = false;
    };
  }, []);

  // Guards double persistence: footer actions persist through onComplete and
  // then close the dialog, which triggers the dismissal path below again.
  const onboardingPersisted = useRef(false);

  async function completeOnboarding() {
    if (onboardingPersisted.current) return;
    onboardingPersisted.current = true;
    try {
      await markOnboardingComplete();
    } catch (persistError) {
      onboardingPersisted.current = false;
      throw persistError;
    }
  }

  function handleOnboardingOpenChange(open: boolean) {
    setOnboardingOpen(open);
    // Any explicit dismissal (X, ESC, outside click) counts as "seen".
    // Re-opening the guide on every popup visit until a footer button is
    // pressed would punish the standard close affordances. A failed write only
    // logs — the dialog is already closing and will simply show again next time.
    if (!open) {
      void completeOnboarding().catch((persistError) => {
        console.error('[frametrail] failed to persist onboarding dismissal', persistError);
      });
    }
  }

  async function startPractice(mode: RecordingMode) {
    await openLocalPracticePage(mode);
    window.close();
  }

  async function openLibraryView() {
    setEditorOpenError(null);
    try {
      await openLibrary();
      window.close();
    } catch (navigationError) {
      console.error('[frametrail] failed to open library', navigationError);
      setEditorOpenError('無法開啟作品庫，請再試一次。');
    }
  }

  async function openEditor() {
    if (openingEditor) return;
    setOpeningEditor(true);
    setEditorOpenError(null);
    try {
      // Recovery must return to the operation owner. Normal navigation resolves
      // the current UI selection afresh so an idle popup never opens a
      // guide-less editor or falls back to stale recording state.
      const targetSessionId = editorRecovery
        ? sessionId
        : (await ensureSelectedGuide()).id;
      const result = requireRuntimeMessageResult<OpenEditorResult>(
        await browser.runtime.sendMessage({
          type: 'OPEN_EDITOR',
          sessionId: targetSessionId ?? undefined,
        }),
        isOpenEditorResult,
        '無法連接編輯器服務，請重新開啟 FrameTrail 後再試一次。',
      );
      if (!result.ok) {
        setEditorOpenError(result.error);
        return;
      }
      window.close();
    } catch (openError) {
      console.error('[frametrail] failed to request editor navigation', openError);
      setEditorOpenError(
        openError instanceof Error ? openError.message : '無法開啟編輯器，請再試一次。',
      );
    } finally {
      setOpeningEditor(false);
    }
  }

  function handleStarted() {
    window.close();
  }

  return (
    <div className="flex w-[320px] flex-col gap-[18px] border border-border/80 bg-card p-[22px_20px] dark:border-white/10">
      <OnboardingDialog
        open={onboardingOpen}
        onOpenChange={handleOnboardingOpenChange}
        onComplete={completeOnboarding}
        onStartPractice={startPractice}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[9px]">
          <span className="text-[14px] font-bold text-foreground dark:text-white">FrameTrail</span>
          <span className="size-[5px] rounded-full bg-brand" aria-hidden="true" />
        </div>
        <span className="text-[11px] font-semibold text-muted-foreground/80 dark:text-white/45">
          {recording.phase === 'starting' ? '準備中' : isRecording ? '錄製中' : '待命'}
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

      {/* Hidden while a run is live: RecordControls already offers the editor
          as its secondary exit, and the background rejects a mid-recording
          reset anyway, so this block would only duplicate one button and
          dangle another that cannot succeed. */}
      {!editorRecovery && !isRecording && <div className="h-[1px] w-full bg-border/80 dark:bg-white/10" aria-hidden="true" />}

      {!editorRecovery && !isRecording && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-[8px] rounded-md border border-border/80 bg-card py-[11px] text-[13px] font-medium text-foreground transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-50 dark:border-white/14 dark:bg-transparent dark:text-white dark:hover:bg-white/8"
            onClick={() => void openEditor()}
            disabled={openingEditor}
          >
            {openingEditor ? <Loader2 className="size-[15px] animate-spin" /> : <PencilLine className="size-[15px]" />}
            {openingEditor ? '正在開啟編輯器' : '開啟編輯器'}
          </button>
          <div className="grid grid-cols-2 gap-[8px]">
            <Button
              variant="outline"
              onClick={() => void openLibraryView()}
              className="w-full justify-center rounded-md border-border/80 py-[10px] text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-secondary dark:border-white/14 dark:bg-transparent dark:text-white/70 dark:hover:bg-white/8 dark:hover:text-white"
            >
              <Library className="size-[14px]" />作品庫
            </Button>
            <ResetButton hasSteps={hasGuideContent} sessionId={sessionId} variant="outline" className="w-full justify-center rounded-md border-border/80 py-[10px] text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-danger-soft hover:border-danger/35 hover:text-danger dark:border-white/14 dark:bg-transparent dark:text-white/70" />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

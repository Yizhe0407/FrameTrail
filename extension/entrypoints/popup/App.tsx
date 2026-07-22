import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, CircleHelp, Library, PencilLine } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import RecordControls from '@/components/RecordControls';
import ResetButton from '@/components/ResetButton';
import ExportImagesButton from '@/components/ExportImagesButton';
import { needsEditorRecovery } from '@/lib/recording-recovery';
import type { OpenEditorResult, RecordingMode } from '@/lib/messages';
import { openLibrary } from '@/lib/navigation';
import { ensureSelectedGuide } from '@/lib/guide-actions';
import OnboardingDialog from '@/components/OnboardingDialog';
import { markOnboardingComplete, openLocalPracticePage, shouldShowOnboarding } from '@/lib/onboarding';
import { isOpenEditorResult, requireRuntimeMessageResult } from '@/lib/runtime-message-result';

function App() {
  const { recording, isRecording, sessionId, steps, error, recoverableError } = useRecordingSession();
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const editorRecovery = needsEditorRecovery(recoverableError);

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

  async function completeOnboarding() {
    await markOnboardingComplete();
  }

  async function startPractice(mode: RecordingMode) {
    await openLocalPracticePage(mode);
    window.close();
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
    <div className="flex w-80 flex-col gap-5 bg-stone-50 px-5 py-5 dark:bg-stone-900">
      <OnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
        onComplete={completeOnboarding}
        onStartPractice={startPractice}
      />
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-base font-semibold text-stone-900 dark:text-stone-50">FrameTrail</h1>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-50"
            onClick={() => setOnboardingOpen(true)}
          >
            <CircleHelp />
            教學
          </Button>
          <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
            {recording.phase === 'starting' ? '準備中' : isRecording ? '錄製中' : '待命'}
          </span>
        </div>
      </div>

      {(editorOpenError || recoverableError?.message || error) && !isRecording && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{editorOpenError ?? recoverableError?.message ?? error}</AlertDescription>
        </Alert>
      )}

      <RecordControls
        recording={recording}
        onStarted={handleStarted}
        onOpenEditor={openEditor}
        openingEditor={openingEditor}
      />

      {!editorRecovery && <Separator className="bg-stone-200 dark:bg-stone-700" />}

      {!editorRecovery && <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
            onClick={openEditor}
          >
            <PencilLine />
            編輯器
          </Button>
          <Button
            variant="outline"
            className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
            onClick={() => void openLibrary().then(() => window.close())}
          >
            <Library />
            作品庫
          </Button>
        </div>
        {!isRecording && steps.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <ExportImagesButton
              steps={steps}
              className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
            />
            <ResetButton hasSteps sessionId={sessionId} variant="outline" className="w-full" />
          </div>
        )}
      </div>}
    </div>
  );
}

export default App;

import { useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, PencilLine } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import RecordControls from '@/components/RecordControls';
import ResetButton from '@/components/ResetButton';
import ExportImagesButton from '@/components/ExportImagesButton';
import { needsEditorRecovery } from '@/lib/recording-recovery';
import type { OpenEditorResult } from '@/lib/messages';

function App() {
  const { recording, isRecording, steps, error, recoverableError } = useRecordingSession();
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  const editorRecovery = needsEditorRecovery(recoverableError);

  async function openEditor() {
    if (openingEditor) return;
    setOpeningEditor(true);
    setEditorOpenError(null);
    try {
      const result = await browser.runtime.sendMessage({ type: 'OPEN_EDITOR' }) as OpenEditorResult;
      if (!result.ok) {
        setEditorOpenError(result.error);
        return;
      }
      window.close();
    } catch (openError) {
      console.error('[frametrail] failed to request editor navigation', openError);
      setEditorOpenError('無法開啟編輯器，請再試一次。');
    } finally {
      setOpeningEditor(false);
    }
  }

  function handleStarted() {
    window.close();
  }

  return (
    <div className="flex w-80 flex-col gap-5 bg-stone-50 px-5 py-5 dark:bg-stone-900">
      <div className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-stone-900 dark:text-stone-50">FrameTrail</h1>
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
          {recording.phase === 'starting' ? '準備中' : isRecording ? '錄製中' : '待命'}
        </span>
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
        <Button
          variant="outline"
          className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
          onClick={openEditor}
        >
          <PencilLine />
          開啟編輯器
        </Button>
        {!isRecording && steps.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <ExportImagesButton
              steps={steps}
              className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
            />
            <ResetButton hasSteps variant="outline" className="w-full" />
          </div>
        )}
      </div>}
    </div>
  );
}

export default App;

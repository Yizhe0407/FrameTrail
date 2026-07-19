import { browser } from 'wxt/browser';
import { AlertCircle, PencilLine } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import RecordControls from '@/components/RecordControls';
import ResetButton from '@/components/ResetButton';
import ExportImagesButton from '@/components/ExportImagesButton';

function App() {
  const { recording, isRecording, steps, error, recoverableError } = useRecordingSession();

  async function openEditor() {
    const url = browser.runtime.getURL('/editor.html');
    const [existing] = await browser.tabs.query({ url: `${url}*` });
    if (existing?.id != null) {
      const tab = await browser.tabs.update(existing.id, { active: true });
      if (tab?.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
    } else {
      await browser.tabs.create({ url });
    }
    window.close();
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

      {(recoverableError?.message || error) && !isRecording && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{recoverableError?.message ?? error}</AlertDescription>
        </Alert>
      )}

      <RecordControls recording={recording} onStarted={handleStarted} />

      <Separator className="bg-stone-200 dark:bg-stone-700" />

      <div className="flex flex-col gap-2">
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
      </div>
    </div>
  );
}

export default App;

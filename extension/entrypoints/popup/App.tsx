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
  const { isRecording, steps, error } = useRecordingSession();

  function openEditor() {
    browser.tabs.create({ url: browser.runtime.getURL('/editor.html') });
  }

  function handleStarted() {
    window.close();
  }

  return (
    <div className="flex w-80 flex-col gap-5 bg-stone-50 px-5 py-6 dark:bg-stone-900">
      <div className="flex items-baseline justify-between">
        <h1 className="text-sm font-semibold tracking-[.02em] text-stone-800 dark:text-stone-100">FrameTrail</h1>
        <span className="text-[11px] tracking-[.14em] text-stone-400 dark:text-stone-500">
          {isRecording ? '錄製中' : '待命'}
        </span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RecordControls isRecording={isRecording} onStarted={handleStarted} />

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
        <div className="grid grid-cols-2 gap-2">
          <ExportImagesButton
            steps={steps}
            className="w-full border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
          />
          <ResetButton hasSteps={steps.length > 0} variant="outline" className="w-full" />
        </div>
      </div>
    </div>
  );
}

export default App;

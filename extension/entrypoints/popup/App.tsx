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
    <div className="w-[320px] space-y-3 p-4">
      <h1 className="text-base font-semibold tracking-tight">FrameTrail</h1>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RecordControls isRecording={isRecording} onStarted={handleStarted} />

      <Separator />

      <div className="space-y-2">
        <Button variant="outline" className="w-full" onClick={openEditor}>
          <PencilLine />
          編輯器
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <ExportImagesButton steps={steps} className="w-full" />
          <ResetButton hasSteps={steps.length > 0} className="w-full" />
        </div>
      </div>
    </div>
  );
}

export default App;

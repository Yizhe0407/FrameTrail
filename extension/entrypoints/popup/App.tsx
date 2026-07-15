import { browser } from 'wxt/browser';
import { PencilLine } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import { countSteps } from '@/lib/db';
import { Button } from '@/components/ui/button';
import RecordControls from '@/components/RecordControls';
import ResetButton from '@/components/ResetButton';
import ExportImagesButton from '@/components/ExportImagesButton';
import type { RecordingMode } from '@/lib/messages';

function App() {
  const { isRecording, steps, error } = useRecordingSession();
  const stepCount = countSteps(steps);

  function openEditor() {
    browser.tabs.create({ url: browser.runtime.getURL('/editor.html') });
  }

  function handleStopped(mode: RecordingMode) {
    // Single-image mode stays on the current page instead of jumping to the
    // editor — the user asked for recording to end without being yanked away.
    if (mode === 'multi') openEditor();
    window.close();
  }

  function handleStarted() {
    window.close();
  }

  return (
    <div className="w-[300px] space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">FrameTrail</h1>
        <span className="text-muted-foreground text-xs">{stepCount} 步驟</span>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <RecordControls isRecording={isRecording} onStarted={handleStarted} onStopped={handleStopped} />

      <div className="flex flex-wrap items-center gap-2">
        <ResetButton hasSteps={steps.length > 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ExportImagesButton steps={steps} />
      </div>

      <Button variant="ghost" size="sm" className="w-full" onClick={openEditor}>
        <PencilLine />
        編輯器
      </Button>
    </div>
  );
}

export default App;

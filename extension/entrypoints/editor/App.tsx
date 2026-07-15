import { useRecordingSession } from '@/lib/useRecordingSession';
import { countSteps } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import StepList from '@/components/StepList';
import ExportImagesButton from '@/components/ExportImagesButton';
import ResetButton from '@/components/ResetButton';

function App() {
  const { isRecording, sessionId, steps, error, refresh } = useRecordingSession();
  const stepCount = countSteps(steps);

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold">編輯器</h1>
            <Badge variant="secondary">{stepCount} 步驟</Badge>
            {isRecording && (
              <Badge variant="destructive" className="gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-white" />
                錄製中
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ResetButton hasSteps={steps.length > 0} className="w-full" />
            <ExportImagesButton steps={steps} className="w-full" />
          </div>
        </div>
        {error && <p className="mx-auto max-w-3xl px-6 pb-3 text-sm text-destructive">{error}</p>}
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <StepList steps={steps} sessionId={sessionId} onChange={refresh} large />
      </main>
    </div>
  );
}

export default App;

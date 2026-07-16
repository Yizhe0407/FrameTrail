import { AlertCircle } from 'lucide-react';
import { useRecordingSession } from '@/lib/useRecordingSession';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import StepList from '@/components/StepList';
import ExportImagesButton from '@/components/ExportImagesButton';
import ResetButton from '@/components/ResetButton';

function App() {
  const { isRecording, sessionId, steps, error, refresh } = useRecordingSession();

  return (
    <div className="bg-muted/40 min-h-screen">
      <header className="bg-background/95 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight">FrameTrail 編輯器</h1>
            {isRecording && (
              <Badge variant="destructive" className="gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-white" />
                錄製中
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ResetButton hasSteps={steps.length > 0} />
            <ExportImagesButton steps={steps} variant="default" />
          </div>
        </div>
        {error && (
          <div className="mx-auto max-w-4xl px-6 pb-3">
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        <StepList steps={steps} sessionId={sessionId} onChange={refresh} />
      </main>
    </div>
  );
}

export default App;

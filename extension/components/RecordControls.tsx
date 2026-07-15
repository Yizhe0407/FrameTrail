import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Circle, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RecordingMode } from '@/lib/messages';

interface Props {
  isRecording: boolean;
  /** Called after the STOP_RECORDING message resolves, with the mode that was
   * just recorded — e.g. the popup uses this to jump straight to the editor
   * tab, but only for the per-click mode (single-image mode stays put so the
   * user isn't yanked away right after finishing). */
  onStopped?: (mode: RecordingMode) => void;
  /** Called after the START_RECORDING message resolves — e.g. the popup uses
   * this to close itself so it doesn't sit in the way while recording. */
  onStarted?: () => void;
  className?: string;
}

export default function RecordControls({ isRecording, onStopped, onStarted, className }: Props) {
  const [mode, setMode] = useState<RecordingMode>('multi');
  const [numbered, setNumbered] = useState(true);

  const start = async () => {
    await browser.runtime.sendMessage({ type: 'START_RECORDING', mode, numbered });
    onStarted?.();
  };
  const stop = async () => {
    await browser.runtime.sendMessage({ type: 'STOP_RECORDING' });
    onStopped?.(mode);
  };

  return (
    <div className={cn('space-y-2', className)}>
      {!isRecording && (
        <div className="space-y-1.5">
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('multi')}
              className={cn(
                'rounded px-2 py-1 transition-colors',
                mode === 'multi' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              逐步模式
            </button>
            <button
              type="button"
              onClick={() => setMode('single')}
              className={cn(
                'rounded px-2 py-1 transition-colors',
                mode === 'single' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              單張圖模式
            </button>
          </div>
          {mode === 'single' && (
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} />
              標記順序編號
            </label>
          )}
        </div>
      )}

      {isRecording ? (
        <Button variant="destructive" size="sm" onClick={stop}>
          <Square className="fill-current" />
          停止錄製
        </Button>
      ) : (
        <Button size="sm" onClick={start}>
          <Circle className="fill-red-500 text-red-500" />
          開始錄製
        </Button>
      )}
    </div>
  );
}

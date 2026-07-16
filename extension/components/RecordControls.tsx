import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Circle, Info, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { RecordingMode } from '@/lib/messages';

interface Props {
  isRecording: boolean;
  /** Called after the START_RECORDING message resolves — e.g. the popup uses
   * this to close itself so it doesn't sit in the way while recording. */
  onStarted?: () => void;
  className?: string;
}

const MODES: { value: RecordingMode; label: string; description: string }[] = [
  { value: 'steps', label: '步驟模式', description: '每次點擊各自截一張圖，適合逐步操作教學。' },
  { value: 'snapshot', label: '快照模式', description: '所有點擊疊標在同一張截圖，適合單畫面重點標註。' },
];

export default function RecordControls({ isRecording, onStarted, className }: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [numbered, setNumbered] = useState(true);

  const start = async () => {
    await browser.runtime.sendMessage({ type: 'START_RECORDING', mode, numbered });
    onStarted?.();
  };
  const stop = async () => {
    await browser.runtime.sendMessage({ type: 'STOP_RECORDING' });
  };

  const activeMode = MODES.find((m) => m.value === mode)!;

  return (
    <div className={cn('space-y-3', className)}>
      {!isRecording && (
        <div className="space-y-2">
          <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
                className={cn(
                  'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                  mode === m.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          <p className="text-muted-foreground px-0.5 text-xs leading-snug">{activeMode.description}</p>

          {mode === 'snapshot' && (
            <div className="space-y-2">
              <label className="border-input flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2">
                <span className="text-sm font-medium">標記順序編號</span>
                <Switch checked={numbered} onCheckedChange={setNumbered} />
              </label>
              <p className="text-muted-foreground bg-muted/60 flex items-start gap-1.5 rounded-md px-2.5 py-2 text-[11px] leading-snug">
                <Info className="mt-px size-3.5 shrink-0" />
                <span>錄製期間會凍結頁面互動：點擊不會真的觸發連結／按鈕／JS，僅用於標註。</span>
              </p>
            </div>
          )}
        </div>
      )}

      {isRecording ? (
        <div className="space-y-2">
          <Button variant="destructive" className="w-full" onClick={stop}>
            <Square className="fill-current" />
            停止錄製
          </Button>
          <p className="text-muted-foreground flex items-center justify-center gap-2 text-xs">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-red-500" />
            </span>
            錄製中，請在頁面上點擊要記錄的元素
          </p>
        </div>
      ) : (
        <Button className="w-full" onClick={start}>
          <Circle className="size-3 fill-red-500 text-red-500" />
          開始錄製
        </Button>
      )}
    </div>
  );
}

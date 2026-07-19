import { useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, Info, Loader2, Square } from 'lucide-react';
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
  { value: 'steps', label: '步驟模式', description: '滑過任意可見元素會先預覽，選取後各自截一張圖。' },
  { value: 'snapshot', label: '快照模式', description: '滑過任意可見元素會先預覽，選取後疊標在同一張圖。' },
];

export default function RecordControls({ isRecording, onStarted, className }: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [numbered, setNumbered] = useState(true);
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  const start = async () => {
    if (pendingAction) return;
    setPendingAction('start');
    setControlError(null);
    try {
      try {
        const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
        setPermissionNotice(
          granted
            ? null
            : mode === 'steps'
              ? '未授予全站權限；本頁仍可錄製，但導覽到新頁面後可能需要重新開始。'
              : '未授予全站權限；主頁面仍可錄製，跨網域內嵌頁面會改標記整個區塊。',
        );
      } catch (err) {
        console.warn('請求可選的全站權限失敗，繼續使用 activeTab 錄製', err);
        setPermissionNotice(
          mode === 'steps'
            ? '無法取得全站權限；本頁仍可錄製，但導覽到新頁面後可能需要重新開始。'
            : '無法取得全站權限；跨網域內嵌頁面會改標記整個區塊。',
        );
      }
      await browser.runtime.sendMessage({ type: 'START_RECORDING', mode, numbered });
      onStarted?.();
    } catch (err) {
      console.error('開始錄製失敗', err);
      setControlError('無法開始錄製，請重新整理頁面後再試一次。');
    } finally {
      setPendingAction(null);
    }
  };
  const stop = async () => {
    if (pendingAction) return;
    setPendingAction('stop');
    setControlError(null);
    try {
      await browser.runtime.sendMessage({ type: 'STOP_RECORDING' });
    } catch (err) {
      console.error('停止錄製失敗', err);
      setControlError('無法停止錄製，請再試一次。');
    } finally {
      setPendingAction(null);
    }
  };

  const activeMode = MODES.find((m) => m.value === mode)!;

  return (
    <div className={cn('space-y-3', className)}>
      {permissionNotice && (
        <p role="status" className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>{permissionNotice}</span>
        </p>
      )}
      {controlError && (
        <p role="alert" className="flex items-start gap-1.5 rounded-md bg-red-50 px-2.5 py-2 text-[11px] leading-snug text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span>{controlError}</span>
        </p>
      )}
      {!isRecording && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-[10px] bg-stone-100 p-1 dark:bg-stone-800">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
                className={cn(
                  'rounded-[7px] px-2 py-1.5 text-xs font-medium transition-colors',
                  mode === m.value
                    ? 'bg-white text-stone-800 shadow-sm dark:bg-stone-700 dark:text-stone-100'
                    : 'text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          <p className="px-0.5 text-xs leading-[1.7] text-stone-400 dark:text-stone-500">{activeMode.description}</p>

          {mode === 'snapshot' && (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-700">
                <span className="text-sm font-medium text-stone-700 dark:text-stone-300">標記順序編號</span>
                <Switch
                  checked={numbered}
                  onCheckedChange={setNumbered}
                  className="data-[state=checked]:bg-lime-700 dark:data-[state=checked]:bg-lime-500"
                />
              </label>
              <p className="flex items-start gap-1.5 rounded-md bg-stone-100 px-2.5 py-2 text-[11px] leading-snug text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                <Info className="mt-px size-3.5 shrink-0" />
                <span>錄製期間會隔離頁面操作：點擊、滾輪與觸控只用於標註，不會送到原頁面。</span>
              </p>
            </div>
          )}
        </div>
      )}

      {isRecording ? (
        <div className="space-y-2">
          <Button variant="destructive" className="w-full" onClick={stop} disabled={pendingAction !== null}>
            {pendingAction === 'stop' ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
            {pendingAction === 'stop' ? '停止中' : '停止錄製'}
          </Button>
          <p className="flex items-center justify-center gap-2 text-xs text-stone-400 dark:text-stone-500">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-red-500" />
            </span>
            錄製中，請在頁面上選取要標記的元素
          </p>
        </div>
      ) : (
        <Button
          className="w-full gap-2 rounded-[10px] bg-lime-700 tracking-[.06em] text-stone-50 hover:bg-lime-800 dark:bg-lime-500 dark:text-stone-900 dark:hover:bg-lime-400"
          onClick={start}
          disabled={pendingAction !== null}
        >
          {pendingAction === 'start' ? <Loader2 className="animate-spin" /> : <span className="size-2 shrink-0 rounded-full bg-red-300" />}
          {pendingAction === 'start' ? '啟動中' : '開始錄製'}
        </Button>
      )}
    </div>
  );
}

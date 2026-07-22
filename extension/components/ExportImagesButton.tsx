import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from 'react';
import { CheckCircle, Images, Loader2, X } from 'lucide-react';
import { exportImagesAsZip, isExportCancelledError, RedactionReviewRequiredError } from '@/lib/export-images';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildStepEntries, getEntryPrivacyState, type Step } from '@/lib/db';

interface Props {
  steps: Step[];
  className?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  onBeforeExport?: () => Promise<Step[] | void>;
  disabled?: boolean;
}

const PRIMARY_CLASS =
  'bg-lime-700 text-stone-50 hover:bg-lime-800 dark:bg-lime-500 dark:text-stone-900 dark:hover:bg-lime-400';

export default function ExportImagesButton({ steps, className, variant = 'outline', onBeforeExport, disabled = false }: Props) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const messageId = useId();
  const busy = preparing || progress !== null;
  const privacyReviewRequired = useMemo(
    () => buildStepEntries(steps).some((entry) => getEntryPrivacyState(entry).reviewRequired),
    [steps],
  );

  const privacyNotice = privacyReviewRequired
    ? '有圖片待確認敏感資訊遮罩；請在黑色步驟開啟「修正／遮罩」並儲存。'
    : null;

  useEffect(() => () => abortController.current?.abort(), []);

  async function handleClick() {
    if (steps.length === 0 || busy || disabled) return;
    if (privacyReviewRequired) {
      setExportError('請先完成所有圖片的敏感資訊遮罩確認，再匯出。');
      return;
    }
    const controller = new AbortController();
    abortController.current = controller;
    setExportError(null);
    setExportNotice(null);
    setCancelling(false);
    setPreparing(true);
    try {
      const flushedSteps = await onBeforeExport?.();
      controller.signal.throwIfAborted();
      const exportSteps = flushedSteps ?? steps;
      setPreparing(false);
      setProgress({ done: 0, total: buildStepEntries(exportSteps).length });
      const result = await exportImagesAsZip(
        exportSteps,
        (done, total) => {
          if (!controller.signal.aborted) setProgress({ done, total });
        },
        controller.signal,
      );
      if (result) setExportNotice(`已匯出 ${result.filename}，共 ${result.itemCount} 張`);
    } catch (err) {
      if (isExportCancelledError(err) || controller.signal.aborted) {
        setExportNotice('已取消匯出');
      } else if (err instanceof RedactionReviewRequiredError) {
        setExportError('請先完成所有圖片的敏感資訊遮罩確認，再匯出。');
      } else {
        console.error('匯出圖片失敗', err);
        setExportError('無法完成儲存或匯出，請重試。');
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setPreparing(false);
      setCancelling(false);
      setProgress(null);
    }
  }

  function cancelExport() {
    if (!busy || cancelling) return;
    setCancelling(true);
    abortController.current?.abort();
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      <Button
        variant={variant}
        onClick={busy ? cancelExport : handleClick}
        disabled={disabled || privacyReviewRequired || steps.length === 0 || cancelling}
        title={privacyReviewRequired ? '請先完成所有圖片的敏感資訊遮罩確認' : '匯出已套用遮罩的圖片'}
        aria-label={busy ? (cancelling ? '正在取消匯出' : '取消匯出') : '匯出圖片'}
        aria-describedby={exportNotice || exportError || privacyNotice ? messageId : undefined}
        className={cn('min-w-[112px]', variant === 'default' && PRIMARY_CLASS, className)}
      >
        {cancelling ? <Loader2 className="animate-spin" /> : busy ? <X /> : <Images />}
        {cancelling
          ? '正在取消'
          : preparing
            ? '取消匯出'
            : progress
              ? `取消 ${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`
              : '匯出圖片'}
      </Button>
      {(exportNotice || exportError || privacyNotice) && (
        <div
          id={messageId}
          role={exportError ? 'alert' : 'status'}
          className={cn(
            'absolute top-[calc(100%+8px)] right-0 z-40 flex w-max max-w-72 items-start gap-2 rounded-md border bg-white px-3 py-2 text-xs leading-[18px] shadow-md dark:bg-stone-800',
            exportError
              ? 'border-red-200 text-red-700 dark:border-red-900 dark:text-red-300'
              : 'border-stone-200 text-stone-700 dark:border-stone-600 dark:text-stone-200',
          )}
        >
          {!exportError && <CheckCircle className="mt-0.5 size-4 shrink-0 text-lime-700 dark:text-lime-400" />}
          <span className="break-words">{exportError ?? exportNotice ?? privacyNotice}</span>
        </div>
      )}
    </div>
  );
}

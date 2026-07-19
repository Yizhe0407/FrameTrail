import { useState, type ComponentProps } from 'react';
import { Images, Loader2 } from 'lucide-react';
import { exportImagesAsZip } from '@/lib/export-images';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildStepEntries, type Step } from '@/lib/db';

interface Props {
  steps: Step[];
  className?: string;
  variant?: ComponentProps<typeof Button>['variant'];
}

const PRIMARY_CLASS =
  'bg-lime-700 text-stone-50 hover:bg-lime-800 dark:bg-lime-500 dark:text-stone-900 dark:hover:bg-lime-400';

export default function ExportImagesButton({ steps, className, variant = 'outline' }: Props) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const busy = progress !== null;

  async function handleClick() {
    if (steps.length === 0 || busy) return;
    setExportError(null);
    setProgress({ done: 0, total: buildStepEntries(steps).length });
    try {
      await exportImagesAsZip(steps, (done, total) => setProgress({ done, total }));
    } catch (err) {
      console.error('匯出圖片失敗', err);
      setExportError('匯出失敗，請再試一次。');
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant={variant}
        onClick={handleClick}
        disabled={steps.length === 0 || busy}
        className={cn(variant === 'default' && PRIMARY_CLASS, className)}
      >
        {progress ? <Loader2 className="animate-spin" /> : <Images />}
        {progress ? `匯出中 ${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` : '匯出圖片'}
      </Button>
      {exportError && <span role="alert" className="text-xs text-red-600 dark:text-red-400">{exportError}</span>}
    </div>
  );
}

import { useState } from 'react';
import { AlertCircle, Loader2, ZoomIn } from 'lucide-react';
import { getOrderedAnnotations, updateStep, type Step, type StepEntry } from '@/lib/db';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';

interface Props {
  entry: StepEntry;
  index: number;
  onChange: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  editingDisabled?: boolean;
}

export default function StepStage({
  entry,
  index,
  onChange,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  editingDisabled = false,
}: Props) {
  const [numberingPending, setNumberingPending] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  async function setNumbered(next: boolean) {
    if (entry.kind !== 'group' || numberingPending || editingDisabled) return;
    setNumberingPending(true);
    setStageError(null);
    try {
      await Promise.all([entry.anchor, ...entry.annotations].map((s) => updateStep(s.id, { numbered: next })));
      await onChange();
    } catch (err) {
      console.error('更新標注編號設定失敗', err);
      setStageError('編號設定儲存失敗，請再試一次。');
    } finally {
      setNumberingPending(false);
    }
  }

  const headerRow = (
    <div className="flex shrink-0 items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="flex size-[30px] items-center justify-center rounded-full bg-stone-800 text-[13px] font-semibold tabular-nums text-stone-50 dark:bg-stone-100 dark:text-stone-900">
          {index + 1}
        </span>
        <span className="text-xs tracking-[.1em] text-stone-400 dark:text-stone-500">
          {entry.kind === 'single' ? '步驟模式' : `快照模式 · ${entry.annotations.length} 個標注`}
        </span>
      </div>
      <div className="flex items-center gap-3.5">
        {entry.kind === 'group' && (
          <label
            className={cn(
              'flex items-center gap-2',
              editingDisabled || numberingPending ? 'cursor-not-allowed' : 'cursor-pointer',
            )}
          >
            <span className="text-xs text-stone-500 dark:text-stone-400">順序編號</span>
            <Switch
              checked={entry.anchor.numbered ?? false}
              onCheckedChange={setNumbered}
              disabled={editingDisabled || numberingPending}
              className="data-[state=checked]:bg-lime-700 dark:data-[state=checked]:bg-lime-500"
            />
          </label>
        )}
        {numberingPending && <Loader2 className="size-3.5 animate-spin text-stone-400" aria-label="正在儲存編號設定" />}
        <StepActions entry={entry} onDelete={onDelete} deleteDisabled={editingDisabled} />
      </div>
    </div>
  );

  const zoomHint = (
    <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs opacity-0 shadow backdrop-blur transition-opacity group-hover:opacity-100 dark:bg-stone-900/90">
      <ZoomIn className="size-3.5" />
      放大
    </span>
  );

  const errorNotice = stageError && (
    <div role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
      <AlertCircle className="size-3.5" />
      {stageError}
    </div>
  );

  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 flex-1 min-w-0 flex-col items-center overflow-hidden bg-stone-100 px-16 pt-10 pb-8 dark:bg-stone-800">
        <div className="flex w-full max-w-[1040px] min-h-0 flex-1 flex-col gap-5">
          {headerRow}
          {errorNotice}
          <button
            type="button"
            onClick={onZoom}
            aria-label="放大圖片"
            className="group relative min-h-0 w-full cursor-zoom-in overflow-hidden rounded-[14px] border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-700 dark:bg-stone-900"
          >
            <HighlightThumbnail
              blob={entry.step.screenshotBlob}
              bounds={entry.step.bounds}
              screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
              alt={`步驟 ${index + 1}`}
              fit="contain"
              className="w-full"
            />
            {zoomHint}
          </button>
          <DescriptionField key={entry.step.id} step={entry.step} onChange={onChange} />
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-0 flex-1 min-w-0 flex-col gap-5 overflow-hidden bg-stone-100 px-9 pt-7 pb-7 dark:bg-stone-800">
      {headerRow}
      {errorNotice}
      <div className="flex min-h-0 flex-1 gap-7">
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <button
            type="button"
            onClick={onZoom}
            aria-label="放大圖片"
            className="group relative w-full cursor-zoom-in overflow-hidden rounded-[14px] border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-700 dark:bg-stone-900"
          >
            <MultiHighlightThumbnail
              blob={entry.anchor.screenshotBlob}
              annotations={getOrderedAnnotations(entry.annotations)}
              screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
              numbered={entry.anchor.numbered ?? false}
              alt={`步驟 ${index + 1}（快照）`}
              fit="contain"
              className="w-full"
            />
            {zoomHint}
          </button>
        </div>
        <aside className="flex min-h-0 w-[400px] shrink-0 flex-col gap-2.5">
          <AnnotationList
            annotations={entry.annotations}
            onChange={onChange}
            onDelete={onDeleteAnnotation}
            onReorder={onReorderAnnotations}
            editingDisabled={editingDisabled}
          />
        </aside>
      </div>
    </main>
  );
}

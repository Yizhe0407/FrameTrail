import { useState } from 'react';
import { AlertCircle, EyeOff, Loader2, ZoomIn } from 'lucide-react';
import { getEffectiveBounds, getEntryPrivacyState, getOrderedAnnotations, updateStep, type Step, type StepEntry } from '@/lib/db';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';
import VisualEditDialog, { type VisualEditCommit } from './VisualEditDialog';
import { Button } from './ui/button';

interface Props {
  entry: StepEntry;
  index: number;
  onChange: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  onEditVisuals: (commit: VisualEditCommit) => Promise<void>;
  onRecapture: () => Promise<void>;
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
  onEditVisuals,
  onRecapture,
  editingDisabled = false,
}: Props) {
  const [numberingPending, setNumberingPending] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [visualEditorOpen, setVisualEditorOpen] = useState(false);
  const [visualSavePending, setVisualSavePending] = useState(false);
  const privacy = getEntryPrivacyState(entry);

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
    <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span className="flex size-[30px] items-center justify-center rounded-full bg-stone-800 text-[13px] font-semibold tabular-nums text-stone-50 dark:bg-stone-100 dark:text-stone-900">
          {index + 1}
        </span>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          {entry.kind === 'single' ? '步驟模式' : `快照模式 · ${entry.annotations.length} 個標注`}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3.5">
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setVisualEditorOpen(true)}
          disabled={editingDisabled}
          title={editingDisabled ? '錄製或資料操作期間無法編輯圖片' : '修正框選或遮罩敏感資訊'}
        >
          <EyeOff />修正／遮罩
        </Button>
        <StepActions
          entry={entry}
          onDelete={onDelete}
          onRecapture={onRecapture}
          deleteDisabled={editingDisabled}
          operationsDisabled={editingDisabled}
          recaptureDisabledReason={
            entry.kind === 'group' && entry.annotations.length !== 1
              ? '此快照有多個標註；為避免其他框選錯位，請重新製作整張快照。'
              : undefined
          }
        />
      </div>
    </div>
  );

  // A privacy-blocked preview should lead directly to the recovery action
  // instead of opening a second black-only lightbox. This reduces the
  // dead-end path while preserving the normal zoom affordance for reviewed
  // images.
  const imageAction = privacy.reviewRequired ? () => setVisualEditorOpen(true) : onZoom;
  const imageActionLabel = privacy.reviewRequired ? '確認敏感資訊遮罩' : '放大圖片';
  const imageActionHint = privacy.reviewRequired ? '確認遮罩' : '放大';
  const imageActionIcon = privacy.reviewRequired ? <EyeOff className="size-3.5" /> : <ZoomIn className="size-3.5" />;
  const zoomHint = (
    <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs opacity-0 shadow backdrop-blur transition-opacity group-hover:opacity-100 dark:bg-stone-900/90">
      {imageActionIcon}
      {imageActionHint}
    </span>
  );

  const errorNotice = stageError && (
    <div role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
      <AlertCircle className="size-3.5" />
      {stageError}
    </div>
  );

  const privacyReviewNotice = privacy.reviewRequired && (
    <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      此圖片的遮罩需要重新確認；確認前預覽會保持全黑，複製與匯出也會被阻擋。請開啟「修正／遮罩」檢查後儲存。
    </div>
  );

  const visualEditor = (
    <VisualEditDialog
      entry={entry}
      open={visualEditorOpen}
      saving={visualSavePending}
      onOpenChange={setVisualEditorOpen}
      onSave={async (commit) => {
        setVisualSavePending(true);
        try {
          await onEditVisuals(commit);
          setVisualEditorOpen(false);
        } finally {
          setVisualSavePending(false);
        }
      }}
    />
  );

  if (entry.kind === 'single') {
    return (
      <>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-stone-100 px-4 pt-4 pb-36 sm:px-6 lg:overflow-hidden lg:px-16 lg:pt-10 lg:pb-8 dark:bg-stone-800">
        <div className="flex w-full max-w-[1040px] flex-none flex-col gap-4 lg:min-h-0 lg:flex-1 lg:gap-5">
          {headerRow}
          {errorNotice}
          {privacyReviewNotice}
          <button
            type="button"
            onClick={imageAction}
            aria-label={imageActionLabel}
            className={cn(
              'group relative w-full shrink-0 overflow-hidden rounded-md border border-stone-200 bg-stone-100 shadow-sm lg:min-h-0 lg:shrink dark:border-stone-700 dark:bg-stone-900',
              privacy.reviewRequired ? 'cursor-pointer' : 'cursor-zoom-in',
            )}
          >
            <HighlightThumbnail
              blob={entry.step.screenshotBlob}
              bounds={getEffectiveBounds(entry.step)}
              redactions={privacy.redactions}
              privacyReviewRequired={privacy.reviewRequired}
              screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
              alt={`步驟 ${index + 1}`}
              fit="contain"
              className="w-full"
            />
            {zoomHint}
          </button>
          <DescriptionField
            key={entry.step.id}
            step={entry.step}
            onChange={onChange}
            disabled={editingDisabled}
          />
        </div>
      </main>
      {visualEditor}
      </>
    );
  }

  return (
    <>
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-stone-100 px-4 pt-4 pb-36 sm:px-6 lg:gap-5 lg:overflow-hidden lg:px-9 lg:pt-7 lg:pb-7 dark:bg-stone-800">
      {headerRow}
      {errorNotice}
      {privacyReviewNotice}
      <div className="flex min-h-0 flex-none flex-col gap-5 lg:flex-1 lg:flex-row lg:gap-7">
        <div className="flex min-w-0 shrink-0 items-center justify-center lg:flex-1">
          <button
            type="button"
            onClick={imageAction}
            aria-label={imageActionLabel}
            className={cn(
              'group relative w-full overflow-hidden rounded-md border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-700 dark:bg-stone-900',
              privacy.reviewRequired ? 'cursor-pointer' : 'cursor-zoom-in',
            )}
          >
            <MultiHighlightThumbnail
              blob={entry.anchor.screenshotBlob}
              annotations={getOrderedAnnotations(entry.annotations)}
              redactions={privacy.redactions}
              privacyReviewRequired={privacy.reviewRequired}
              screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
              numbered={entry.anchor.numbered ?? false}
              alt={`步驟 ${index + 1}（快照）`}
              fit="contain"
              className="w-full"
            />
            {zoomHint}
          </button>
        </div>
        <aside className="flex min-h-[280px] w-full shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[400px]">
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
    {visualEditor}
    </>
  );
}

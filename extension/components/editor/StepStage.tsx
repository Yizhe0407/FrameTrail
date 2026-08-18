import { useState } from 'react';
import { Loader2, Pencil, Plus, X, ZoomIn } from 'lucide-react';
import { entryId, getEntryPrivacyState, type Step, type StepEntry } from '@/lib/storage/models';
import { Badge } from '@/components/ui/badge';
import EntryThumbnail from './EntryThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';
import TagSelectDialog from './TagSelectDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { recordingItemCountLabel, RECORDING_MODE_COPY } from '@/lib/recording/recording-mode-copy';
import {
  MULTI_ANNOTATION_RECAPTURE_BLOCKED,
  PRIVACY_REVIEW_REQUIRED_NOTICE,
  UNTITLED_GUIDE_TITLE,
} from '@/lib/editor/editor-messages';

interface Props {
  entry: StepEntry;
  index: number;
  guideTitle?: string;
  guideTags?: readonly string[];
  onTitleChange?: (title: string) => Promise<void>;
  onTagsChange?: (tags: string[]) => Promise<void>;
  onChange: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  onRecapture: () => Promise<void>;
  onSetNumbered: (entryId: string, next: boolean) => Promise<void>;
  editingDisabled?: boolean;
}

export default function StepStage({
  entry,
  index,
  guideTitle,
  guideTags = [],
  onTitleChange,
  onTagsChange,
  onChange,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  onRecapture,
  onSetNumbered,
  editingDisabled = false,
}: Props) {
  const [numberingPending, setNumberingPending] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const privacy = getEntryPrivacyState(entry);

  const displayTags = guideTags;

  // Guide metadata writes can be refused (a recording or recapture holds the
  // data lock) or fail outright. Both used to be swallowed by a bare `void`,
  // leaving the field showing a value that was never stored.
  //
  // Rethrows so each surface owns its own reporting (and logging): the tag
  // dialog shows the failure inline while it is open (a stage banner would sit
  // behind the modal), and the inline chip row routes it into `stageError`.
  async function commitTags(tags: string[]): Promise<void> {
    if (!onTagsChange) return;
    setStageError(null);
    await onTagsChange(tags);
  }

  async function commitTagsInline(tags: string[]): Promise<void> {
    try {
      await commitTags(tags);
    } catch (tagError) {
      setStageError(reportError('更新標籤失敗', tagError, '標籤儲存失敗，請再試一次。'));
    }
  }

  const titleAndTagRow = (
    <>
      <div className="mb-4 flex shrink-0 flex-col gap-3 border-b border-border/80 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 w-full items-center gap-1.5 sm:max-w-[45%]">
          <EditableTitle
            value={guideTitle ?? ''}
            fallback={UNTITLED_GUIDE_TITLE}
            label="內容標題"
            disabled={editingDisabled || !onTitleChange}
            onCommit={(title) => onTitleChange?.(title)}
            onCommitError={(titleError) => {
              setStageError(reportError('重新命名內容失敗', titleError, '標題儲存失敗，請再試一次。'));
            }}
            className="w-fit min-w-[8ch] max-w-[calc(100%-1.75rem)] rounded-md border-none px-2 py-1 text-[20px] font-bold leading-tight text-foreground transition-colors hover:bg-foreground/5 focus:bg-card focus:shadow-[0_0_0_1.5px_var(--focus)] [field-sizing:content]"
          />
          <Pencil className="size-[15px] shrink-0 text-muted-foreground/50" />
        </div>
        <div className="app-scrollbar flex max-h-[84px] min-w-0 flex-wrap items-center gap-2 overflow-y-auto pr-1 sm:max-w-[55%] sm:justify-end">
          {displayTags.map((tag) => (
            <Badge key={tag} variant="tagEditable" className="max-w-full select-none">
              <span className="min-w-0 truncate">{tag}</span>
              <button
                type="button"
                onClick={() => void commitTagsInline(guideTags.filter((t) => t !== tag))}
                aria-label={`移除 ${tag} 標籤`}
                disabled={editingDisabled}
                className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/70 transition-colors hover:bg-destructive/20 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/15 dark:text-white/70 dark:hover:bg-rose-500/30 dark:hover:text-rose-300"
              >
                <X className="size-2.5 stroke-[2.5]" />
              </button>
            </Badge>
          ))}
          <Badge asChild variant="tagAction" className="disabled:opacity-50">
            <button
              type="button"
              onClick={() => setTagDialogOpen(true)}
              disabled={editingDisabled}
              title="新增標籤（顯示於作品庫）"
            >
              <Plus className="size-3.5 stroke-[2.5]" />
              標籤
            </button>
          </Badge>
        </div>
      </div>

      <TagSelectDialog
        open={tagDialogOpen}
        selectedTags={guideTags}
        onOpenChange={setTagDialogOpen}
        onSave={commitTags}
      />
    </>
  );

  async function setNumbered(next: boolean) {
    if (entry.kind !== 'group' || numberingPending || editingDisabled) return;
    setNumberingPending(true);
    setStageError(null);
    try {
      await onSetNumbered(entryId(entry), next);
    } catch (err) {
      setStageError(reportError('更新標註編號設定失敗', err, '編號設定儲存失敗，請再試一次。'));
    } finally {
      setNumberingPending(false);
    }
  }

  const headerRow = (
    <div className="flex shrink-0 items-center justify-between gap-3 mb-3.5">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-muted-foreground/80">
          {/* A single entry came from steps mode, a group from snapshot mode, so
              the stage names them with the same vocabulary as the popup and the
              recording toolbar. */}
          {entry.kind === 'single'
            ? RECORDING_MODE_COPY.steps.label
            : `${RECORDING_MODE_COPY.snapshot.label} · ${recordingItemCountLabel('snapshot', entry.annotations.length)}`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {numberingPending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="正在儲存編號設定" />}
        <StepActions
          entry={entry}
          onDelete={onDelete}
          onRecapture={onRecapture}
          deleteDisabled={editingDisabled}
          operationsDisabled={editingDisabled}
          recaptureDisabledReason={
            entry.kind === 'group' && entry.annotations.length !== 1
              ? MULTI_ANNOTATION_RECAPTURE_BLOCKED
              : undefined
          }
        />
      </div>
    </div>
  );

  const zoomHint = (
    <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-xs opacity-0 shadow backdrop-blur transition-opacity group-hover:opacity-100">
      <ZoomIn className="size-3.5" />
      點擊放大
    </span>
  );

  const errorNotice = stageError && <InlineAlert>{stageError}</InlineAlert>;

  const privacyReviewNotice = privacy.reviewRequired && (
    <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      {PRIVACY_REVIEW_REQUIRED_NOTICE}
    </div>
  );

  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-4 pt-4 pb-6 sm:px-6 lg:overflow-hidden lg:px-10 lg:pt-5 lg:pb-16">
        <div className="flex w-full max-w-[1180px] flex-none flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex-none">{titleAndTagRow}</div>
          <div className="flex-none">{headerRow}</div>
          {errorNotice && <div className="flex-none">{errorNotice}</div>}
          {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
          <div className="flex w-full flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
            <button
              type="button"
              onClick={onZoom}
              aria-label="放大圖片"
              className="group relative flex w-full items-center justify-center cursor-zoom-in border-none bg-transparent outline-none lg:h-full lg:max-h-full lg:max-w-full"
            >
              <EntryThumbnail
                entry={entry}
                alt={`步驟 ${index + 1}`}
                fit="contain"
                className="max-w-full lg:h-full lg:max-h-full"
                imgClassName="block h-auto max-w-full w-auto object-contain rounded-md border border-black/15 shadow-xs dark:border-white/15 lg:max-h-full"
                overlay={zoomHint}
              />
            </button>
          </div>
          <div className="flex-none">
            <DescriptionField
              key={entry.step.id}
              step={entry.step}
              onChange={onChange}
              disabled={editingDisabled}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-background px-4 pt-4 pb-6 sm:px-6 lg:overflow-hidden lg:px-10 lg:pt-5 lg:pb-16">
      <div className="flex-none">{titleAndTagRow}</div>
      <div className="flex-none">{headerRow}</div>
      {errorNotice && <div className="flex-none">{errorNotice}</div>}
      {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
      <div className="flex flex-none flex-col gap-5 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-[22px]">
        <div className="flex min-w-0 flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
          <button
            type="button"
            onClick={onZoom}
            aria-label="放大圖片"
            className="group relative flex w-full items-center justify-center cursor-zoom-in border-none bg-transparent outline-none lg:h-full lg:max-h-full lg:max-w-full"
          >
            <EntryThumbnail
              entry={entry}
              alt={`步驟 ${index + 1}（快照）`}
              fit="contain"
              className="max-w-full lg:h-full lg:max-h-full"
              imgClassName="block h-auto max-w-full w-auto object-contain rounded-md border border-black/15 shadow-xs dark:border-white/15 lg:max-h-full"
              overlay={zoomHint}
            />
          </button>
        </div>
        <aside className="flex min-h-[280px] w-full shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[380px]">
          <AnnotationList
            annotations={entry.annotations}
            numbered={entry.anchor.numbered ?? false}
            onSetNumbered={(next) => setNumbered(next)}
            numberingPending={numberingPending}
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

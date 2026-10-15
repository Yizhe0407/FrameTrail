import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, Pencil, Plus, SquareDashedMousePointer, X, ZoomIn } from 'lucide-react';
import { entryId, getEntryImageOwner, getEntryPrivacyState, type Bounds, type Redaction, type Step, type StepEntry } from '@/lib/storage/models';
import { itemsToRedactions, newImageEditItem, redactionsToItems, type ImageEditItem, type ImageEditItemKind } from '@/lib/editor/image-edit-items';
import { type ImageEditToolId } from '@/lib/editor/image-edit-tools';
import { useImageCssSize } from '@/lib/editor/use-image-css-size';
import ImageEditLayer from './ImageEditLayer';
import ImageEditToolbar from './ImageEditToolbar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/shared/utils';
import { tagHueClass } from '@/lib/shared/tag-hue';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import EntryThumbnail from './EntryThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';
import TagSelectDialog from './TagSelectDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { recordingItemCountLabel, recordingModeCopy } from '@/lib/recording/recording-mode-copy';
import { t } from '@/lib/shared/i18n';

interface Props {
  entry: StepEntry;
  index: number;
  projectTitle?: string;
  projectTags?: readonly string[];
  onTitleChange?: (title: string) => Promise<void>;
  onTagsChange?: (tags: string[]) => Promise<void>;
  onChange: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  onRecapture: () => Promise<void>;
  onSetNumbered: (entryId: string, next: boolean) => Promise<void>;
  onSaveRedactions?: (entryId: string, redactions: Redaction[]) => Promise<void>;
  editingDisabled?: boolean;
}

export default function StepStage({
  entry,
  index,
  projectTitle,
  projectTags = [],
  onTitleChange,
  onTagsChange,
  onChange,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  onRecapture,
  onSetNumbered,
  onSaveRedactions,
  editingDisabled = false,
}: Props) {
  const [numberingPending, setNumberingPending] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const privacy = getEntryPrivacyState(entry);
  const [imageEditing, setImageEditing] = useState(false);
  const [editTool, setEditTool] = useState<ImageEditToolId>('redact');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const imageOwner = getEntryImageOwner(entry);
  const imageCssSize = useImageCssSize(imageOwner.screenshotBlob, imageOwner.screenshotScale ?? imageOwner.devicePixelRatio);
  const editItems = useMemo(() => redactionsToItems(privacy.redactions), [privacy.redactions]);
  const canEditImage = Boolean(onSaveRedactions) && !privacy.reviewRequired;

  async function saveEditItems(next: ImageEditItem[]): Promise<void> {
    if (!onSaveRedactions) return;
    setStageError(null);
    try {
      await onSaveRedactions(entryId(entry), itemsToRedactions(next));
    } catch (saveError) {
      setStageError(reportError('[stepmark] failed to save image edits', saveError, t().editor.imageEdit.saveFailed));
    }
  }

  function createEditItem(kind: ImageEditItemKind, bounds: Bounds) {
    const item = newImageEditItem(kind, bounds);
    setSelectedItemId(item.id);
    void saveEditItems([...editItems, item]);
  }

  function updateEditItem(id: string, bounds: Bounds) {
    void saveEditItems(editItems.map((item) => (item.id === id ? { ...item, bounds } : item)));
  }

  function deleteEditItem(id: string) {
    setSelectedItemId(null);
    void saveEditItems(editItems.filter((item) => item.id !== id));
  }

  /** Overlay for the stage image: the zoom hint normally, the interactive edit layer while editing. */
  const stageOverlay: ReactNode = imageEditing
    ? imageCssSize && (
      <ImageEditLayer
        items={editItems}
        tool={editTool}
        size={imageCssSize}
        selectedId={selectedItemId}
        onSelect={setSelectedItemId}
        onCreate={createEditItem}
        onUpdate={updateEditItem}
        onDelete={deleteEditItem}
        disabled={editingDisabled}
      />
    )
    : undefined;

  const imageEditToolbar = imageEditing && (
    <ImageEditToolbar
      tool={editTool}
      onToolChange={setEditTool}
      hasSelection={selectedItemId !== null}
      onDeleteSelected={() => selectedItemId && deleteEditItem(selectedItemId)}
      itemCount={editItems.length}
      onDone={() => {
        setImageEditing(false);
        setSelectedItemId(null);
      }}
      disabled={editingDisabled}
    />
  );

  const displayTags = projectTags;

  // Rethrows so each surface owns its own reporting: the tag dialog shows the failure inline
  // while open (a stage banner would sit behind the modal), and the chip row uses `stageError`.
  async function commitTags(tags: string[]): Promise<void> {
    if (!onTagsChange) return;
    setStageError(null);
    await onTagsChange(tags);
  }

  async function commitTagsInline(tags: string[]): Promise<void> {
    try {
      await commitTags(tags);
    } catch (tagError) {
      setStageError(reportError('[stepmark] failed to update project tags', tagError, t().editor.stage.tagSaveFailed));
    }
  }

  const titleAndTagRow = (
    <>
      <div className="mb-4 flex shrink-0 flex-col gap-3 border-b-2 border-border-soft pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 w-full items-center gap-1.5 sm:max-w-[45%]">
          <EditableTitle
            value={projectTitle ?? ''}
            fallback={t().common.untitledProject}
            label={t().editor.stage.titleLabel}
            disabled={editingDisabled || !onTitleChange}
            onCommit={(title) => onTitleChange?.(title)}
            onCommitError={(titleError) => {
              setStageError(reportError('[stepmark] failed to rename project', titleError, t().editor.stage.titleSaveFailed));
            }}
            className="w-fit min-w-[8ch] max-w-[calc(100%-1.75rem)] rounded-md border-2 border-transparent px-2 py-1 text-[22px] leading-tight font-bold text-foreground transition-colors focus-ring hover:border-border-soft focus:border-border focus:bg-card [field-sizing:content]"
          />
          <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="app-scrollbar flex max-h-[84px] min-w-0 flex-wrap items-center gap-2 overflow-y-auto pr-1 sm:max-w-[55%] sm:justify-end">
          {displayTags.map((tag) => (
            <Badge key={tag} variant="tagEditable" className={cn('max-w-full select-none', tagHueClass(tag))}>
              <span className="min-w-0 truncate">{tag}</span>
              <button
                type="button"
                onClick={() => void commitTagsInline(projectTags.filter((t) => t !== tag))}
                aria-label={t().editor.stage.removeTag(tag)}
                disabled={editingDisabled}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-on-accent outline-none transition-colors focus-ring hover:bg-on-accent hover:text-card disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-3 stroke-[2.5]" />
              </button>
            </Badge>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge asChild variant="tagAction" className="disabled:opacity-50">
                <button
                  type="button"
                  onClick={() => setTagDialogOpen(true)}
                  disabled={editingDisabled}
                >
                  <Plus className="size-3.5 stroke-[2.5]" />
                  {t().editor.stage.tagButton}
                </button>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t().editor.stage.tagTooltip}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <TagSelectDialog
        open={tagDialogOpen}
        selectedTags={projectTags}
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
      setStageError(reportError('[stepmark] failed to update annotation numbering', err, t().editor.stage.numberingSaveFailed));
    } finally {
      setNumberingPending(false);
    }
  }

  const headerRow = (
    <div className="flex shrink-0 items-center justify-between gap-3 mb-3.5">
      <div className="flex items-center gap-3">
        <span className="rounded-full border-2 border-border bg-secondary px-2.5 py-0.5 text-xs font-bold text-foreground">
          {/* Names entries with the same vocabulary as the popup and recording toolbar. */}
          {entry.kind === 'single'
            ? recordingModeCopy('steps').label
            : `${recordingModeCopy('snapshot').label} · ${recordingItemCountLabel('snapshot', entry.annotations.length)}`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {numberingPending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={t().editor.stage.savingNumbering} />}
        {canEditImage && !imageEditing && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setImageEditing(true)}
                disabled={editingDisabled}
                className="flex h-9 items-center gap-1.5 rounded-md border-2 border-border bg-card px-2.5 text-xs font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
              >
                <SquareDashedMousePointer className="size-4" />
                {t().editor.imageEdit.open}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t().editor.imageEdit.openTooltip}</TooltipContent>
          </Tooltip>
        )}
        <StepActions
          entry={entry}
          onDelete={onDelete}
          onRecapture={onRecapture}
          deleteDisabled={editingDisabled}
          operationsDisabled={editingDisabled}
          recaptureDisabledReason={
            entry.kind === 'group' && entry.annotations.length !== 1
              ? t().editor.multiAnnotationRecaptureBlocked
              : undefined
          }
        />
      </div>
    </div>
  );

  const zoomHint = (
    <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-full border-2 border-border bg-card px-2.5 py-1 text-xs font-bold text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      <ZoomIn className="size-3.5" />
      {t().editor.stage.zoomHint}
    </span>
  );

  const errorNotice = stageError && <InlineAlert>{stageError}</InlineAlert>;

  const privacyReviewNotice = privacy.reviewRequired && (
    <div role="alert" className="rounded-md border-2 border-border bg-warning-soft px-3.5 py-2.5 text-sm text-foreground">
      {t().editor.privacyReviewRequiredNotice}
    </div>
  );

  /** The stage image: click-to-zoom normally; a plain frame hosting the edit layer while editing,
   * since interactive controls can't live inside the zoom button. */
  function imageFrame(alt: string): ReactNode {
    const frameClass = 'group relative flex w-full items-center justify-center rounded-md lg:h-full lg:max-h-full lg:max-w-full';
    const thumbnail = (overlay: ReactNode) => (
      <EntryThumbnail
        entry={entry}
        alt={alt}
        fit="contain"
        className="max-w-full lg:h-full lg:max-h-full"
        imgClassName="block h-auto w-auto max-w-full rounded-md object-contain outline-2 outline-border lg:max-h-full"
        overlay={overlay}
      />
    );
    if (imageEditing) return <div className={frameClass}>{thumbnail(stageOverlay)}</div>;
    return (
      <button
        type="button"
        onClick={onZoom}
        aria-label={t().editor.stage.zoomImage}
        className={`${frameClass} cursor-zoom-in border-none bg-transparent outline-none focus-ring`}
      >
        {thumbnail(zoomHint)}
      </button>
    );
  }

  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-4 pt-4 pb-6 sm:px-6 lg:overflow-hidden lg:px-10 lg:pt-5 lg:pb-16">
        <div className="flex w-full max-w-[1180px] flex-none flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex-none">{titleAndTagRow}</div>
          <div className="flex-none">{headerRow}</div>
          {errorNotice && <div className="flex-none">{errorNotice}</div>}
          {imageEditToolbar && <div className="flex-none">{imageEditToolbar}</div>}
          {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
          <div className="flex w-full flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
            {imageFrame(t().editor.stage.stepAlt(index + 1))}
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
      {imageEditToolbar && <div className="flex-none">{imageEditToolbar}</div>}
      {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
      <div className="flex flex-none flex-col gap-5 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-[22px]">
        <div className="flex min-w-0 flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
          {imageFrame(t().editor.stage.snapshotAlt(index + 1))}
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

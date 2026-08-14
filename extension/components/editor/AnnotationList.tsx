import { useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { restrictToVerticalAxis, useSortableReorder } from '@/lib/editor/dnd';
import { useStepDescriptionAutosave } from '@/lib/editor/editor-autosave';
import { Switch } from '@/components/ui/switch';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import DescriptionDraftRecoveries from './DescriptionDraftRecoveries';
import SortableItem from './SortableItem';

interface RowProps {
  step: Step;
  index: number;
  onChange: () => void | Promise<void>;
  onDelete: (step: Step) => Promise<void>;
  deleteDisabled: boolean;
  dragHandle: ReactNode;
}

function AnnotationRow({ step, index, onChange, onDelete, deleteDisabled, dragHandle }: RowProps) {
  const {
    description,
    setDescription,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    confirmOverwrite,
  } = useStepDescriptionAutosave(step, onChange);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleDelete() {
    if (deleting || deleteDisabled) return;
    setDeleting(true);
    setActionError(null);
    try {
      await onDelete(step);
    } catch (err) {
      setActionError(reportError('刪除標註失敗', err, '標註刪除失敗，請再試一次。'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="group flex flex-col rounded-md border border-border/80 bg-surface-raised p-[12px_14px] transition-all hover:border-foreground/20 dark:border-white/10 dark:hover:border-white/20">
      <div className="flex items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-recording text-xs font-bold text-recording-foreground shadow-xs">
          {index + 1}
        </span>
        <input
          type="text"
          aria-label={`標註 ${index + 1} 說明`}
          value={description}
          maxLength={PERSISTED_STEP_LIMITS.maxDescriptionLength}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void flush().catch(() => undefined)}
          disabled={deleteDisabled || deleting}
          placeholder="輸入標註說明…"
          className="min-w-0 flex-1 border-none bg-transparent px-1 py-0 text-[13.5px] font-normal text-foreground outline-none focus:ring-0 dark:text-white/90"
        />
        <div className="flex items-center gap-1 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={handleDelete}
            onPointerDown={(event) => event.preventDefault()}
            disabled={deleteDisabled || deleting}
            aria-label={`刪除標註 ${index + 1}`}
            title={deleteDisabled ? '錄製或補拍期間無法刪除標註' : '刪除標註'}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive dark:text-white/40 dark:hover:bg-rose-500/20 dark:hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </button>
          {dragHandle}
        </div>
      </div>
      <DescriptionDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        onConfirmOverwrite={() => confirmOverwrite()}
        disabled={deleteDisabled || deleting}
        className="mt-2 ml-9"
      />
      {actionError && (
        <InlineAlert className="ml-9">
          {actionError}
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="ml-2 rounded-md px-1.5 py-1 font-medium text-focus outline-none hover:bg-focus/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            重試刪除
          </button>
        </InlineAlert>
      )}
    </div>
  );
}

interface Props {
  annotations: Step[];
  numbered?: boolean;
  onSetNumbered?: (numbered: boolean) => void | Promise<void>;
  numberingPending?: boolean;
  onChange: () => void | Promise<void>;
  onDelete: (step: Step) => Promise<void>;
  onReorder: (reordered: Step[]) => Promise<void>;
  editingDisabled?: boolean;
}

export default function AnnotationList({
  annotations,
  numbered = false,
  onSetNumbered,
  numberingPending = false,
  onChange,
  onDelete,
  onReorder,
  editingDisabled = false,
}: Props) {
  const { sensors, accessibility, handleDragEnd, itemIds } = useSortableReorder(
    annotations,
    (step) => step.id,
    onReorder,
    {
      disabled: editingDisabled,
      itemNoun: '標註',
      logLabel: '[frametrail] failed to reorder snapshot annotations',
    },
  );

  if (annotations.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">此快照目前沒有標註。</p>;
  }

  return (
    <div className="flex h-full w-full shrink-0 flex-col overflow-hidden rounded-md border border-border/80 bg-card shadow-sm dark:border-white/10">
      <div className="flex shrink-0 items-center justify-between border-b border-border/80 px-[18px] py-[14px] dark:border-white/10">
        <span className="text-xs font-semibold text-muted-foreground/75 dark:text-white/50">
          標註 · {annotations.length}
        </span>
        <label className="flex items-center gap-2.5 text-xs font-medium text-muted-foreground/75 cursor-pointer select-none dark:text-white/60">
          順序編號
          <Switch
            checked={numbered}
            onCheckedChange={(checked) => void onSetNumbered?.(checked)}
            disabled={editingDisabled || numberingPending || !onSetNumbered}
          />
        </label>
      </div>
      <div className="app-scrollbar flex-1 min-h-0 overflow-y-auto p-3.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={accessibility}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-2.5">
              {annotations.map((step, index) => (
                <SortableItem key={step.id} id={step.id} disabled={editingDisabled}>
                  {(handle) => (
                    <AnnotationRow
                      step={step}
                      index={index}
                      onChange={onChange}
                      onDelete={onDelete}
                      deleteDisabled={editingDisabled}
                      dragHandle={handle}
                    />
                  )}
                </SortableItem>
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

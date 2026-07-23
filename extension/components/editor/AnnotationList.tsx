import { useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Step } from '@/lib/storage/db';
import { reorderById, restrictToVerticalAxis, useSortableSensors } from '@/lib/editor/dnd';
import { useStepDescriptionAutosave } from '@/lib/editor/editor-autosave';
import { Textarea } from '@/components/ui/textarea';
import SaveStatus from './SaveStatus';
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
    status,
    error,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    retry,
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
      console.error('刪除標注失敗', err);
      setActionError('標注刪除失敗，請再試一次。');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-xs font-semibold text-white">
          {index + 1}
        </span>
        <Textarea
          aria-label={`標註 ${index + 1} 說明`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void flush().catch(() => undefined)}
          disabled={deleteDisabled || deleting}
          placeholder="輸入標注說明…"
          rows={1}
          className="min-h-0 flex-1 resize-none border-transparent bg-transparent px-3 py-2 text-[13.5px] leading-[1.7] text-stone-700 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:text-stone-300"
        />
        <button
          type="button"
          onClick={handleDelete}
          onPointerDown={(event) => event.preventDefault()}
          disabled={deleteDisabled || deleting}
          aria-label={`刪除標注 ${index + 1}`}
          title={deleteDisabled ? '錄製或補拍期間無法刪除標注' : '刪除標注'}
          className="shrink-0 rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-stone-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
        >
          {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </button>
        {dragHandle}
      </div>
      <SaveStatus
        status={status}
        error={error}
        onRetry={() => void retry().catch(() => undefined)}
        className={`mt-1 ml-8 ${status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-stone-500 dark:text-stone-400'}`}
      />
      <DescriptionDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        disabled={deleteDisabled || deleting}
        className="mt-2 ml-8"
      />
      {actionError && (
        <div role="alert" className="ml-8 flex min-h-6 items-center gap-2 text-xs text-red-700 dark:text-red-300">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="rounded px-1.5 py-1 font-medium text-blue-700 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-blue-300 dark:hover:bg-blue-950/40"
          >
            重試刪除
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  annotations: Step[];
  onChange: () => void | Promise<void>;
  onDelete: (step: Step) => Promise<void>;
  onReorder: (reordered: Step[]) => Promise<void>;
  editingDisabled?: boolean;
}

export default function AnnotationList({ annotations, onChange, onDelete, onReorder, editingDisabled = false }: Props) {
  const sensors = useSortableSensors();

  function handleDragEnd(event: DragEndEvent) {
    if (editingDisabled) return;
    const reordered = reorderById(annotations, event.active.id, event.over?.id, (step) => step.id);
    if (reordered) {
      void onReorder(reordered).catch((error) => {
        console.error('[frametrail] failed to reorder snapshot annotations', error);
      });
    }
  }

  if (annotations.length === 0) {
    return <p className="text-sm text-stone-400 dark:text-stone-500">此快照目前沒有標注。</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <label className="shrink-0 text-xs font-medium text-stone-600 dark:text-stone-300">
        標注說明 · {annotations.length}
      </label>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-md border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext items={annotations.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-stone-200 dark:divide-stone-700">
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

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { updateStep, type Step } from '@/lib/db';
import { reorderById, restrictToVerticalAxis, useSortableSensors } from '@/lib/dnd';
import { Textarea } from '@/components/ui/textarea';
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
  const [description, setDescription] = useState(step.description);
  const [pendingAction, setPendingAction] = useState<'save' | 'delete' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setDescription(step.description);
    setPendingAction(null);
    setActionError(null);
  }, [step.id, step.description]);

  async function saveDescription() {
    if (pendingAction || description === step.description) return;
    const stepId = step.id;
    const nextDescription = description;
    setPendingAction('save');
    setActionError(null);
    try {
      await updateStep(stepId, { description: nextDescription });
      await onChange();
    } catch (err) {
      console.error('儲存標注說明失敗', err);
      setActionError('標注說明儲存失敗，請再試一次。');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDelete() {
    if (pendingAction || deleteDisabled) return;
    setPendingAction('delete');
    setActionError(null);
    try {
      await onDelete(step);
    } catch (err) {
      console.error('刪除標注失敗', err);
      setActionError('標注刪除失敗，請再試一次。');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[11px] font-semibold text-white">
          {index + 1}
        </span>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
          disabled={pendingAction !== null}
          placeholder="輸入標注說明…"
          rows={1}
          className="min-h-0 flex-1 resize-none border-transparent bg-transparent px-3 py-2 text-[13.5px] leading-[1.7] text-stone-700 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:text-stone-300"
        />
        <button
          type="button"
          onClick={handleDelete}
          onPointerDown={(event) => event.preventDefault()}
          disabled={deleteDisabled || pendingAction !== null}
          aria-label={`刪除標注 ${index + 1}`}
          title={deleteDisabled ? '錄製期間無法刪除標注' : '刪除標注'}
          className="shrink-0 rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-stone-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
        >
          {pendingAction === 'delete' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </button>
        {dragHandle}
      </div>
      {(pendingAction === 'save' || actionError) && (
        <div
          role={actionError ? 'alert' : 'status'}
          className={`mt-1 ml-8 flex items-center gap-1.5 text-xs ${actionError ? 'text-red-600 dark:text-red-400' : 'text-stone-400 dark:text-stone-500'}`}
        >
          {pendingAction === 'save' && <Loader2 className="size-3 animate-spin" />}
          {actionError ?? '正在儲存…'}
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
    if (reordered) void onReorder(reordered);
  }

  if (annotations.length === 0) {
    return <p className="text-sm text-stone-400 dark:text-stone-500">此快照目前沒有標注。</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <label className="shrink-0 text-[11px] tracking-[.16em] text-stone-400 dark:text-stone-500">
        標注說明 · {annotations.length}
      </label>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
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

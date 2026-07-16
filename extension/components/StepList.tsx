import { useState, type ReactNode } from 'react';
import { MousePointerClick } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { buildStepEntries, flattenEntries, reorderSteps, type Step, type StepEntry } from '@/lib/db';
import StepItem from './StepItem';
import StepGroupBlock from './StepGroupBlock';
import SortableItem from './SortableItem';
import Lightbox from './Lightbox';

interface Props {
  steps: Step[];
  sessionId: string | null;
  onChange: () => void;
}

/** Stable id for a timeline entry — an ordinary step's own id, or a group's
 * anchor id — used as the @dnd-kit sortable key. */
function entryId(entry: StepEntry): string {
  return entry.kind === 'single' ? entry.step.id : entry.anchor.id;
}

export default function StepList({ steps, sessionId, onChange }: Props) {
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  const entries = buildStepEntries(steps);

  const sensors = useSensors(
    // Small activation distance so a click on a button/input inside a row
    // isn't swallowed as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function persistEntries(newEntries: StepEntry[]) {
    if (!sessionId) return;
    await reorderSteps(sessionId, flattenEntries(newEntries));
    onChange();
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = entries.findIndex((e) => entryId(e) === active.id);
    const newIndex = entries.findIndex((e) => entryId(e) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    void persistEntries(arrayMove(entries, oldIndex, newIndex));
  }

  function reorderGroupAnnotations(anchorId: string, reorderedAnnotations: Step[]) {
    const newEntries = entries.map((e) => (e.kind === 'group' && e.anchor.id === anchorId ? { ...e, annotations: reorderedAnnotations } : e));
    void persistEntries(newEntries);
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
        <div className="bg-muted flex size-12 items-center justify-center rounded-full">
          <MousePointerClick className="text-muted-foreground size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">尚未錄製任何步驟</p>
          <p className="text-muted-foreground mx-auto max-w-sm text-xs leading-relaxed">
            開啟要教學的頁面，點工具列的 FrameTrail 圖示，按「開始錄製」後在頁面上點擊，步驟就會顯示在這裡。
          </p>
        </div>
      </div>
    );
  }

  function renderEntry(entry: StepEntry, index: number, dragHandle: ReactNode) {
    if (entry.kind === 'single') {
      return (
        <StepItem step={entry.step} index={index} onChange={onChange} onZoom={() => setZoomIndex(index)} dragHandle={dragHandle} />
      );
    }
    return (
      <StepGroupBlock
        anchor={entry.anchor}
        annotations={entry.annotations}
        index={index}
        onChange={onChange}
        onReorderAnnotations={(reordered) => reorderGroupAnnotations(entry.anchor.id, reordered)}
        onZoom={() => setZoomIndex(index)}
        dragHandle={dragHandle}
      />
    );
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={entries.map(entryId)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-6">
            {entries.map((entry, index) => (
              <SortableItem key={entryId(entry)} id={entryId(entry)}>
                {(handle) => renderEntry(entry, index, handle)}
              </SortableItem>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <Lightbox entries={entries} index={zoomIndex} onClose={() => setZoomIndex(null)} onNavigate={setZoomIndex} />
    </>
  );
}

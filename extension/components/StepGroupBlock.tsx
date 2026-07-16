import { type ReactNode } from 'react';
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
import { Layers, ZoomIn } from 'lucide-react';
import { updateStep, type Step } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import StepItem from './StepItem';
import SortableItem from './SortableItem';

interface Props {
  anchor: Step;
  annotations: Step[];
  /** Position in the overall (mixed) step timeline — drives the outer "Step N" badge. */
  index: number;
  onChange: () => void;
  /** Bubbles a locally-reordered annotations array up so the parent can
   * persist it against the *complete* session step list (reordering only
   * this group's own subset would collide with other entries' order values —
   * see reorderSteps' contract). */
  onReorderAnnotations: (reordered: Step[]) => void;
  /** Opens this group's combined image in the shared Lightbox (see StepList). */
  onZoom?: () => void;
  /** Ready-made drag handle from SortableItem — placed in the header's
   * control column, vertically centered on the card's right edge. */
  dragHandle: ReactNode;
}

/**
 * Snapshot mode entry: one combined screenshot with every click's box
 * (and, if numbered, its order badge) drawn on top, plus an editable,
 * reorderable list of the per-click descriptions underneath. The anchor step
 * (shared screenshot owner) is never itself shown as an editable row.
 */
export default function StepGroupBlock({ anchor, annotations, index, onChange, onReorderAnnotations, onZoom, dragHandle }: Props) {
  const numbered = anchor.numbered ?? false;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = annotations.findIndex((s) => s.id === active.id);
    const newIndex = annotations.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorderAnnotations(arrayMove(annotations, oldIndex, newIndex));
  }

  async function setNumbered(next: boolean) {
    await Promise.all([anchor, ...annotations].map((s) => updateStep(s.id, { numbered: next })));
    onChange();
  }

  const boxAnnotations = annotations.map((s, i) => ({ bounds: s.bounds!, order: i + 1 }));

  const image = (
    <MultiHighlightThumbnail
      blob={anchor.screenshotBlob}
      annotations={boxAnnotations}
      screenshotScale={anchor.screenshotScale ?? anchor.devicePixelRatio}
      numbered={numbered}
      alt={`步驟 ${index + 1}（快照）`}
      fit="contain"
      imgClassName="block h-full w-full"
      className="h-full w-full"
    />
  );

  return (
    <Card className="group gap-0 overflow-hidden py-0 transition-shadow hover:shadow-md">
      <div className="flex min-h-[180px] items-stretch">
        <div className="bg-muted relative w-1/2 shrink-0">
          {onZoom ? (
            <button type="button" onClick={onZoom} className="block h-full w-full cursor-zoom-in" aria-label="放大圖片">
              {image}
              <span className="bg-background/90 pointer-events-none absolute right-3 bottom-3 z-10 flex items-center gap-1 rounded-md px-2 py-1 text-xs opacity-0 shadow backdrop-blur transition-opacity group-hover:opacity-100">
                <ZoomIn className="size-3.5" />
                放大
              </span>
            </button>
          ) : (
            image
          )}
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 pr-9">
            <Badge className="size-7 justify-center rounded-full p-0 text-xs font-semibold tabular-nums">{index + 1}</Badge>
            <Badge variant="secondary" className="gap-1">
              <Layers className="size-3" />
              快照
            </Badge>
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 pr-9">
            <span className="text-muted-foreground text-xs">標記順序編號</span>
            <Switch checked={numbered} onCheckedChange={setNumbered} />
          </label>
          <div className="absolute top-1/2 right-2 z-10 -translate-y-1/2">{dragHandle}</div>
        </div>
      </div>

      {annotations.length > 0 && (
        <div className="border-t px-3 py-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={annotations.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ul className="divide-y">
                {annotations.map((step, i) => (
                  <SortableItem key={step.id} id={step.id}>
                    {(handle) => <StepItem step={step} index={i} onChange={onChange} thumbnail={false} accent dragHandle={handle} />}
                  </SortableItem>
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      )}
    </Card>
  );
}

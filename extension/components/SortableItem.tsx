import { type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  /** Render prop: receives a ready-made drag handle (a button wired to
   * @dnd-kit's sortable listeners) so the caller can place it anywhere in its
   * own layout instead of a fixed hard-left position. */
  children: (handle: ReactNode) => ReactNode;
  /** Extra classes for the row's <li> element. */
  className?: string;
  disabled?: boolean;
}

/**
 * A drag-to-reorder row: wires up @dnd-kit's sortable state and hands the
 * content a drag handle via render prop. Only the handle carries the drag
 * listeners, so buttons and inputs inside the content stay independently
 * clickable (the parent DndContext also uses a small pointer activation
 * distance for this).
 *
 * Uses CSS.Translate (not CSS.Transform) for the drag transform — Transform
 * also applies dnd-kit's scaleX/scaleY, which visually squashes the dragged
 * row when list items have different heights.
 */
export default function SortableItem({ id, children, className, disabled = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = { transform: CSS.Translate.toString(transform), transition: isDragging ? undefined : transition };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="拖曳排序"
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40"
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <li ref={setNodeRef} style={style} className={cn(isDragging && 'relative z-10', className)}>
      {children(handle)}
    </li>
  );
}

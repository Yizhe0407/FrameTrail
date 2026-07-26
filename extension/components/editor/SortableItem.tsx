import { type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface Props {
  id: string;
  /** Render prop: receives a ready-made drag handle (a button wired to
   * @dnd-kit's sortable listeners) plus this row's drag state, so the caller can
   * place the handle anywhere in its own layout and style the row while it
   * moves, instead of a fixed hard-left position. */
  children: (handle: ReactNode, state: { isDragging: boolean }) => ReactNode;
  /** Extra classes for the row's <li> element. */
  className?: string;
  /** Extra classes for the handle button — rows that sit the handle on top of
   * an image need their own contrast treatment. */
  handleClassName?: string;
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
export default function SortableItem({ id, children, className, handleClassName, disabled = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = { transform: CSS.Translate.toString(transform), transition: isDragging ? undefined : transition };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="拖曳排序"
      // Names the interaction for screen readers, which otherwise announce only
      // "button" and give no hint that this row can be moved.
      aria-roledescription="可拖曳的排序控制項"
      title="拖曳以重新排序（鍵盤：Enter 或空白鍵開始，方向鍵移動，再按一次放下）"
      disabled={disabled}
      className={cn(
        'flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded border-none bg-transparent text-muted-foreground/50 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40',
        handleClassName,
      )}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && 'relative z-10 cursor-grabbing', className)}
    >
      {children(handle, { isDragging })}
    </li>
  );
}

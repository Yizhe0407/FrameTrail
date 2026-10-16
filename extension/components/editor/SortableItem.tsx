import { type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  id: string;
  /** Render prop: receives a ready-made drag handle plus this row's drag state, so the caller can place the handle anywhere in its own layout. */
  children: (handle: ReactNode, state: { isDragging: boolean }) => ReactNode;
  /** Extra classes for the row's <li> element. */
  className?: string;
  /** Extra classes for the handle button — rows that sit the handle on top of
   * an image need their own contrast treatment. */
  handleClassName?: string;
  disabled?: boolean;
}

/**
 * A drag-to-reorder row: only the handle carries drag listeners, so buttons/inputs in the content stay clickable.
 * Uses CSS.Translate (not CSS.Transform) since Transform also applies scaleX/scaleY, squashing rows of differing heights.
 */
export default function SortableItem({ id, children, className, handleClassName, disabled = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = { transform: CSS.Translate.toString(transform), transition: isDragging ? undefined : transition };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={t().sortable.handle}
      // Names the interaction for screen readers, which otherwise just announce "button".
      aria-roledescription={t().sortable.roleDescription}
      disabled={disabled}
      className={cn(
        'flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md border-none bg-transparent text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40',
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

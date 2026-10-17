import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { t } from '@/lib/shared/i18n';

/** The drag handle is a focusable button, so reordering must work without a
 * pointer: Space/Enter lifts, arrows move through the sortable neighbours. */
function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * dnd-kit's built-in announcements are English and describe raw ids, so a drag
 * is announced in the active language with the item's name and position;
 * callers supply a 1-based position lookup. The instructions that explain the
 * keyboard pick-up are localized the same way.
 *
 * @param itemNoun what one row is called, from the i18n `sortable` nouns
 * @param positionOf 1-based display position of an id, or 0 when it is unknown
 */
function createSortableAccessibility(
  itemNoun: string,
  positionOf: (id: UniqueIdentifier) => number,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  const copy = () => t().sortable;
  const describe = (id: UniqueIdentifier) => copy().item(itemNoun, positionOf(id));
  return {
    screenReaderInstructions: { draggable: copy().keyboardInstructions },
    announcements: {
      onDragStart: ({ active }) => copy().dragStart(describe(active.id)),
      onDragOver: ({ active, over }) => (
        over ? copy().dragOver(describe(active.id), positionOf(over.id)) : undefined
      ),
      onDragEnd: ({ active, over }) => (
        over
          ? copy().dragEnd(describe(active.id), positionOf(over.id))
          : copy().dragEndInPlace(describe(active.id))
      ),
      onDragCancel: ({ active }) => copy().dragCancel(describe(active.id)),
    },
  };
}

/**
 * The whole sortable-list scaffold the editor's reorderable lists share:
 * sensors, localized accessibility announcements, the item-id list for
 * SortableContext, and a drag-end handler that maps the drop back onto the
 * caller's array and reports persistence failures under `logLabel`.
 */
export function useSortableReorder<T>(
  items: T[],
  getId: (item: T) => UniqueIdentifier,
  onReorder: (reordered: T[]) => Promise<void>,
  { disabled = false, itemNoun, logLabel }: { disabled?: boolean; itemNoun: string; logLabel: string },
) {
  const sensors = useSortableSensors();
  const accessibility = createSortableAccessibility(
    itemNoun,
    (id) => items.findIndex((item) => getId(item) === id) + 1,
  );

  function handleDragEnd(event: DragEndEvent): void {
    if (disabled) return;
    const reordered = reorderById(items, event.active.id, event.over?.id, getId);
    if (reordered) {
      void onReorder(reordered).catch((error) => {
        console.error(logLabel, error);
      });
    }
  }

  return { sensors, accessibility, handleDragEnd, itemIds: items.map(getId) };
}

export function reorderById<T>(
  items: T[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier | undefined,
  getId: (item: T) => UniqueIdentifier,
): T[] | null {
  if (overId === undefined || activeId === overId) return null;
  const oldIndex = items.findIndex((item) => getId(item) === activeId);
  const newIndex = items.findIndex((item) => getId(item) === overId);
  return oldIndex === -1 || newIndex === -1 ? null : arrayMove(items, oldIndex, newIndex);
}

/** Locks dnd-kit's drag transform to the vertical axis — without this, the
 * dragged item's visual position follows the pointer on both axes and can be
 * dragged arbitrarily far left/right even though these lists only reorder
 * vertically. */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

/** Mobile timeline entries are laid out in one horizontal bottom rail. */
export const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

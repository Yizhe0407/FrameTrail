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

function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * dnd-kit's built-in announcements are English and describe raw ids. A sortable
 * list is only usable without sight if the announcement says which item moved
 * and where it landed, so callers supply a 1-based position lookup.
 *
 * @param itemNoun what one row is called, e.g. 步驟
 * @param positionOf 1-based display position of an id, or 0 when it is unknown
 */
function createSortableAccessibility(
  itemNoun: string,
  positionOf: (id: UniqueIdentifier) => number,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  const describe = (id: UniqueIdentifier) => `${itemNoun} ${positionOf(id)}`;
  return {
    screenReaderInstructions: {
      draggable: `按 Enter 或空白鍵開始排序。開始後用方向鍵移動${itemNoun}，再按一次 Enter 或空白鍵放下，按 Esc 取消。`,
    },
    announcements: {
      onDragStart: ({ active }) => `已提起 ${describe(active.id)}。`,
      onDragOver: ({ active, over }) => (
        over ? `${describe(active.id)} 移到 第 ${positionOf(over.id)} 個位置。` : undefined
      ),
      onDragEnd: ({ active, over }) => (
        over
          ? `${describe(active.id)} 已放在 第 ${positionOf(over.id)} 個位置。`
          : `${describe(active.id)} 已放回原位。`
      ),
      onDragCancel: ({ active }) => `已取消排序，${describe(active.id)} 回到原位。`,
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

import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
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

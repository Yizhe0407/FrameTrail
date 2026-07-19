import { describe, expect, it } from 'vitest';
import { reorderById, restrictToHorizontalAxis, restrictToVerticalAxis } from '@/lib/dnd';

describe('reorderById', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getId = (item: { id: string }) => item.id;

  it('moves the active item to the hovered position', () => {
    expect(reorderById(items, 'a', 'c', getId)?.map(getId)).toEqual(['b', 'c', 'a']);
  });

  it('ignores no-op and stale drop targets', () => {
    expect(reorderById(items, 'a', 'a', getId)).toBeNull();
    expect(reorderById(items, 'a', undefined, getId)).toBeNull();
    expect(reorderById(items, 'missing', 'b', getId)).toBeNull();
  });
});

describe('drag axis modifiers', () => {
  const input = {
    transform: { x: 12, y: 24, scaleX: 1, scaleY: 1 },
  } as Parameters<typeof restrictToVerticalAxis>[0];

  it('keeps desktop rail movement vertical', () => {
    expect(restrictToVerticalAxis(input)).toMatchObject({ x: 0, y: 24 });
  });

  it('keeps mobile rail movement horizontal', () => {
    expect(restrictToHorizontalAxis(input)).toMatchObject({ x: 12, y: 0 });
  });
});

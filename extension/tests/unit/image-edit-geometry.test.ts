import { describe, expect, it } from 'vitest';
import {
  boundsFromPoints,
  clientToImagePoint,
  isUsableItemBounds,
  MIN_ITEM_SIZE,
  moveBounds,
  resizeBounds,
} from '@/lib/editor/image-edit-geometry';
import { itemsToRedactions, redactionsToItems } from '@/lib/editor/image-edit-items';

const size = { width: 400, height: 200 };

describe('image edit geometry', () => {
  it('maps client pixels onto image CSS pixels and clamps to the image', () => {
    const frame = { left: 100, top: 50, width: 200, height: 100 };
    expect(clientToImagePoint({ x: 200, y: 100 }, frame, size)).toEqual({ x: 200, y: 100 });
    expect(clientToImagePoint({ x: 0, y: 1_000 }, frame, size)).toEqual({ x: 0, y: 200 });
  });

  it('normalises drag corners in any direction', () => {
    expect(boundsFromPoints({ x: 50, y: 60 }, { x: 10, y: 20 }, size)).toEqual({ x: 10, y: 20, width: 40, height: 40 });
    expect(boundsFromPoints({ x: -20, y: 10 }, { x: 500, y: 30 }, size)).toEqual({ x: 0, y: 10, width: 400, height: 20 });
  });

  it('treats tiny drags as unusable', () => {
    expect(isUsableItemBounds({ x: 0, y: 0, width: MIN_ITEM_SIZE - 1, height: 50 })).toBe(false);
    expect(isUsableItemBounds({ x: 0, y: 0, width: MIN_ITEM_SIZE, height: MIN_ITEM_SIZE })).toBe(true);
  });

  it('moves without leaving the image', () => {
    const bounds = { x: 350, y: 10, width: 40, height: 20 };
    expect(moveBounds(bounds, 100, -50, size)).toEqual({ x: 360, y: 0, width: 40, height: 20 });
  });

  it('resizes from a handle keeping the opposite edges fixed', () => {
    const bounds = { x: 100, y: 100, width: 100, height: 50 };
    expect(resizeBounds(bounds, 'se', 20, 10, size)).toEqual({ x: 100, y: 100, width: 120, height: 60 });
    expect(resizeBounds(bounds, 'nw', -30, -20, size)).toEqual({ x: 70, y: 80, width: 130, height: 70 });
  });

  it('never collapses or escapes when resizing', () => {
    const bounds = { x: 100, y: 100, width: 100, height: 50 };
    expect(resizeBounds(bounds, 'e', -500, 0, size).width).toBe(MIN_ITEM_SIZE);
    expect(resizeBounds(bounds, 'se', 5_000, 5_000, size)).toEqual({ x: 100, y: 100, width: 300, height: 100 });
  });
});

describe('image edit items', () => {
  it('round-trips redactions through the generic item list', () => {
    const redactions = [{ id: 'a', kind: 'solid' as const, bounds: { x: 1, y: 2, width: 30, height: 40 } }];
    expect(itemsToRedactions(redactionsToItems(redactions))).toEqual(redactions);
  });
});

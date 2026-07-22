import { describe, expect, it } from 'vitest';
import { boundsFromPoints, clampBounds, moveBounds, resizeBounds } from '@/lib/visual-editing';

const viewport = { width: 100, height: 80 };

describe('visual editing geometry', () => {
  it('normalizes drag direction and clamps to the source viewport', () => {
    expect(boundsFromPoints({ x: 90, y: 70 }, { x: 110, y: 90 }, viewport)).toEqual({
      x: 80,
      y: 60,
      width: 20,
      height: 20,
    });
  });

  it('keeps moved bounds fully inside the viewport', () => {
    expect(moveBounds({ x: 10, y: 10, width: 30, height: 20 }, -50, 100, viewport)).toEqual({
      x: 0,
      y: 60,
      width: 30,
      height: 20,
    });
  });

  it('resizes from an edge and enforces a finite minimum', () => {
    expect(resizeBounds({ x: 10, y: 10, width: 30, height: 20 }, 'nw', 100, 100, viewport)).toEqual({
      x: 30,
      y: 0,
      width: 70,
      height: 80,
    });
    expect(clampBounds({ x: Number.NaN, y: 0, width: 0, height: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    });
  });
});

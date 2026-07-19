import { describe, expect, it } from 'vitest';
import {
  clampToolbarPosition,
  isRecordingToolbarCorner,
  moveToolbarCorner,
  positionForToolbarCorner,
  snapToolbarCorner,
} from '@/lib/recording-toolbar-position';

describe('recording toolbar position', () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 320, height: 44 };

  it('positions every corner inside the viewport margin', () => {
    expect(positionForToolbarCorner('top-left', size, viewport, 16)).toEqual({ x: 16, y: 16 });
    expect(positionForToolbarCorner('top-right', size, viewport, 16)).toEqual({ x: 464, y: 16 });
    expect(positionForToolbarCorner('bottom-left', size, viewport, 16)).toEqual({ x: 16, y: 540 });
    expect(positionForToolbarCorner('bottom-right', size, viewport, 16)).toEqual({ x: 464, y: 540 });
  });

  it('clamps oversized and offscreen positions without producing negative coordinates', () => {
    expect(clampToolbarPosition({ x: -200, y: 900 }, { width: 900, height: 700 }, viewport, 8)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it('snaps by the toolbar center and supports keyboard corner movement', () => {
    expect(snapToolbarCorner({ x: 20, y: 20 }, size, viewport)).toBe('top-left');
    expect(snapToolbarCorner({ x: 460, y: 520 }, size, viewport)).toBe('bottom-right');
    expect(moveToolbarCorner('bottom-right', 'up')).toBe('top-right');
    expect(moveToolbarCorner('top-right', 'left')).toBe('top-left');
  });

  it('rejects corrupt stored values', () => {
    expect(isRecordingToolbarCorner('bottom-left')).toBe(true);
    expect(isRecordingToolbarCorner('center')).toBe(false);
    expect(isRecordingToolbarCorner(null)).toBe(false);
  });
});

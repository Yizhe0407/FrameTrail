import type { Bounds } from './db';

export interface ViewportSize {
  width: number;
  height: number;
}

export const MIN_VISUAL_BOUNDS_SIZE = 4;
const PRECISION = 100;

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

export function clampBounds(
  bounds: Bounds,
  viewport: ViewportSize,
  minimumSize = MIN_VISUAL_BOUNDS_SIZE,
): Bounds {
  const safeViewport = {
    width: Math.max(0, Number.isFinite(viewport.width) ? viewport.width : 0),
    height: Math.max(0, Number.isFinite(viewport.height) ? viewport.height : 0),
  };
  const minWidth = Math.min(minimumSize, safeViewport.width);
  const minHeight = Math.min(minimumSize, safeViewport.height);
  const width = Math.min(
    safeViewport.width,
    Math.max(minWidth, Number.isFinite(bounds.width) ? Math.abs(bounds.width) : minWidth),
  );
  const height = Math.min(
    safeViewport.height,
    Math.max(minHeight, Number.isFinite(bounds.height) ? Math.abs(bounds.height) : minHeight),
  );
  const x = Math.min(
    Math.max(0, Number.isFinite(bounds.x) ? bounds.x : 0),
    Math.max(0, safeViewport.width - width),
  );
  const y = Math.min(
    Math.max(0, Number.isFinite(bounds.y) ? bounds.y : 0),
    Math.max(0, safeViewport.height - height),
  );
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function boundsFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: ViewportSize,
): Bounds {
  return clampBounds(
    {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    },
    viewport,
  );
}

export function moveBounds(
  bounds: Bounds,
  dx: number,
  dy: number,
  viewport: ViewportSize,
): Bounds {
  return clampBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, viewport);
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function resizeBounds(
  bounds: Bounds,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  viewport: ViewportSize,
): Bounds {
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  if (right < left) [left, right] = [right, left];
  if (bottom < top) [top, bottom] = [bottom, top];
  return clampBounds({ x: left, y: top, width: right - left, height: bottom - top }, viewport);
}

export function boundsEqual(a: Bounds | null | undefined, b: Bounds | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

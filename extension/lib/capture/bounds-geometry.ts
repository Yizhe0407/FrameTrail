import type { Bounds } from '../storage/models';

/**
 * Rectangle algebra shared by the capture and recording pipelines. Kept apart
 * from the DOM-aware modules so that pure parsers (image maps) and pure
 * geometry consumers (frame relays) can use it without importing element
 * inspection code.
 */

/**
 * Overlap of two rectangles, or null when they only touch or miss entirely. A
 * zero-area overlap is treated as no overlap because callers use the result to
 * decide whether anything is actually painted there.
 */
export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

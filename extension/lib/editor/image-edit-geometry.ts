import type { Bounds } from '@/lib/storage/models';

/** Pure pointer/rectangle math for the image edit layer. Everything is in
 * screenshot CSS pixels (the same space `Bounds` are stored in); callers map
 * client pixels through `clientToImagePoint` first. */

export interface Point {
  x: number;
  y: number;
}

export interface ImageCssSize {
  width: number;
  height: number;
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest edge a drawn item may have; anything smaller is treated as a stray click. */
export const MIN_ITEM_SIZE = 4;

const round = (value: number): number => Math.round(value * 100) / 100;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Maps a pointer position onto the image, given the on-screen rect of the image content frame. */
export function clientToImagePoint(
  client: Point,
  frame: { left: number; top: number; width: number; height: number },
  size: ImageCssSize,
): Point {
  if (frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0 };
  // Rounded so stored coordinates are clean numbers, not float noise from the division.
  return {
    x: round(clamp(((client.x - frame.left) / frame.width) * size.width, 0, size.width)),
    y: round(clamp(((client.y - frame.top) / frame.height) * size.height, 0, size.height)),
  };
}

/** Normalises two drag corners into a bounds rect clamped to the image. */
export function boundsFromPoints(a: Point, b: Point, size: ImageCssSize): Bounds {
  const left = clamp(Math.min(a.x, b.x), 0, size.width);
  const top = clamp(Math.min(a.y, b.y), 0, size.height);
  const right = clamp(Math.max(a.x, b.x), 0, size.width);
  const bottom = clamp(Math.max(a.y, b.y), 0, size.height);
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

export function isUsableItemBounds(bounds: Bounds): boolean {
  return bounds.width >= MIN_ITEM_SIZE && bounds.height >= MIN_ITEM_SIZE;
}

/** Translates a rect, keeping it fully inside the image. */
export function moveBounds(bounds: Bounds, dx: number, dy: number, size: ImageCssSize): Bounds {
  return {
    x: round(clamp(bounds.x + dx, 0, Math.max(0, size.width - bounds.width))),
    y: round(clamp(bounds.y + dy, 0, Math.max(0, size.height - bounds.height))),
    width: bounds.width,
    height: bounds.height,
  };
}

/** Drags one handle by (dx, dy). The opposite edges stay put and the rect never
 * collapses below MIN_ITEM_SIZE or leaves the image. */
export function resizeBounds(
  bounds: Bounds,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  size: ImageCssSize,
): Bounds {
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_ITEM_SIZE);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_ITEM_SIZE, size.width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_ITEM_SIZE);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_ITEM_SIZE, size.height);
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

/** The farthest a ray from `origin` in direction (ux, uy) can go before leaving the image. */
function reachInsideImage(origin: Point, ux: number, uy: number, size: ImageCssSize): number {
  const toEdge = (position: number, direction: number, extent: number): number => {
    if (direction > 0) return (extent - position) / direction;
    if (direction < 0) return position / -direction;
    return Number.POSITIVE_INFINITY;
  };
  return Math.max(Math.min(toEdge(origin.x, ux, size.width), toEdge(origin.y, uy, size.height)), 0);
}

/** Holding Shift while drawing a box or ellipse: the point moves so the box is a square (or circle). */
export function constrainToSquare(anchor: Point, point: Point, size: ImageCssSize): Point {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const signX = dx < 0 ? -1 : 1;
  const signY = dy < 0 ? -1 : 1;
  const side = Math.min(
    Math.max(Math.abs(dx), Math.abs(dy)),
    reachInsideImage(anchor, signX, 0, size),
    reachInsideImage(anchor, 0, signY, size),
  );
  return { x: round(anchor.x + signX * side), y: round(anchor.y + signY * side) };
}

/** Holding Shift while drawing a line or arrow: the end snaps to the nearest multiple of `stepDegrees`, keeping its length. */
export function snapToAngle(origin: Point, point: Point, size: ImageCssSize, stepDegrees = 45): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const reach = Math.min(length, reachInsideImage(origin, ux, uy, size));
  return { x: round(origin.x + ux * reach), y: round(origin.y + uy * reach) };
}

/** Shift while dragging a corner handle: the box keeps the proportions it had when the drag began. */
export function resizeBoundsKeepRatio(
  bounds: Bounds,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  size: ImageCssSize,
): Bounds {
  if (handle.length !== 2) return resizeBounds(bounds, handle, dx, dy, size);
  const ratio = bounds.width / bounds.height;
  const growsRight = handle.includes('e');
  const growsDown = handle.includes('s');
  // Take whichever axis the pointer moved further along, as a share of the box, and derive the other from the ratio.
  const widthChange = growsRight ? dx : -dx;
  const heightChange = growsDown ? dy : -dy;
  const scale = Math.abs(widthChange / bounds.width) >= Math.abs(heightChange / bounds.height)
    ? (bounds.width + widthChange) / bounds.width
    : (bounds.height + heightChange) / bounds.height;
  const width = Math.max(bounds.width * scale, MIN_ITEM_SIZE);
  const fixedX = growsRight ? bounds.x : bounds.x + bounds.width;
  const fixedY = growsDown ? bounds.y : bounds.y + bounds.height;
  const room = Math.min(
    growsRight ? size.width - fixedX : fixedX,
    (growsDown ? size.height - fixedY : fixedY) * ratio,
  );
  const finalWidth = Math.min(width, Math.max(room, MIN_ITEM_SIZE));
  const finalHeight = finalWidth / ratio;
  return {
    x: round(growsRight ? fixedX : fixedX - finalWidth),
    y: round(growsDown ? fixedY : fixedY - finalHeight),
    width: round(finalWidth),
    height: round(finalHeight),
  };
}

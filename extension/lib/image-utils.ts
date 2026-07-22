/** Returns a finite, positive screenshot-pixel-to-CSS-pixel scale. Corrupt or
 * legacy metadata must never create infinite/zero viewport geometry. */
export function getValidScreenshotScale(value: number | null | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}

export interface ImageBounds { x: number; y: number; width: number; height: number }

export function isValidImageBounds(bounds: ImageBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

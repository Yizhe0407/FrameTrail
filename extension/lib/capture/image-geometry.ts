import { type Bounds } from '../storage/models';
import { createBorderBoxCoordinateMapper, getUntransformedBorderBoxSize } from './frame-geometry';

export interface ImageCoordinateMapper {
  /** The image-map coordinate plane before CSS transforms are applied. */
  coordinateBounds: Bounds;
  /** The transformed border-box bounds in viewport coordinates. */
  imageBounds: Bounds;
  toImagePoint(clientX: number, clientY: number): { x: number; y: number };
  toViewportBounds(bounds: Bounds): Bounds;
}

/**
 * Maps HTML image-map CSS coordinates through the image's border-box transform.
 *
 * Image-map coordinates use the untransformed border-box CSS pixel plane, so
 * border and padding occupy coordinates too. They are not intrinsic image pixels
 * and are not remapped through naturalWidth, object-fit, or object-position.
 */
export function createImageCoordinateMapper(image: HTMLImageElement): ImageCoordinateMapper | null {
  const { width, height } = getUntransformedBorderBoxSize(image);
  if (width <= 0 || height <= 0) return null;

  const borderMapper = createBorderBoxCoordinateMapper(image, { width, height });
  if (!borderMapper) return null;
  const coordinateBounds = { x: 0, y: 0, width, height };

  return {
    coordinateBounds,
    imageBounds: borderMapper.toParentBounds(coordinateBounds),
    toImagePoint(clientX, clientY) {
      return borderMapper.toLocalPoint({ x: clientX, y: clientY });
    },
    toViewportBounds(bounds) {
      return borderMapper.toParentBounds(bounds);
    },
  };
}

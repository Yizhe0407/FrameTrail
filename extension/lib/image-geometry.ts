import type { Bounds } from './db';
import { createBorderBoxCoordinateMapper } from './frame-geometry';

export interface ImageCoordinateMapper {
  contentBounds: Bounds;
  toSourcePoint(clientX: number, clientY: number): { x: number; y: number };
  toViewportBounds(bounds: Bounds): Bounds;
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectPositionOffset(value: string, freeSpace: number): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'left' || normalized === 'top') return 0;
  if (normalized === 'center') return freeSpace / 2;
  if (normalized === 'right' || normalized === 'bottom') return freeSpace;
  if (normalized.endsWith('%')) {
    const percentage = Number.parseFloat(normalized);
    return Number.isFinite(percentage) ? (freeSpace * percentage) / 100 : freeSpace / 2;
  }
  if (normalized.endsWith('px')) return cssPixels(normalized);
  return freeSpace / 2;
}

function objectPositionTokens(value: string): [string, string] {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ['50%', '50%'];
  if (tokens.length === 1) {
    return tokens[0] === 'top' || tokens[0] === 'bottom'
      ? ['50%', tokens[0]]
      : [tokens[0], '50%'];
  }
  const horizontal = new Set(['left', 'right']);
  const vertical = new Set(['top', 'bottom']);
  return vertical.has(tokens[0]) && horizontal.has(tokens[1])
    ? [tokens[1], tokens[0]]
    : [tokens[0], tokens[1]];
}

/** Maps intrinsic image-map coordinates to the pixels where the image is
 * actually painted, including border, padding, object-fit and object-position. */
export function createImageCoordinateMapper(
  image: HTMLImageElement,
  sourceWidth: number,
  sourceHeight: number,
): ImageCoordinateMapper | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const borderMapper = createBorderBoxCoordinateMapper(image);
  if (!borderMapper) return null;
  const borderWidth = image.offsetWidth;
  const borderHeight = image.offsetHeight;
  const style = getComputedStyle(image);
  const paddingLeft = cssPixels(style.paddingLeft);
  const paddingRight = cssPixels(style.paddingRight);
  const paddingTop = cssPixels(style.paddingTop);
  const paddingBottom = cssPixels(style.paddingBottom);
  const paddingBoxWidth = image.clientWidth || Math.max(borderWidth - image.clientLeft * 2, 0);
  const paddingBoxHeight = image.clientHeight || Math.max(borderHeight - image.clientTop * 2, 0);
  const contentWidth = Math.max(paddingBoxWidth - paddingLeft - paddingRight, 0);
  const contentHeight = Math.max(paddingBoxHeight - paddingTop - paddingBottom, 0);
  if (contentWidth <= 0 || contentHeight <= 0) return null;

  let renderedWidth = contentWidth;
  let renderedHeight = contentHeight;
  const containScale = Math.min(contentWidth / sourceWidth, contentHeight / sourceHeight);
  switch (style.objectFit) {
    case 'contain':
      renderedWidth = sourceWidth * containScale;
      renderedHeight = sourceHeight * containScale;
      break;
    case 'cover': {
      const coverScale = Math.max(contentWidth / sourceWidth, contentHeight / sourceHeight);
      renderedWidth = sourceWidth * coverScale;
      renderedHeight = sourceHeight * coverScale;
      break;
    }
    case 'none':
      renderedWidth = sourceWidth;
      renderedHeight = sourceHeight;
      break;
    case 'scale-down': {
      const scale = Math.min(1, containScale);
      renderedWidth = sourceWidth * scale;
      renderedHeight = sourceHeight * scale;
      break;
    }
  }

  const [positionX, positionY] = objectPositionTokens(style.objectPosition);
  const contentLeft = image.clientLeft + paddingLeft;
  const contentTop = image.clientTop + paddingTop;
  const renderedLeft = contentLeft + objectPositionOffset(positionX, contentWidth - renderedWidth);
  const renderedTop = contentTop + objectPositionOffset(positionY, contentHeight - renderedHeight);
  const rendered = { x: renderedLeft, y: renderedTop, width: renderedWidth, height: renderedHeight };

  return {
    contentBounds: borderMapper.toParentBounds({
      x: contentLeft,
      y: contentTop,
      width: contentWidth,
      height: contentHeight,
    }),
    toSourcePoint(clientX, clientY) {
      const local = borderMapper.toLocalPoint({ x: clientX, y: clientY });
      return {
        x: ((local.x - rendered.x) / rendered.width) * sourceWidth,
        y: ((local.y - rendered.y) / rendered.height) * sourceHeight,
      };
    },
    toViewportBounds(bounds) {
      return borderMapper.toParentBounds({
        x: rendered.x + (bounds.x / sourceWidth) * rendered.width,
        y: rendered.y + (bounds.y / sourceHeight) * rendered.height,
        width: (bounds.width / sourceWidth) * rendered.width,
        height: (bounds.height / sourceHeight) * rendered.height,
      });
    },
  };
}

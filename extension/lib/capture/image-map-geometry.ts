import type { Bounds } from '../storage/models';
import { createImageCoordinateMapper } from './image-geometry';

const ASCII_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' ']);
const COORDINATE_DELIMITERS = new Set([...ASCII_WHITESPACE, ',', ';']);

interface ImageMapRegion {
  bounds: Bounds;
  contains(x: number, y: number): boolean;
}

export interface ResolvedImageMapAreaBounds {
  image: HTMLImageElement;
  bounds: Bounds;
}

function isCoordinateDelimiter(character: string): boolean {
  return COORDINATE_DELIMITERS.has(character);
}

function canStartCoordinateNumber(character: string): boolean {
  return (character >= '0' && character <= '9') || character === '.' || character === '-';
}

/** Implements HTML's list-of-floating-point-numbers tokenization used by coords. */
export function parseImageMapCoordinates(input: string): number[] {
  const numbers: number[] = [];
  let position = 0;

  const skipDelimiters = () => {
    while (position < input.length && isCoordinateDelimiter(input[position])) position += 1;
  };

  skipDelimiters();
  while (position < input.length) {
    while (
      position < input.length &&
      !isCoordinateDelimiter(input[position]) &&
      !canStartCoordinateNumber(input[position])
    ) {
      position += 1;
    }

    const start = position;
    while (position < input.length && !isCoordinateDelimiter(input[position])) position += 1;
    const parsed = Number.parseFloat(input.slice(start, position));
    numbers.push(Number.isFinite(parsed) && !Object.is(parsed, -0) ? parsed : 0);
    skipDelimiters();
  }

  return numbers;
}

function normalizedShape(area: HTMLAreaElement): 'default' | 'rect' | 'circle' | 'poly' {
  switch ((area.getAttribute('shape') ?? '').toLowerCase()) {
    case 'default':
      return 'default';
    case 'circle':
    case 'circ':
      return 'circle';
    case 'poly':
    case 'polygon':
      return 'poly';
    case 'rect':
    case 'rectangle':
      return 'rect';
    default:
      return 'rect';
  }
}

function pointOnSegment(
  x: number,
  y: number,
  start: readonly [number, number],
  end: readonly [number, number],
): boolean {
  const [startX, startY] = start;
  const [endX, endY] = end;
  const cross = (endX - startX) * (y - startY) - (endY - startY) * (x - startX);
  const scale = Math.max(
    1,
    Math.abs(endX - startX),
    Math.abs(endY - startY),
    Math.abs(x - startX),
    Math.abs(y - startY),
  );
  if (Math.abs(cross) > Number.EPSILON * scale * scale * 16) return false;
  return (
    x >= Math.min(startX, endX) &&
    x <= Math.max(startX, endX) &&
    y >= Math.min(startY, endY) &&
    y <= Math.max(startY, endY)
  );
}

/** HTML image-map polygons use the even-odd rule and include polygon edges. */
function pointInPolygon(x: number, y: number, points: Array<readonly [number, number]>): boolean {
  let inside = false;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (pointOnSegment(x, y, start, end)) return true;

    const crossesScanline = (start[1] > y) !== (end[1] > y);
    if (crossesScanline) {
      const intersectionX = start[0] + ((y - start[1]) * (end[0] - start[0])) / (end[1] - start[1]);
      if (x < intersectionX) inside = !inside;
    }
  }
  return inside;
}

function regionForArea(area: HTMLAreaElement, imageBounds: Bounds): ImageMapRegion | null {
  const shape = normalizedShape(area);
  if (shape === 'default') {
    return { bounds: imageBounds, contains: () => true };
  }

  const coords = parseImageMapCoordinates(area.coords);
  if (shape === 'rect') {
    if (coords.length < 4) return null;
    let [left, top, right, bottom] = coords;
    if (left > right) [left, right] = [right, left];
    if (top > bottom) [top, bottom] = [bottom, top];
    return {
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      contains: (x, y) => x >= left && x <= right && y >= top && y <= bottom,
    };
  }

  if (shape === 'circle') {
    if (coords.length < 3) return null;
    const [centerX, centerY, radius] = coords;
    if (radius <= 0) return null;
    return {
      bounds: {
        x: centerX - radius,
        y: centerY - radius,
        width: radius * 2,
        height: radius * 2,
      },
      contains: (x, y) => Math.hypot(x - centerX, y - centerY) <= radius,
    };
  }

  if (coords.length % 2 === 1) coords.pop();
  if (coords.length <= 4) return null;
  const points = Array.from(
    { length: coords.length / 2 },
    (_, index) => [coords[index * 2], coords[index * 2 + 1]] as const,
  );
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    bounds: {
      x: left,
      y: top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    },
    contains: (x, y) => pointInPolygon(x, y, points),
  };
}

function imageMapNameReference(image: HTMLImageElement): string | null {
  const useMap = image.getAttribute('usemap') ?? '';
  const hashIndex = useMap.indexOf('#');
  return hashIndex >= 0 && hashIndex < useMap.length - 1 ? useMap.slice(hashIndex + 1) : null;
}

function queryTree(node: Node, selector: string): Element[] {
  const root = node.getRootNode();
  const matchesRoot = root instanceof Element && root.matches(selector) ? [root] : [];
  if (!('querySelectorAll' in root)) return matchesRoot;
  return [...matchesRoot, ...Array.from((root as ParentNode).querySelectorAll(selector))];
}

/** Resolves the first map whose id or name exactly matches the hash-name reference. */
export function findMapForImage(image: HTMLImageElement): HTMLMapElement | null {
  const mapName = imageMapNameReference(image);
  if (!mapName) return null;
  return (
    queryTree(image, 'map').find(
      (candidate): candidate is HTMLMapElement =>
        candidate instanceof HTMLMapElement && (candidate.id === mapName || candidate.name === mapName),
    ) ?? null
  );
}

function containsBoundsPoint(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.x &&
    y >= bounds.y &&
    x <= bounds.x + bounds.width &&
    y <= bounds.y + bounds.height
  );
}

function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Finds an image that actually resolves to the area element's containing map. */
export function findImageForArea(
  area: HTMLAreaElement,
  clientX?: number,
  clientY?: number,
): HTMLImageElement | null {
  const map = area.closest('map');
  if (!(map instanceof HTMLMapElement)) return null;
  const images = queryTree(area, 'img').filter(
    (candidate): candidate is HTMLImageElement =>
      candidate instanceof HTMLImageElement && findMapForImage(candidate) === map,
  );

  if (
    typeof clientX === 'number' &&
    typeof clientY === 'number' &&
    Number.isFinite(clientX) &&
    Number.isFinite(clientY)
  ) {
    const root = area.getRootNode() as Node & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    const stackedImage = root
      .elementsFromPoint?.(clientX, clientY)
      .find((candidate) => candidate instanceof HTMLImageElement && images.includes(candidate));
    if (stackedImage instanceof HTMLImageElement) return stackedImage;

    const containingImage = images.find((image) => {
      const mapper = createImageCoordinateMapper(image);
      if (!mapper) return false;
      const point = mapper.toImagePoint(clientX, clientY);
      return containsBoundsPoint(mapper.coordinateBounds, point.x, point.y);
    });
    if (containingImage) return containingImage;
  }

  return images[0] ?? null;
}

/** Returns the first image-map area whose region contains the viewport point. */
export function findImageMapAreaAtPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): HTMLAreaElement | null {
  const map = findMapForImage(image);
  if (!map) return null;

  const mapper = createImageCoordinateMapper(image);
  if (!mapper) return null;
  const point = mapper.toImagePoint(clientX, clientY);
  if (!containsBoundsPoint(mapper.coordinateBounds, point.x, point.y)) return null;

  for (const area of Array.from(map.areas) as HTMLAreaElement[]) {
    const region = regionForArea(area, mapper.coordinateBounds);
    if (region?.contains(point.x, point.y)) return area;
  }
  return null;
}

/**
 * Resolves an area's image-clipped viewport bounds. Visibility clipping is
 * deliberately left to selector-utils so it follows the image's paint tree.
 */
export function resolveImageMapAreaBounds(
  area: HTMLAreaElement,
  clientX: number,
  clientY: number,
): ResolvedImageMapAreaBounds | null {
  const image = findImageForArea(area, clientX, clientY);
  if (!image) return null;

  const mapper = createImageCoordinateMapper(image);
  if (!mapper) return null;
  const region = regionForArea(area, mapper.coordinateBounds);
  if (!region) return null;
  const localBounds = intersectBounds(region.bounds, mapper.coordinateBounds);
  if (!localBounds) return null;

  return { image, bounds: mapper.toViewportBounds(localBounds) };
}

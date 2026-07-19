import type { Bounds } from './db';

interface Point {
  x: number;
  y: number;
}

interface QuadLike {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}

type ElementWithOptionalQuads = HTMLElement & {
  getBoxQuads?: (options?: { box?: 'border' }) => QuadLike[];
};

export interface BorderBoxCoordinateMapper {
  toLocalPoint(point: Point): Point;
  toParentBounds(bounds: Bounds): Bounds;
}

export interface FrameCoordinateMapper {
  toChildPoint(point: Point): Point;
  toParentBounds(bounds: Bounds): Bounds;
}

function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function transformedBasisFromComputedStyle(
  element: HTMLElement,
  rect: DOMRect,
  borderWidth: number,
  borderHeight: number,
): { origin: Point; xBasis: Point; yBasis: Point } | null {
  if (typeof getComputedStyle !== 'function' || typeof DOMMatrixReadOnly === 'undefined') return null;
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === 'none') return null;

  try {
    const matrix = new DOMMatrixReadOnly(transform);
    const relativeCorners = [
      { x: 0, y: 0 },
      { x: matrix.a * borderWidth, y: matrix.b * borderWidth },
      { x: matrix.c * borderHeight, y: matrix.d * borderHeight },
      {
        x: matrix.a * borderWidth + matrix.c * borderHeight,
        y: matrix.b * borderWidth + matrix.d * borderHeight,
      },
    ];
    const xs = relativeCorners.map((point) => point.x);
    const ys = relativeCorners.map((point) => point.y);
    const expectedWidth = Math.max(...xs) - Math.min(...xs);
    const expectedHeight = Math.max(...ys) - Math.min(...ys);
    if (expectedWidth <= 0 || expectedHeight <= 0) return null;

    // Axis-aligned transforms on ancestors (including CSS zoom) scale the
    // computed element matrix's output. The observed AABB recovers that scale.
    const outputScaleX = rect.width / expectedWidth;
    const outputScaleY = rect.height / expectedHeight;
    const scaledCorners = relativeCorners.map((point) => ({
      x: point.x * outputScaleX,
      y: point.y * outputScaleY,
    }));
    const minX = Math.min(...scaledCorners.map((point) => point.x));
    const minY = Math.min(...scaledCorners.map((point) => point.y));
    return {
      origin: { x: rect.left - minX, y: rect.top - minY },
      xBasis: { x: matrix.a * outputScaleX, y: matrix.b * outputScaleY },
      yBasis: { x: matrix.c * outputScaleX, y: matrix.d * outputScaleY },
    };
  } catch {
    return null;
  }
}

/**
 * Maps between a child viewport and its iframe's parent viewport. getBoxQuads
 * supplies the actual affine border-box basis when available, covering scale,
 * rotation, skew and transformed ancestors. Browsers without getBoxQuads use
 * a computed DOMMatrix plus the observed bounding box, then fall back to an
 * axis-aligned mapping only when neither transform representation is usable.
 */
export function createFrameCoordinateMapper(frame: HTMLIFrameElement): FrameCoordinateMapper | null {
  const borderMapper = createBorderBoxCoordinateMapper(frame);
  if (!borderMapper) return null;
  return {
    toChildPoint(point) {
      const local = borderMapper.toLocalPoint(point);
      return { x: local.x - frame.clientLeft, y: local.y - frame.clientTop };
    },
    toParentBounds(bounds) {
      return borderMapper.toParentBounds({
        x: frame.clientLeft + bounds.x,
        y: frame.clientTop + bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    },
  };
}

/** General border-box mapper shared by iframes and replaced elements. */
export function createBorderBoxCoordinateMapper(element: HTMLElement): BorderBoxCoordinateMapper | null {
  const borderWidth = element.offsetWidth;
  const borderHeight = element.offsetHeight;
  if (borderWidth <= 0 || borderHeight <= 0) return null;

  let origin: Point;
  let xBasis: Point;
  let yBasis: Point;
  const elementWithQuads = element as ElementWithOptionalQuads;
  let quad: QuadLike | undefined;
  try {
    quad = elementWithQuads.getBoxQuads?.({ box: 'border' })[0];
  } catch {
    try {
      quad = elementWithQuads.getBoxQuads?.()[0];
    } catch {
      // Fall through to computed transform or bounding-rect geometry.
    }
  }

  if (quad && [quad.p1, quad.p2, quad.p4].every(isFinitePoint)) {
    origin = quad.p1;
    xBasis = {
      x: (quad.p2.x - quad.p1.x) / borderWidth,
      y: (quad.p2.y - quad.p1.y) / borderWidth,
    };
    yBasis = {
      x: (quad.p4.x - quad.p1.x) / borderHeight,
      y: (quad.p4.y - quad.p1.y) / borderHeight,
    };
  } else {
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const transformed = transformedBasisFromComputedStyle(element, rect, borderWidth, borderHeight);
    origin = transformed?.origin ?? { x: rect.left, y: rect.top };
    xBasis = transformed?.xBasis ?? { x: rect.width / borderWidth, y: 0 };
    yBasis = transformed?.yBasis ?? { x: 0, y: rect.height / borderHeight };
  }

  const determinant = xBasis.x * yBasis.y - xBasis.y * yBasis.x;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return null;

  const borderToParent = (point: Point): Point => ({
    x: origin.x + point.x * xBasis.x + point.y * yBasis.x,
    y: origin.y + point.x * xBasis.y + point.y * yBasis.y,
  });

  return {
    toLocalPoint(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      return {
        x: (dx * yBasis.y - dy * yBasis.x) / determinant,
        y: (dy * xBasis.x - dx * xBasis.y) / determinant,
      };
    },
    toParentBounds(bounds) {
      const left = bounds.x;
      const top = bounds.y;
      const right = left + bounds.width;
      const bottom = top + bounds.height;
      const corners = [
        borderToParent({ x: left, y: top }),
        borderToParent({ x: right, y: top }),
        borderToParent({ x: right, y: bottom }),
        borderToParent({ x: left, y: bottom }),
      ];
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    },
  };
}

import type { Bounds } from './db';

// Highlight geometry in CSS px, scaled by the screenshot pixel ratio.
export const HIGHLIGHT_PADDING = 6;
export const HIGHLIGHT_RADIUS = 8;
export const HIGHLIGHT_LINE_WIDTH = 3;
export const HIGHLIGHT_COLOR = '#ef4444';

// Order-number badge (single-image mode): filled circle straddling whichever
// corner or edge of its own frame clears the neighboring annotations.
export const BADGE_RADIUS = 11;
export const BADGE_FONT_SIZE = 13;
export const BADGE_TEXT_COLOR = '#ffffff';
const COMPACT_PADDING = 2;
const CALLOUT_GAP = 14;
const CALLOUT_SPACING = BADGE_RADIUS * 2 + 6;
// Minimum gap kept between a perimeter badge and a neighboring frame or
// another badge, so circles never touch even when list rows are packed tight.
const BADGE_CLEARANCE = 4;

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface Annotation {
  bounds: Bounds;
  /** 1-based order number shown in the badge when numbered=true. */
  order: number;
}

/** The exact layout shared by the live preview and exported image. */
export interface AnnotationLayout {
  order: number;
  frame: Bounds;
  anchor: AnnotationPoint;
  /** True when the actual targets overlap and a full frame would be ambiguous. */
  markerOnly: boolean;
  /** Where the order badge renders when there is no collision callout: a point
   * on this frame's own perimeter (corner or edge) that clears its neighbors. */
  badgeAnchor: AnnotationPoint;
  /** Present only for a genuine collision group (targets that actually
   * overlap). When set, the badge always renders here with a leader line —
   * regardless of `numbered` — because the frame itself is hidden/ambiguous
   * and the badge is the only way to identify the target. */
  callout: AnnotationPoint | null;
  /** Orthogonal leader path from the target to its callout. */
  leader: AnnotationPoint[];
}

function inflateBounds(bounds: Bounds, padding: number): Bounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Many list/menu components render adjacent rows with a shared 1px border
// (a collapsed-border or negative-margin technique), so their raw
// getBoundingClientRect() values can overlap by a hairline even though the
// rows are visually and semantically distinct. Eroding each side by this much
// before testing overlap ignores that incidental sliver while still catching
// a real overlap (an icon sitting on a button, a badge covering part of a tab).
const GROUPING_TOLERANCE = 3;

function erodeBounds(bounds: Bounds, amount: number): Bounds {
  const width = Math.max(0, bounds.width - amount * 2);
  const height = Math.max(0, bounds.height - amount * 2);
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}

function meaningfullyOverlaps(a: Bounds, b: Bounds): boolean {
  return overlaps(erodeBounds(a, GROUPING_TOLERANCE), erodeBounds(b, GROUPING_TOLERANCE));
}

function unionBounds(bounds: Bounds[]): Bounds {
  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function distanceToBounds(point: AnnotationPoint, bounds: Bounds): number {
  const x = Math.max(bounds.x, Math.min(point.x, bounds.x + bounds.width));
  const y = Math.max(bounds.y, Math.min(point.y, bounds.y + bounds.height));
  return Math.hypot(point.x - x, point.y - y);
}

function segmentCrossesBounds(start: AnnotationPoint, end: AnnotationPoint, bounds: Bounds): boolean {
  if (start.x === end.x) {
    return start.x > bounds.x && start.x < bounds.x + bounds.width && Math.max(start.y, end.y) > bounds.y && Math.min(start.y, end.y) < bounds.y + bounds.height;
  }
  if (start.y === end.y) {
    return start.y > bounds.y && start.y < bounds.y + bounds.height && Math.max(start.x, end.x) > bounds.x && Math.min(start.x, end.x) < bounds.x + bounds.width;
  }
  return false;
}

function routeCrossingCount(points: AnnotationPoint[], obstacles: Bounds[]): number {
  return points.slice(1).reduce(
    (count, point, index) => count + obstacles.filter((bounds) => segmentCrossesBounds(points[index], point, bounds)).length,
    0,
  );
}

function buildLeader(anchor: AnnotationPoint, callout: AnnotationPoint, obstacles: Bounds[]): AnnotationPoint[] {
  if (Math.abs(anchor.x - callout.x) < 4 || Math.abs(anchor.y - callout.y) < 4) return [anchor, callout];

  const horizontalFirst = [anchor, { x: callout.x, y: anchor.y }, callout];
  const verticalFirst = [anchor, { x: anchor.x, y: callout.y }, callout];
  const horizontalCrossings = routeCrossingCount(horizontalFirst, obstacles);
  const verticalCrossings = routeCrossingCount(verticalFirst, obstacles);
  if (horizontalCrossings === 0 || verticalCrossings === 0) {
    return horizontalCrossings <= verticalCrossings ? horizontalFirst : verticalFirst;
  }

  // In a packed cluster both elbow routes can cross another marker. A short
  // diagonal is clearer than an orthogonal line that falsely points through it.
  return [anchor, callout];
}

/**
 * Finds visually quiet points for callouts. It samples the captured image in
 * CSS-pixel cells and accepts only pale, low-contrast cells, then removes any
 * point too close to an annotation. This lets the layout prefer real blank
 * margins instead of blindly choosing the closest left/right edge.
 */
export function findQuietCalloutSlots(
  imageData: ImageData,
  viewportWidth: number,
  viewportHeight: number,
  annotations: Annotation[],
): AnnotationPoint[] {
  const cellSize = 28;
  const radius = BADGE_RADIUS + 4;
  const scaleX = imageData.width / viewportWidth;
  const scaleY = imageData.height / viewportHeight;
  const columns = Math.floor(viewportWidth / cellSize) - 1;
  const rows = Math.floor(viewportHeight / cellSize) - 1;
  if (columns < 3 || rows < 3) return [];
  const quietCells = Array.from({ length: rows }, () => Array<boolean>(columns).fill(false));
  const slots: AnnotationPoint[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = cellSize * (column + 1);
      const y = cellSize * (row + 1);
      let minLuma = 255;
      let maxLuma = 0;
      let lumaTotal = 0;
      let samples = 0;

      // A 7x7 probe catches text, borders and filled controls without reading
      // the full screenshot pixel-by-pixel.
      for (let sampleY = -3; sampleY <= 3; sampleY++) {
        for (let sampleX = -3; sampleX <= 3; sampleX++) {
          const px = Math.min(imageData.width - 1, Math.max(0, Math.round((x + (sampleX * cellSize) / 7) * scaleX)));
          const py = Math.min(imageData.height - 1, Math.max(0, Math.round((y + (sampleY * cellSize) / 7) * scaleY)));
          const offset = (py * imageData.width + px) * 4;
          const luma = imageData.data[offset] * 0.2126 + imageData.data[offset + 1] * 0.7152 + imageData.data[offset + 2] * 0.0722;
          minLuma = Math.min(minLuma, luma);
          maxLuma = Math.max(maxLuma, luma);
          lumaTotal += luma;
          samples++;
        }
      }

      quietCells[row][column] = lumaTotal / samples > 238 && maxLuma - minLuma < 26;
    }
  }

  for (let row = 1; row < rows - 1; row++) {
    for (let column = 1; column < columns - 1; column++) {
      // A 3x3 quiet neighborhood filters out the small white holes inside
      // tables and forms, retaining genuinely open margins and gutters.
      const hasQuietNeighborhood = [-1, 0, 1].every((rowOffset) =>
        [-1, 0, 1].every((columnOffset) => quietCells[row + rowOffset][column + columnOffset]),
      );
      if (!hasQuietNeighborhood) continue;

      const point = { x: cellSize * (column + 1), y: cellSize * (row + 1) };
      const clearOfAnnotations = annotations.every(({ bounds }) => distanceToBounds(point, inflateBounds(bounds, radius)) > radius);
      if (clearOfAnnotations) slots.push(point);
    }
  }

  return slots;
}

function pickQuietCallouts(
  candidates: AnnotationPoint[] | undefined,
  groupBounds: Bounds,
  count: number,
): AnnotationPoint[] | null {
  if (!candidates?.length) return null;

  const selected: AnnotationPoint[] = [];
  const ranked = candidates
    .filter((point) => distanceToBounds(point, groupBounds) > BADGE_RADIUS + CALLOUT_GAP)
    .sort((a, b) => distanceToBounds(a, groupBounds) - distanceToBounds(b, groupBounds));

  for (const point of ranked) {
    if (selected.every((other) => Math.hypot(point.x - other.x, point.y - other.y) >= CALLOUT_SPACING)) {
      selected.push(point);
      if (selected.length === count) return selected;
    }
  }

  return null;
}

/**
 * The 8 points a badge can straddle on a frame's perimeter, ranked by visual
 * preference: the familiar top-right corner first, then the mid-edges (which
 * stay clear of a neighbor stacked directly above/below, as in a list of
 * rows), then the remaining corners and mid-edges as a last resort.
 */
function perimeterCandidates(frame: Bounds): AnnotationPoint[] {
  const { x, y, width: w, height: h } = frame;
  return [
    { x: x + w, y }, // top-right
    { x: x + w, y: y + h / 2 }, // right-mid
    { x, y: y + h / 2 }, // left-mid
    { x, y }, // top-left
    { x: x + w, y: y + h }, // bottom-right
    { x, y: y + h }, // bottom-left
    { x: x + w / 2, y }, // top-mid
    { x: x + w / 2, y: y + h }, // bottom-mid
  ];
}

function fitsInViewport(point: AnnotationPoint, viewportWidth: number, viewportHeight: number): boolean {
  return (
    point.x - BADGE_RADIUS >= 0 &&
    point.x + BADGE_RADIUS <= viewportWidth &&
    point.y - BADGE_RADIUS >= 0 &&
    point.y + BADGE_RADIUS <= viewportHeight
  );
}

function clampToViewport(point: AnnotationPoint, viewportWidth: number, viewportHeight: number): AnnotationPoint {
  return {
    x: Math.min(Math.max(point.x, BADGE_RADIUS), viewportWidth - BADGE_RADIUS),
    y: Math.min(Math.max(point.y, BADGE_RADIUS), viewportHeight - BADGE_RADIUS),
  };
}

/**
 * Places a badge on its own frame's perimeter, picking whichever corner/edge
 * clears every other frame and already-placed badge. This keeps the badge
 * attached to the box it labels instead of exiling it to a shared lane —
 * that lane is reserved for annotations whose actual targets overlap.
 */
function pickPerimeterBadge(
  frame: Bounds,
  otherFrames: Bounds[],
  placedBadges: AnnotationPoint[],
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint {
  const candidates = perimeterCandidates(frame).filter((point) => fitsInViewport(point, viewportWidth, viewportHeight));

  for (const point of candidates) {
    const clearOfFrames = otherFrames.every((other) => distanceToBounds(point, other) >= BADGE_RADIUS + BADGE_CLEARANCE);
    const clearOfBadges = placedBadges.every(
      (badge) => Math.hypot(point.x - badge.x, point.y - badge.y) >= BADGE_RADIUS * 2 + BADGE_CLEARANCE,
    );
    if (clearOfFrames && clearOfBadges) return point;
  }

  // Every perimeter point is crowded (dense cluster) — the familiar top-right
  // default, clamped back onto the canvas, still beats drawing nothing.
  return clampToViewport(perimeterCandidates(frame)[0], viewportWidth, viewportHeight);
}

/**
 * Places each annotation's frame and order badge. Annotations are grouped
 * together only when their actual click targets overlap — elements that are
 * merely close (e.g. adjacent sidebar rows) are never merged into one
 * cluster. A genuine collision group gets a compact frame (or, if the
 * targets fully coincide, a marker) plus a badge moved to a quiet lane with a
 * leader line. Every other annotation keeps its own frame and gets a badge
 * that straddles whichever corner or edge of that frame clears its
 * neighbors, so the badge never has to be pulled away from what it labels.
 */
export function layoutAnnotations(
  annotations: Annotation[],
  viewportWidth: number,
  viewportHeight: number,
  quietSlots?: AnnotationPoint[],
): AnnotationLayout[] {
  const count = annotations.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  // Join only on genuine overlap of the actual click targets. The visual
  // padding used for drawing must not make merely-adjacent list rows chain
  // transitively into one giant cluster (row A touches B touches C ... Z).
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      if (meaningfullyOverlaps(annotations[a].bounds, annotations[b].bounds)) join(a, b);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < count; index++) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }

  const frames = annotations.map(({ bounds }) => inflateBounds(bounds, HIGHLIGHT_PADDING));
  const placedBadges: AnnotationPoint[] = [];
  const layouts: AnnotationLayout[] = [];
  for (const indexes of groups.values()) {
    if (indexes.length === 1) {
      const index = indexes[0];
      const annotation = annotations[index];
      const frame = frames[index];
      const otherFrames = frames.filter((_, otherIndex) => otherIndex !== index);
      const badgeAnchor = pickPerimeterBadge(frame, otherFrames, placedBadges, viewportWidth, viewportHeight);
      placedBadges.push(badgeAnchor);
      layouts.push({
        order: annotation.order,
        frame,
        anchor: { x: annotation.bounds.x + annotation.bounds.width / 2, y: annotation.bounds.y + annotation.bounds.height / 2 },
        markerOnly: false,
        badgeAnchor,
        callout: null,
        leader: [],
      });
      continue;
    }

    const compactFrames = indexes.map((index) => inflateBounds(annotations[index].bounds, COMPACT_PADDING));
    const groupBounds = unionBounds(compactFrames);
    const quietCallouts = pickQuietCallouts(quietSlots, groupBounds, indexes.length);
    const leftSpace = groupBounds.x;
    const rightSpace = viewportWidth - (groupBounds.x + groupBounds.width);
    const laneOnRight = rightSpace >= leftSpace;
    const laneX = laneOnRight
      ? Math.min(viewportWidth - BADGE_RADIUS, groupBounds.x + groupBounds.width + CALLOUT_GAP + BADGE_RADIUS)
      : Math.max(BADGE_RADIUS, groupBounds.x - CALLOUT_GAP - BADGE_RADIUS);
    const spacing = indexes.length > 1
      ? Math.min(CALLOUT_SPACING, Math.max(BADGE_RADIUS * 2 + 2, (viewportHeight - BADGE_RADIUS * 2) / (indexes.length - 1)))
      : 0;
    const startY = Math.max(
      BADGE_RADIUS,
      Math.min(groupBounds.y + BADGE_RADIUS, viewportHeight - BADGE_RADIUS - spacing * (indexes.length - 1)),
    );

    indexes.forEach((index, position) => {
      const annotation = annotations[index];
      const overlapsTarget = indexes.some((otherIndex) => otherIndex !== index && meaningfullyOverlaps(annotation.bounds, annotations[otherIndex].bounds));
      const anchor = { x: annotation.bounds.x + annotation.bounds.width / 2, y: annotation.bounds.y + annotation.bounds.height / 2 };
      const callout = quietCallouts?.[position] ?? { x: laneX, y: startY + position * spacing };
      placedBadges.push(callout);
      layouts.push({
        order: annotation.order,
        frame: compactFrames[position],
        anchor,
        markerOnly: overlapsTarget,
        badgeAnchor: callout,
        callout,
        leader: buildLeader(
          anchor,
          callout,
          annotations
            .filter((_, otherIndex) => otherIndex !== index)
            .map(({ bounds }) => inflateBounds(bounds, COMPACT_PADDING)),
        ),
      });
    });
  }

  return layouts.sort((a, b) => a.order - b.order);
}

function strokeBox(ctx: OffscreenCanvasRenderingContext2D, bounds: Bounds, dpr: number) {
  const x = bounds.x * dpr;
  const y = bounds.y * dpr;
  const w = bounds.width * dpr;
  const h = bounds.height * dpr;
  const radius = Math.max(Math.min(HIGHLIGHT_RADIUS * dpr, w / 2, h / 2), 0);

  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = HIGHLIGHT_LINE_WIDTH * dpr;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.stroke();

  return { x, y, w, h };
}

function strokeTarget(ctx: OffscreenCanvasRenderingContext2D, anchor: AnnotationPoint, dpr: number) {
  const x = anchor.x * dpr;
  const y = anchor.y * dpr;
  const radius = 6 * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function drawBadge(ctx: OffscreenCanvasRenderingContext2D, point: AnnotationPoint, order: number, dpr: number) {
  const r = BADGE_RADIUS * dpr;
  const cx = point.x * dpr;
  const cy = point.y * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.fill();
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `600 ${BADGE_FONT_SIZE * dpr}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(order), cx, cy);
}

function drawLeader(ctx: OffscreenCanvasRenderingContext2D, points: AnnotationPoint[], dpr: number) {
  if (points.length < 2) return;
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(points[0].x * dpr, points[0].y * dpr);
  for (const point of points.slice(1)) ctx.lineTo(point.x * dpr, point.y * dpr);
  ctx.stroke();
}

/**
 * Composites the red highlight box onto a raw screenshot and returns a new
 * JPEG blob. Shared by every export path so annotation lives in exactly one
 * place. If bounds is null (legacy step), the screenshot is returned as-is.
 */
export async function compositeHighlight(
  screenshot: Blob,
  bounds: Bounds | null,
  screenshotScale: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(screenshot);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  if (bounds) {
    strokeBox(ctx, inflateBounds(bounds, HIGHLIGHT_PADDING), screenshotScale || 1);
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

/**
 * Composites every annotation's red box (and, if numbered, an order badge) onto
 * one shared screenshot — the single-image mode counterpart of
 * {@link compositeHighlight}.
 */
export async function compositeMultiHighlight(
  screenshot: Blob,
  annotations: Annotation[],
  screenshotScale: number,
  numbered: boolean,
): Promise<Blob> {
  const bitmap = await createImageBitmap(screenshot);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);

  const dpr = screenshotScale || 1;
  const viewportWidth = bitmap.width / dpr;
  const viewportHeight = bitmap.height / dpr;
  const quietSlots = findQuietCalloutSlots(ctx.getImageData(0, 0, bitmap.width, bitmap.height), viewportWidth, viewportHeight, annotations);
  const layouts = layoutAnnotations(annotations, viewportWidth, viewportHeight, quietSlots);
  bitmap.close();
  for (const layout of layouts) {
    if (layout.markerOnly) {
      strokeTarget(ctx, layout.anchor, dpr);
    } else {
      strokeBox(ctx, layout.frame, dpr);
    }

    if (layout.callout) {
      drawLeader(ctx, layout.leader, dpr);
      drawBadge(ctx, layout.callout, layout.order, dpr);
    } else if (numbered) {
      drawBadge(ctx, layout.badgeAnchor, layout.order, dpr);
    }
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

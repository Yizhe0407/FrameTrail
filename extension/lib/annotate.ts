import { validateRasterImageBlob } from './raster-image-validation';
import type { Bounds, Redaction } from './db';
import { getValidScreenshotScale, isValidImageBounds } from './image-utils';

// Highlight geometry in CSS px, scaled by the screenshot pixel ratio.
export const HIGHLIGHT_PADDING = 6;
export const HIGHLIGHT_RADIUS = 6;
export const HIGHLIGHT_LINE_WIDTH = 2;
export const HIGHLIGHT_COLOR = '#f43f5e';
export const HIGHLIGHT_FILL_COLOR = 'rgba(244, 63, 94, 0.055)';
export const HIGHLIGHT_PREVIEW_FILL_COLOR = 'rgba(244, 63, 94, 0.09)';

/** Raster redactions deliberately overpaint a small safety margin so no source
 * pixels can survive from antialiased edges or a slightly imprecise selection. */
export const REDACTION_EXPANSION = 2;
export const REDACTION_COLOR = '#000000';

// Order-number badge: a filled circle. A single target's badge straddles its
// own frame's perimeter; a coincident group's badges sit in a side lane, each
// tied to its marker by a leader line.
export const BADGE_RADIUS = 11;
// Digit size as a fraction of the badge diameter (BADGE_RADIUS * 2). Both the
// CSS preview and the canvas export derive the font size from this so they can
// never drift.
export const BADGE_FONT_RATIO = 0.55;
export const BADGE_TEXT_COLOR = '#ffffff';
// The stack the editor page renders with (Tailwind v4 default `font-sans`); the
// canvas badge must name it explicitly since it has no inherited CSS font.
export const BADGE_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

// Leader line from a marker to its side-lane badge.
export const LEADER_LINE_WIDTH = 1.5;

const CALLOUT_GAP = 14;
const CALLOUT_SPACING = BADGE_RADIUS * 2 + 6;
// Minimum gap kept between a badge and a neighboring frame, marker or other
// badge, so circles never touch even when targets are packed tight.
const BADGE_CLEARANCE = 4;
// Anchors closer than this along the lane axis read as one visual cluster, so
// their lane slots follow the step numbers (1,2,3…) instead of a sub-marker-
// sized coordinate difference that would scramble the numbering.
const ANCHOR_TIE_EPSILON = 8;
// How far the whole lane is pushed outward, and how many pushes are tried,
// when its first position collides with already-placed badges or frames.
// Moving the lane as a block preserves the sorted slot order that keeps
// leaders crossing-free; skipping individual slots would scramble it.
const LANE_NUDGE_ATTEMPTS = 3;
// The dot drawn at a coincident target's anchor. Leaders leave from its edge
// rather than the target centre, so the line never sits under its own dot.
// Exported so the CSS preview and canvas export size the marker identically.
export const MARKER_RADIUS = 6;
// White ring around the marker dot, and the filled inner dot's radius. The
// inner radius is 0.4 * MARKER_RADIUS, matching the preview's `inset: 30%`
// (a child inset 30% per side is 40% of the parent → 0.4 of the radius).
export const MARKER_RING_WIDTH = 2;
export const MARKER_INNER_RADIUS = MARKER_RADIUS * 0.4;

// Two targets merge into one coincident group only when their intersection
// covers most of *both* boxes (ratio against the larger area — the smaller of
// the two per-box ratios). Duplicate or heavily stacked same-size targets
// score near 1.0 and merge; merely-adjacent rows sharing a hairline border
// score near 0 and stay separate framed singles. Crucially, a small target
// inside a page-sized container scores near 0 too: measuring against the
// smaller box instead used to read containment as coincidence, gluing every
// target on the page into one giant pseudo-group whose leaders then criss-
// crossed the whole screenshot.
const MERGE_OVERLAP_RATIO = 0.4;

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface Annotation {
  bounds: Bounds;
  /** 1-based order number shown in the badge when numbered=true. */
  order: number;
}

/** The exact layout shared by the live preview and exported image. It is a
 * pure function of the annotations and viewport, so preview and export always
 * agree and each renders in a single pass. */
export interface AnnotationLayout {
  order: number;
  frame: Bounds;
  anchor: AnnotationPoint;
  /** True for a member of a coincident group: it renders as a marker dot at
   * its anchor instead of a frame, because full frames would coincide. */
  markerOnly: boolean;
  /** Where the order badge renders when there is no leader callout: a point on
   * this frame's own perimeter (corner or edge) that clears its neighbors. */
  badgeAnchor: AnnotationPoint;
  /** Present only for a coincident-group member. When set, the badge always
   * renders here — regardless of `numbered` — because the marker alone cannot
   * carry the order number. */
  callout: AnnotationPoint | null;
  /** Straight leader segment from the marker's edge to its callout badge's
   * edge; empty when the badge sits close enough to touch the marker. Lane
   * slots follow the anchors' order along the lane axis (one-sided boundary
   * labeling), so leaders don't cross — except inside a sub-marker-sized
   * anchor blob, where step-number order deliberately wins. */
  leader: AnnotationPoint[];
}

/** Keeps multi-digit labels inside the fixed badge diameter. */
export function getBadgeFontSize(order: number, diameter = BADGE_RADIUS * 2): number {
  const characters = Math.max(1, String(order).length);
  const base = diameter * BADGE_FONT_RATIO;
  const horizontalFit = (diameter - 4) / (characters * 0.62);
  return Math.max(Math.min(base, horizontalFit), Math.min(7, base));
}

/** Per-side highlight padding for a single, so a box squeezed on one side by a
 * neighbor keeps its full padding on the other three (see
 * {@link adaptiveSidePaddings}). */
interface SidePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Scalar inflate, kept for callers that never collide — group-member frames
 * (rendered as marker dots) and {@link compositeHighlight}'s lone box. */
function inflateBounds(bounds: Bounds, padding: number): Bounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function inflateBoundsPerSide(bounds: Bounds, padding: SidePadding): Bounds {
  return {
    x: bounds.x - padding.left,
    y: bounds.y - padding.top,
    width: bounds.width + padding.left + padding.right,
    height: bounds.height + padding.top + padding.bottom,
  };
}

/** Fits the final drawable frame inside the screenshot. Browser hit bounds are
 * already viewport-clipped, but highlight padding can push the outer border
 * beyond an edge and make that side disappear during canvas/SVG clipping. */
function fitBoundsInViewport(bounds: Bounds, viewportWidth: number, viewportHeight: number): Bounds {
  const width = Math.max(Number.isFinite(viewportWidth) ? viewportWidth : 0, 0);
  const height = Math.max(Number.isFinite(viewportHeight) ? viewportHeight : 0, 0);
  const left = Math.min(Math.max(bounds.x, 0), width);
  const top = Math.min(Math.max(bounds.y, 0), height);
  const right = Math.min(Math.max(bounds.x + Math.max(bounds.width, 0), left), width);
  const bottom = Math.min(Math.max(bounds.y + Math.max(bounds.height, 0), top), height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Returns the final single-target highlight frame in screenshot CSS pixels.
 * All single-image renderers use this helper so padding and edge clipping stay
 * identical in previews, thumbnails and exported images. */
export function fitHighlightFrame(bounds: Bounds, viewportWidth: number, viewportHeight: number): Bounds {
  return fitBoundsInViewport(inflateBounds(bounds, HIGHLIGHT_PADDING), viewportWidth, viewportHeight);
}

function fitPointInViewport(
  point: AnnotationPoint,
  radius: number,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint {
  const fitAxis = (value: number, extent: number) => {
    const safeExtent = Math.max(Number.isFinite(extent) ? extent : 0, 0);
    return safeExtent <= radius * 2
      ? safeExtent / 2
      : Math.min(Math.max(value, radius), safeExtent - radius);
  };
  return {
    x: fitAxis(point.x, viewportWidth),
    y: fitAxis(point.y, viewportHeight),
  };
}

/** True when `outer`'s raw bounds fully enclose `inner`'s. */
function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/**
 * Visits every pair of bounds within `maxGap` on both axes, sweeping along the
 * less-congested axis so a long single-column list stays near-linear instead of
 * degenerating to O(n²).
 */
function forEachNearbyPair(
  bounds: Bounds[],
  maxGap: number,
  visit: (first: number, second: number) => void,
): void {
  if (bounds.length < 2) return;

  // Sweep along the less-congested axis. A fixed x-axis sweep still becomes
  // quadratic for a long vertical list because every item shares the same x
  // interval even though none are near each other in y.
  const minX = Math.min(...bounds.map((rect) => rect.x));
  const minY = Math.min(...bounds.map((rect) => rect.y));
  const maxX = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...bounds.map((rect) => rect.y + rect.height));
  const xSpan = Math.max(maxX - minX, 1);
  const ySpan = Math.max(maxY - minY, 1);
  const xCongestion = bounds.reduce((sum, rect) => sum + Math.max(rect.width, 0), 0) / xSpan;
  const yCongestion = bounds.reduce((sum, rect) => sum + Math.max(rect.height, 0), 0) / ySpan;
  const primaryIsX = xCongestion <= yCongestion;
  const primaryStart = (rect: Bounds) => (primaryIsX ? rect.x : rect.y);
  const primaryEnd = (rect: Bounds) => primaryStart(rect) + (primaryIsX ? rect.width : rect.height);
  const secondaryGap = (a: Bounds, b: Bounds) =>
    primaryIsX
      ? Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
      : Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));

  const ordered = bounds.map((_, index) => index).sort((a, b) => primaryStart(bounds[a]) - primaryStart(bounds[b]));
  for (let position = 0; position < ordered.length; position++) {
    const first = ordered[position];
    const a = bounds[first];
    const maxPrimary = primaryEnd(a) + maxGap;
    for (let next = position + 1; next < ordered.length; next++) {
      const second = ordered[next];
      const b = bounds[second];
      if (primaryStart(b) > maxPrimary) break;
      if (secondaryGap(a, b) <= maxGap) visit(first, second);
    }
  }
}

/**
 * Per-side padding for each single so their drawn frames never cross.
 *
 * Invariant: sibling frames do not cross even when their raw browser hit areas
 * already overlap. Disjoint targets only shrink the two facing outer paddings.
 * Partially overlapping targets are split at the middle of their intersection
 * on the axis between their centers; this may make a facing padding negative,
 * intentionally pulling that frame edge inside its oversized hit area. The
 * other sides retain full padding, so the visual target remains recognizable.
 *
 * Only singles are compared: group members render as marker dots, never frames,
 * so they can never collide and would only make this over-conservative.
 *
 * Nested targets are handled separately: the inner frame stays inside the
 * outer raw bounds instead of being split as if the two were siblings.
 */
function adaptiveSidePaddings(rawBounds: Bounds[]): SidePadding[] {
  const paddings: SidePadding[] = rawBounds.map(() => ({
    top: HIGHLIGHT_PADDING,
    right: HIGHLIGHT_PADDING,
    bottom: HIGHLIGHT_PADDING,
    left: HIGHLIGHT_PADDING,
  }));
  forEachNearbyPair(rawBounds, HIGHLIGHT_PADDING * 2 + 2, (first, second) => {
    const a = rawBounds[first];
    const b = rawBounds[second];
    const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
    const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));

    if (dx > 0 || dy > 0) {
      const cap = Math.max(dx, dy) / 2 - 1;
      if (dx >= dy) {
        // Disjoint on x: the box with the smaller x is the left one, so its
        // right side and the other's left side are the pair that face.
        const [left, right] = a.x < b.x ? [first, second] : [second, first];
        paddings[left].right = Math.min(paddings[left].right, cap);
        paddings[right].left = Math.min(paddings[right].left, cap);
      } else {
        const [top, bottom] = a.y < b.y ? [first, second] : [second, first];
        paddings[top].bottom = Math.min(paddings[top].bottom, cap);
        paddings[bottom].top = Math.min(paddings[bottom].top, cap);
      }
      return;
    }

    // Raw bounds overlap (dx = dy = 0). A container and its descendant should
    // remain nested; cap the inner frame so it stays inside the outer raw box.
    const aInB = contains(b, a);
    const bInA = contains(a, b);
    if (aInB || bInA) {
      const inner = bInA ? paddings[second] : paddings[first];
      const io = bInA ? b : a;
      const oo = bInA ? a : b;
      inner.left = Math.min(inner.left, io.x - oo.x - 1);
      inner.top = Math.min(inner.top, io.y - oo.y - 1);
      inner.right = Math.min(inner.right, oo.x + oo.width - (io.x + io.width) - 1);
      inner.bottom = Math.min(inner.bottom, oo.y + oo.height - (io.y + io.height) - 1);
      return;
    }

    // Adjacent controls often use intentionally overlapping hit areas. Divide
    // the overlap between their centers and pull only the two facing frame
    // edges inward, leaving a stroke-width gap between the rendered boxes.
    const centerAX = a.x + a.width / 2;
    const centerAY = a.y + a.height / 2;
    const centerBX = b.x + b.width / 2;
    const centerBY = b.y + b.height / 2;
    const normalizedX = Math.abs(centerAX - centerBX) / Math.max((a.width + b.width) / 2, 1);
    const normalizedY = Math.abs(centerAY - centerBY) / Math.max((a.height + b.height) / 2, 1);
    const halfClearance = HIGHLIGHT_LINE_WIDTH / 2;

    if (normalizedX >= normalizedY && centerAX !== centerBX) {
      const divider = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
      const [leftIndex, rightIndex] = centerAX < centerBX ? [first, second] : [second, first];
      const leftBounds = rawBounds[leftIndex];
      const rightBounds = rawBounds[rightIndex];
      paddings[leftIndex].right = Math.min(
        paddings[leftIndex].right,
        divider - halfClearance - (leftBounds.x + leftBounds.width),
      );
      paddings[rightIndex].left = Math.min(
        paddings[rightIndex].left,
        rightBounds.x - divider - halfClearance,
      );
    } else if (centerAY !== centerBY) {
      const divider = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
      const [topIndex, bottomIndex] = centerAY < centerBY ? [first, second] : [second, first];
      const topBounds = rawBounds[topIndex];
      const bottomBounds = rawBounds[bottomIndex];
      paddings[topIndex].bottom = Math.min(
        paddings[topIndex].bottom,
        divider - halfClearance - (topBounds.y + topBounds.height),
      );
      paddings[bottomIndex].top = Math.min(
        paddings[bottomIndex].top,
        bottomBounds.y - divider - halfClearance,
      );
    }
  });

  const clamp = (value: number) => Math.min(HIGHLIGHT_PADDING, value);
  return paddings.map((padding) => ({
    top: clamp(padding.top),
    right: clamp(padding.right),
    bottom: clamp(padding.bottom),
    left: clamp(padding.left),
  }));
}

function pointBounds(point: AnnotationPoint, radius: number): Bounds {
  return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
}

function intersectionArea(a: Bounds, b: Bounds): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function coincident(a: Bounds, b: Bounds): boolean {
  const inter = intersectionArea(a, b);
  if (inter === 0) return false;
  const maxArea = Math.max(a.width * a.height, b.width * b.height);
  return maxArea > 0 && inter / maxArea > MERGE_OVERLAP_RATIO;
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

/**
 * Ordered 1-D slot placement: slots keep the given order, sit at least
 * `spacing` apart, stay inside [lo, hi], and land as close to their targets as
 * possible (least squares). Substituting away the cumulative minimum gap turns
 * the constraint into plain monotonicity, solved by pool-adjacent-violators.
 * Order preservation is what keeps a lane's leaders crossing-free; closeness
 * to the targets is what keeps them short and near-parallel.
 */
function placeOrderedSlots(targets: number[], spacing: number, lo: number, hi: number): number[] {
  if (targets.length === 0) return [];
  const shifted = targets.map((value, index) => value - index * spacing);
  const pools: { sum: number; weight: number; mean: number }[] = [];
  for (const value of shifted) {
    let sum = value;
    let weight = 1;
    while (pools.length > 0 && pools[pools.length - 1].mean >= sum / weight) {
      const previous = pools.pop()!;
      sum += previous.sum;
      weight += previous.weight;
    }
    pools.push({ sum, weight, mean: sum / weight });
  }
  const slots: number[] = [];
  for (const pool of pools) {
    for (let member = 0; member < pool.weight; member++) slots.push(pool.mean + slots.length * spacing);
  }

  const min = slots[0];
  const max = slots[slots.length - 1];
  const room = hi - lo;
  if (room <= 0) return slots.map(() => (lo + hi) / 2);
  const span = max - min;
  if (span > room) return slots.map((value) => lo + ((value - min) / span) * room);
  const shift = min < lo ? lo - min : max > hi ? hi - max : 0;
  return slots.map((value) => value + shift);
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
  return fitPointInViewport(point, BADGE_RADIUS, viewportWidth, viewportHeight);
}

class BoundsSpatialIndex {
  private readonly cells = new Map<string, Bounds[]>();
  private readonly oversized = new Set<Bounds>();
  private readonly columns: number;
  private readonly rows: number;

  // A viewport-sized frame can cover millions of 64px cells on a large
  // canvas. Index it once and filter it geometrically at query time instead
  // of trading a small number of distance checks for unbounded memory use.
  private static readonly MAX_CELLS_PER_RECT = 256;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly cellSize = 64,
  ) {
    this.columns = Math.max(1, Math.ceil(Math.max(width, 0) / cellSize));
    this.rows = Math.max(1, Math.ceil(Math.max(height, 0) / cellSize));
  }

  add(rect: Bounds): void {
    const left = Math.max(0, rect.x);
    const top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width);
    const bottom = Math.min(this.height, rect.y + rect.height);
    if (right < left || bottom < top) return;
    const minColumn = this.cell(left, this.columns);
    const maxColumn = this.cell(right, this.columns);
    const minRow = this.cell(top, this.rows);
    const maxRow = this.cell(bottom, this.rows);
    const coveredCells = (maxColumn - minColumn + 1) * (maxRow - minRow + 1);
    if (coveredCells > BoundsSpatialIndex.MAX_CELLS_PER_RECT) {
      this.oversized.add(rect);
      return;
    }
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const key = `${column}:${row}`;
        const entries = this.cells.get(key);
        if (entries) entries.push(rect);
        else this.cells.set(key, [rect]);
      }
    }
  }

  near(point: AnnotationPoint, radius: number): Bounds[] {
    const minColumn = this.cell(point.x - radius, this.columns);
    const maxColumn = this.cell(point.x + radius, this.columns);
    const minRow = this.cell(point.y - radius, this.rows);
    const maxRow = this.cell(point.y + radius, this.rows);
    const matches = new Set<Bounds>();
    for (const rect of this.oversized) {
      if (
        rect.x <= point.x + radius &&
        rect.x + rect.width >= point.x - radius &&
        rect.y <= point.y + radius &&
        rect.y + rect.height >= point.y - radius
      ) {
        matches.add(rect);
      }
    }
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        for (const rect of this.cells.get(`${column}:${row}`) ?? []) matches.add(rect);
      }
    }
    return [...matches];
  }

  private cell(value: number, count: number): number {
    return Math.max(0, Math.min(count - 1, Math.floor(value / this.cellSize)));
  }
}

class PointSpatialIndex {
  private readonly cells = new Map<string, AnnotationPoint[]>();

  constructor(private readonly cellSize = BADGE_RADIUS * 2 + BADGE_CLEARANCE) {}

  add(point: AnnotationPoint): void {
    const key = this.key(point.x, point.y);
    const entries = this.cells.get(key);
    if (entries) entries.push(point);
    else this.cells.set(key, [point]);
  }

  near(point: AnnotationPoint, radius: number): AnnotationPoint[] {
    const minX = Math.floor((point.x - radius) / this.cellSize);
    const maxX = Math.floor((point.x + radius) / this.cellSize);
    const minY = Math.floor((point.y - radius) / this.cellSize);
    const maxY = Math.floor((point.y + radius) / this.cellSize);
    const matches: AnnotationPoint[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) matches.push(...(this.cells.get(`${x}:${y}`) ?? []));
    }
    return matches;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`;
  }
}

function badgeOverlaps(
  point: AnnotationPoint,
  badges: PointSpatialIndex,
  rects: BoundsSpatialIndex,
  ignoredRects?: Set<Bounds>,
): boolean {
  const badgeDistance = BADGE_RADIUS * 2 + BADGE_CLEARANCE;
  if (badges.near(point, badgeDistance).some((badge) => Math.hypot(point.x - badge.x, point.y - badge.y) < badgeDistance)) {
    return true;
  }
  const rectDistance = BADGE_RADIUS + BADGE_CLEARANCE;
  return rects
    .near(point, rectDistance)
    .some((rect) => !ignoredRects?.has(rect) && distanceToBounds(point, rect) < rectDistance);
}

function calloutAxes(
  preferredX: number,
  preferredStartY: number,
  count: number,
  viewportWidth: number,
  viewportHeight: number,
  laneOnRight: boolean,
): { xs: number[]; ys: number[] } {
  const clamped = clampToViewport({ x: preferredX, y: preferredStartY }, viewportWidth, viewportHeight);
  if (viewportWidth <= BADGE_RADIUS * 2 || viewportHeight <= BADGE_RADIUS * 2) {
    return { xs: [clamped.x], ys: [clamped.y] };
  }

  const minX = BADGE_RADIUS;
  const maxX = viewportWidth - BADGE_RADIUS;
  const xs = [clamped.x];
  const preferredDirection = laneOnRight ? 1 : -1;
  for (let distance = CALLOUT_SPACING; distance <= viewportWidth + CALLOUT_SPACING; distance += CALLOUT_SPACING) {
    const x = clamped.x + distance * preferredDirection;
    if (x >= minX && x <= maxX) xs.push(x);
  }
  for (let distance = CALLOUT_SPACING; distance <= viewportWidth + CALLOUT_SPACING; distance += CALLOUT_SPACING) {
    const x = clamped.x - distance * preferredDirection;
    if (x >= minX && x <= maxX) xs.push(x);
  }

  const minY = BADGE_RADIUS;
  const maxY = viewportHeight - BADGE_RADIUS;
  const rowCapacity = Math.floor((maxY - minY) / CALLOUT_SPACING) + 1;
  const startY = count > rowCapacity ? minY : clamped.y;
  const ys: number[] = [];
  for (let y = startY; y <= maxY; y += CALLOUT_SPACING) ys.push(y);
  for (let y = startY - CALLOUT_SPACING; y >= minY; y -= CALLOUT_SPACING) ys.push(y);
  return { xs, ys };
}

function placeGroupCallouts(
  count: number,
  preferredX: number,
  preferredStartY: number,
  laneOnRight: boolean,
  obstacleRects: BoundsSpatialIndex,
  placedBadges: PointSpatialIndex,
  ignoredRects: Set<Bounds>,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint[] {
  const { xs, ys } = calloutAxes(
    preferredX,
    preferredStartY,
    count,
    viewportWidth,
    viewportHeight,
    laneOnRight,
  );
  const candidateCount = xs.length * ys.length;
  const candidateAt = (index: number): AnnotationPoint | undefined => {
    if (index < 0 || index >= candidateCount || ys.length === 0) return undefined;
    return {
      x: xs[Math.floor(index / ys.length)],
      y: ys[index % ys.length],
    };
  };
  const slots: AnnotationPoint[] = [];
  let candidateIndex = 0;

  for (let position = 0; position < count; position++) {
    let candidate = candidateAt(candidateIndex);
    while (candidate && badgeOverlaps(candidate, placedBadges, obstacleRects, ignoredRects)) {
      candidateIndex++;
      candidate = candidateAt(candidateIndex);
    }
    // More annotations than physically fit in the viewport is unsatisfiable.
    // Reuse the deterministic grid only after every collision-free slot has
    // been exhausted, keeping all geometry finite and inside the screenshot.
    const slot = candidate ?? candidateAt(candidateCount > 0 ? position % candidateCount : -1) ?? { x: 0, y: 0 };
    if (candidate) candidateIndex++;
    slots.push(slot);
    placedBadges.add(slot);
  }
  return slots;
}

/**
 * Places a single target's badge on its own frame's perimeter, picking the
 * first corner/edge that clears every already-drawn frame and marker and every
 * globally-placed badge. This keeps the badge attached to the box it labels
 * instead of exiling it to the group lane.
 */
function pickPerimeterBadge(
  frame: Bounds,
  obstacleRects: BoundsSpatialIndex,
  placedBadges: PointSpatialIndex,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint {
  const candidates = perimeterCandidates(frame).filter((point) => fitsInViewport(point, viewportWidth, viewportHeight));
  const ignored = new Set([frame]);
  for (const point of candidates) {
    if (!badgeOverlaps(point, placedBadges, obstacleRects, ignored)) return point;
  }

  // Every perimeter point is crowded (dense cluster) — the familiar top-right
  // default, clamped back onto the canvas, still beats drawing nothing.
  return clampToViewport(perimeterCandidates(frame)[0], viewportWidth, viewportHeight);
}

/**
 * Places each annotation's frame and order badge as a pure function of the
 * targets and viewport — no image sampling, so the live preview and the
 * exported image are byte-for-byte identical in geometry.
 *
 * Targets whose boxes genuinely coincide (see {@link coincident}) collapse into
 * a group: every member becomes a marker dot, and its badge moves to a lane
 * joined by a straight leader. The lane runs along the axis the anchors spread
 * on (a row of targets gets a lane above/below sorted by x, a column or point
 * cluster a side lane sorted by y), slots are assigned in the anchors' order
 * along that axis — the one-sided boundary-labeling invariant that keeps
 * leaders from crossing — and each slot sits as close to its own anchor as the
 * badge spacing allows, so leaders stay short and near-parallel. Every other
 * target keeps its own frame with a perimeter badge. A global badge registry
 * lets every badge — lane or perimeter — steer clear of every badge placed
 * before it, across groups and singles alike.
 */
export function layoutAnnotations(
  annotations: Annotation[],
  viewportWidth: number,
  viewportHeight: number,
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

  const rawBounds = annotations.map((annotation) => annotation.bounds);
  const representativeByBounds = new Map<string, number>();
  const representatives: number[] = [];
  for (let index = 0; index < rawBounds.length; index++) {
    const rect = rawBounds[index];
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    const representative = representativeByBounds.get(key);
    if (representative === undefined) {
      representativeByBounds.set(key, index);
      representatives.push(index);
    } else {
      join(representative, index);
    }
  }
  const representativeBounds = representatives.map((index) => rawBounds[index]);
  forEachNearbyPair(representativeBounds, 0, (a, b) => {
    if (coincident(representativeBounds[a], representativeBounds[b])) join(representatives[a], representatives[b]);
  });

  const grouped = new Map<number, number[]>();
  for (let index = 0; index < count; index++) {
    const root = find(index);
    (grouped.get(root) ?? grouped.set(root, []).get(root)!).push(index);
  }

  // Stable ordering keeps the output deterministic for identical input.
  const singles: number[] = [];
  const groups: number[][] = [];
  for (const indexes of grouped.values()) {
    if (indexes.length === 1) singles.push(indexes[0]);
    else groups.push(indexes.slice().sort((a, b) => a - b));
  }
  singles.sort((a, b) => a - b);
  groups.sort((a, b) => a[0] - b[0]);

  const anchorOf = (index: number): AnnotationPoint => {
    const { x, y, width, height } = annotations[index].bounds;
    return fitPointInViewport(
      { x: x + width / 2, y: y + height / 2 },
      MARKER_RADIUS,
      viewportWidth,
      viewportHeight,
    );
  };

  // Geometry that will actually be drawn, known before any badge is placed so
  // every badge can be tested against all of it. Padding is adaptive per side
  // (see adaptiveSidePaddings) so two frames for near-but-non-overlapping
  // targets never visually collide; the obstacle index and perimeter-badge
  // picker below both build on these final frames.
  const singleRawBounds = singles.map((index) => annotations[index].bounds);
  const singlePaddings = adaptiveSidePaddings(singleRawBounds);
  const singleFrames = singleRawBounds.map((bounds, position) =>
    fitBoundsInViewport(
      inflateBoundsPerSide(bounds, singlePaddings[position]),
      viewportWidth,
      viewportHeight,
    ),
  );
  const groupMembers = groups.flat();
  const markerRectOf = (index: number): Bounds => pointBounds(anchorOf(index), MARKER_RADIUS);
  const markerRects = new Map(groupMembers.map((index) => [index, markerRectOf(index)]));
  // A group's markers substantially overlap by definition. One union obstacle
  // prevents thousands of coincident marker rectangles from turning every
  // nearby badge query into a linear scan.
  const groupMarkerObstacles = groups.map((group) => unionBounds(group.map((index) => markerRects.get(index)!)));

  const badgeIndex = new PointSpatialIndex();
  const obstacleIndex = new BoundsSpatialIndex(viewportWidth, viewportHeight);
  for (const frame of singleFrames) obstacleIndex.add(frame);
  for (const marker of groupMarkerObstacles) obstacleIndex.add(marker);
  const layouts: AnnotationLayout[] = [];

  /**
   * Lane members sorted by their anchor coordinate along the lane axis — the
   * one-sided boundary-labeling invariant that makes straight leaders to
   * sorted slots crossing-free. Runs of anchors closer than ANCHOR_TIE_EPSILON
   * read as one cluster, so within a run the step numbers win: the lane then
   * shows 1,2,3… instead of an order dictated by sub-pixel anchor jitter.
   */
  const sortAlongLane = (group: number[], coordinate: (index: number) => number): number[] => {
    const byCoordinate = group
      .slice()
      .sort((a, b) => coordinate(a) - coordinate(b) || annotations[a].order - annotations[b].order);
    const ordered: number[] = [];
    let run: number[] = [];
    const flushRun = () => {
      run.sort((a, b) => annotations[a].order - annotations[b].order);
      ordered.push(...run);
      run = [];
    };
    for (const index of byCoordinate) {
      if (run.length > 0 && coordinate(index) - coordinate(run[run.length - 1]) > ANCHOR_TIE_EPSILON) flushRun();
      run.push(index);
    }
    flushRun();
    return ordered;
  };

  // Groups first, so a single's perimeter badge can dodge the lane badges.
  groups.forEach((group, groupPosition) => {
    const ownMarkers = new Set([groupMarkerObstacles[groupPosition]]);
    const groupBounds = unionBounds(group.map((index) => annotations[index].bounds));
    const anchorXs = group.map((index) => anchorOf(index).x);
    const anchorYs = group.map((index) => anchorOf(index).y);
    const spreadX = Math.max(...anchorXs) - Math.min(...anchorXs);
    const spreadY = Math.max(...anchorYs) - Math.min(...anchorYs);

    // The lane runs along the axis the anchors spread on: a row of targets
    // gets its badges above/below sorted by x, a column (or a point cluster)
    // gets a side lane sorted by y. A lane on the wrong axis degenerates into
    // a lattice of near-parallel leaders.
    const laneIsVertical = spreadY >= spreadX;
    const laneExtent = laneIsVertical ? viewportHeight : viewportWidth;
    const laneCapacity =
      laneExtent > BADGE_RADIUS * 2 ? Math.floor((laneExtent - BADGE_RADIUS * 2) / CALLOUT_SPACING) + 1 : 0;

    let slots: AnnotationPoint[];
    let ordered: number[];
    if (group.length <= laneCapacity) {
      ordered = sortAlongLane(group, (index) => (laneIsVertical ? anchorOf(index).y : anchorOf(index).x));
      const alongLane = ordered.map((index) => (laneIsVertical ? anchorOf(index).y : anchorOf(index).x));
      const slotCoordinates = placeOrderedSlots(alongLane, CALLOUT_SPACING, BADGE_RADIUS, laneExtent - BADGE_RADIUS);

      // The lane's cross-axis position: just outside the cluster on whichever
      // side has more room. If badges or frames placed earlier already occupy
      // it, the whole lane nudges further out — as a block, so the sorted slot
      // order (and with it crossing-freeness) survives.
      const crossExtent = laneIsVertical ? viewportWidth : viewportHeight;
      const clusterStart = laneIsVertical ? groupBounds.x : groupBounds.y;
      const clusterEnd = laneIsVertical
        ? groupBounds.x + groupBounds.width
        : groupBounds.y + groupBounds.height;
      const laneOutward = crossExtent - clusterEnd >= clusterStart;
      const laneBase = laneOutward
        ? Math.min(crossExtent - BADGE_RADIUS, clusterEnd + CALLOUT_GAP + BADGE_RADIUS)
        : Math.max(BADGE_RADIUS, clusterStart - CALLOUT_GAP - BADGE_RADIUS);
      const toPoints = (cross: number) =>
        slotCoordinates.map((coordinate) =>
          laneIsVertical ? { x: cross, y: coordinate } : { x: coordinate, y: cross },
        );
      const collisions = (points: AnnotationPoint[]) =>
        points.reduce(
          (sum, point) => sum + (badgeOverlaps(point, badgeIndex, obstacleIndex, ownMarkers) ? 1 : 0),
          0,
        );
      slots = toPoints(laneBase);
      let bestCollisions = collisions(slots);
      for (let attempt = 1; attempt <= LANE_NUDGE_ATTEMPTS && bestCollisions > 0; attempt++) {
        const nudged = laneBase + attempt * CALLOUT_SPACING * (laneOutward ? 1 : -1);
        if (nudged < BADGE_RADIUS || nudged > crossExtent - BADGE_RADIUS) break;
        const candidate = toPoints(nudged);
        const candidateCollisions = collisions(candidate);
        if (candidateCollisions < bestCollisions) {
          slots = candidate;
          bestCollisions = candidateCollisions;
        }
        if (candidateCollisions === 0) break;
      }
      for (const slot of slots) badgeIndex.add(slot);
    } else {
      // More badges than one lane can hold: fall back to the deterministic
      // multi-column side grid. Order along each column still follows the
      // anchor sort, which keeps the common case of a huge duplicate stack
      // readable even though cross-column leaders may touch.
      ordered = sortAlongLane(group, (index) => anchorOf(index).y);
      const leftSpace = groupBounds.x;
      const rightSpace = viewportWidth - (groupBounds.x + groupBounds.width);
      const laneOnRight = rightSpace >= leftSpace;
      const laneX = laneOnRight
        ? Math.min(viewportWidth - BADGE_RADIUS, groupBounds.x + groupBounds.width + CALLOUT_GAP + BADGE_RADIUS)
        : Math.max(BADGE_RADIUS, groupBounds.x - CALLOUT_GAP - BADGE_RADIUS);
      const startY = Math.max(
        BADGE_RADIUS,
        Math.min(groupBounds.y + BADGE_RADIUS, viewportHeight - BADGE_RADIUS - CALLOUT_SPACING * (ordered.length - 1)),
      );
      slots = placeGroupCallouts(
        ordered.length,
        laneX,
        startY,
        laneOnRight,
        obstacleIndex,
        badgeIndex,
        ownMarkers,
        viewportWidth,
        viewportHeight,
      );
    }

    ordered.forEach((index, position) => {
      const anchor = anchorOf(index);
      const badge = slots[position];
      const dx = badge.x - anchor.x;
      const dy = badge.y - anchor.y;
      const length = Math.hypot(dx, dy) || 1;
      const start = { x: anchor.x + (dx / length) * MARKER_RADIUS, y: anchor.y + (dy / length) * MARKER_RADIUS };
      const end = { x: badge.x - (dx / length) * BADGE_RADIUS, y: badge.y - (dy / length) * BADGE_RADIUS };
      layouts.push({
        order: annotations[index].order,
        frame: fitHighlightFrame(annotations[index].bounds, viewportWidth, viewportHeight),
        anchor,
        markerOnly: true,
        badgeAnchor: badge,
        callout: badge,
        leader: length > MARKER_RADIUS + BADGE_RADIUS ? [start, end] : [],
      });
    });
  });

  singles.forEach((index, position) => {
    const frame = singleFrames[position];
    const badgeAnchor = pickPerimeterBadge(frame, obstacleIndex, badgeIndex, viewportWidth, viewportHeight);
    badgeIndex.add(badgeAnchor);
    layouts.push({
      order: annotations[index].order,
      frame,
      anchor: anchorOf(index),
      markerOnly: false,
      badgeAnchor,
      callout: null,
      leader: [],
    });
  });

  return layouts.sort((a, b) => a.order - b.order);
}

/**
 * Draws the frame as an *inside* stroke, matching the CSS overlay's
 * `box-border` border: the whole line width sits inside `bounds`, and
 * HIGHLIGHT_RADIUS is the outer corner radius. A plain centered `ctx.stroke()`
 * would straddle the path — making the frame a half-line-width larger and the
 * corner read tighter than the preview. So inset the path by lineWidth/2 and
 * use the outer radius minus lineWidth/2 for the centerline radius.
 */
function strokeBox(ctx: OffscreenCanvasRenderingContext2D, bounds: Bounds, dpr: number) {
  const lineWidth = HIGHLIGHT_LINE_WIDTH * dpr;
  const outerX = bounds.x * dpr;
  const outerY = bounds.y * dpr;
  const outerWidth = bounds.width * dpr;
  const outerHeight = bounds.height * dpr;
  // CSS clamps border-radius to half the box; do the same before insetting.
  const outerRadius = Math.max(Math.min(HIGHLIGHT_RADIUS * dpr, outerWidth / 2, outerHeight / 2), 0);
  const x = bounds.x * dpr + lineWidth / 2;
  const y = bounds.y * dpr + lineWidth / 2;
  const w = outerWidth - lineWidth;
  const h = outerHeight - lineWidth;
  const radius = Math.max(outerRadius - lineWidth / 2, 0);

  ctx.fillStyle = HIGHLIGHT_FILL_COLOR;
  ctx.beginPath();
  ctx.roundRect(outerX, outerY, outerWidth, outerHeight, outerRadius);
  ctx.fill();

  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.stroke();
}

function strokeTarget(ctx: OffscreenCanvasRenderingContext2D, anchor: AnnotationPoint, dpr: number) {
  const x = anchor.x * dpr;
  const y = anchor.y * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, MARKER_RADIUS * dpr, 0, Math.PI * 2);
  ctx.fill();
  // The preview's ring is a box-border CSS border: it sits entirely inside the
  // MARKER_RADIUS outer edge. Stroke the ring's centerline accordingly.
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = MARKER_RING_WIDTH * dpr;
  ctx.beginPath();
  ctx.arc(x, y, (MARKER_RADIUS - MARKER_RING_WIDTH / 2) * dpr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, MARKER_INNER_RADIUS * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function drawBadge(ctx: OffscreenCanvasRenderingContext2D, point: AnnotationPoint, order: number, dpr: number) {
  const r = BADGE_RADIUS * dpr;
  const cx = point.x * dpr;
  const cy = point.y * dpr;

  // Subtle elevation matching the preview badge's Tailwind `shadow`
  // (0 1px 3px rgb(0 0 0 / 0.1)). Reset before the digit so it stays crisp.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
  ctx.shadowBlur = 3 * dpr;
  ctx.shadowOffsetY = 1 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `600 ${getBadgeFontSize(order) * dpr}px ${BADGE_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  // Center the digit glyphs by their actual bounding box rather than the font's
  // full line box, so they sit optically centered like the preview's flexbox.
  ctx.textBaseline = 'alphabetic';
  const text = String(order);
  const metrics = ctx.measureText(text);
  const textY = cy + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  ctx.fillText(text, cx, textY);
}

function drawLeader(ctx: OffscreenCanvasRenderingContext2D, points: AnnotationPoint[], dpr: number) {
  if (points.length < 2) return;
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = LEADER_LINE_WIDTH * dpr;
  // Match the SVG polyline defaults the preview uses (butt caps, miter joins).
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(points[0].x * dpr, points[0].y * dpr);
  for (const point of points.slice(1)) ctx.lineTo(point.x * dpr, point.y * dpr);
  ctx.stroke();
}

/** Returns a redaction's expanded CSS-pixel rect clipped to the screenshot.
 * `null` means the mask lies wholly outside the drawable bitmap. */
export function getExpandedRedactionBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
): Bounds | null {
  if (!isValidImageBounds(bounds) || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }
  const left = Math.max(0, bounds.x - REDACTION_EXPANSION);
  const top = Math.max(0, bounds.y - REDACTION_EXPANSION);
  const right = Math.min(viewportWidth, bounds.x + bounds.width + REDACTION_EXPANSION);
  const bottom = Math.min(viewportHeight, bounds.y + bounds.height + REDACTION_EXPANSION);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function drawRedactions(
  ctx: OffscreenCanvasRenderingContext2D,
  redactions: readonly Redaction[],
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): void {
  ctx.fillStyle = REDACTION_COLOR;
  for (const redaction of redactions) {
    const bounds = getExpandedRedactionBounds(redaction.bounds, viewportWidth, viewportHeight);
    if (bounds) ctx.fillRect(bounds.x * dpr, bounds.y * dpr, bounds.width * dpr, bounds.height * dpr);
  }
}

type RasterFormat = 'image/jpeg' | 'image/png';

/** Draws source pixels, annotations, then privacy masks in that strict order.
 * Keeping this low-level pipeline shared prevents clipboard and ZIP rendering
 * from drifting in their final redaction treatment. */
async function compositeRaster(
  screenshot: Blob,
  screenshotScale: number,
  redactions: readonly Redaction[],
  privacyBlockRequired: boolean,
  format: RasterFormat,
  drawAnnotations: (
    ctx: OffscreenCanvasRenderingContext2D,
    dpr: number,
    viewportWidth: number,
    viewportHeight: number,
  ) => void,
): Promise<Blob> {
  await validateRasterImageBlob(screenshot);
  const bitmap = await createImageBitmap(screenshot);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create a 2D canvas context.');
    ctx.drawImage(bitmap, 0, 0);

    const dpr = getValidScreenshotScale(screenshotScale);
    const viewportWidth = bitmap.width / dpr;
    const viewportHeight = bitmap.height / dpr;
    drawAnnotations(ctx, dpr, viewportWidth, viewportHeight);
    // Must remain last: a redaction is privacy-critical and intentionally
    // covers highlight strokes, callouts, markers, and badges beneath it.
    drawRedactions(ctx, redactions, viewportWidth, viewportHeight, dpr);
    if (privacyBlockRequired) {
      ctx.fillStyle = REDACTION_COLOR;
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    }

    return canvas.convertToBlob(format === 'image/jpeg' ? { type: format, quality: 0.95 } : { type: format });
  } finally {
    bitmap.close();
  }
}

/**
 * Composites the red highlight box onto a raw screenshot and returns a new
 * image blob. If bounds is null (legacy step), the screenshot is retained and
 * any privacy redactions are still rendered.
 */
export async function compositeHighlight(
  screenshot: Blob,
  bounds: Bounds | null,
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
): Promise<Blob> {
  return compositeRaster(screenshot, screenshotScale, redactions, privacyBlockRequired, format, (ctx, dpr, viewportWidth, viewportHeight) => {
    if (bounds) strokeBox(ctx, fitHighlightFrame(bounds, viewportWidth, viewportHeight), dpr);
  });
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
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
): Promise<Blob> {
  return compositeRaster(screenshot, screenshotScale, redactions, privacyBlockRequired, format, (ctx, dpr, viewportWidth, viewportHeight) => {
    const layouts = layoutAnnotations(annotations, viewportWidth, viewportHeight);
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
  });
}

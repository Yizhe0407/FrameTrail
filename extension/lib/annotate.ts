import type { Bounds } from './db';

// Highlight geometry in CSS px, scaled by the screenshot pixel ratio.
export const HIGHLIGHT_PADDING = 6;
// Floor for the adaptive per-single padding below. Below this, a shrunk
// frame reads as "no highlight" rather than a tight one.
const MIN_PADDING = 1;
export const HIGHLIGHT_RADIUS = 8;
export const HIGHLIGHT_LINE_WIDTH = 3;
export const HIGHLIGHT_COLOR = '#ef4444';

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
// covers most of the smaller one. A boolean "do the boxes touch" test chained
// adjacent list rows — each sharing a hairline border with the next — into one
// runaway cluster; requiring near-containment instead keeps merely-adjacent
// rows as separate framed singles and merges only genuinely stacked or
// duplicate targets. 0.4 sits below the ratio a row overlapping its neighbor
// by a few px produces, yet well under the ~1.0 of truly coincident boxes.
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
   * renders here with a leader line — regardless of `numbered` — because the
   * marker alone cannot carry the order number. */
  callout: AnnotationPoint | null;
  /** Orthogonal (or, as a last resort, diagonal) leader path from the marker
   * to its callout badge. */
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

/**
 * Two clicked elements can sit just a few px apart even though the targets
 * themselves don't overlap; inflating both by the flat HIGHLIGHT_PADDING then
 * makes their frames visually collide. Each single instead gets only as much
 * padding as fits before its frame would cross its nearest neighbor's.
 *
 * For raw bounds a, b the axis separations are
 * `dx = max(0, a.x-(b.x+b.width), b.x-(a.x+a.width))` (dy likewise). Inflating
 * both by padding p keeps them apart iff `2p < max(dx, dy)` — they only
 * collide once *both* axes overlap. The `-1` keeps a visible gap once the
 * stroke width is drawn on top. Compared only against other singles' raw
 * bounds: group members render as marker dots, never frames, so they can't
 * collide with anything and would only make this over-conservative.
 */
function adaptivePadding(rawBounds: Bounds[], index: number): number {
  const a = rawBounds[index];
  let tightest = HIGHLIGHT_PADDING;
  for (let other = 0; other < rawBounds.length; other++) {
    if (other === index) continue;
    const b = rawBounds[other];
    const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
    const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
    tightest = Math.min(tightest, Math.max(dx, dy) / 2 - 1);
  }
  // Genuinely overlapping raw bounds (below the coincident-group threshold)
  // produce max(dx,dy) === 0: clamp to MIN_PADDING and accept the small
  // residual frame overlap rather than collapsing the highlight entirely.
  return Math.min(HIGHLIGHT_PADDING, Math.max(MIN_PADDING, tightest));
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
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 && inter / minArea > MERGE_OVERLAP_RATIO;
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
 * Liang–Barsky segment/rectangle clip, reduced to a boolean intersection test.
 * Works for any orientation — an honest answer for diagonal leaders, where the
 * old axis-only test silently reported "no crossing" and let diagonals cut
 * straight through frames.
 */
function segmentIntersectsBounds(start: AnnotationPoint, end: AnnotationPoint, bounds: Bounds): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [start.x - bounds.x, bounds.x + bounds.width - start.x, start.y - bounds.y, bounds.y + bounds.height - start.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel to this edge and wholly outside it
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

// Proper segment/segment crossing: true only when the two segments straddle
// each other's interior, so leaders that merely share their origin cluster or
// touch end-to-end are not counted.
function segmentsCross(a1: AnnotationPoint, a2: AnnotationPoint, b1: AnnotationPoint, b2: AnnotationPoint): boolean {
  const orient = (p: AnnotationPoint, q: AnnotationPoint, r: AnnotationPoint) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

function routeCrossings(points: AnnotationPoint[], obstacles: Bounds[], siblings: AnnotationPoint[][]): number {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    for (const obstacle of obstacles) {
      if (segmentIntersectsBounds(points[i - 1], points[i], obstacle)) count++;
    }
    for (const sibling of siblings) {
      for (let j = 1; j < sibling.length; j++) {
        if (segmentsCross(points[i - 1], points[i], sibling[j - 1], sibling[j])) count++;
      }
    }
  }
  return count;
}

/**
 * Routes a leader from a marker's edge to a badge's edge. Prefers an orthogonal
 * elbow (reads as a deliberate connector), picking horizontal-first over
 * vertical-first on a tie, and only falls back to a straight diagonal when both
 * elbows would cut through strictly more obstacles or previously-drawn sibling
 * leaders. Passing the group's already-placed leaders as `siblings` lets each
 * leader steer clear of them — the sorted-slot invariant fixes vertical order,
 * this keeps the connecting lines from crossing when badges straddle the
 * anchor cluster.
 */
function buildLeader(
  start: AnnotationPoint,
  end: AnnotationPoint,
  obstacles: Bounds[],
  siblings: AnnotationPoint[][],
): AnnotationPoint[] {
  const routes =
    Math.abs(start.x - end.x) < 1 || Math.abs(start.y - end.y) < 1
      ? [[start, end]]
      : [
          [start, { x: end.x, y: start.y }, end],
          [start, { x: start.x, y: end.y }, end],
          [start, end],
        ];
  let best = routes[0];
  let bestCrossings = routeCrossings(routes[0], obstacles, siblings);
  for (const route of routes.slice(1)) {
    const crossings = routeCrossings(route, obstacles, siblings);
    if (crossings < bestCrossings) {
      best = route;
      bestCrossings = crossings;
    }
  }
  return best;
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

function badgeOverlaps(point: AnnotationPoint, badges: AnnotationPoint[], rects: Bounds[]): boolean {
  if (badges.some((badge) => Math.hypot(point.x - badge.x, point.y - badge.y) < BADGE_RADIUS * 2 + BADGE_CLEARANCE)) return true;
  return rects.some((rect) => distanceToBounds(point, rect) < BADGE_RADIUS + BADGE_CLEARANCE);
}

/**
 * Places a single target's badge on its own frame's perimeter, picking the
 * first corner/edge that clears every already-drawn frame and marker and every
 * globally-placed badge. This keeps the badge attached to the box it labels
 * instead of exiling it to the group lane.
 */
function pickPerimeterBadge(
  frame: Bounds,
  obstacleRects: Bounds[],
  placedBadges: AnnotationPoint[],
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint {
  const candidates = perimeterCandidates(frame).filter((point) => fitsInViewport(point, viewportWidth, viewportHeight));
  for (const point of candidates) {
    if (!badgeOverlaps(point, placedBadges, obstacleRects)) return point;
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
 * a group: every member becomes a marker dot, and its badge moves to a side
 * lane joined by a leader. Members are sorted by anchor.y and assigned lane
 * slots top-to-bottom in that same order — the one-sided boundary-labeling
 * invariant that keeps orthogonal leaders from crossing. Every other target
 * keeps its own frame with a perimeter badge. A global badge registry lets
 * every badge — lane or perimeter — steer clear of every badge placed before
 * it, across groups and singles alike.
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

  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      if (coincident(annotations[a].bounds, annotations[b].bounds)) join(a, b);
    }
  }

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
    return { x: x + width / 2, y: y + height / 2 };
  };

  // Geometry that will actually be drawn, known before any badge is placed so
  // every badge can be tested against all of it. Padding is adaptive (see
  // adaptivePadding) so two frames for near-but-non-overlapping targets never
  // visually collide.
  const singleRawBounds = singles.map((index) => annotations[index].bounds);
  const singleFrames = singleRawBounds.map((bounds, position) =>
    inflateBounds(bounds, adaptivePadding(singleRawBounds, position)),
  );
  const groupMembers = groups.flat();
  const markerRectOf = (index: number): Bounds => pointBounds(anchorOf(index), MARKER_RADIUS);

  const placedBadges: AnnotationPoint[] = [];
  const layouts: AnnotationLayout[] = [];

  // Groups first, so a single's perimeter badge can dodge the lane badges.
  for (const group of groups) {
    const groupSet = new Set(group);
    const foreignMarkers = groupMembers.filter((index) => !groupSet.has(index)).map(markerRectOf);
    const groupBounds = unionBounds(group.map((index) => annotations[index].bounds));

    const leftSpace = groupBounds.x;
    const rightSpace = viewportWidth - (groupBounds.x + groupBounds.width);
    const laneOnRight = rightSpace >= leftSpace;
    const laneX = laneOnRight
      ? Math.min(viewportWidth - BADGE_RADIUS, groupBounds.x + groupBounds.width + CALLOUT_GAP + BADGE_RADIUS)
      : Math.max(BADGE_RADIUS, groupBounds.x - CALLOUT_GAP - BADGE_RADIUS);

    const ordered = group.slice().sort((a, b) => anchorOf(a).y - anchorOf(b).y);
    const startY = Math.max(
      BADGE_RADIUS,
      Math.min(groupBounds.y + BADGE_RADIUS, viewportHeight - BADGE_RADIUS - CALLOUT_SPACING * (ordered.length - 1)),
    );

    // Lane badges placed strictly top-to-bottom with monotonically increasing
    // y — the property that, combined with the anchor.y sort above, forbids
    // any two of this group's leaders from crossing. Badges placed by earlier
    // groups count as obstacles to nudge past; this group's own not-yet-placed
    // badges never do, keeping the monotonic slot order intact.
    const foreignBadges = placedBadges.slice();
    const slots: AnnotationPoint[] = [];
    let cursorY = startY;
    ordered.forEach((_, position) => {
      let y = Math.max(cursorY, startY + position * CALLOUT_SPACING);
      while (
        y < viewportHeight - BADGE_RADIUS &&
        badgeOverlaps({ x: laneX, y }, foreignBadges, [...singleFrames, ...foreignMarkers])
      ) {
        y += BADGE_RADIUS;
      }
      y = Math.min(y, viewportHeight - BADGE_RADIUS);
      const slot = { x: laneX, y };
      slots.push(slot);
      placedBadges.push(slot);
      cursorY = y + CALLOUT_SPACING;
    });

    // Own-group markers are excluded from the obstacle set: they share one
    // cluster every leader must leave from, so counting them would penalise all
    // routes equally. Sibling leaders are fed in incrementally so each new one
    // routes around those already drawn.
    const siblingLeaders: AnnotationPoint[][] = [];
    ordered.forEach((index, position) => {
      const anchor = anchorOf(index);
      const badge = slots[position];
      const dx = badge.x - anchor.x;
      const dy = badge.y - anchor.y;
      const length = Math.hypot(dx, dy) || 1;
      const start = { x: anchor.x + (dx / length) * MARKER_RADIUS, y: anchor.y + (dy / length) * MARKER_RADIUS };
      const end = { x: badge.x - (dx / length) * BADGE_RADIUS, y: badge.y - (dy / length) * BADGE_RADIUS };
      const siblingBadges = slots.filter((_, other) => other !== position).map((point) => pointBounds(point, BADGE_RADIUS));
      const obstacles = [
        ...singleFrames,
        ...foreignMarkers,
        ...foreignBadges.map((point) => pointBounds(point, BADGE_RADIUS)),
        ...siblingBadges,
      ];
      const leader = buildLeader(start, end, obstacles, siblingLeaders);
      siblingLeaders.push(leader);
      layouts.push({
        order: annotations[index].order,
        frame: inflateBounds(annotations[index].bounds, HIGHLIGHT_PADDING),
        anchor,
        markerOnly: true,
        badgeAnchor: badge,
        callout: badge,
        leader,
      });
    });
  }

  const groupMarkerRects = groupMembers.map(markerRectOf);
  singles.forEach((index, position) => {
    const frame = singleFrames[position];
    const obstacleRects = [...singleFrames.filter((_, other) => other !== position), ...groupMarkerRects];
    const badgeAnchor = pickPerimeterBadge(frame, obstacleRects, placedBadges, viewportWidth, viewportHeight);
    placedBadges.push(badgeAnchor);
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
  const outerWidth = bounds.width * dpr;
  const outerHeight = bounds.height * dpr;
  // CSS clamps border-radius to half the box; do the same before insetting.
  const outerRadius = Math.max(Math.min(HIGHLIGHT_RADIUS * dpr, outerWidth / 2, outerHeight / 2), 0);
  const x = bounds.x * dpr + lineWidth / 2;
  const y = bounds.y * dpr + lineWidth / 2;
  const w = outerWidth - lineWidth;
  const h = outerHeight - lineWidth;
  const radius = Math.max(outerRadius - lineWidth / 2, 0);

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
  ctx.font = `600 ${BADGE_RADIUS * 2 * BADGE_FONT_RATIO * dpr}px ${BADGE_FONT_FAMILY}`;
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
  const layouts = layoutAnnotations(annotations, bitmap.width / dpr, bitmap.height / dpr);
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

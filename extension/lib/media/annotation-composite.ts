import { validateRasterImageBlob } from '../capture/raster-image-validation';
import type { Bounds, Redaction } from '../storage/models';
import { getValidScreenshotScale, isValidImageBounds } from './image-utils';
import {
  BADGE_FONT_FAMILY,
  BADGE_TEXT_COLOR,
  BADGE_RADIUS,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  REDACTION_COLOR,
  REDACTION_EXPANSION,
  fitHighlightFrame,
  getBadgeFontSize,
  layoutAnnotations,
  type Annotation,
  type AnnotationPoint,
} from './annotation-layout';

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

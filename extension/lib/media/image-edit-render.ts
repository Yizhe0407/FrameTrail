import {
  type ArrowEdit,
  type EditPoint,
  type ImageEdit,
  type ImageEditColor,
  type RectEdit,
  type TextEdit,
} from '../storage/image-edit-model';
import { BADGE_FONT_FAMILY } from './annotation-contract';

/**
 * One definition of how image edits look, shared by the live preview (SVG) and
 * the exported raster (canvas). Everything that decides *where* something goes
 * (text wrapping, arrow head, baselines) is computed here, in screenshot CSS
 * pixels, so the two renderers can only differ in the final draw calls.
 */

export const IMAGE_EDIT_COLOR_HEX: Record<ImageEditColor, string> = {
  red: '#ff4747',
  yellow: '#ffc800',
  green: '#22a559',
  blue: '#2f6fed',
  black: '#111111',
  white: '#ffffff',
};

export const IMAGE_EDIT_FONT_FAMILY = BADGE_FONT_FAMILY;
export const IMAGE_EDIT_FONT_WEIGHT = 600;
const LINE_HEIGHT_RATIO = 1.3;

export type TextMeasure = (text: string, fontSize: number) => number;

let measureContext: { font: string; measureText(text: string): { width: number } } | null | undefined;

function ensureMeasureContext() {
  if (measureContext !== undefined) return measureContext;
  measureContext = null;
  try {
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    measureContext = (canvas?.getContext('2d') as typeof measureContext) ?? null;
  } catch {
    measureContext = null;
  }
  return measureContext;
}

/** Measures with the real canvas font engine. Where no canvas exists (some test
 * environments) it falls back to a width estimate, so layout still terminates. */
export const measureTextWidth: TextMeasure = (text, fontSize) => {
  const context = ensureMeasureContext();
  if (!context) return text.length * fontSize * 0.6;
  context.font = `${IMAGE_EDIT_FONT_WEIGHT} ${fontSize}px ${IMAGE_EDIT_FONT_FAMILY}`;
  return context.measureText(text).width;
};

export function textLineHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT_RATIO;
}

/** Distance from the top of a line box to its text baseline. */
export function textBaselineOffset(fontSize: number): number {
  return (textLineHeight(fontSize) - fontSize) / 2 + fontSize * 0.8;
}

/** Wraps `text` into lines no wider than `maxWidth`: at spaces where there are
 * any, otherwise between characters (CJK text has no spaces). Explicit line
 * breaks are kept. A single character wider than the box still gets its own line. */
export function layoutTextLines(text: string, fontSize: number, maxWidth: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let breakAt = -1;
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line !== '' && measure(candidate.trimEnd(), fontSize) > maxWidth) {
        if (breakAt > 0) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt) + character;
        } else {
          lines.push(line);
          line = character;
        }
        breakAt = line.lastIndexOf(' ') + 1 || -1;
      } else {
        line = candidate;
        if (character === ' ') breakAt = line.length;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The height a text edit's box needs for its content. */
export function measureTextEditHeight(edit: Pick<TextEdit, 'text' | 'fontSize'> & { width: number }, measure: TextMeasure = measureTextWidth): number {
  return layoutTextLines(edit.text, edit.fontSize, edit.width, measure).length * textLineHeight(edit.fontSize);
}

export interface ArrowShape {
  /** Where the shaft stops, tucked under the head so there is no gap. */
  shaftEnd: EditPoint;
  /** Triangle tip, then the two base corners. */
  head: [EditPoint, EditPoint, EditPoint];
}

/** Arrow head proportions grow with the stroke so thick arrows keep a visible head. */
export function arrowShape(edit: Pick<ArrowEdit, 'from' | 'to' | 'width'>): ArrowShape | null {
  const dx = edit.to.x - edit.from.x;
  const dy = edit.to.y - edit.from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.min(length, 8 + edit.width * 3);
  const halfWidth = headLength * 0.45;
  const baseX = edit.to.x - ux * headLength;
  const baseY = edit.to.y - uy * headLength;
  return {
    shaftEnd: { x: baseX + ux * headLength * 0.4, y: baseY + uy * headLength * 0.4 },
    head: [
      { x: edit.to.x, y: edit.to.y },
      { x: baseX - uy * halfWidth, y: baseY + ux * halfWidth },
      { x: baseX + uy * halfWidth, y: baseY - ux * halfWidth },
    ],
  };
}

/** Everything needed to paint one text edit, independent of how it is painted. */
export interface TextPlacement {
  lines: { text: string; baselineY: number }[];
  x: number;
}

export function placeText(edit: TextEdit, measure: TextMeasure = measureTextWidth): TextPlacement {
  const lineHeight = textLineHeight(edit.fontSize);
  const offset = textBaselineOffset(edit.fontSize);
  return {
    x: edit.bounds.x,
    lines: layoutTextLines(edit.text, edit.fontSize, edit.bounds.width, measure).map((text, index) => ({
      text,
      baselineY: edit.bounds.y + index * lineHeight + offset,
    })),
  };
}

type Canvas2D = OffscreenCanvasRenderingContext2D;

function drawRect(ctx: Canvas2D, edit: RectEdit, dpr: number) {
  ctx.strokeStyle = IMAGE_EDIT_COLOR_HEX[edit.color];
  ctx.lineWidth = edit.width * dpr;
  ctx.lineJoin = 'round';
  ctx.strokeRect(edit.bounds.x * dpr, edit.bounds.y * dpr, edit.bounds.width * dpr, edit.bounds.height * dpr);
}

function drawArrow(ctx: Canvas2D, edit: ArrowEdit, dpr: number) {
  const shape = arrowShape(edit);
  if (!shape) return;
  const color = IMAGE_EDIT_COLOR_HEX[edit.color];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = edit.width * dpr;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(edit.from.x * dpr, edit.from.y * dpr);
  ctx.lineTo(shape.shaftEnd.x * dpr, shape.shaftEnd.y * dpr);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(shape.head[0].x * dpr, shape.head[0].y * dpr);
  ctx.lineTo(shape.head[1].x * dpr, shape.head[1].y * dpr);
  ctx.lineTo(shape.head[2].x * dpr, shape.head[2].y * dpr);
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx: Canvas2D, edit: TextEdit, dpr: number, measure: TextMeasure) {
  ctx.fillStyle = IMAGE_EDIT_COLOR_HEX[edit.color];
  ctx.font = `${IMAGE_EDIT_FONT_WEIGHT} ${edit.fontSize * dpr}px ${IMAGE_EDIT_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const placement = placeText(edit, measure);
  for (const line of placement.lines) ctx.fillText(line.text, placement.x * dpr, line.baselineY * dpr);
}

/** Paints the edits in order (later ones on top) onto an already-drawn screenshot. */
export function drawImageEdits(
  ctx: Canvas2D,
  edits: readonly ImageEdit[],
  dpr: number,
  measure: TextMeasure = measureTextWidth,
): void {
  for (const edit of edits) {
    ctx.save();
    if (edit.kind === 'rect') drawRect(ctx, edit, dpr);
    else if (edit.kind === 'arrow') drawArrow(ctx, edit, dpr);
    else drawText(ctx, edit, dpr, measure);
    ctx.restore();
  }
}

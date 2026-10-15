import { PERSISTED_STEP_LIMITS } from './persistence-limits';

/**
 * Things a person draws onto a screenshot in the image editor: text, arrows
 * and outlined rectangles. They live on the step that owns the image (the
 * step itself, or a snapshot's shared anchor) in screenshot CSS pixels, the
 * same space as highlight bounds and privacy masks.
 *
 * Privacy masks are deliberately NOT part of this list. They have their own
 * field, their own fail-closed review state, and are always painted last so
 * nothing drawn here can ever show through a mask.
 */

/** A small fixed palette instead of free colours: it stays legible on any
 * screenshot, renders identically everywhere, and keeps stored data trivially
 * valid. The hex values live in the render contract. */
export const IMAGE_EDIT_COLORS = ['red', 'yellow', 'green', 'blue', 'black', 'white'] as const;
export type ImageEditColor = (typeof IMAGE_EDIT_COLORS)[number];

/** Strokes (rectangle outline, arrow shaft) in CSS px, and text sizes in CSS px. */
export const IMAGE_EDIT_STROKE_WIDTHS = [2, 4, 6] as const;
export const IMAGE_EDIT_FONT_SIZES = [16, 24, 36, 56] as const;

export const IMAGE_EDIT_LIMITS = Object.freeze({
  minFontSize: 8,
  maxFontSize: 200,
  minStrokeWidth: 1,
  maxStrokeWidth: 40,
  maxTextLength: PERSISTED_STEP_LIMITS.maxImageEditTextLength,
  maxItems: PERSISTED_STEP_LIMITS.maxImageEditsPerStep,
  maxCoordinateMagnitude: PERSISTED_STEP_LIMITS.maxCoordinateMagnitude,
  maxBoundsDimension: PERSISTED_STEP_LIMITS.maxBoundsDimension,
  maxIdLength: PERSISTED_STEP_LIMITS.maxIdLength,
});

export interface EditPoint {
  x: number;
  y: number;
}

export interface EditBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextEdit {
  id: string;
  kind: 'text';
  /** The text box: `width` is the wrap width, `height` the laid-out height at save time. */
  bounds: EditBounds;
  text: string;
  fontSize: number;
  color: ImageEditColor;
}

export interface ArrowEdit {
  id: string;
  kind: 'arrow';
  from: EditPoint;
  /** The arrow head is drawn here. */
  to: EditPoint;
  width: number;
  color: ImageEditColor;
}

export interface RectEdit {
  id: string;
  kind: 'rect';
  bounds: EditBounds;
  width: number;
  color: ImageEditColor;
}

export type ImageEdit = TextEdit | ArrowEdit | RectEdit;
export type ImageEditKind = ImageEdit['kind'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= IMAGE_EDIT_LIMITS.maxCoordinateMagnitude;

const isDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= IMAGE_EDIT_LIMITS.maxBoundsDimension;

function isEditBounds(value: unknown): value is EditBounds {
  return isRecord(value)
    && isCoordinate(value.x) && isCoordinate(value.y)
    && isDimension(value.width) && isDimension(value.height)
    && isCoordinate((value.x as number) + (value.width as number))
    && isCoordinate((value.y as number) + (value.height as number));
}

const isEditPoint = (value: unknown): value is EditPoint =>
  isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y);

export const isImageEditColor = (value: unknown): value is ImageEditColor =>
  typeof value === 'string' && (IMAGE_EDIT_COLORS as readonly string[]).includes(value);

const isStrokeWidth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
  && value >= IMAGE_EDIT_LIMITS.minStrokeWidth && value <= IMAGE_EDIT_LIMITS.maxStrokeWidth;

const isFontSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
  && value >= IMAGE_EDIT_LIMITS.minFontSize && value <= IMAGE_EDIT_LIMITS.maxFontSize;

const isEditId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= IMAGE_EDIT_LIMITS.maxIdLength
  && value.trim() === value
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Strict shape check, used on every boundary (storage, archive, render). */
export function isValidImageEdit(value: unknown): value is ImageEdit {
  if (!isRecord(value) || !isEditId(value.id) || !isImageEditColor(value.color)) return false;
  switch (value.kind) {
    case 'text':
      return isEditBounds(value.bounds)
        && typeof value.text === 'string'
        && value.text.length > 0
        && value.text.length <= IMAGE_EDIT_LIMITS.maxTextLength
        && isFontSize(value.fontSize);
    case 'arrow':
      return isEditPoint(value.from) && isEditPoint(value.to) && isStrokeWidth(value.width);
    case 'rect':
      return isEditBounds(value.bounds) && isStrokeWidth(value.width);
    default:
      return false;
  }
}

/** Copies only the known fields, so nothing unexpected can ride along into storage or an archive. */
export function cloneImageEdit(edit: ImageEdit): ImageEdit {
  switch (edit.kind) {
    case 'text':
      return { id: edit.id, kind: 'text', bounds: { ...edit.bounds }, text: edit.text, fontSize: edit.fontSize, color: edit.color };
    case 'arrow':
      return { id: edit.id, kind: 'arrow', from: { ...edit.from }, to: { ...edit.to }, width: edit.width, color: edit.color };
    case 'rect':
      return { id: edit.id, kind: 'rect', bounds: { ...edit.bounds }, width: edit.width, color: edit.color };
  }
}

/** The usable edits of a stored value: anything malformed or duplicated is left out rather than drawn. */
export function readImageEdits(raw: unknown): ImageEdit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const edits: ImageEdit[] = [];
  for (const item of raw as unknown[]) {
    if (!isValidImageEdit(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    edits.push(cloneImageEdit(item));
    if (edits.length >= IMAGE_EDIT_LIMITS.maxItems) break;
  }
  return edits;
}

import type { Bounds, Redaction } from '@/lib/storage/models';
import type { ImageEdit } from '@/lib/storage/image-edit-model';

/**
 * Everything the image editor can place on a screenshot, as one list. Privacy
 * masks are stored in their own field (they have their own review rules and
 * always paint last); text, arrows and rectangles are `ImageEdit`s. This module
 * is the only place that converts between that storage and the flat list the
 * edit layer works with, so a new tool adds a kind here, a tool in
 * `image-edit-tools`, and geometry in `image-edit-item-geometry`.
 */
export interface RedactionItem {
  id: string;
  kind: 'redaction';
  bounds: Bounds;
}

export type ImageEditItem = RedactionItem | ImageEdit;
export type ImageEditItemKind = ImageEditItem['kind'];

/** Items in the order they are drawn: the person's edits first, masks last (always on top). */
export function toItems(redactions: readonly Redaction[], edits: readonly ImageEdit[]): ImageEditItem[] {
  return [
    ...edits,
    ...redactions.map((redaction): RedactionItem => ({ id: redaction.id, kind: 'redaction', bounds: redaction.bounds })),
  ];
}

export interface SplitItems {
  redactions: Redaction[];
  imageEdits: ImageEdit[];
}

/** The inverse of `toItems`: items back into the two stored fields, keeping relative order. */
export function splitItems(items: readonly ImageEditItem[]): SplitItems {
  const redactions: Redaction[] = [];
  const imageEdits: ImageEdit[] = [];
  for (const item of items) {
    if (item.kind === 'redaction') redactions.push({ id: item.id, kind: 'solid', bounds: { ...item.bounds } });
    else imageEdits.push(item);
  }
  return { redactions, imageEdits };
}

/** Keeps the draw order rule when something is added: masks stay last. */
export function appendItem(items: readonly ImageEditItem[], item: ImageEditItem): ImageEditItem[] {
  if (item.kind === 'redaction') return [...items, item];
  const firstMask = items.findIndex((existing) => existing.kind === 'redaction');
  if (firstMask === -1) return [...items, item];
  return [...items.slice(0, firstMask), item, ...items.slice(firstMask)];
}

export function newItemId(): string {
  return crypto.randomUUID();
}

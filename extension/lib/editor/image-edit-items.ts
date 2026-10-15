import type { Bounds, Redaction } from '@/lib/storage/models';

/**
 * The editor's view of everything a user can place on a screenshot. Each item
 * kind owns its own persisted field on the image-owning step; this module is
 * the only place that knows how to convert between that storage and the flat
 * list the edit layer works with. A new tool (text, arrows, ...) adds a kind
 * here, a tool in `image-edit-tools`, and a renderer in the edit layer — the
 * layer's selection, drag and keyboard behaviour is shared.
 */
export type ImageEditItem = { id: string; kind: 'redaction'; bounds: Bounds };

export type ImageEditItemKind = ImageEditItem['kind'];

export function redactionsToItems(redactions: readonly Redaction[]): ImageEditItem[] {
  return redactions.map((redaction) => ({ id: redaction.id, kind: 'redaction', bounds: redaction.bounds }));
}

export function itemsToRedactions(items: readonly ImageEditItem[]): Redaction[] {
  return items.flatMap((item) => (
    item.kind === 'redaction' ? [{ id: item.id, kind: 'solid' as const, bounds: { ...item.bounds } }] : []
  ));
}

export function newImageEditItem(kind: ImageEditItemKind, bounds: Bounds): ImageEditItem {
  return { id: crypto.randomUUID(), kind, bounds };
}

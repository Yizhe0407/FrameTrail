import type { ResolvedSnapshotTarget } from './snapshot-targeting';
import { snapshotRectKey, type SnapshotShieldRect } from './snapshot-shield-protocol';

export interface SnapshotSelectionSet {
  /** True when the target (by live element, stable identity, or rect key) was
   * already annotated on the current snapshot. */
  isSelected(target: ResolvedSnapshotTarget): boolean;
  /** Rect-only membership, for region annotations that carry no element. */
  hasRect(rect: SnapshotShieldRect): boolean;
  /** Records a committed annotation and invalidates any pending redo. */
  add(target: ResolvedSnapshotTarget): void;
  /** Removes the most recent annotation and parks it for a single restore. */
  undoLast(): ResolvedSnapshotTarget | null;
  /** Re-adds the last undone annotation, if any. */
  restoreUndone(): ResolvedSnapshotTarget | null;
}

/**
 * Pure bookkeeping for which snapshot targets are already annotated. Ordinary
 * targets are tracked by live element (survives text changes), string identity
 * (survives element replacement), and rect key (dedups region/element overlap).
 * Composite targets may opt out of the live-element dimension while retaining
 * their composite identity and rect membership.
 */
export function createSnapshotSelectionSet(): SnapshotSelectionSet {
  const identities = new Set<string>();
  const elements = new WeakSet<Element>();
  const rectKeys = new Set<string>();
  const history: ResolvedSnapshotTarget[] = [];
  let undoneTarget: ResolvedSnapshotTarget | null = null;

  const dedupeElementFor = (target: ResolvedSnapshotTarget): Element | null =>
    target.dedupeElement === undefined ? (target.element ?? null) : target.dedupeElement;

  return {
    isSelected(target) {
      const dedupeElement = dedupeElementFor(target);
      return (
        (dedupeElement ? elements.has(dedupeElement) : false) ||
        identities.has(target.identity) ||
        rectKeys.has(snapshotRectKey(target.rect))
      );
    },
    hasRect(rect) {
      return rectKeys.has(snapshotRectKey(rect));
    },
    add(target) {
      const dedupeElement = dedupeElementFor(target);
      identities.add(target.identity);
      if (dedupeElement) elements.add(dedupeElement);
      rectKeys.add(snapshotRectKey(target.rect));
      history.push(target);
      undoneTarget = null;
    },
    undoLast() {
      const target = history.pop() ?? null;
      if (target) {
        const dedupeElement = dedupeElementFor(target);
        identities.delete(target.identity);
        if (dedupeElement) elements.delete(dedupeElement);
        rectKeys.delete(snapshotRectKey(target.rect));
        undoneTarget = target;
      }
      return target;
    },
    restoreUndone() {
      if (!undoneTarget) return null;
      const target = undoneTarget;
      const dedupeElement = dedupeElementFor(target);
      identities.add(target.identity);
      if (dedupeElement) elements.add(dedupeElement);
      rectKeys.add(snapshotRectKey(target.rect));
      history.push(target);
      undoneTarget = null;
      return target;
    },
  };
}

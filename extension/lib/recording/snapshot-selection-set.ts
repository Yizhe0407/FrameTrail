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
 * Pure bookkeeping for which snapshot targets are already annotated. A target
 * is tracked three ways at once — live element (survives text changes),
 * string identity (survives element replacement), and rect key (dedups
 * region/element overlap) — so duplicate detection cannot be dodged by any
 * single dimension drifting.
 */
export function createSnapshotSelectionSet(): SnapshotSelectionSet {
  const identities = new Set<string>();
  const elements = new WeakSet<Element>();
  const rectKeys = new Set<string>();
  const history: ResolvedSnapshotTarget[] = [];
  let undoneTarget: ResolvedSnapshotTarget | null = null;

  return {
    isSelected(target) {
      return (
        (target.element ? elements.has(target.element) : false) ||
        identities.has(target.identity) ||
        rectKeys.has(snapshotRectKey(target.rect))
      );
    },
    hasRect(rect) {
      return rectKeys.has(snapshotRectKey(rect));
    },
    add(target) {
      identities.add(target.identity);
      if (target.element) elements.add(target.element);
      rectKeys.add(snapshotRectKey(target.rect));
      history.push(target);
      undoneTarget = null;
    },
    undoLast() {
      const target = history.pop() ?? null;
      if (target) {
        identities.delete(target.identity);
        if (target.element) elements.delete(target.element);
        rectKeys.delete(snapshotRectKey(target.rect));
        undoneTarget = target;
      }
      return target;
    },
    restoreUndone() {
      if (!undoneTarget) return null;
      const target = undoneTarget;
      identities.add(target.identity);
      if (target.element) elements.add(target.element);
      rectKeys.add(snapshotRectKey(target.rect));
      history.push(target);
      undoneTarget = null;
      return target;
    },
  };
}

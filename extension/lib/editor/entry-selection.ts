/**
 * Pure helpers for the editor's entry-level selection model.
 *
 * Selection is intentionally keyed by complete timeline entry ids (ordinary
 * step ids or snapshot anchor ids), never by annotation ids or array indexes.
 * This keeps snapshot groups indivisible and avoids stale index bugs after a
 * filter or reorder.
 */
export interface EntrySelectionState {
  activeId: string | null;
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
}

export interface EntrySelectionModifiers {
  additive?: boolean;
  range?: boolean;
}

function firstId(ids: readonly string[]): string | null {
  return ids.length > 0 ? ids[0] : null;
}

function validIdSet(ids: readonly string[]): Set<string> {
  return new Set(ids.filter((id) => id.length > 0));
}

/**
 * Reconciles selection after loading, filtering, deletion, or an external
 * revision. Hidden entries are deliberately removed so destructive batch
 * operations can never affect items the user cannot currently see.
 */
export function reconcileEntrySelection(
  state: EntrySelectionState,
  visibleIds: readonly string[],
): EntrySelectionState {
  const valid = validIdSet(visibleIds);
  if (valid.size === 0) {
    return { activeId: null, selectedIds: new Set(), anchorId: null };
  }

  const activeId = state.activeId && valid.has(state.activeId)
    ? state.activeId
    : firstId(visibleIds);
  const selectedIds = new Set([...state.selectedIds].filter((id) => valid.has(id)));

  if (selectedIds.size === 0 && activeId) selectedIds.add(activeId);
  return {
    activeId,
    selectedIds,
    anchorId: state.anchorId && valid.has(state.anchorId) ? state.anchorId : activeId,
  };
}

/** Applies a pointer/keyboard activation using common desktop selection rules. */
export function selectEntry(
  state: EntrySelectionState,
  targetId: string,
  visibleIds: readonly string[],
  modifiers: EntrySelectionModifiers = {},
): EntrySelectionState {
  const valid = validIdSet(visibleIds);
  if (!valid.has(targetId)) return reconcileEntrySelection(state, visibleIds);

  if (modifiers.range) {
    const anchorId = state.anchorId && valid.has(state.anchorId)
      ? state.anchorId
      : (state.activeId && valid.has(state.activeId) ? state.activeId : targetId);
    const anchorIndex = visibleIds.indexOf(anchorId);
    const targetIndex = visibleIds.indexOf(targetId);
    const from = Math.min(anchorIndex, targetIndex);
    const to = Math.max(anchorIndex, targetIndex);
    const selectedIds = modifiers.additive ? new Set(state.selectedIds) : new Set<string>();
    for (let index = from; index <= to; index += 1) selectedIds.add(visibleIds[index]);
    return { activeId: targetId, selectedIds, anchorId };
  }

  if (modifiers.additive) {
    const selectedIds = new Set(state.selectedIds);
    if (selectedIds.has(targetId)) selectedIds.delete(targetId);
    else selectedIds.add(targetId);

    // Keep an active item selected. This prevents the stage from implying that
    // an unselected item is the target of the visible batch controls.
    const activeId = selectedIds.size === 0
      ? targetId
      : (selectedIds.has(targetId) ? targetId : [...selectedIds][0]);
    if (selectedIds.size === 0) selectedIds.add(targetId);
    return { activeId, selectedIds, anchorId: targetId };
  }

  return { activeId: targetId, selectedIds: new Set([targetId]), anchorId: targetId };
}

export function selectAllVisibleEntries(visibleIds: readonly string[]): EntrySelectionState {
  const activeId = firstId(visibleIds);
  return {
    activeId,
    selectedIds: new Set(visibleIds),
    anchorId: activeId,
  };
}

export function collapseEntrySelection(state: EntrySelectionState): EntrySelectionState {
  if (!state.activeId) return { activeId: null, selectedIds: new Set(), anchorId: null };
  return {
    activeId: state.activeId,
    selectedIds: new Set([state.activeId]),
    anchorId: state.activeId,
  };
}

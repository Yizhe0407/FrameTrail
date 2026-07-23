import { useEffect, useMemo, useRef, useState } from 'react';
import type { StepRailSelectionModifiers } from '@/components/editor/StepRail';
import {
  collapseEntrySelection,
  reconcileEntrySelection,
  selectAllVisibleEntries,
  selectEntry as applyEntrySelection,
  type EntrySelectionState,
} from '@/lib/editor/entry-selection';
import { entryId, type StepEntry } from '@/lib/storage/db';

interface UseEditorEntryWorkspaceOptions {
  entries: StepEntry[];
  flushDescriptions: () => Promise<void>;
  isSelectionBlocked: () => boolean;
  onSelectionInteraction: () => void;
  onSelectionSaved: () => void;
}

/**
 * Keeps timeline selection and view-only state in one place. All entries stay
 * visible in the rail: the editor intentionally has no search or filtering
 * controls, so batch operations always operate on the complete guide.
 */
export function useEditorEntryWorkspace({
  entries,
  flushDescriptions,
  isSelectionBlocked,
  onSelectionInteraction,
  onSelectionSaved,
}: UseEditorEntryWorkspaceOptions) {
  const [publishOpen, setPublishOpen] = useState(false);
  const visibleEntries = entries;
  const [entrySelection, setEntrySelection] = useState<EntrySelectionState>({
    activeId: null,
    selectedIds: new Set(),
    anchorId: null,
  });
  const selectedEntryId = entrySelection.activeId;
  const visibleEntryIds = useMemo(() => visibleEntries.map(entryId), [visibleEntries]);
  const orderedSelectedEntryIds = useMemo(
    () => visibleEntryIds.filter((id) => entrySelection.selectedIds.has(id)),
    [entrySelection.selectedIds, visibleEntryIds],
  );
  const multipleEntriesSelected = orderedSelectedEntryIds.length > 1;
  const requestedEntryId = useMemo(() => new URLSearchParams(window.location.search).get('entryId'), []);
  const appliedRequestedEntry = useRef(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    if (multipleEntriesSelected) setZoomOpen(false);
  }, [multipleEntriesSelected]);

  useEffect(() => {
    setEntrySelection((current) => reconcileEntrySelection(current, visibleEntryIds));
  }, [visibleEntryIds]);

  useEffect(() => {
    if (appliedRequestedEntry.current || !requestedEntryId) return;
    if (!visibleEntries.some((entry) => entryId(entry) === requestedEntryId)) return;
    appliedRequestedEntry.current = true;
    setEntrySelection({ activeId: requestedEntryId, selectedIds: new Set([requestedEntryId]), anchorId: requestedEntryId });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#frametrail-editor-title')?.focus());
  }, [visibleEntries, requestedEntryId]);

  const selectedIndex = visibleEntries.findIndex((entry) => entryId(entry) === selectedEntryId);
  const selectedEntry = selectedIndex === -1 ? undefined : visibleEntries[selectedIndex];
  const selectedSnapshotEntries = useMemo(() => {
    const selectedIds = entrySelection.selectedIds;
    return visibleEntries.filter(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && selectedIds.has(entry.anchor.id),
    );
  }, [entrySelection.selectedIds, visibleEntries]);
  const snapshotNumberingEnabled = selectedSnapshotEntries.length > 0 && selectedSnapshotEntries.every((entry) => entry.anchor.numbered ?? false);

  async function selectEntry(id: string, modifiers: StepRailSelectionModifiers = { additive: false, range: false }): Promise<void> {
    if (isSelectionBlocked()) return;
    onSelectionInteraction();
    const nextSelection = applyEntrySelection(entrySelection, id, visibleEntryIds, modifiers);
    if (
      nextSelection.activeId === entrySelection.activeId &&
      nextSelection.anchorId === entrySelection.anchorId &&
      nextSelection.selectedIds.size === entrySelection.selectedIds.size &&
      [...nextSelection.selectedIds].every((selectedId) => entrySelection.selectedIds.has(selectedId))
    ) return;
    try {
      if (nextSelection.activeId !== selectedEntryId) await flushDescriptions();
      onSelectionSaved();
      setEntrySelection(nextSelection);
    } catch {
      // Keep the current field mounted so its unsaved draft remains available.
    }
  }

  async function selectAllVisible(): Promise<void> {
    if (isSelectionBlocked() || visibleEntryIds.length === 0) return;
    onSelectionInteraction();
    const nextSelection = selectAllVisibleEntries(visibleEntryIds);
    try {
      if (nextSelection.activeId !== selectedEntryId) await flushDescriptions();
      setEntrySelection(nextSelection);
    } catch {
      // Keep the current selection and mounted field when autosave fails.
    }
  }

  function collapseSelection(): void {
    if (isSelectionBlocked()) return;
    onSelectionInteraction();
    setEntrySelection((current) => collapseEntrySelection(current));
  }

  return {
    collapseSelection,
    entries,
    entrySelection,
    multipleEntriesSelected,
    orderedSelectedEntryIds,
    publishOpen,
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setEntrySelection,
    setPublishOpen,
    setZoomOpen,
    snapshotNumberingEnabled,
    selectAllVisible,
    selectEntry,
    visibleEntries,
    visibleEntryIds,
    zoomOpen,
  };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { StepRailSelectionModifiers } from '@/components/editor/StepRail';
import type { StepRailFilterValue } from '@/components/editor/StepRailFilters';
import {
  analyzeGuideQuality,
  createGuideEntryIndex,
  DEFAULT_GUIDE_ENTRY_FILTERS,
  filterGuideEntryIndex,
  type EntryQualityIssue,
} from '@/lib/guide/guide-quality';
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
  isFilterChangeBlocked: () => boolean;
  onSelectionInteraction: () => void;
  onSelectionSaved: () => void;
}

/**
 * Keeps filters, quality-derived visibility, and timeline selection in one
 * place. The hook deliberately owns only view state: all persistence and
 * permission decisions remain with the editor coordinator.
 */
export function useEditorEntryWorkspace({
  entries,
  flushDescriptions,
  isSelectionBlocked,
  isFilterChangeBlocked,
  onSelectionInteraction,
  onSelectionSaved,
}: UseEditorEntryWorkspaceOptions) {
  const qualityReport = useMemo(() => analyzeGuideQuality(entries), [entries]);
  const qualityIndex = useMemo(() => createGuideEntryIndex(entries, qualityReport), [entries, qualityReport]);
  const [filters, setFilters] = useState<StepRailFilterValue>({ ...DEFAULT_GUIDE_ENTRY_FILTERS });
  const [qualityOpen, setQualityOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const filteredIndex = useMemo(() => filterGuideEntryIndex(qualityIndex, filters), [qualityIndex, filters]);
  const visibleEntries = useMemo(() => filteredIndex.map((item) => item.entry), [filteredIndex]);
  const filtersActive = filters.text.trim().length > 0 || filters.kind !== 'all' || filters.issue !== 'all';

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

  // Hidden entries are deliberately removed from the selected set so a batch
  // operation can never mutate a step that the current filter conceals.
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

  async function changeFilters(nextFilters: StepRailFilterValue): Promise<void> {
    if (isFilterChangeBlocked()) return;
    try {
      await flushDescriptions();
      setFilters(nextFilters);
    } catch {
      // Keep the active editor field mounted and preserve the previous filter.
    }
  }

  function focusQualityIssue(issue: EntryQualityIssue): void {
    void changeFilters({ ...DEFAULT_GUIDE_ENTRY_FILTERS, issue });
    const first = qualityReport.entries.find((entry) => entry.issues.includes(issue));
    if (first) setEntrySelection({ activeId: first.entryId, selectedIds: new Set([first.entryId]), anchorId: first.entryId });
    setQualityOpen(false);
  }

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
    changeFilters,
    collapseSelection,
    entries,
    entrySelection,
    filters,
    filtersActive,
    focusQualityIssue,
    multipleEntriesSelected,
    orderedSelectedEntryIds,
    publishOpen,
    qualityOpen,
    qualityReport,
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setEntrySelection,
    setPublishOpen,
    setQualityOpen,
    setZoomOpen,
    snapshotNumberingEnabled,
    selectAllVisible,
    selectEntry,
    visibleEntries,
    visibleEntryIds,
    zoomOpen,
  };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { entryId, type StepEntry } from '@/lib/storage/db';

interface UseEditorEntryWorkspaceOptions {
  entries: StepEntry[];
  flushDescriptions: () => Promise<void>;
  isSelectionBlocked: () => boolean;
  onSelectionInteraction: () => void;
  onSelectionSaved: () => void;
}

/** Keeps the editor's single active timeline entry and view-only state together. */
export function useEditorEntryWorkspace({
  entries,
  flushDescriptions,
  isSelectionBlocked,
  onSelectionInteraction,
  onSelectionSaved,
}: UseEditorEntryWorkspaceOptions) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const requestedEntryId = useMemo(() => new URLSearchParams(window.location.search).get('entryId'), []);
  const appliedRequestedEntry = useRef(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const visibleEntries = entries;

  useEffect(() => {
    setSelectedEntryId((current) => {
      if (visibleEntries.length === 0) return null;
      if (current && visibleEntries.some((entry) => entryId(entry) === current)) return current;
      return entryId(visibleEntries[0]);
    });
  }, [visibleEntries]);

  useEffect(() => {
    if (appliedRequestedEntry.current || !requestedEntryId) return;
    if (!visibleEntries.some((entry) => entryId(entry) === requestedEntryId)) return;
    appliedRequestedEntry.current = true;
    setSelectedEntryId(requestedEntryId);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#frametrail-editor-title')?.focus());
  }, [visibleEntries, requestedEntryId]);

  const selectedIndex = visibleEntries.findIndex((entry) => entryId(entry) === selectedEntryId);
  const selectedEntry = selectedIndex === -1 ? undefined : visibleEntries[selectedIndex];

  async function selectEntry(id: string): Promise<void> {
    if (isSelectionBlocked() || id === selectedEntryId) return;
    if (!visibleEntries.some((entry) => entryId(entry) === id)) return;
    onSelectionInteraction();
    try {
      await flushDescriptions();
      onSelectionSaved();
      setSelectedEntryId(id);
    } catch {
      // Keep the current field mounted so its unsaved draft remains available.
    }
  }

  return {
    entries,
    publishOpen,
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setPublishOpen,
    setSelectedEntryId,
    setZoomOpen,
    selectEntry,
    visibleEntries,
    zoomOpen,
  };
}

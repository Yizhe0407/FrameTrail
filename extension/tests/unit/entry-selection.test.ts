import { describe, expect, it } from 'vitest';
import {
  collapseEntrySelection,
  reconcileEntrySelection,
  selectAllVisibleEntries,
  selectEntry,
  type EntrySelectionState,
} from '@/lib/editor/entry-selection';

function state(
  activeId: string | null,
  selectedIds: readonly string[],
  anchorId: string | null = activeId,
): EntrySelectionState {
  return { activeId, selectedIds: new Set(selectedIds), anchorId };
}

function selected(result: EntrySelectionState): string[] {
  return [...result.selectedIds];
}

describe('entry selection', () => {
  it('plain activation selects one complete entry', () => {
    const result = selectEntry(state('a', ['a']), 'c', ['a', 'b', 'c']);
    expect(result.activeId).toBe('c');
    expect(result.anchorId).toBe('c');
    expect(selected(result)).toEqual(['c']);
  });

  it('supports additive toggling without leaving an ambiguous empty selection', () => {
    const added = selectEntry(state('a', ['a']), 'c', ['a', 'b', 'c'], { additive: true });
    expect(selected(added)).toEqual(['a', 'c']);
    expect(added.activeId).toBe('c');

    const removed = selectEntry(added, 'c', ['a', 'b', 'c'], { additive: true });
    expect(selected(removed)).toEqual(['a']);
    expect(removed.activeId).toBe('a');

    const only = selectEntry(state('a', ['a']), 'a', ['a', 'b'], { additive: true });
    expect(selected(only)).toEqual(['a']);
    expect(only.activeId).toBe('a');
  });

  it('selects an inclusive visible range and preserves its anchor', () => {
    const result = selectEntry(state('b', ['b'], 'b'), 'd', ['a', 'b', 'c', 'd'], { range: true });
    expect(selected(result)).toEqual(['b', 'c', 'd']);
    expect(result.activeId).toBe('d');
    expect(result.anchorId).toBe('b');
  });

  it('can add a range to an existing selection', () => {
    const result = selectEntry(state('b', ['a', 'b'], 'b'), 'd', ['a', 'b', 'c', 'd'], {
      additive: true,
      range: true,
    });
    expect(selected(result)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops missing selections when the timeline changes', () => {
    const result = reconcileEntrySelection(state('hidden', ['hidden', 'b'], 'hidden'), ['a', 'b']);
    expect(result.activeId).toBe('a');
    expect(result.anchorId).toBe('a');
    expect(selected(result)).toEqual(['b']);
  });

  it('selects all visible entries and collapses back to active', () => {
    const all = selectAllVisibleEntries(['a', 'b', 'c']);
    expect(selected(all)).toEqual(['a', 'b', 'c']);
    expect(selected(collapseEntrySelection({ ...all, activeId: 'b' }))).toEqual(['b']);
  });

  it('returns an empty state for an empty timeline', () => {
    const result = reconcileEntrySelection(state('a', ['a']), []);
    expect(result).toEqual({ activeId: null, selectedIds: new Set(), anchorId: null });
  });
});

import { useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { entryId, getOrderedAnnotations, type StepEntry } from '@/lib/db';
import { reorderById, restrictToVerticalAxis, useSortableSensors } from '@/lib/dnd';
import { cn } from '@/lib/utils';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import SortableItem from './SortableItem';

interface Props {
  entries: StepEntry[];
  selectedEntryId: string | null;
  onSelect: (id: string) => void;
  onReorder: (reordered: StepEntry[]) => Promise<void>;
  reorderDisabled?: boolean;
}

export default function StepRail({ entries, selectedEntryId, onSelect, onReorder, reorderDisabled = false }: Props) {
  const sensors = useSortableSensors();

  function handleDragEnd(event: DragEndEvent) {
    if (reorderDisabled) return;
    const reordered = reorderById(entries, event.active.id, event.over?.id, entryId);
    if (reordered) void onReorder(reordered);
  }

  // Arrow-key navigation across the rail, skipped while the user is typing
  // in a description/annotation field elsewhere on the page.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const idx = entries.findIndex((entry) => entryId(entry) === selectedEntryId);
      if (idx === -1) return;
      const nextIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= entries.length) return;
      e.preventDefault();
      onSelect(entryId(entries[nextIdx]));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [entries, selectedEntryId, onSelect]);

  function renderThumbnail(entry: StepEntry) {
    if (entry.kind === 'single') {
      return (
        <HighlightThumbnail
          blob={entry.step.screenshotBlob}
          bounds={entry.step.bounds}
          screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
          alt=""
          fit="cover"
          className="size-full"
        />
      );
    }
    const boxAnnotations = getOrderedAnnotations(entry.annotations);
    return (
      <>
        <MultiHighlightThumbnail
          blob={entry.anchor.screenshotBlob}
          annotations={boxAnnotations}
          screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
          numbered={entry.anchor.numbered ?? false}
          alt=""
          fit="cover"
          className="size-full"
        />
        <span className="absolute right-1 bottom-1 rounded border border-stone-200 bg-stone-50 px-1 py-px text-[9px] tracking-[.06em] text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
          快照
        </span>
      </>
    );
  }

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
      <div className="shrink-0 px-5 pt-5 pb-3 text-[11px] tracking-[.16em] text-stone-400 dark:text-stone-500">
        步驟 · {entries.length}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        modifiers={[restrictToVerticalAxis]}
      >
        <SortableContext items={entries.map(entryId)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-4">
            {entries.map((entry, index) => {
              const id = entryId(entry);
              const selected = id === selectedEntryId;
              return (
                <SortableItem key={id} id={id} disabled={reorderDisabled}>
                  {(handle) => (
                    <div
                      className={cn(
                        'group relative flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left',
                        selected
                          ? 'border border-stone-300 bg-white shadow-sm dark:border-stone-600 dark:bg-stone-800'
                          : 'hover:bg-stone-100 dark:hover:bg-stone-800',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-label={`選取步驟 ${index + 1}`}
                        aria-current={selected ? 'step' : undefined}
                        className="absolute inset-0 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-inset"
                      />
                      <span
                        className={cn(
                          'pointer-events-none relative z-[1] w-5 shrink-0 text-center text-xs tabular-nums',
                          selected
                            ? 'font-semibold text-lime-700 dark:text-lime-400'
                            : 'text-stone-400 dark:text-stone-500',
                        )}
                      >
                        {index + 1}
                      </span>
                      <div className="pointer-events-none relative z-[1] h-14 w-24 shrink-0 overflow-hidden rounded-[6px]">
                        {renderThumbnail(entry)}
                      </div>
                      <span
                        className={cn(
                          'relative z-[2] ml-auto flex shrink-0 items-center gap-1.5',
                          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                      >
                        {handle}
                        {selected && <span className="h-9 w-[3px] rounded-sm bg-lime-700 dark:bg-lime-500" />}
                      </span>
                    </div>
                  )}
                </SortableItem>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
    </nav>
  );
}

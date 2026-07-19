import { useEffect, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { entryId, getOrderedAnnotations, type StepEntry } from '@/lib/db';
import {
  reorderById,
  restrictToHorizontalAxis,
  restrictToVerticalAxis,
  useSortableSensors,
} from '@/lib/dnd';
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
  const selectedItem = useRef<HTMLButtonElement | null>(null);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)').matches : true,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktop(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    selectedItem.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [entries.length, selectedEntryId]);

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
      const previousKey = isDesktop ? 'ArrowUp' : 'ArrowLeft';
      const nextKey = isDesktop ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== previousKey && e.key !== nextKey) return;
      const idx = entries.findIndex((entry) => entryId(entry) === selectedEntryId);
      if (idx === -1) return;
      const nextIdx = e.key === previousKey ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= entries.length) return;
      e.preventDefault();
      onSelect(entryId(entries[nextIdx]));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [entries, isDesktop, selectedEntryId, onSelect]);

  function entrySummary(entry: StepEntry): string {
    if (entry.kind === 'group') return `單頁標註 · ${entry.annotations.length} 個標註`;
    return entry.step.description.trim() || '尚未填寫說明';
  }

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
        <span className="absolute right-1 bottom-1 rounded border border-stone-200 bg-stone-50 px-1 py-px text-[11px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
          快照
        </span>
      </>
    );
  }

  return (
    <nav
      aria-label="步驟導覽"
      className="fixed inset-x-0 bottom-0 z-30 flex h-32 shrink-0 flex-col border-t border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900 lg:static lg:z-auto lg:h-auto lg:w-64 lg:border-t-0 lg:border-r"
    >
      <div className="shrink-0 px-4 py-2 text-xs font-medium text-stone-600 dark:text-stone-300 lg:px-5 lg:pt-5 lg:pb-3">
        步驟 · {entries.length}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        modifiers={[isDesktop ? restrictToVerticalAxis : restrictToHorizontalAxis]}
      >
        <SortableContext
          items={entries.map(entryId)}
          strategy={isDesktop ? verticalListSortingStrategy : horizontalListSortingStrategy}
        >
          <ul className="app-scrollbar flex flex-1 flex-row gap-2 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-1.5 lg:overflow-x-hidden lg:overflow-y-auto lg:pb-4">
            {entries.map((entry, index) => {
              const id = entryId(entry);
              const selected = id === selectedEntryId;
              return (
                <SortableItem key={id} id={id} disabled={reorderDisabled} className="w-44 shrink-0 lg:w-auto">
                  {(handle) => (
                    <div
                      className={cn(
                        'group relative flex h-[76px] w-full items-center gap-2 rounded-md p-2 text-left lg:h-auto lg:gap-2.5',
                        selected
                          ? 'border border-stone-300 bg-white shadow-sm dark:border-stone-600 dark:bg-stone-800'
                          : 'hover:bg-stone-100 dark:hover:bg-stone-800',
                      )}
                    >
                      <button
                        ref={selected ? selectedItem : undefined}
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-label={`選取步驟 ${index + 1}`}
                        aria-current={selected ? 'step' : undefined}
                        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset"
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
                      <div className="pointer-events-none relative z-[1] h-12 w-16 shrink-0 overflow-hidden rounded-[6px] lg:h-14 lg:w-20">
                        {renderThumbnail(entry)}
                      </div>
                      <span className="pointer-events-none relative z-[1] hidden min-w-0 flex-1 text-xs leading-[18px] text-stone-600 lg:block dark:text-stone-300">
                        <span className="line-clamp-2">{entrySummary(entry)}</span>
                      </span>
                      <span
                        className={cn(
                          'relative z-[2] ml-auto flex shrink-0 items-center gap-1',
                          selected ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100',
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

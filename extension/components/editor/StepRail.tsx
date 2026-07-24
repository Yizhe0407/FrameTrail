import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { entryId, getEffectiveBounds, getEntryPrivacyState, getOrderedAnnotations, type StepEntry } from '@/lib/storage/db';
import type { GuideSection } from '@/lib/guide/guide-sections';
import {
  reorderById,
  restrictToHorizontalAxis,
  restrictToVerticalAxis,
  useSortableSensors,
} from '@/lib/editor/dnd';
import { cn } from '@/lib/shared/utils';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import SortableItem from './SortableItem';
import GuideSectionHeading from './GuideSectionHeading';


function LazyRailPreview({ eager, children }: { eager: boolean; children: ReactNode }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (eager || visible) {
      setVisible(true);
      return;
    }
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '320px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, visible]);

  return (
    <div
      ref={host}
      aria-busy={!visible}
      className="relative h-12 w-16 shrink-0 overflow-hidden rounded-[6px] bg-stone-200 lg:h-14 lg:w-20 dark:bg-stone-700"
    >
      {visible ? children : <span className="sr-only">縮圖尚未載入</span>}
    </div>
  );
}


interface Props {
  entries: StepEntry[];
  selectedEntryId: string | null;
  sections?: readonly GuideSection[];
  onSelect: (id: string) => void;
  onRenameSection?: (sectionId: string, title: string) => Promise<void>;
  onDeleteSection?: (sectionId: string) => Promise<void>;
  onReorder: (reordered: StepEntry[]) => Promise<void>;
  reorderDisabled?: boolean;
}

export default function StepRail({
  entries,
  selectedEntryId,
  sections = [],
  onSelect,
  onRenameSection,
  onDeleteSection,
  onReorder,
  reorderDisabled = false,
}: Props) {
  const sensors = useSortableSensors();
  const selectedItem = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const sectionByStartId = new Map(sections.map((section) => [section.startEntryId, section]));
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
    if (reordered) {
      void onReorder(reordered).catch((error) => {
        console.error('[frametrail] failed to reorder guide entries', error);
      });
    }
  }

  // Arrow-key navigation across the rail, skipped while the user is typing
  // in a description/annotation field elsewhere on the page.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const activeElement = document.activeElement as HTMLElement | null;
      // Keep rail navigation scoped to the rail so arrow keys used by other
      // editor controls do not unexpectedly switch the current entry.
      if (!activeElement || !railRef.current?.contains(activeElement)) return;
      const tag = activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || activeElement.isContentEditable) return;
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
  }, [entries, isDesktop, onSelect, selectedEntryId]);

  function renderThumbnail(entry: StepEntry) {
    const privacy = getEntryPrivacyState(entry);
    if (entry.kind === 'single') {
      return (
        <HighlightThumbnail
          blob={entry.step.screenshotBlob}
          bounds={getEffectiveBounds(entry.step)}
          redactions={privacy.redactions}
          privacyReviewRequired={privacy.reviewRequired}
          screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
          alt=""
          fit="cover"
          loading="lazy"
          decoding="async"
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
          redactions={privacy.redactions}
          privacyReviewRequired={privacy.reviewRequired}
          screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
          numbered={entry.anchor.numbered ?? false}
          alt=""
          fit="cover"
          loading="lazy"
          decoding="async"
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
      ref={railRef}
      aria-label="步驟導覽"
      className="fixed inset-x-0 bottom-0 z-30 flex h-32 shrink-0 flex-col border-t border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900 lg:static lg:z-auto lg:h-auto lg:w-[19rem] lg:min-w-[18rem] lg:shrink-0 lg:basis-[19rem] lg:border-t-0 lg:border-r"
    >
      <div className="flex shrink-0 items-center px-4 py-2 text-xs font-medium text-stone-600 dark:text-stone-300 lg:px-5 lg:pt-5 lg:pb-3">
        <span>步驟 · {entries.length}</span>
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
          <ul
            aria-label="可重新排序的步驟清單"
            className="app-scrollbar flex flex-1 flex-row gap-2 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-1.5 lg:overflow-x-visible lg:overflow-y-auto lg:px-3 lg:pb-4 lg:pr-4"
          >
            {entries.map((entry, index) => {
              const id = entryId(entry);
              const active = id === selectedEntryId;
              const section = sectionByStartId.get(id);
              return (
                <SortableItem
                  key={id}
                  id={id}
                  disabled={reorderDisabled}
                  className="w-44 shrink-0 [content-visibility:auto] [contain-intrinsic-size:176px_76px] lg:w-full lg:min-w-0 lg:[contain-intrinsic-size:288px_76px]"
                >
                  {(handle) => (
                    <div className="flex min-w-0 flex-col gap-1">
                      {section && onRenameSection && onDeleteSection && (
                        <GuideSectionHeading
                          section={section}
                          disabled={reorderDisabled}
                          onRename={onRenameSection}
                          onDelete={onDeleteSection}
                        />
                      )}
                      <div
                        data-active={active || undefined}
                        className={cn(
                          "group relative flex min-w-0 items-center gap-2 rounded-md p-2 pr-11 text-left transition-colors before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-sm before:content-[''] lg:min-h-[76px] lg:gap-2.5",
                          active
                            ? 'border border-stone-300 bg-white shadow-sm before:bg-emerald-700 dark:border-stone-600 dark:bg-stone-800 dark:before:bg-emerald-400'
                            : 'border border-transparent hover:bg-stone-100 dark:hover:bg-stone-800',
                        )}
                      >
                        <button
                          ref={active ? selectedItem : undefined}
                          type="button"
                          onClick={() => onSelect(id)}
                          aria-label={`開啟步驟 ${index + 1}`}
                          aria-current={active ? 'step' : undefined}
                          className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset"
                        />
                        <span
                          className={cn(
                            'pointer-events-none relative z-[1] w-5 shrink-0 text-center text-xs tabular-nums',
                            active ? 'font-semibold text-stone-800 dark:text-stone-100' : 'text-stone-400 dark:text-stone-500',
                          )}
                        >
                          {index + 1}
                        </span>
                        <div className="pointer-events-none relative z-[1]">
                          <LazyRailPreview eager={active}>
                            {renderThumbnail(entry)}
                          </LazyRailPreview>
                        </div>
                        <span className="absolute top-1/2 right-1 z-[3] flex -translate-y-1/2 items-center opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                          {handle}
                        </span>
                      </div>
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

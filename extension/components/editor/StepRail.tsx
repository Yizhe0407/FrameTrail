import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical, Video } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { entryId, type StepEntry } from '@/lib/storage/models';
import type { GuideSection } from '@/lib/guide/guide-sections';
import {
  restrictToHorizontalAxis,
  restrictToVerticalAxis,
  useSortableReorder,
} from '@/lib/editor/dnd';
import { NEW_STEPS_APPEND_NOTE } from '@/lib/editor/editor-messages';
import { cn } from '@/lib/shared/utils';
import EntryThumbnail from './EntryThumbnail';
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
      className="relative size-full overflow-hidden"
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
  onContinueRecording?: () => void;
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
  onContinueRecording,
  reorderDisabled = false,
}: Props) {
  const { sensors, accessibility, handleDragEnd, itemIds } = useSortableReorder(
    entries,
    entryId,
    onReorder,
    {
      disabled: reorderDisabled,
      itemNoun: '步驟',
      logLabel: '[frametrail] failed to reorder guide entries',
    },
  );
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

  // The parent recreates `onSelect` inline on every render, so binding the
  // window listener to it directly would tear down and re-add it each time.
  // Writing the ref during render breaks under concurrent rendering (a render
  // can be discarded); committing it in an effect is safe because keydown only
  // ever fires after a commit.
  const navigation = useRef({ entries, isDesktop, onSelect, selectedEntryId });
  useEffect(() => {
    navigation.current = { entries, isDesktop, onSelect, selectedEntryId };
  });

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
      const { entries, isDesktop, onSelect, selectedEntryId } = navigation.current;
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
  }, []);

  return (
    <nav
      ref={railRef}
      aria-label="步驟導覽"
      className="fixed inset-x-0 bottom-0 z-30 flex h-32 shrink-0 flex-col border-t border-border bg-card lg:static lg:z-auto lg:my-6 lg:ml-6 lg:h-auto lg:max-h-[calc(100%-3rem)] lg:min-h-0 lg:w-[194px] lg:min-w-[194px] lg:shrink-0 lg:self-start lg:basis-[194px] lg:rounded-md lg:border lg:border-border/70"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-3 pb-2 text-[10.5px] font-semibold text-muted-foreground">
        <span>步驟 · {entries.length}</span>
        {/* The grip icon on each card is the affordance; this legend is what
            makes it readable as one, since a rail of screenshots gives no other
            hint that the order is editable. */}
        {entries.length > 1 && !reorderDisabled && (
          <span className="hidden items-center gap-0.5 font-medium text-muted-foreground/70 lg:flex">
            <GripVertical className="size-3" aria-hidden="true" />拖曳排序
          </span>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={accessibility}
        modifiers={[isDesktop ? restrictToVerticalAxis : restrictToHorizontalAxis]}
      >
        <SortableContext
          items={itemIds}
          strategy={isDesktop ? verticalListSortingStrategy : horizontalListSortingStrategy}
        >
          <ul
            aria-label="可重新排序的步驟清單"
            className="app-scrollbar flex flex-1 flex-row gap-1.5 overflow-x-auto px-2 pb-2 lg:min-h-0 lg:flex-col lg:gap-1.5 lg:overflow-x-visible lg:overflow-y-auto lg:px-2 lg:pb-1.5"
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
                  className="w-32 shrink-0 [content-visibility:auto] [contain-intrinsic-size:128px_78px] lg:w-full lg:min-w-0"
                  // Sits on top of a screenshot, so it needs the same solid chip
                  // treatment as the step number rather than muted-on-transparent.
                  handleClassName="rounded-md bg-[rgba(28,28,28,0.75)] text-white/85 shadow-md hover:text-white dark:bg-[rgba(30,30,30,0.85)]"
                >
                  {(handle, { isDragging }) => (
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
                          'group relative flex min-w-0 items-center rounded-md p-[6px] transition-all cursor-pointer border',
                          active
                            ? 'border-transparent bg-card'
                            : 'border-transparent bg-transparent hover:bg-foreground/5 dark:hover:bg-white/5',
                          // Lifts the row being moved off the list so the
                          // reflow underneath reads as the drop preview.
                          isDragging && 'border-brand/60 bg-card shadow-lg',
                        )}
                      >
                        <button
                          ref={active ? selectedItem : undefined}
                          type="button"
                          onClick={() => onSelect(id)}
                          aria-label={`開啟步驟 ${index + 1}`}
                          aria-current={active ? 'step' : undefined}
                          className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        />
                        {active && (
                          <span
                            aria-hidden="true"
                            data-frametrail-selected-step-outline
                            className="frametrail-selected-step-outline pointer-events-none absolute inset-0 z-10 rounded-md border-2"
                          />
                        )}
                        <div className="pointer-events-none relative z-[1] aspect-[16/9] w-full overflow-hidden rounded-md bg-secondary">
                          <LazyRailPreview eager={active}>
                            <EntryThumbnail
                              entry={entry}
                              alt=""
                              fit="contain"
                              loading="lazy"
                              decoding="async"
                              className="size-full"
                            />
                          </LazyRailPreview>
                          <span className={cn(
                            'absolute left-2 top-2 z-30 flex size-6 items-center justify-center rounded-md text-xs font-bold tabular-nums shadow-md transition-all',
                            active
                              ? 'bg-brand text-primary-foreground scale-105'
                              : 'bg-[rgba(28,28,28,0.75)] text-white dark:bg-[rgba(30,30,30,0.85)] dark:text-white',
                          )}>
                            {index + 1}
                          </span>
                          {entry.kind === 'group' && (
                            <span className="pointer-events-none absolute inset-[6px] rounded-md border-[1.4px] border-recording/75" aria-hidden="true" />
                          )}
                        </div>
                        {/* Always rendered: a hover-only handle is invisible on
                            touch and undiscoverable everywhere else. It rests
                            dimmed so it does not compete with the thumbnail. */}
                        <span className="absolute top-2 right-2 z-20 opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
      {onContinueRecording && (
        <button
          type="button"
          onClick={onContinueRecording}
          disabled={reorderDisabled}
          title={`回到來源頁面繼續錄製，${NEW_STEPS_APPEND_NOTE}`}
          className="mx-2.5 mt-1.5 mb-3 hidden h-[32px] shrink-0 items-center justify-center gap-[5px] rounded-md border border-dashed border-border/80 bg-card text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:border-brand/40 hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 lg:flex"
        >
          <Video className="size-3" />接續錄製
        </button>
      )}
    </nav>
  );
}

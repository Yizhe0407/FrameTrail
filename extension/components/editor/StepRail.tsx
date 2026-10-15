import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, GripVertical, Video } from 'lucide-react';
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
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      {visible ? children : <span className="sr-only">{t().editor.rail.thumbnailPending}</span>}
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
      itemNoun: t().sortable.stepNoun,
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

  // Ref avoids rebinding the window listener each render; written in an effect
  // (not during render) since a concurrent render can be discarded.
  const navigation = useRef({ entries, isDesktop, onSelect, selectedEntryId });
  useEffect(() => {
    navigation.current = { entries, isDesktop, onSelect, selectedEntryId };
  });

  // Arrow-key navigation across the rail, skipped while typing in a field elsewhere on the page.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const activeElement = document.activeElement as HTMLElement | null;
      // Scoped to the rail so arrow keys used by other editor controls don't switch the entry.
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
      aria-label={t().editor.rail.label}
      className="fixed inset-x-0 bottom-0 z-30 flex h-32 shrink-0 flex-col border-t-2 border-border bg-card lg:static lg:z-auto lg:my-6 lg:ml-6 lg:h-auto lg:max-h-[calc(100%-3rem)] lg:min-h-0 lg:w-[200px] lg:min-w-[200px] lg:shrink-0 lg:self-start lg:basis-[200px] lg:rounded-md lg:border-2"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-3 pb-2 text-xs font-bold text-muted-foreground">
        <span>{t().editor.rail.count(entries.length)}</span>
        {/* Legend for the grip-icon affordance; a rail of screenshots gives no other hint the order is editable. */}
        {entries.length > 1 && !reorderDisabled && (
          <span className="hidden items-center gap-0.5 lg:flex">
            <GripVertical className="size-3" aria-hidden="true" />{t().editor.rail.dragHint}
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
            aria-label={t().editor.rail.listLabel}
            className="app-scrollbar flex flex-1 flex-row gap-1 overflow-x-auto px-2 pb-2 lg:min-h-0 lg:flex-col lg:gap-1 lg:overflow-x-visible lg:overflow-y-auto lg:px-2 lg:pb-2"
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
                  // Sits on top of a screenshot, so it wears the same solid sticker chip as the step number.
                  handleClassName="size-6 rounded-full border-2 border-border bg-card text-foreground hover:bg-secondary [&_svg]:size-3.5"
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
                          // p-1 puts the thumbnail exactly 4px inside, the inset its `rounded-sm` is drawn for.
                          'group relative flex min-w-0 cursor-pointer items-center rounded-md p-1 transition-colors',
                          active ? 'bg-card' : 'bg-transparent hover:bg-secondary',
                          // Lifts the row being moved off the list so the reflow underneath reads as the drop preview.
                          isDragging && 'bg-card outline-2 outline-dashed outline-border',
                        )}
                      >
                        <button
                          ref={active ? selectedItem : undefined}
                          type="button"
                          onClick={() => onSelect(id)}
                          aria-label={t().editor.rail.openStep(index + 1)}
                          aria-current={active ? 'step' : undefined}
                          className="absolute inset-0 z-0 rounded-md outline-none focus-ring"
                        />
                        {active && (
                          <span
                            aria-hidden="true"
                            data-frametrail-selected-step-outline
                            className="frametrail-selected-step-outline pointer-events-none absolute inset-0 z-10 rounded-md border-2"
                          />
                        )}
                        <div className="pointer-events-none relative z-[1] aspect-[16/9] w-full overflow-hidden rounded-sm bg-secondary">
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
                            'absolute top-1.5 left-1.5 z-30 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-border px-1 text-xs font-bold tabular-nums transition-colors',
                            active ? 'bg-selected text-on-accent' : 'bg-card text-foreground',
                          )}>
                            {index + 1}
                          </span>
                          {entry.kind === 'group' && (
                            <span
                              className="absolute bottom-1.5 left-1.5 z-30 flex size-6 items-center justify-center rounded-full border-2 border-border bg-card text-foreground"
                              aria-hidden="true"
                            >
                              <Camera className="size-3" />
                            </span>
                          )}
                        </div>
                        {/* Always rendered: a hover-only handle is invisible on touch; rests dimmed to not compete with the thumbnail. */}
                        <span className="absolute top-2.5 right-2.5 z-20 opacity-80 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onContinueRecording}
              disabled={reorderDisabled}
              className="mx-2 mt-1 mb-2 hidden h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-border bg-transparent text-xs font-bold text-muted-foreground outline-none transition-colors focus-ring hover:border-solid hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40 lg:flex"
            >
              <Video className="size-3.5" />{t().editor.rail.continueRecording}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t().editor.rail.continueRecordingTooltip}</TooltipContent>
        </Tooltip>
      )}
    </nav>
  );
}

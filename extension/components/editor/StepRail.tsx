import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, GripVertical, Plus, Video } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { entryId, type StepEntry } from '@/lib/storage/models';
import type { ProjectSection } from '@/lib/project/project-sections';
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
import ProjectSectionHeading from './ProjectSectionHeading';


/**
 * The seam between two steps. It takes no room of its own: a zero-height row
 * whose hit area straddles the existing gap, so the list keeps its density.
 * Invisible until hovered or focused, then a dashed line with a pill floats
 * over the seam to say new steps go right here.
 */
function InsertSlot({ afterStep, disabled, onInsert }: { afterStep: number; disabled: boolean; onInsert: () => void }) {
  return (
    <li className="relative z-10 -mt-1 hidden h-0 shrink-0 lg:block">
      <button
        type="button"
        disabled={disabled}
        onClick={onInsert}
        aria-label={t().editor.rail.insertAfter(afterStep)}
        className="group/slot absolute inset-x-0 -top-2 flex h-4 items-center justify-center outline-none disabled:pointer-events-none"
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-2 top-1/2 border-t-2 border-dashed border-border opacity-0 transition-opacity group-hover/slot:opacity-100 group-focus-visible/slot:opacity-100"
        />
        <span
          aria-hidden="true"
          className="relative flex h-5 items-center gap-1 rounded-full border-2 border-border bg-card px-2.5 text-[11px] leading-none font-bold text-foreground opacity-0 transition-opacity group-hover/slot:opacity-100 group-focus-visible/slot:opacity-100 group-focus-visible/slot:outline-2 group-focus-visible/slot:outline-offset-2 group-focus-visible/slot:outline-focus"
        >
          <Plus className="size-3" />{t().editor.rail.insertHere}
        </span>
      </button>
    </li>
  );
}

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
  sections?: readonly ProjectSection[];
  onSelect: (id: string) => void;
  onRenameSection?: (sectionId: string, title: string) => Promise<void>;
  onDeleteSection?: (sectionId: string) => Promise<void>;
  onReorder: (reordered: StepEntry[]) => Promise<void>;
  /** Starts a continuation; `afterEntryId` inserts after that entry, omitted appends at the end. */
  onContinueRecording?: (afterEntryId?: string) => void;
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
      logLabel: '[stepmark] failed to reorder project entries',
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
                <Fragment key={id}>
                <SortableItem
                  id={id}
                  disabled={reorderDisabled}
                  className="w-32 shrink-0 [content-visibility:auto] [contain-intrinsic-size:128px_78px] lg:w-full lg:min-w-0"
                  // Sits on top of a screenshot, so it wears the same solid sticker chip as the step number.
                  handleClassName="size-6 rounded-full border-2 border-border bg-card text-foreground hover:bg-secondary [&_svg]:size-3.5"
                >
                  {(handle, { isDragging }) => (
                    <div className="flex min-w-0 flex-col gap-1">
                      {section && onRenameSection && onDeleteSection && (
                        <ProjectSectionHeading
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
                            data-stepmark-selected-step-outline
                            className="stepmark-selected-step-outline pointer-events-none absolute inset-0 z-10 rounded-md border-2"
                          />
                        )}
                        <div className="pointer-events-none relative z-[1] aspect-[16/9] w-full overflow-hidden rounded-sm border-2 border-border bg-secondary">
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
                {/* The last seam is the 接續錄製 button below the list. */}
                {onContinueRecording && index < entries.length - 1 && (
                  <InsertSlot
                    afterStep={index + 1}
                    disabled={reorderDisabled}
                    onInsert={() => onContinueRecording(id)}
                  />
                )}
                </Fragment>
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
              onClick={() => onContinueRecording()}
              disabled={reorderDisabled}
              className="mx-2 mt-1 mb-2 hidden h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border-2 border-border bg-card text-xs leading-none font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 lg:flex"
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

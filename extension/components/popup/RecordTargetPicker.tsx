import { useEffect, useState } from 'react';
import { FilePlus2, FolderOpen } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getProjectSummaries } from '@/lib/storage/project-repository';
import type { ProjectSummary } from '@/lib/storage/models';
import { getLocale, t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

/** How many of the most recently updated Projects the popup offers. Browsing the
 * rest is the Library's job; the popup only needs the one just worked on. */
export const RECORD_TARGET_RECENT_LIMIT = 5;

// Radix Select cannot hold an empty value, and a bare sentinel could collide
// with a Project id, so every Project option carries its own prefix.
const NEW_VALUE = 'new';
const PROJECT_PREFIX = 'project:';

interface Props {
  /** The Project to append to, or null to record into a brand-new one. */
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/** Coarse "2 hours ago" label that tells same-titled Projects apart. */
function relativeUpdated(updatedAt: number, now = Date.now()): string {
  const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  const minutes = Math.round((updatedAt - now) / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(Math.min(minutes, -1), 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

/**
 * 「錄到哪裡」: the popup's opt-in for appending to an existing Project. The
 * default stays 新專案 so a stray click can never mix steps into finished work.
 * Renders nothing until the Library holds at least one Project, so a first-time
 * user sees no extra control.
 */
export default function RecordTargetPicker({ value, onChange, disabled = false, className }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    let active = true;
    void getProjectSummaries()
      .then((all) => {
        if (active) setProjects(all.slice(0, RECORD_TARGET_RECENT_LIMIT));
      })
      .catch((error) => {
        // Fail closed to "new project only": a missing list must never block recording.
        console.warn('[stepmark] failed to read projects for the record target', error);
      });
    return () => {
      active = false;
    };
  }, []);

  if (projects.length === 0) return null;

  const selected = value === null ? null : projects.find((project) => project.id === value);
  const selectedTitle = selected ? selected.title.trim() || t().common.untitledProject : null;

  return (
    <div className="flex flex-col gap-1.5">
    <Select
      value={value === null ? NEW_VALUE : `${PROJECT_PREFIX}${value}`}
      onValueChange={(next) => onChange(next === NEW_VALUE ? null : next.slice(PROJECT_PREFIX.length))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={t().popup.recordTarget}
        className={cn(
          'h-9 w-full gap-2 border-2 border-border bg-card px-3 text-sm font-bold text-foreground focus-ring focus-visible:border-border focus-visible:ring-0 data-[size=default]:h-9 dark:bg-card dark:hover:bg-secondary *:data-[slot=select-value]:flex-1',
          className,
        )}
      >
        {value === null ? <FilePlus2 aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
        {/* The trigger stays one line: the dropdown rows carry the extra update time. */}
        <SelectValue>
          {selected ? (
            <>
              <span className="min-w-0 flex-1 truncate">{selectedTitle}</span>
              <span className="shrink-0 text-xs font-bold text-muted-foreground">
                {t().popup.recordTargetCount(selected.entryCount)}
              </span>
            </>
          ) : (
            t().popup.recordTargetNew
          )}
        </SelectValue>
      </SelectTrigger>
      {/* The popup is a fixed 320px window that clips anything drawn past its
          edge, so the list is pinned to the trigger's width instead of growing
          with its longest title; titles truncate and the count stays visible. */}
      <SelectContent
        position="popper"
        className="w-(--radix-select-trigger-width) max-w-(--radix-select-trigger-width) min-w-0 border-0 ring-2 ring-border"
      >
        <SelectItem value={NEW_VALUE} className="font-bold">{t().popup.recordTargetNew}</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={`${PROJECT_PREFIX}${project.id}`} className="font-bold">
            <span className="min-w-0 flex-1 truncate">{project.title.trim() || t().common.untitledProject}</span>
            <span className="flex shrink-0 flex-col items-end text-xs font-bold text-muted-foreground">
              <span>{t().popup.recordTargetCount(project.entryCount)}</span>
              <span className="font-normal">{t().popup.recordTargetUpdated(relativeUpdated(project.updatedAt))}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {selectedTitle && (
      <p className="px-1 text-xs leading-snug text-muted-foreground">{t().popup.recordTargetNote(selectedTitle)}</p>
    )}
    </div>
  );
}

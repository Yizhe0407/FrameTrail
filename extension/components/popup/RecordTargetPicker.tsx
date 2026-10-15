import { useEffect, useState } from 'react';
import { FilePlus2, FolderOpen } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getGuideSummaries } from '@/lib/storage/guide-repository';
import type { GuideSummary } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

/** How many of the most recently updated Guides the popup offers. Browsing the
 * rest is the Library's job; the popup only needs the one just worked on. */
export const RECORD_TARGET_RECENT_LIMIT = 5;

// Radix Select cannot hold an empty value, and a bare sentinel could collide
// with a Guide id, so every Guide option carries its own prefix.
const NEW_VALUE = 'new';
const GUIDE_PREFIX = 'guide:';

interface Props {
  /** The Guide to append to, or null to record into a brand-new one. */
  value: string | null;
  onChange: (guideId: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 「錄到哪裡」: the popup's opt-in for appending to an existing Guide. The
 * default stays 新作品 so a stray click can never mix steps into finished work.
 * Renders nothing until the Library holds at least one Guide, so a first-time
 * user sees no extra control.
 */
export default function RecordTargetPicker({ value, onChange, disabled = false, className }: Props) {
  const [guides, setGuides] = useState<GuideSummary[]>([]);

  useEffect(() => {
    let active = true;
    void getGuideSummaries()
      .then((all) => {
        if (active) setGuides(all.slice(0, RECORD_TARGET_RECENT_LIMIT));
      })
      .catch((error) => {
        // Fail closed to "new guide only": a missing list must never block recording.
        console.warn('[stepmark] failed to read guides for the record target', error);
      });
    return () => {
      active = false;
    };
  }, []);

  if (guides.length === 0) return null;

  return (
    <Select
      value={value === null ? NEW_VALUE : `${GUIDE_PREFIX}${value}`}
      onValueChange={(next) => onChange(next === NEW_VALUE ? null : next.slice(GUIDE_PREFIX.length))}
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
        <SelectValue />
      </SelectTrigger>
      {/* The popup is a fixed 320px window that clips anything drawn past its
          edge, so the list is pinned to the trigger's width instead of growing
          with its longest title; titles truncate and the count stays visible. */}
      <SelectContent
        position="popper"
        className="w-(--radix-select-trigger-width) max-w-(--radix-select-trigger-width) min-w-0 border-0 ring-2 ring-border"
      >
        <SelectItem value={NEW_VALUE} className="font-bold">{t().popup.recordTargetNew}</SelectItem>
        {guides.map((guide) => (
          <SelectItem key={guide.id} value={`${GUIDE_PREFIX}${guide.id}`} className="font-bold">
            <span className="min-w-0 flex-1 truncate">{guide.title.trim() || t().common.untitledGuide}</span>
            <span className="shrink-0 text-xs font-bold text-muted-foreground">
              {t().popup.recordTargetCount(guide.entryCount)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

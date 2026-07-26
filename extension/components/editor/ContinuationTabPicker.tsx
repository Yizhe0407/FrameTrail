import { Check, Globe } from 'lucide-react';
import type { ContinuationTabOption } from '@/lib/editor/editor-app-model';
import { cn } from '@/lib/shared/utils';

interface Props {
  tabs: ContinuationTabOption[];
  selectedTabId: number | null;
  onSelect: (tabId: number) => void;
  disabled?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Compact explicit tab list for 「改在其他頁面接續」. Tabs arrive most recently
 * used first; the caller owns preselection (it skips the page the Guide just
 * recorded). Only http(s) favicons are rendered — anything else falls back to
 * a generic globe so a hostile page cannot smuggle an odd URL scheme in here.
 */
export default function ContinuationTabPicker({ tabs, selectedTabId, onSelect, disabled = false }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="選擇要接續錄製的分頁"
      className="mt-3 max-h-52 overflow-y-auto rounded-md border border-border"
    >
      {tabs.map((tab) => {
        const host = hostOf(tab.url);
        const selected = tab.id === selectedTabId;
        const favicon = tab.favIconUrl && /^https?:\/\//.test(tab.favIconUrl) ? tab.favIconUrl : null;
        return (
          <button
            key={tab.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-2 text-left last:border-b-0',
              'transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-50',
              selected && 'bg-secondary',
            )}
          >
            {favicon ? (
              <img src={favicon} alt="" aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">{tab.title || host}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{host}</span>
            </span>
            {selected && <Check className="size-4 shrink-0 text-brand" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

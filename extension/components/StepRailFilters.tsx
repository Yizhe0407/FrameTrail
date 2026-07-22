import { useId } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_GUIDE_ENTRY_FILTERS,
  ENTRY_QUALITY_ISSUES,
  GUIDE_QUALITY_ISSUE_LABELS,
  type EntryQualityIssue,
  type GuideEntryIssueFilter,
  type GuideEntryKindFilter,
} from '@/lib/guide-quality';
import { cn } from '@/lib/utils';

export interface StepRailFilterValue {
  text: string;
  kind: GuideEntryKindFilter;
  issue: GuideEntryIssueFilter;
}

export interface StepRailFiltersProps {
  value: StepRailFilterValue;
  onChange: (value: StepRailFilterValue) => void;
  totalCount: number;
  filteredCount?: number;
  issueCounts?: Readonly<Partial<Record<EntryQualityIssue, number>>>;
  disabled?: boolean;
  className?: string;
  idPrefix?: string;
}

function safeCount(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

export default function StepRailFilters({
  value,
  onChange,
  totalCount,
  filteredCount = totalCount,
  issueCounts,
  disabled = false,
  className,
  idPrefix,
}: StepRailFiltersProps) {
  const generatedId = useId();
  const prefix = idPrefix ?? `step-rail-filters-${generatedId.replace(/:/g, '')}`;
  const searchId = `${prefix}-search`;
  const kindId = `${prefix}-kind`;
  const issueId = `${prefix}-issue`;
  const active = value.text.trim().length > 0 || value.kind !== 'all' || value.issue !== 'all';
  const normalizedTotal = safeCount(totalCount);
  const normalizedFiltered = Math.min(safeCount(filteredCount), normalizedTotal);

  function update(changes: Partial<StepRailFilterValue>) {
    onChange({ ...value, ...changes });
  }

  return (
    <section
      aria-label="篩選步驟"
      className={cn(
        'flex flex-col gap-3 border-b border-stone-200 bg-stone-50 px-3 py-3 dark:border-stone-700 dark:bg-stone-900',
        className,
      )}
    >
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">搜尋步驟說明或網址</label>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-stone-400" />
        <input
          id={searchId}
          type="search"
          value={value.text}
          disabled={disabled}
          autoComplete="off"
          placeholder="搜尋步驟"
          onChange={(event) => update({ text: event.currentTarget.value })}
          className="h-9 w-full rounded-md border border-stone-300 bg-white pr-3 pl-9 text-sm text-stone-900 outline-none placeholder:text-stone-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={kindId} className="text-xs font-medium text-stone-600 dark:text-stone-300">類型</label>
          <select
            id={kindId}
            value={value.kind}
            disabled={disabled}
            onChange={(event) => update({ kind: event.currentTarget.value as GuideEntryKindFilter })}
            className="h-9 min-w-0 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
          >
            <option value="all">全部類型</option>
            <option value="single">操作步驟</option>
            <option value="group">單頁標註</option>
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={issueId} className="text-xs font-medium text-stone-600 dark:text-stone-300">品質問題</label>
          <select
            id={issueId}
            value={value.issue}
            disabled={disabled}
            onChange={(event) => update({ issue: event.currentTarget.value as GuideEntryIssueFilter })}
            className="h-9 min-w-0 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
          >
            <option value="all">全部步驟</option>
            <option value="any">有品質問題</option>
            <option value="none">沒有品質問題</option>
            {ENTRY_QUALITY_ISSUES.map((issue) => (
              <option key={issue} value={issue}>
                {GUIDE_QUALITY_ISSUE_LABELS[issue]}（{safeCount(issueCounts?.[issue])}）
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex min-h-8 items-center justify-between gap-2">
        <output aria-live="polite" className="text-xs text-stone-500 dark:text-stone-400">
          顯示 {normalizedFiltered} / {normalizedTotal} 個步驟
        </output>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ ...DEFAULT_GUIDE_ENTRY_FILTERS })}
            aria-label="清除所有步驟篩選"
            className="text-stone-600 dark:text-stone-300"
          >
            <RotateCcw aria-hidden="true" />
            清除篩選
          </Button>
        )}
      </div>
    </section>
  );
}

export { StepRailFilters };

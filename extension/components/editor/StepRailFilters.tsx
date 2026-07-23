import { useId } from 'react';
import { RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_GUIDE_ENTRY_FILTERS,
  ENTRY_QUALITY_ISSUES,
  GUIDE_QUALITY_ISSUE_LABELS,
  type EntryQualityIssue,
  type GuideEntryIssueFilter,
  type GuideEntryKindFilter,
} from '@/lib/guide/guide-quality';
import { cn } from '@/lib/shared/utils';

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

function formatIssueFilter(issue: GuideEntryIssueFilter): string | null {
  if (issue === 'all') return null;
  if (issue === 'any') return '有待確認項目';
  if (issue === 'none') return '沒有待確認項目';
  return GUIDE_QUALITY_ISSUE_LABELS[issue];
}

function formatKindFilter(kind: GuideEntryKindFilter): string | null {
  if (kind === 'all') return null;
  return kind === 'single' ? '操作流程' : '單頁標註';
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
  const activeFilters = [
    value.text.trim() ? `搜尋「${value.text.trim()}」` : null,
    formatKindFilter(value.kind),
    formatIssueFilter(value.issue),
  ].filter((item): item is string => Boolean(item));

  function update(changes: Partial<StepRailFilterValue>) {
    onChange({ ...value, ...changes });
  }

  return (
    <section
      aria-label="篩選步驟"
      className={cn(
        'flex flex-col gap-2 border-b border-stone-200 bg-stone-50/80 px-3 py-3 dark:border-stone-700 dark:bg-stone-900/80',
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

      <details className="group">
        <summary
          className={cn(
            'flex h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 text-sm font-medium text-stone-600 outline-none transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-blue-600/25 dark:text-stone-300 dark:hover:bg-stone-800',
            disabled && 'cursor-not-allowed opacity-60',
          )}
          aria-label="篩選：依類型或發佈前狀態"
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          <span>篩選</span>
          <span className="text-xs font-normal text-stone-400 group-open:hidden dark:text-stone-500">類型與發佈前狀態</span>
          <span className="ml-auto text-xs text-stone-400 group-open:hidden dark:text-stone-500">展開</span>
        </summary>

        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
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
              <option value="single">操作流程</option>
              <option value="group">單頁標註</option>
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={issueId} className="text-xs font-medium text-stone-600 dark:text-stone-300">發佈前狀態</label>
            <select
              id={issueId}
              value={value.issue}
              disabled={disabled}
              onChange={(event) => update({ issue: event.currentTarget.value as GuideEntryIssueFilter })}
              className="h-9 min-w-0 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
            >
              <option value="all">全部項目</option>
              <option value="any">有待確認項目</option>
              <option value="none">沒有待確認項目</option>
              {ENTRY_QUALITY_ISSUES.map((issue) => (
                <option key={issue} value={issue}>
                  {GUIDE_QUALITY_ISSUE_LABELS[issue]}（{safeCount(issueCounts?.[issue])}）
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>

      {active && (
        <div className="flex min-h-8 items-center justify-between gap-2">
          <output aria-live="polite" className="min-w-0 truncate text-xs text-stone-500 dark:text-stone-400">
            已篩選：{activeFilters.join('、')} · {normalizedFiltered} / {normalizedTotal}
          </output>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ ...DEFAULT_GUIDE_ENTRY_FILTERS })}
            aria-label="清除所有步驟篩選"
            className="shrink-0 text-stone-600 dark:text-stone-300"
          >
            <RotateCcw aria-hidden="true" />
            清除
          </Button>
        </div>
      )}
    </section>
  );
}

export { StepRailFilters };

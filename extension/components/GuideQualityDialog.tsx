import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  analyzeGuideQuality,
  ENTRY_QUALITY_ISSUES,
  GUIDE_QUALITY_ISSUE_LABELS,
  type EntryQualityIssue,
  type GuideQualityReport,
} from '@/lib/guide-quality';
import type { StepEntry } from '@/lib/db';
import { cn } from '@/lib/utils';

export interface GuideQualityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a memoized report to avoid re-analysis in parent-controlled flows. */
  report?: GuideQualityReport;
  /** Used only when `report` is omitted. */
  entries?: readonly StepEntry[];
  veryLongThreshold?: number;
  onSelectEntry?: (entryId: string, index: number) => void;
  onFilterIssue?: (issue: EntryQualityIssue) => void;
  closeOnSelect?: boolean;
  className?: string;
}

function issueSummary(report: GuideQualityReport, issue: EntryQualityIssue): string {
  const entries = report.issueCounts[issue];
  const occurrences = report.occurrenceCounts[issue];
  if (occurrences > entries) return `${entries} 個步驟，${occurrences} 處`;
  return `${entries} 個步驟`;
}

export default function GuideQualityDialog({
  open,
  onOpenChange,
  report: suppliedReport,
  entries = [],
  veryLongThreshold,
  onSelectEntry,
  onFilterIssue,
  closeOnSelect = true,
  className,
}: GuideQualityDialogProps) {
  const report = useMemo(
    () => suppliedReport ?? analyzeGuideQuality(entries, { veryLongThreshold }),
    [entries, suppliedReport, veryLongThreshold],
  );
  const affectedEntries = useMemo(
    () => report.entries.filter((entry) => entry.issues.length > 0),
    [report],
  );
  const hasQualityWarnings = report.totalIssueCount > 0;

  function selectEntry(entryId: string, index: number) {
    onSelectEntry?.(entryId, index);
    if (onSelectEntry && closeOnSelect) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'app-scrollbar max-h-[calc(100vh-32px)] w-[min(760px,calc(100vw-32px))] overflow-y-auto border border-stone-200 bg-white p-0 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100',
          className,
        )}
      >
        <DialogHeader className="border-b border-stone-200 px-6 pt-6 pb-5 pr-14 dark:border-stone-700">
          <DialogTitle className="text-xl">教學品質檢查</DialogTitle>
          <DialogDescription className="max-w-2xl leading-6 text-stone-500 dark:text-stone-400">
            以文字與中繼資料快速檢查 {report.entryCount} 個步驟；不會載入或解碼截圖。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 py-5">
          <section aria-labelledby="guide-quality-summary" className="flex flex-col gap-3">
            <h2 id="guide-quality-summary" className="sr-only">檢查摘要</h2>
            <div
              role="status"
              className={cn(
                'flex items-start gap-3 rounded-lg border p-4',
                hasQualityWarnings
                  ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100'
                  : 'border-green-300 bg-green-50 text-green-950 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100',
              )}
            >
              {hasQualityWarnings
                ? <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                : <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" />}
              <div className="min-w-0">
                <p className="font-semibold">
                  {hasQualityWarnings ? `${report.affectedEntryCount} 個步驟需要檢查` : '沒有發現品質問題'}
                </p>
                <p className="mt-1 text-sm opacity-80">
                  {report.isVeryLong
                    ? `這份教學已達 ${report.entryCount} 個步驟，建議拆分章節或多份教學。`
                    : `已檢查 ${report.descriptionCount} 個說明欄位。`}
                </p>
              </div>
            </div>

            <ul aria-label="品質問題統計" className="grid gap-2 sm:grid-cols-2">
              {ENTRY_QUALITY_ISSUES.map((issue) => {
                const count = report.issueCounts[issue];
                return (
                  <li key={issue}>
                    {onFilterIssue ? (
                      <button
                        type="button"
                        disabled={count === 0}
                        onClick={() => onFilterIssue(issue)}
                        className="flex w-full items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-left text-sm outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-default disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800"
                        aria-label={`${GUIDE_QUALITY_ISSUE_LABELS[issue]}：${issueSummary(report, issue)}；套用篩選`}
                      >
                        <span>{GUIDE_QUALITY_ISSUE_LABELS[issue]}</span>
                        <Badge variant={count > 0 ? 'destructive' : 'outline'}>{issueSummary(report, issue)}</Badge>
                      </button>
                    ) : (
                      <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-700">
                        <span>{GUIDE_QUALITY_ISSUE_LABELS[issue]}</span>
                        <Badge variant={count > 0 ? 'destructive' : 'outline'}>{issueSummary(report, issue)}</Badge>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="guide-quality-entries" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h2 id="guide-quality-entries" className="text-sm font-semibold">需要檢查的步驟</h2>
              <span className="text-xs text-stone-500 dark:text-stone-400">{affectedEntries.length} 個</span>
            </div>

            {affectedEntries.length === 0 ? (
              <p className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
                所有步驟都通過目前的檢查。
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {affectedEntries.map((entry) => {
                  const content = (
                    <>
                      <span className="w-9 shrink-0 text-sm font-semibold tabular-nums text-stone-500 dark:text-stone-400">
                        {entry.index + 1}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                        {entry.issues.map((issue) => (
                          <Badge key={issue} variant="outline" className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                            {GUIDE_QUALITY_ISSUE_LABELS[issue]}
                            {(entry.occurrences[issue] ?? 0) > 1 && ` ×${entry.occurrences[issue]}`}
                          </Badge>
                        ))}
                      </span>
                      {onSelectEntry && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-stone-400" />}
                    </>
                  );
                  return (
                    <li key={`${entry.entryId}-${entry.index}`}>
                      {onSelectEntry ? (
                        <button
                          type="button"
                          onClick={() => selectEntry(entry.entryId, entry.index)}
                          className="flex w-full items-center gap-2 rounded-md border border-stone-200 px-3 py-3 text-left outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-stone-700 dark:hover:bg-stone-800"
                          aria-label={`前往步驟 ${entry.index + 1}：${entry.issues.map((issue) => GUIDE_QUALITY_ISSUE_LABELS[issue]).join('、')}`}
                        >
                          {content}
                        </button>
                      ) : (
                        <div className="flex items-center gap-2 rounded-md border border-stone-200 px-3 py-3 dark:border-stone-700">
                          {content}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        <DialogFooter className="border-t border-stone-200 px-6 py-4 dark:border-stone-700">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { GuideQualityDialog };

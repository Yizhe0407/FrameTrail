import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Info } from 'lucide-react';
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
  GUIDE_QUALITY_ISSUE_LABELS,
  type EntryQualityIssue,
  type GuideQualityReport,
} from '@/lib/guide/guide-quality';
import { BLOCKING_PUBLICATION_ISSUES } from '@/lib/export/publication-policy';
import type { StepEntry } from '@/lib/storage/db';
import { cn } from '@/lib/shared/utils';

export interface GuideQualityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report?: GuideQualityReport;
  entries?: readonly StepEntry[];
  veryLongThreshold?: number;
  onSelectEntry?: (entryId: string, index: number) => void;
  onFilterIssue?: (issue: EntryQualityIssue) => void;
}

const BLOCKING = new Set<EntryQualityIssue>(BLOCKING_PUBLICATION_ISSUES);

export default function GuideQualityDialog({
  open,
  onOpenChange,
  report: suppliedReport,
  entries = [],
  veryLongThreshold,
  onSelectEntry,
  onFilterIssue,
}: GuideQualityDialogProps) {
  const fallbackReport = useMemo(
    () => analyzeGuideQuality(entries, { veryLongThreshold }),
    [entries, veryLongThreshold],
  );
  const report = suppliedReport ?? fallbackReport;
  const blockingEntries = report.entries
    .map((entry) => ({ ...entry, issues: entry.issues.filter((issue) => BLOCKING.has(issue)) }))
    .filter((entry) => entry.issues.length > 0);
  const advisoryEntries = report.entries
    .map((entry) => ({ ...entry, issues: entry.issues.filter((issue) => !BLOCKING.has(issue)) }))
    .filter((entry) => entry.issues.length > 0);
  const blockingCount = BLOCKING_PUBLICATION_ISSUES.reduce(
    (sum, issue) => sum + report.issueCounts[issue],
    0,
  );
  const advisoryCount = report.totalIssueCount - blockingCount;

  function selectEntry(entryId: string, index: number) {
    onSelectEntry?.(entryId, index);
    if (onSelectEntry) onOpenChange(false);
  }

  function IssueList({
    entries: affectedEntries,
    tone,
  }: {
    entries: typeof blockingEntries;
    tone: 'blocking' | 'advisory';
  }) {
    if (affectedEntries.length === 0) {
      return (
        <p className="rounded-md bg-stone-50 px-4 py-4 text-sm text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
          {tone === 'blocking' ? '沒有阻擋發佈的問題。' : '沒有其他閱讀性建議。'}
        </p>
      );
    }
    return (
      <ol className="flex flex-col divide-y divide-stone-200 dark:divide-stone-700">
        {affectedEntries.map((entry) => {
          const content = (
            <>
              <span className="w-9 shrink-0 text-sm font-semibold tabular-nums text-stone-500 dark:text-stone-400">
                {entry.index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {entry.issues.map((issue) => (
                  <Badge
                    key={issue}
                    variant="outline"
                    className={cn(
                      tone === 'blocking'
                        ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
                        : 'border-stone-300 bg-white text-stone-700 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-200',
                    )}
                  >
                    {GUIDE_QUALITY_ISSUE_LABELS[issue]}
                    {(entry.occurrences[issue] ?? 0) > 1 && ` ×${entry.occurrences[issue]}`}
                  </Badge>
                ))}
              </span>
              {onSelectEntry && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-stone-400" />}
            </>
          );
          return (
            <li key={`${tone}-${entry.entryId}-${entry.index}`}>
              {onSelectEntry ? (
                <button
                  type="button"
                  onClick={() => selectEntry(entry.entryId, entry.index)}
                  className="flex w-full items-center gap-2 px-2 py-3 text-left outline-none transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset dark:hover:bg-stone-800"
                  aria-label={`前往步驟 ${entry.index + 1}：${entry.issues.map((issue) => GUIDE_QUALITY_ISSUE_LABELS[issue]).join('、')}`}
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-2 py-3">{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-scrollbar max-h-[calc(100vh-32px)] w-[min(720px,calc(100vw-32px))] max-w-none overflow-y-auto p-0">
        <DialogHeader className="border-b border-stone-200 px-6 pt-6 pb-5 pr-14 dark:border-stone-700">
          <DialogTitle className="text-xl">發佈前檢查</DialogTitle>
          <DialogDescription className="max-w-2xl leading-6">
            這不是品質評分。FrameTrail 只檢查可自動判斷的內容完整性與隱私狀態，不會分析截圖內容。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-7 px-6 py-5">
          <section aria-labelledby="blocking-checks-title" className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2 id="blocking-checks-title" className="font-semibold text-stone-900 dark:text-stone-100">
                  必須處理才能發佈{blockingCount > 0 ? `（${blockingCount}）` : ''}
                </h2>
                <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
                  遮罩待確認、缺少圖片或缺少框選會讓輸出不安全或無法閱讀。
                </p>
              </div>
            </div>
            <IssueList entries={blockingEntries} tone="blocking" />
          </section>

          <section aria-labelledby="advisory-checks-title" className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                <Info className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2 id="advisory-checks-title" className="font-semibold text-stone-900 dark:text-stone-100">
                  可改善閱讀性{advisoryCount > 0 ? `（${advisoryCount}）` : ''}
                </h2>
                <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
                  這些是編輯建議，不會阻擋發佈；請依教學目的自行決定。
                </p>
              </div>
            </div>
            <IssueList entries={advisoryEntries} tone="advisory" />
            {report.isVeryLong && (
              <div className="flex items-start gap-3 rounded-md bg-stone-50 px-4 py-3 text-sm text-stone-700 dark:bg-stone-800/60 dark:text-stone-200">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{GUIDE_QUALITY_ISSUE_LABELS['very-long-guide']}</p>
                  <p className="mt-1 text-stone-500 dark:text-stone-400">
                    目前有 {report.entryCount} 個項目；可考慮用章節整理，或拆成多份較短的教學。
                  </p>
                </div>
              </div>
            )}
          </section>

          {report.totalIssueCount === 0 && !report.isVeryLong && (
            <div className="flex items-center gap-3 rounded-md bg-emerald-50 px-4 py-4 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              已完成自動檢查，可以繼續發佈。
            </div>
          )}

          {onFilterIssue && report.totalIssueCount > 0 && (
            <details className="group rounded-md bg-stone-50 px-4 py-3 text-sm dark:bg-stone-800/60">
              <summary className="font-medium text-stone-700 dark:text-stone-200">依問題篩選左側步驟</summary>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(report.issueCounts).map(([issue, count]) => (
                  issue !== 'very-long-guide' && count > 0 && (
                    <Button key={issue} type="button" size="sm" variant="outline" onClick={() => onFilterIssue(issue as EntryQualityIssue)}>
                      {GUIDE_QUALITY_ISSUE_LABELS[issue as EntryQualityIssue]}（{count}）
                    </Button>
                  )
                ))}
              </div>
            </details>
          )}
        </div>

        <DialogFooter className="border-t border-stone-200 px-6 py-4 dark:border-stone-700">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { GuideQualityDialog };

import { useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { StepEntry } from '@/lib/storage/db';
import type { InsertionSide, RecordingMode } from '@/lib/runtime/messages';

export function insertionTargetForEntry(entry: StepEntry): { anchorEntryId: string } {
  return { anchorEntryId: entry.kind === 'single' ? entry.step.id : entry.anchor.id };
}

interface InsertionRecordingActionsProps {
  disabled?: boolean;
  pending?: boolean;
  onStart: (side: InsertionSide, mode: RecordingMode, numbered: boolean) => Promise<void> | void;
}

export default function InsertionRecordingActions({
  disabled = false,
  pending = false,
  onStart,
}: InsertionRecordingActionsProps) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [numbered, setNumbered] = useState(true);
  const unavailable = disabled || pending;

  return (
    <details className="group shrink-0 border-b border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
      <summary
        aria-label="展開指定位置補錄"
        className="flex min-h-10 items-center gap-2 px-4 py-2 text-sm font-medium text-stone-600 outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset sm:px-6 lg:px-9 dark:text-stone-300 dark:hover:bg-stone-800"
      >
        <Plus className="size-4" aria-hidden="true" />
        在這個步驟附近新增內容
        <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <section aria-label="指定位置補錄" className="flex flex-wrap items-end gap-3 border-t border-stone-100 px-4 py-3 sm:px-6 lg:px-9 dark:border-stone-800">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
          錄製方式
          <select
            aria-label="補錄模式"
            value={mode}
            disabled={unavailable}
            onChange={(event) => setMode(event.target.value as RecordingMode)}
            className="h-9 rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/25 disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
          >
            <option value="steps">操作流程</option>
            <option value="snapshot">單頁標註</option>
          </select>
        </label>
        {mode === 'snapshot' && (
          <label className="flex h-9 items-center gap-2 rounded-md bg-stone-50 px-3 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Switch
              aria-label="標註顯示順序編號"
              checked={numbered}
              disabled={unavailable}
              onCheckedChange={setNumbered}
            />
            顯示標註編號
          </label>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={unavailable}
            onClick={() => void onStart('before', mode, mode === 'snapshot' && numbered)}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ArrowUpToLine />}
            在前方補錄
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={unavailable}
            onClick={() => void onStart('after', mode, mode === 'snapshot' && numbered)}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
            在後方補錄
          </Button>
        </div>
      </section>
    </details>
  );
}

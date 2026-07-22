import { useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StepEntry } from '@/lib/db';
import type { InsertionSide, RecordingMode } from '@/lib/messages';

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
    <section
      aria-label="指定位置補錄"
      className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white px-4 py-2.5 sm:px-6 lg:px-9 dark:border-stone-700 dark:bg-stone-900"
    >
      <span className="mr-1 text-sm font-medium text-stone-800 dark:text-stone-100">指定位置補錄</span>
      <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300">
        <span className="sr-only">補錄模式</span>
        <select
          aria-label="補錄模式"
          value={mode}
          disabled={unavailable}
          onChange={(event) => setMode(event.target.value as RecordingMode)}
          className="h-8 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus-visible:ring-2 focus-visible:ring-lime-500 disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
        >
          <option value="steps">步驟模式</option>
          <option value="snapshot">快照模式</option>
        </select>
      </label>
      {mode === 'snapshot' && (
        <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300">
          <input
            type="checkbox"
            checked={numbered}
            disabled={unavailable}
            onChange={(event) => setNumbered(event.target.checked)}
            className="size-4 accent-lime-600"
          />
          標註顯示順序編號
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
  );
}

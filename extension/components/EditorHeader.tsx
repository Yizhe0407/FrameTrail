import { Badge } from '@/components/ui/badge';
import ExportImagesButton from './ExportImagesButton';
import ResetButton from './ResetButton';
import type { Step } from '@/lib/db';
import type { ActiveOperation } from '@/lib/messages';

interface Props {
  operationActive: boolean;
  operation?: ActiveOperation;
  steps: Step[];
  onBeforeExport?: () => Promise<Step[] | void>;
}

export default function EditorHeader({ operationActive, operation, steps, onBeforeExport }: Props) {
  return (
    <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2 sm:px-7 dark:border-stone-700 dark:bg-stone-900">
      <div className="flex min-w-0 items-baseline gap-2 sm:gap-3.5">
        <h1
          id="frametrail-editor-title"
          tabIndex={-1}
          className="text-[15px] font-semibold text-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-stone-100"
        >
          FrameTrail
        </h1>
        <span className="hidden text-xs text-stone-500 sm:inline dark:text-stone-400">編輯器</span>
        {operationActive && (
          <Badge variant="destructive" className="gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            {operation === 'recapture' ? '補拍中' : '錄製中'}
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
        <ResetButton hasSteps={steps.length > 0} disabled={operationActive} />
        <ExportImagesButton steps={steps} variant="default" onBeforeExport={onBeforeExport} disabled={operationActive} />
      </div>
    </header>
  );
}

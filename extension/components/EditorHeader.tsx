import { Badge } from '@/components/ui/badge';
import ExportImagesButton from './ExportImagesButton';
import ResetButton from './ResetButton';
import type { Step } from '@/lib/db';

interface Props {
  isRecording: boolean;
  steps: Step[];
}

export default function EditorHeader({ isRecording, steps }: Props) {
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-stone-200 bg-stone-50 px-7 dark:border-stone-700 dark:bg-stone-900">
      <div className="flex items-baseline gap-3.5">
        <span className="text-[15px] font-semibold tracking-[.02em] text-stone-800 dark:text-stone-100">
          FrameTrail
        </span>
        <span className="text-xs tracking-[.14em] text-stone-400 dark:text-stone-500">編輯器</span>
        {isRecording && (
          <Badge variant="destructive" className="gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            錄製中
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <ResetButton hasSteps={steps.length > 0} disabled={isRecording} />
        <ExportImagesButton steps={steps} variant="default" />
      </div>
    </header>
  );
}

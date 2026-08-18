import { Download, Library } from 'lucide-react';
import ResetButton from '../shared/ResetButton';
import { type Step } from '@/lib/storage/models';
import type { ActiveOperation } from '@/lib/storage/recording-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { openLibrary } from '@/lib/runtime/actions';

interface Props {
  operationActive: boolean;
  editingDisabled?: boolean;
  operation?: ActiveOperation;
  steps: Step[];
  sessionId: string | null;
  onOpenPublish?: () => void;
  onReset?: () => void | Promise<void>;
}

export default function EditorHeader({
  operationActive, editingDisabled = false, operation, steps, sessionId, onOpenPublish, onReset,
}: Props) {
  const unavailable = operationActive || editingDisabled;

  return (
    <header className="flex h-[60px] min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:gap-3 sm:px-7">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3.5">
        <h1
          id="frametrail-editor-title"
          tabIndex={-1}
          className="shrink-0 text-base font-bold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          FrameTrail
        </h1>
        <span className="hidden size-[5px] shrink-0 rounded-full bg-brand sm:block" aria-hidden="true" />
        <span className="hidden shrink-0 text-[11px] font-semibold text-muted-foreground sm:block">
          編輯器
        </span>
        {operationActive && (
          <Badge variant="status" className="min-w-0">
            <span className="size-1.5 rounded-full bg-recording animate-pulse" />
            <span className="truncate">{operation === 'recapture' ? '補拍中' : '錄製中'}</span>
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
        {/* One control per action at every width: the icon always shows and the
            label appears from `sm` up. The `aria-label` carries the accessible
            name so the icon-only state below `sm` is never unlabelled. */}
        <Button
          variant="outline"
          title="回到作品庫"
          aria-label="作品庫"
          className="h-[36px] gap-[7px] rounded-md px-2.5 text-[13px] font-medium sm:px-[13px]"
          onClick={() => void openLibrary()}
        >
          <Library className="size-4" /><span className="hidden sm:inline">作品庫</span>
        </Button>
        <span className="hidden h-[22px] w-[1px] bg-border sm:block" aria-hidden="true" />
        <ResetButton hasSteps={steps.length > 0} sessionId={sessionId} disabled={unavailable} onReset={onReset} />
        <Button
          variant="default"
          aria-label="匯出"
          className="h-[36px] gap-[7px] rounded-md px-2.5 text-[13px] font-medium sm:px-[15px]"
          onClick={onOpenPublish}
          disabled={unavailable || steps.length === 0 || !onOpenPublish}
        >
          <Download className="size-3.5" /><span className="hidden sm:inline">匯出</span>
        </Button>
      </div>
    </header>
  );
}

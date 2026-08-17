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
        <Button
          variant="outline"
          title="回到作品庫"
          size="icon"
          aria-label="回到作品庫"
          className="size-9 sm:hidden"
          onClick={() => void openLibrary()}
        >
          <Library className="size-4" />
        </Button>
        <Button
          variant="outline"
          title="回到作品庫"
          className="hidden h-[36px] gap-[7px] rounded-md px-[13px] text-[13px] font-medium sm:inline-flex"
          onClick={() => void openLibrary()}
        >
          <Library className="size-4" />作品庫
        </Button>
        <span className="hidden h-[22px] w-[1px] bg-border sm:block" aria-hidden="true" />
        <div className="sm:hidden">
          <ResetButton compact hasSteps={steps.length > 0} sessionId={sessionId} disabled={unavailable} onReset={onReset} />
        </div>
        <div className="hidden sm:block">
          <ResetButton hasSteps={steps.length > 0} sessionId={sessionId} disabled={unavailable} onReset={onReset} />
        </div>
        <Button
          variant="default"
          size="icon"
          aria-label="匯出"
          className="size-9 sm:hidden"
          onClick={onOpenPublish}
          disabled={unavailable || steps.length === 0 || !onOpenPublish}
        >
          <Download className="size-3.5" />
        </Button>
        <Button
          variant="default"
          className="hidden h-[36px] gap-[7px] rounded-md px-[15px] text-[13px] font-medium sm:inline-flex"
          onClick={onOpenPublish}
          disabled={unavailable || steps.length === 0 || !onOpenPublish}
        >
          <Download className="size-3.5" />匯出
        </Button>
      </div>
    </header>
  );
}

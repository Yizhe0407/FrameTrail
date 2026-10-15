import { Download, Library } from 'lucide-react';
import ResetButton from '../shared/ResetButton';
import Mascot from '../shared/Mascot';
import { type Step } from '@/lib/storage/models';
import type { ActiveOperation } from '@/lib/storage/recording-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openLibrary } from '@/lib/runtime/actions';
import { t } from '@/lib/shared/i18n';

interface Props {
  operationActive: boolean;
  editingDisabled?: boolean;
  operation?: ActiveOperation;
  steps: Step[];
  sessionId: string | null;
  /** False when there is no guide to act on (a missing guide): only the way
   * back to the library stays, instead of a row of permanently disabled buttons. */
  guideActionsAvailable?: boolean;
  onOpenPublish?: () => void;
  onReset?: () => void | Promise<void>;
}

export default function EditorHeader({
  operationActive,
  editingDisabled = false,
  operation,
  steps,
  sessionId,
  guideActionsAvailable = true,
  onOpenPublish,
  onReset,
}: Props) {
  const unavailable = operationActive || editingDisabled;

  return (
    <header className="flex h-16 min-h-16 shrink-0 items-center gap-2 border-b-2 border-border bg-card px-3 sm:gap-3 sm:px-7">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
        <Mascot />
        <h1
          id="frametrail-editor-title"
          tabIndex={-1}
          className="shrink-0 rounded-sm text-base font-bold text-foreground outline-none focus-ring"
        >
          FrameTrail
        </h1>
        <span className="hidden shrink-0 rounded-full border-2 border-border bg-secondary px-2.5 py-0.5 text-xs font-bold text-foreground sm:inline-block">
          {t().common.editor}
        </span>
        {operationActive && (
          <Badge variant="status" className="min-w-0">
            <span className="size-1.5 rounded-full bg-recording animate-pulse" />
            <span className="truncate">{operation === 'recapture' ? t().common.recapturing : t().common.recording}</span>
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {/* Icon always shows; label appears from `sm` up. `aria-label` keeps the icon-only state accessible. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              aria-label={t().common.library}
              className="px-2.5 sm:px-3.5"
              onClick={() => void openLibrary()}
            >
              <Library /><span className="hidden sm:inline">{t().common.library}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t().editor.header.libraryTooltip}</TooltipContent>
        </Tooltip>
        {guideActionsAvailable && (
          <>
            <span className="hidden h-6 w-0.5 rounded-full bg-border-soft sm:block" aria-hidden="true" />
            <ResetButton hasSteps={steps.length > 0} sessionId={sessionId} disabled={unavailable} onReset={onReset} />
            <Button
              variant="default"
              aria-label={t().common.export}
              className="px-2.5 sm:px-4"
              onClick={onOpenPublish}
              disabled={unavailable || steps.length === 0 || !onOpenPublish}
            >
              <Download /><span className="hidden sm:inline">{t().common.export}</span>
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

import { Loader2, RotateCcw } from 'lucide-react';
import { reportError } from '@/components/shared/report-error';
import { resetSession } from '@/lib/runtime/actions';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';
import { useState, type ComponentProps } from 'react';
import ConfirmationDialog from './ConfirmationDialog';
import { t } from '@/lib/shared/i18n';

interface Props {
  hasSteps: boolean;
  sessionId: string | null;
  className?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  disabled?: boolean;
  onReset?: () => void | Promise<void>;
}

export default function ResetButton({
  hasSteps,
  sessionId,
  className,
  variant = 'ghost',
  disabled = false,
  onReset,
}: Props) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  async function handleReset() {
    setResetting(true);
    setResetError(null);
    try {
      if (!sessionId) throw new Error(t().reset.noTarget);
      await resetSession(sessionId);
      await onReset?.();
      setConfirmationOpen(false);
    } catch (err) {
      // The background reports actionable reasons (for example a reset refused
      // mid-recording); surface them instead of flattening to a generic retry.
      const reason = reportError('[frametrail] failed to reset recording', err, '');
      setResetError(reason ? t().reset.failedWithReason(reason) : t().reset.failed);
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={variant}
              onClick={() => {
                setResetError(null);
                setConfirmationOpen(true);
              }}
              disabled={!hasSteps || !sessionId || disabled || resetting}
              aria-label={resetting ? t().reset.pendingLabel : t().reset.actionLabel}
              className={cn(
                'hover:bg-danger-soft hover:text-danger',
                variant === 'outline' && 'hover:border-recording',
                className,
              )}
            >
              {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              <span>{resetting ? t().reset.pending : t().reset.label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{disabled ? t().reset.disabledTooltip : t().reset.actionLabel}</TooltipContent>
        </Tooltip>
      </div>
      <ConfirmationDialog
        open={confirmationOpen}
        title={t().reset.dialogTitle}
        description={t().reset.dialogDescription}
        confirmLabel={t().reset.label}
        pending={resetting}
        // Failure keeps the dialog open for a retry, so the message must live
        // inside the modal; anything rendered behind it is aria-hidden.
        error={resetError}
        onOpenChange={(open) => {
          setConfirmationOpen(open);
          if (!open) setResetError(null);
        }}
        onConfirm={handleReset}
      />
    </>
  );
}

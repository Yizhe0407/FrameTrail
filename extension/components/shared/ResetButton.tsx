import { Loader2, RotateCcw } from 'lucide-react';
import { reportError } from '@/components/shared/report-error';
import { resetSession } from '@/lib/runtime/actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shared/utils';
import { useState, type ComponentProps } from 'react';
import ConfirmationDialog from './ConfirmationDialog';

interface Props {
  hasSteps: boolean;
  sessionId: string | null;
  className?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  compact?: boolean;
  disabled?: boolean;
  onReset?: () => void | Promise<void>;
}

export default function ResetButton({
  hasSteps,
  sessionId,
  className,
  variant = 'ghost',
  compact = false,
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
      if (!sessionId) throw new Error('找不到要重置的教學。');
      await resetSession(sessionId);
      await onReset?.();
      setConfirmationOpen(false);
    } catch (err) {
      // The background reports actionable reasons (for example a reset refused
      // mid-recording); surface them instead of flattening to a generic retry.
      const reason = reportError('重置錄製失敗', err, '');
      setResetError(reason ? `重置失敗：${reason}` : '重置失敗，請再試一次。');
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button
          variant={variant}
          size={compact ? 'icon' : undefined}
          onClick={() => {
            setResetError(null);
            setConfirmationOpen(true);
          }}
          disabled={!hasSteps || !sessionId || disabled || resetting}
          aria-label={resetting ? '正在重置' : '重置目前錄製'}
          title={disabled ? '錄製或補拍期間無法重置' : '重置目前錄製'}
          className={cn(
            'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
            variant === 'outline' && 'hover:border-destructive/40',
            className,
          )}
        >
          {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          <span className={compact ? 'sr-only' : undefined}>{resetting ? '重置中' : '重置'}</span>
        </Button>
      </div>
      <ConfirmationDialog
        open={confirmationOpen}
        title="重置目前錄製？"
        description="所有步驟與標註都會永久刪除，這項操作無法復原。"
        confirmLabel="重置"
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

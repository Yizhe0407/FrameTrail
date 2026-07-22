import { Loader2, RotateCcw } from 'lucide-react';
import { resetSession } from '@/lib/actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useState, type ComponentProps } from 'react';
import ConfirmationDialog from './ConfirmationDialog';

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
      if (!sessionId) throw new Error('找不到要重置的教學。');
      await resetSession(sessionId);
      await onReset?.();
      setConfirmationOpen(false);
    } catch (err) {
      console.error('重置錄製失敗', err);
      setResetError('重置失敗，請再試一次。');
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button
          variant={variant}
          onClick={() => setConfirmationOpen(true)}
          disabled={!hasSteps || !sessionId || disabled || resetting}
          title={disabled ? '錄製或補拍期間無法重置' : '重置目前錄製'}
          className={cn(
            'text-stone-500 hover:bg-red-50 hover:text-red-700 dark:text-stone-400 dark:hover:bg-red-950/40 dark:hover:text-red-400',
            variant === 'outline' && 'border-stone-200 hover:border-red-200 dark:border-stone-700',
            className,
          )}
        >
          {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {resetting ? '重置中' : '重置'}
        </Button>
        {resetError && <span role="alert" className="text-xs text-red-600 dark:text-red-400">{resetError}</span>}
      </div>
      <ConfirmationDialog
        open={confirmationOpen}
        title="重置目前錄製？"
        description="所有步驟與標注都會永久刪除，這項操作無法復原。"
        confirmLabel="重置"
        pending={resetting}
        onOpenChange={setConfirmationOpen}
        onConfirm={handleReset}
      />
    </>
  );
}

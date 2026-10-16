import { useEffect, useRef } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { t } from '@/lib/shared/i18n';

interface Props {
  message: string;
  pending?: boolean;
  aboveMobileRail?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function UndoSnackbar({
  message,
  pending = false,
  aboveMobileRail = false,
  onUndo,
  onDismiss,
}: Props) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    // Auto-dismiss must not unmount the snackbar mid-restore; timer restarts once it settles.
    if (pending) return;
    const timer = setTimeout(() => dismissRef.current(), 5_000);
    return () => clearTimeout(timer);
  }, [message, pending]);

  return (
    <div
      role="status"
      className={`fixed right-4 bottom-4 z-50 flex min-h-12 max-w-[calc(100vw-32px)] items-center gap-2 rounded-full border-2 border-border bg-card py-1.5 pr-1.5 pl-4 text-sm font-bold text-foreground ${aboveMobileRail ? 'max-lg:bottom-36' : ''}`}
    >
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={pending}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border-2 border-border bg-selected px-3 font-bold text-on-accent outline-none transition-colors focus-ring hover:brightness-95 disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        {pending ? t().common.restoring : t().common.restore}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        aria-label={t().editor.undo.close}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground disabled:opacity-60"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';

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
    // While the restore runs, auto-dismiss must not unmount the snackbar mid
    // operation; the timer restarts from zero once the operation settles.
    if (pending) return;
    const timer = setTimeout(() => dismissRef.current(), 5_000);
    return () => clearTimeout(timer);
  }, [message, pending]);

  return (
    <div
      role="status"
      className={`fixed right-4 bottom-4 z-50 flex min-h-12 max-w-[calc(100vw-32px)] items-center gap-3 rounded-full bg-[var(--primary-raw)] px-4 py-2 text-sm text-[var(--primary-text-raw)] shadow-[var(--shadow-menu)] ${aboveMobileRail ? 'max-lg:bottom-36' : ''}`}
    >
      <span className="min-w-0 truncate" title={message}>{message}</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={pending}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2 font-semibold text-brand outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        {pending ? '還原中' : '還原'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        aria-label="關閉還原提示"
        className="flex size-8 items-center justify-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-60"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

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
    const timer = setTimeout(() => dismissRef.current(), 5_000);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div
      role="status"
      className={`fixed right-4 bottom-4 z-50 flex min-h-12 max-w-[calc(100vw-32px)] items-center gap-3 rounded-md border border-stone-700 bg-stone-900 px-4 py-2 text-sm text-stone-50 shadow-lg dark:border-stone-500 dark:bg-stone-100 dark:text-stone-900 ${aboveMobileRail ? 'max-lg:bottom-36' : ''}`}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={pending}
        className="inline-flex min-h-8 items-center gap-1.5 rounded px-2 font-semibold text-lime-300 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-60 dark:text-lime-700 dark:hover:bg-black/10"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        {pending ? '還原中' : '還原'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        aria-label="關閉還原提示"
        className="flex size-8 items-center justify-center rounded outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-60 dark:hover:bg-black/10"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

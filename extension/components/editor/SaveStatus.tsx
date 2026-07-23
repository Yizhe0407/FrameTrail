import { Check, Loader2, RotateCcw } from 'lucide-react';
import type { DescriptionSaveStatus } from '@/lib/editor/editor-autosave';

interface Props {
  status: DescriptionSaveStatus;
  error: string | null;
  onRetry: () => void;
  className?: string;
}

export default function SaveStatus({ status, error, onRetry, className = '' }: Props) {
  return (
    <div className={`flex min-h-[18px] items-center gap-1.5 text-xs ${className}`}>
      {status === 'saving' && <Loader2 className="size-3 animate-spin" />}
      {status === 'saved' && <Check className="size-3 text-lime-700 dark:text-lime-400" />}
      <span role={status === 'error' ? 'alert' : 'status'} aria-live="polite">
        {status === 'dirty' && '尚未儲存'}
        {status === 'saving' && '正在儲存'}
        {status === 'saved' && '已儲存'}
        {status === 'error' && (error ?? '無法儲存')}
      </span>
      {status === 'error' && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-6 items-center gap-1 rounded px-1.5 font-medium text-blue-700 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-blue-300 dark:hover:bg-blue-950/40"
        >
          <RotateCcw className="size-3" />
          重試
        </button>
      )}
    </div>
  );
}

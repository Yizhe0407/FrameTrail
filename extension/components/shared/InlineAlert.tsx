import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface Props {
  children: ReactNode;
  className?: string;
}

/**
 * Destructive inline alert for form/dialog error rows: the shared
 * icon-plus-message block announced to assistive tech via role="alert".
 * Spacing relative to surrounding content belongs to the caller (className).
 */
export default function InlineAlert({ children, className }: Props) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-[18px] text-destructive',
        className,
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

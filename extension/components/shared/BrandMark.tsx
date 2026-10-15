import { cn } from '@/lib/shared/utils';
import Mascot from './Mascot';

/** The mascot plus wordmark the popup opens with; full pages get the same
 * pairing from AppHeader's home crumb. */
export default function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <Mascot />
      <span className="shrink-0 text-base font-bold text-foreground">Stepmark</span>
    </span>
  );
}

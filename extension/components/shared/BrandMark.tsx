import { cn } from '@/lib/shared/utils';
import Mascot from './Mascot';

interface Props {
  /** Optional page name shown after the wordmark (作品庫, 編輯器 …). */
  page?: string;
  className?: string;
}

/** The mascot plus wordmark every surface opens with, so the header reads the same everywhere. */
export default function BrandMark({ page, className }: Props) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <Mascot />
      <span className="shrink-0 text-base font-bold text-foreground">FrameTrail</span>
      {page && (
        <span className="hidden shrink-0 rounded-full border-2 border-border bg-secondary px-2.5 py-0.5 text-xs font-bold text-foreground sm:inline-block">
          {page}
        </span>
      )}
    </span>
  );
}

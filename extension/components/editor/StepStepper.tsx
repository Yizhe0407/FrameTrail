import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

/** Floating pill control mirroring the step rail's prev/next navigation, for
 * quick single-step movement without reaching for the (possibly offscreen,
 * on mobile) rail. */
export default function StepStepper({ current, total, onPrev, onNext }: Props) {
  return (
    <div className="flex shrink-0 justify-center pt-4 pb-8 lg:pb-10">
      <div className="flex h-[42px] items-center gap-[4px] rounded-full border border-border/80 bg-card px-[6px] shadow-[0_6px_20px_-8px_rgba(28,28,28,0.16)] dark:border-white/10 dark:shadow-none">
        <button
          type="button"
          onClick={onPrev}
          disabled={current <= 1}
          aria-label="上一步"
          title="上一步"
          className="flex size-8 items-center justify-center rounded-md text-foreground/55 outline-none transition-colors hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-[6px] text-[13px] font-semibold tabular-nums text-foreground dark:text-white">
          {current} <span className="text-foreground/35 dark:text-white/35">/ {total}</span>
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={current >= total}
          aria-label="下一步"
          title="下一步"
          className="flex size-8 items-center justify-center rounded-md text-foreground/55 outline-none transition-colors hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

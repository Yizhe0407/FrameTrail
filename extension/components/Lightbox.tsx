import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import HighlightThumbnail from './HighlightThumbnail';
import type { Step } from '@/lib/db';

interface Props {
  steps: Step[];
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

/** Full-screen preview with prev/next (buttons + arrow keys) across all steps. */
export default function Lightbox({ steps, index, onClose, onNavigate }: Props) {
  const open = index !== null;
  const step = index !== null ? steps[index] : null;
  const hasPrev = index !== null && index > 0;
  const hasNext = index !== null && index < steps.length - 1;

  useEffect(() => {
    if (!open || index === null) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' && index! < steps.length - 1) onNavigate(index! + 1);
      if (e.key === 'ArrowLeft' && index! > 0) onNavigate(index! - 1);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, index, steps.length, onNavigate]);

  if (!step || index === null) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] border-none bg-transparent p-0 shadow-none">
        <HighlightThumbnail
          blob={step.screenshotBlob}
          bounds={step.bounds}
          screenshotScale={step.screenshotScale ?? step.devicePixelRatio}
          alt={`Step ${index + 1} 放大`}
          fit="contain"
          imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto rounded-lg"
        />

        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 left-4 z-50 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
          onClick={() => onNavigate(index - 1)}
          disabled={!hasPrev}
          aria-label="上一張"
        >
          <ChevronLeft className="size-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 right-4 z-50 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
          onClick={() => onNavigate(index + 1)}
          disabled={!hasNext}
          aria-label="下一張"
        >
          <ChevronRight className="size-6" />
        </Button>
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
          {index + 1} / {steps.length}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import { getOrderedAnnotations, type StepEntry } from '@/lib/db';

interface Props {
  entries: StepEntry[];
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

/** Full-screen preview with prev/next (buttons + arrow keys) across every
 * timeline entry — ordinary steps and single-image groups alike. */
export default function Lightbox({ entries, index, onClose, onNavigate }: Props) {
  const open = index !== null;
  const entry = index !== null ? entries[index] : null;
  const hasPrev = index !== null && index > 0;
  const hasNext = index !== null && index < entries.length - 1;

  useEffect(() => {
    if (!open || index === null) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' && index! < entries.length - 1) onNavigate(index! + 1);
      if (e.key === 'ArrowLeft' && index! > 0) onNavigate(index! - 1);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, index, entries.length, onNavigate]);

  if (!entry || index === null) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] border-none bg-transparent p-0 shadow-none">
        {entry.kind === 'single' ? (
          <HighlightThumbnail
            blob={entry.step.screenshotBlob}
            bounds={entry.step.bounds}
            screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
            alt={`Step ${index + 1} 放大`}
            fit="contain"
            imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto rounded-lg"
          />
        ) : (
          <MultiHighlightThumbnail
            blob={entry.anchor.screenshotBlob}
            annotations={getOrderedAnnotations(entry.annotations)}
            screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
            numbered={entry.anchor.numbered ?? false}
            alt={`Step ${index + 1} 放大`}
            fit="contain"
            imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto rounded-lg"
          />
        )}

        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 left-4 z-50 size-11 -translate-y-1/2 rounded-full bg-black/50 text-white shadow-lg hover:bg-black/70 hover:text-white disabled:opacity-30"
          onClick={() => onNavigate(index - 1)}
          disabled={!hasPrev}
          aria-label="上一張"
        >
          <ChevronLeft className="size-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 right-4 z-50 size-11 -translate-y-1/2 rounded-full bg-black/50 text-white shadow-lg hover:bg-black/70 hover:text-white disabled:opacity-30"
          onClick={() => onNavigate(index + 1)}
          disabled={!hasNext}
          aria-label="下一張"
        >
          <ChevronRight className="size-6" />
        </Button>
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/60 px-3.5 py-1.5 text-sm font-medium text-white tabular-nums shadow-lg">
          {index + 1} / {entries.length}
        </div>
      </DialogContent>
    </Dialog>
  );
}

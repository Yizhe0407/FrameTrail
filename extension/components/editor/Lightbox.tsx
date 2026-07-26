import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import EntryThumbnail from './EntryThumbnail';
import { PRIVACY_REVIEW_REQUIRED_HIDDEN } from '@/lib/editor/editor-messages';
import { getEntryPrivacyState, type StepEntry } from '@/lib/storage/db';

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
    const current = index;
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'ArrowRight' && current < entries.length - 1) {
        e.preventDefault();
        onNavigate(current + 1);
      }
      if (e.key === 'ArrowLeft' && current > 0) {
        e.preventDefault();
        onNavigate(current - 1);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, index, entries.length, onNavigate, onClose]);

  if (!entry || index === null) return null;
  const privacy = getEntryPrivacyState(entry);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showClose={false} className="fixed inset-0 z-50 flex max-h-none max-w-none translate-x-0 translate-y-0 items-center justify-center border-none bg-black/85 p-0 shadow-none backdrop-blur-md focus:outline-none">
        <DialogTitle className="sr-only">步驟 {index + 1} 圖片大圖預覽</DialogTitle>
        <DialogDescription className="sr-only">
          {privacy.reviewRequired
            ? PRIVACY_REVIEW_REQUIRED_HIDDEN
            : '使用左右方向鍵或畫面按鈕瀏覽其他步驟。'}
        </DialogDescription>

        <Button
          variant="ghost"
          size="icon"
          className="fixed top-2 right-2 z-50 size-[44px] rounded-full border border-white/20 bg-black/75 text-white shadow-xl backdrop-blur-md transition-all hover:bg-black/90 hover:scale-105 hover:text-white sm:top-6 sm:right-6"
          onClick={onClose}
          aria-label="關閉預覽"
        >
          <X className="size-6 stroke-[2.5]" />
        </Button>

        <div className="relative flex items-center justify-center">
          <EntryThumbnail
            entry={entry}
            alt={`步驟 ${index + 1} 放大`}
            fit="contain"
            className="max-w-full border-none shadow-none"
            imgClassName="max-h-[calc(100dvh-10rem)] max-w-[calc(100vw-7rem)] w-auto h-auto object-contain rounded-md border-none shadow-none sm:max-w-[calc(100vw-10rem)]"
          />
        </div>

        {privacy.reviewRequired && (
          <div
            role="alert"
            className="fixed top-1/2 left-1/2 z-50 max-w-[min(80vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-amber-300 bg-amber-50 px-5 py-3.5 text-center text-sm leading-6 text-amber-950 shadow-2xl dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            {PRIVACY_REVIEW_REQUIRED_HIDDEN}
          </div>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 left-2 z-50 size-[44px] -translate-y-1/2 rounded-full border border-white/10 bg-black/60 text-white shadow-xl backdrop-blur-md transition-all hover:bg-black/80 hover:scale-105 hover:text-white disabled:pointer-events-none disabled:opacity-20 sm:left-6"
          onClick={() => onNavigate(index - 1)}
          disabled={!hasPrev}
          aria-label="上一張"
        >
          <ChevronLeft className="size-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-1/2 right-2 z-50 size-[44px] -translate-y-1/2 rounded-full border border-white/10 bg-black/60 text-white shadow-xl backdrop-blur-md transition-all hover:bg-black/80 hover:scale-105 hover:text-white disabled:pointer-events-none disabled:opacity-20 sm:right-6"
          onClick={() => onNavigate(index + 1)}
          disabled={!hasNext}
          aria-label="下一張"
        >
          <ChevronRight className="size-6" />
        </Button>

        <div className="fixed bottom-6 left-1/2 z-50 flex h-[42px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-black/75 px-5 text-[13px] font-semibold tabular-nums text-white shadow-xl backdrop-blur-md">
          <span>{index + 1}</span>
          <span className="opacity-40">/ {entries.length}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

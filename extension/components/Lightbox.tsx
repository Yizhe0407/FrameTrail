import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import { getEffectiveBounds, getEntryPrivacyState, getOrderedAnnotations, type StepEntry } from '@/lib/db';

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
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'ArrowRight' && index! < entries.length - 1) {
        e.preventDefault();
        onNavigate(index! + 1);
      }
      if (e.key === 'ArrowLeft' && index! > 0) {
        e.preventDefault();
        onNavigate(index! - 1);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, index, entries.length, onNavigate]);

  if (!entry || index === null) return null;
  const privacy = getEntryPrivacyState(entry);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] border-none bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">步驟 {index + 1} 圖片預覽</DialogTitle>
        <DialogDescription className="sr-only">
          {privacy.reviewRequired
            ? '此圖片因敏感資訊遮罩尚未重新確認而被隱藏。請回到編輯畫面完成確認。'
            : '使用左右方向鍵或畫面按鈕瀏覽其他步驟。'}
        </DialogDescription>
        {entry.kind === 'single' ? (
          <HighlightThumbnail
            blob={entry.step.screenshotBlob}
            bounds={getEffectiveBounds(entry.step)}
            redactions={privacy.redactions}
            privacyReviewRequired={privacy.reviewRequired}
            screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
            alt={`Step ${index + 1} 放大`}
            fit="contain"
            className="rounded-lg"
            imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto"
          />
        ) : (
          <MultiHighlightThumbnail
            blob={entry.anchor.screenshotBlob}
            annotations={getOrderedAnnotations(entry.annotations)}
            redactions={privacy.redactions}
            privacyReviewRequired={privacy.reviewRequired}
            screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
            numbered={entry.anchor.numbered ?? false}
            alt={`Step ${index + 1} 放大`}
            fit="contain"
            className="rounded-lg"
            imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto"
          />
        )}

        {privacy.reviewRequired && (
          <div
            role="alert"
            className="fixed top-1/2 left-1/2 z-50 max-w-[min(80vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm leading-6 text-amber-950 shadow-lg dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            此圖片因敏感資訊遮罩尚未重新確認而暫時隱藏。請關閉預覽，開啟「調整圖片」確認後儲存。
          </div>
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

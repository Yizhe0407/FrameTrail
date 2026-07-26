import { ExternalLink, Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import type { RecapturePhase } from '@/lib/runtime/messages';

interface Props {
  open: boolean;
  phase: RecapturePhase;
  /** Surfaced inside the dialog because a modal aria-hides the page alert. */
  error?: string | null;
  onFocusSource: () => void;
  onCancel: () => void;
}

/**
 * Recapture takes over the source tab, so the editor cannot be edited until it
 * ends. A modal states that plainly and keeps the only two available exits —
 * return to the source tab, or cancel — in front of the user, instead of a
 * banner that scrolls out of reach on a long guide.
 */
export default function RecaptureProgressDialog({
  open,
  phase,
  error,
  onFocusSource,
  onCancel,
}: Props) {
  const capturing = phase === 'capturing';

  return (
    <Dialog open={open}>
      <DialogContent
        showClose={false}
        // The workflow owns the editor until the background reports a result;
        // dismissing the dialog would hide state the user cannot otherwise reach.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="w-[min(420px,calc(100vw-32px))] rounded-md border border-border bg-card p-6 text-foreground"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-brand" aria-hidden="true" />
            {capturing ? '正在擷取新的步驟圖片…' : '補拍進行中'}
          </DialogTitle>
          <DialogDescription className="leading-6 text-muted-foreground">
            {capturing
              ? '請稍候，擷取完成後會自動回到編輯器。'
              : '請到來源網頁選取要補拍的目標。完成前編輯器會維持鎖定，避免內容被覆蓋。'}
          </DialogDescription>
        </DialogHeader>

        {error && <InlineAlert className="mt-4">{error}</InlineAlert>}

        <DialogFooter className="mt-6">
          <Button type="button" variant="ghost" onClick={onCancel}>
            <X />取消補拍
          </Button>
          <Button type="button" variant="outline" onClick={onFocusSource}>
            <ExternalLink />回到補拍分頁
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

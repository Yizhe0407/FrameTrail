import { Loader2, ShieldCheck, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  /** Origin the browser prompt will name. Shown verbatim so the user can compare
   * it against the permission prompt Chrome raises next. */
  sourceOrigin: string;
  /** What the grant is for, e.g. 補拍 or 接續錄製. */
  actionLabel: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Granting a host permission is a security decision, so it gets a modal rather
 * than a banner: it states the exact origin, blocks the editor behind it, and
 * cannot scroll out of view while the browser's own prompt is about to appear.
 *
 * The confirm button must remain the direct source of the click that calls
 * browser.permissions.request — Chromium only honours the request while
 * transient user activation from that gesture is alive.
 */
export default function SourcePermissionDialog({
  open,
  sourceOrigin,
  actionLabel,
  pending = false,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onCancel(); }}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-border bg-card p-6 text-foreground"
      >
        <DialogHeader className="pr-2">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-brand" aria-hidden="true" />
            {actionLabel}前需要存取來源網站
          </DialogTitle>
          <DialogDescription className="leading-6 text-muted-foreground">
            FrameTrail 只會要求這個網站的存取權，且會在開始前由背景程序再次核對目前儲存的來源。
          </DialogDescription>
        </DialogHeader>

        <p className="mt-4 rounded-md border border-border bg-secondary px-3 py-2.5 font-mono text-xs break-all text-foreground">
          {sourceOrigin}
        </p>

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            <X />取消
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="animate-spin" />}
            {pending ? '正在授權…' : '允許並開始'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

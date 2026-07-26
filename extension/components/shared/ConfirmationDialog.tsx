import { AlertCircle, Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  pendingLabel?: string;
  confirmVariant?: ComponentProps<typeof Button>['variant'];
  /**
   * Failure feedback rendered inside the dialog. The modal overlay aria-hides
   * the rest of the page, so a failed confirm that keeps the dialog open must
   * report here rather than through a page-level alert behind it.
   */
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export default function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  pendingLabel = '處理中',
  confirmVariant = 'destructive',
  error = null,
  onOpenChange,
  onConfirm,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        className="w-[min(420px,calc(100vw-32px))] rounded-md border border-border bg-card p-6 text-foreground"
      >
        <DialogHeader className="pr-10">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-6 text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-[18px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        )}
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant={confirmVariant} disabled={pending} onClick={() => void onConfirm()}>
            {pending && <Loader2 className="animate-spin" />}
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

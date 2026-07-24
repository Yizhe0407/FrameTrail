import { Loader2 } from 'lucide-react';
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
  onOpenChange,
  onConfirm,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        className="w-[min(420px,calc(100vw-32px))] border border-stone-200 bg-white p-6 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-6 text-stone-500 dark:text-stone-400">
            {description}
          </DialogDescription>
        </DialogHeader>
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

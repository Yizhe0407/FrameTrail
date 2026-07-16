import { RotateCcw } from 'lucide-react';
import { resetSession } from '@/lib/actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  hasSteps: boolean;
  className?: string;
}

export default function ResetButton({ hasSteps, className }: Props) {
  async function handleReset() {
    if (hasSteps && !confirm('重置後會清除目前所有步驟，且無法復原。確定要繼續嗎？')) return;
    await resetSession();
  }

  return (
    <Button
      variant="ghost"
      onClick={handleReset}
      className={cn('text-muted-foreground hover:bg-destructive/10 hover:text-destructive', className)}
    >
      <RotateCcw />
      重置
    </Button>
  );
}

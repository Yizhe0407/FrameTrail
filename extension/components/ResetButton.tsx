import { Trash2 } from 'lucide-react';
import { resetSession } from '@/lib/actions';
import { Button } from '@/components/ui/button';

interface Props {
  hasSteps: boolean;
  className?: string;
}

export default function ResetButton({ hasSteps, className }: Props) {
  async function handleReset() {
    if (hasSteps && !confirm('清除目前錄製的所有步驟？此動作無法復原。')) return;
    await resetSession();
  }

  return (
    <Button variant="outline" size="sm" onClick={handleReset} className={className}>
      <Trash2 />
      重置
    </Button>
  );
}

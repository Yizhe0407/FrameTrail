import { useState } from 'react';
import { Images, Loader2 } from 'lucide-react';
import { exportImagesAsZip } from '@/lib/export-images';
import { Button } from '@/components/ui/button';
import type { Step } from '@/lib/db';

interface Props {
  steps: Step[];
  className?: string;
}

export default function ExportImagesButton({ steps, className }: Props) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const busy = progress !== null;

  async function handleClick() {
    if (steps.length === 0 || busy) return;
    setProgress({ done: 0, total: steps.length });
    try {
      await exportImagesAsZip(steps, (done, total) => setProgress({ done, total }));
    } finally {
      setProgress(null);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={steps.length === 0 || busy} className={className}>
      {progress ? <Loader2 className="animate-spin" /> : <Images />}
      {progress ? `${Math.round((progress.done / progress.total) * 100)}%` : '匯出圖片'}
    </Button>
  );
}

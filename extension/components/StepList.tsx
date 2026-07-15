import { useState } from 'react';
import { ChevronDown, ChevronUp, MousePointerClick } from 'lucide-react';
import { buildStepEntries, flattenEntries, reorderSteps, type Step, type StepEntry } from '@/lib/db';
import { Button } from '@/components/ui/button';
import StepItem from './StepItem';
import StepGroupBlock from './StepGroupBlock';
import Lightbox from './Lightbox';

interface Props {
  steps: Step[];
  sessionId: string | null;
  onChange: () => void;
  large?: boolean;
}

export default function StepList({ steps, sessionId, onChange, large = false }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  const entries = buildStepEntries(steps);
  // Zoom/lightbox only navigates ordinary steps — a group's combined image has
  // its own self-contained zoom dialog (see StepGroupBlock), so mixing the two
  // into one prev/next sequence isn't worth the complexity.
  const singleSteps = entries.flatMap((e) => (e.kind === 'single' ? [e.step] : []));

  async function persistEntries(newEntries: StepEntry[]) {
    if (!sessionId) return;
    await reorderSteps(sessionId, flattenEntries(newEntries));
    onChange();
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const reordered = [...entries];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    setDragIndex(null);
    void persistEntries(reordered);
  }

  function moveEntry(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= entries.length) return;
    const reordered = [...entries];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    void persistEntries(reordered);
  }

  function reorderGroupAnnotations(anchorId: string, reorderedAnnotations: Step[]) {
    const newEntries = entries.map((e) => (e.kind === 'group' && e.anchor.id === anchorId ? { ...e, annotations: reorderedAnnotations } : e));
    void persistEntries(newEntries);
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
        <MousePointerClick className="text-muted-foreground size-8" />
        <p className="text-muted-foreground text-sm">尚未錄製任何步驟。點「開始錄製」後在頁面上點擊，步驟會顯示在這裡。</p>
      </div>
    );
  }

  if (large) {
    return (
      <>
        <ul className="space-y-6">
          {entries.map((entry, index) => (
            <li
              key={entry.kind === 'single' ? entry.step.id : entry.anchor.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
            >
              {entry.kind === 'single' ? (
                <StepItem
                  step={entry.step}
                  index={index}
                  onChange={onChange}
                  large
                  onMoveUp={() => moveEntry(index, -1)}
                  onMoveDown={() => moveEntry(index, 1)}
                  canMoveUp={index > 0}
                  canMoveDown={index < entries.length - 1}
                  onZoom={() => setZoomIndex(singleSteps.indexOf(entry.step))}
                />
              ) : (
                <StepGroupBlock
                  anchor={entry.anchor}
                  annotations={entry.annotations}
                  index={index}
                  onChange={onChange}
                  onReorderAnnotations={(reordered) => reorderGroupAnnotations(entry.anchor.id, reordered)}
                />
              )}
            </li>
          ))}
        </ul>
        <Lightbox steps={singleSteps} index={zoomIndex} onClose={() => setZoomIndex(null)} onNavigate={setZoomIndex} />
      </>
    );
  }

  return (
    <ul className="divide-y">
      {entries.map((entry, index) => (
        <li
          key={entry.kind === 'single' ? entry.step.id : entry.anchor.id}
          draggable
          onDragStart={() => setDragIndex(index)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(index)}
          className="flex items-start gap-1"
        >
          <div className="flex flex-col gap-0.5 shrink-0">
            <Button variant="outline" size="icon" onClick={() => moveEntry(index, -1)} disabled={index === 0} aria-label="上移">
              <ChevronUp />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => moveEntry(index, 1)}
              disabled={index === entries.length - 1}
              aria-label="下移"
            >
              <ChevronDown />
            </Button>
          </div>
          <div className="flex-1">
            {entry.kind === 'single' ? (
              <StepItem step={entry.step} index={index} onChange={onChange} />
            ) : (
              <StepGroupBlock
                anchor={entry.anchor}
                annotations={entry.annotations}
                index={index}
                onChange={onChange}
                onReorderAnnotations={(reordered) => reorderGroupAnnotations(entry.anchor.id, reordered)}
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

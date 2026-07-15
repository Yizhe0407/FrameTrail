import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { updateStep, type Step } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';
import StepItem from './StepItem';

interface Props {
  anchor: Step;
  annotations: Step[];
  /** Position in the overall (mixed) step timeline — drives the outer "Step N" badge. */
  index: number;
  onChange: () => void;
  /** Bubbles a locally-reordered annotations array up so the parent can
   * persist it against the *complete* session step list (reordering only
   * this group's own subset would collide with other entries' order values —
   * see reorderSteps' contract). */
  onReorderAnnotations: (reordered: Step[]) => void;
}

/**
 * Single-image mode entry: one combined screenshot with every click's box
 * (and, if numbered, its order badge) drawn on top, plus an editable,
 * reorderable list of the per-click descriptions underneath. The anchor step
 * (shared screenshot owner) is never itself shown as an editable row.
 */
export default function StepGroupBlock({ anchor, annotations, index, onChange, onReorderAnnotations }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const numbered = anchor.numbered ?? false;

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const reordered = [...annotations];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    setDragIndex(null);
    onReorderAnnotations(reordered);
  }

  function moveAnnotation(annotationIndex: number, direction: -1 | 1) {
    const targetIndex = annotationIndex + direction;
    if (targetIndex < 0 || targetIndex >= annotations.length) return;
    const reordered = [...annotations];
    [reordered[annotationIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[annotationIndex]];
    onReorderAnnotations(reordered);
  }

  async function toggleNumbered() {
    const next = !numbered;
    await Promise.all([anchor, ...annotations].map((s) => updateStep(s.id, { numbered: next })));
    onChange();
  }

  const boxAnnotations = annotations.map((s, i) => ({ bounds: s.bounds!, order: i + 1 }));

  return (
    <Card className="overflow-hidden py-0 gap-0">
      <div className="relative bg-muted">
        <Badge className="absolute top-3 left-3 z-10 size-8 justify-center rounded-full p-0 text-sm shadow">
          {index + 1}
        </Badge>
        <label className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-xs shadow backdrop-blur">
          <input type="checkbox" checked={numbered} onChange={toggleNumbered} />
          標記順序編號
        </label>
        <button type="button" onClick={() => setZoomOpen(true)} className="block w-full cursor-zoom-in" aria-label="放大圖片">
          <MultiHighlightThumbnail
            blob={anchor.screenshotBlob}
            annotations={boxAnnotations}
            screenshotScale={anchor.screenshotScale ?? anchor.devicePixelRatio}
            numbered={numbered}
            alt={`Step ${index + 1}（單張圖模式）`}
            fit="contain"
            className="w-full"
          />
        </button>
      </div>

      {annotations.length > 0 && (
        <ul className="divide-y">
          {annotations.map((step, i) => (
            <li
              key={step.id}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(i)}
              className="flex items-start gap-1 px-2"
            >
              <div className="flex shrink-0 flex-col gap-0.5 py-3">
                <Button variant="ghost" size="icon" onClick={() => moveAnnotation(i, -1)} disabled={i === 0} aria-label="上移">
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => moveAnnotation(i, 1)}
                  disabled={i === annotations.length - 1}
                  aria-label="下移"
                >
                  <ChevronDown />
                </Button>
              </div>
              <div className="flex-1">
                <StepItem step={step} index={i} onChange={onChange} thumbnail={false} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] border-none bg-transparent p-0 shadow-none">
          <MultiHighlightThumbnail
            blob={anchor.screenshotBlob}
            annotations={boxAnnotations}
            screenshotScale={anchor.screenshotScale ?? anchor.devicePixelRatio}
            numbered={numbered}
            alt={`Step ${index + 1} 放大`}
            fit="contain"
            imgClassName="max-w-[95vw] max-h-[95vh] w-auto h-auto rounded-lg"
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

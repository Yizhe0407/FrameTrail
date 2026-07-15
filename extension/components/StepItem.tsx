import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { updateStep, deleteStep, type Step } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import HighlightThumbnail from './HighlightThumbnail';

interface Props {
  step: Step;
  index: number;
  onChange: () => void;
  large?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onZoom?: () => void;
  /** false hides the per-step thumbnail — used in single-image mode, where the
   * combined image is already shown once above the annotation list. */
  thumbnail?: boolean;
}

export default function StepItem({
  step,
  index,
  onChange,
  large = false,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
  onZoom,
  thumbnail = true,
}: Props) {
  const [description, setDescription] = useState(step.description);

  useEffect(() => {
    setDescription(step.description);
  }, [step.description]);

  async function saveDescription() {
    if (description !== step.description) {
      await updateStep(step.id, { description });
      onChange();
    }
  }

  async function handleDelete() {
    await deleteStep(step.id);
    onChange();
  }

  if (large) {
    return (
      <Card className="overflow-hidden py-0 gap-0 transition-shadow hover:shadow-md">
        <div className="relative bg-muted">
          <Badge className="absolute top-3 left-3 z-10 size-8 justify-center rounded-full p-0 text-sm shadow">
            {index + 1}
          </Badge>
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-md bg-background/90 p-0.5 shadow backdrop-blur">
            <Button variant="ghost" size="icon" onClick={onMoveUp} disabled={!canMoveUp} aria-label="上移">
              <ChevronUp />
            </Button>
            <Button variant="ghost" size="icon" onClick={onMoveDown} disabled={!canMoveDown} aria-label="下移">
              <ChevronDown />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDelete} aria-label="刪除">
              <Trash2 className="text-destructive" />
            </Button>
          </div>
          {thumbnail && (
            <button type="button" onClick={onZoom} className="block w-full cursor-zoom-in" aria-label="放大圖片">
              <HighlightThumbnail
                blob={step.screenshotBlob}
                bounds={step.bounds}
                screenshotScale={step.screenshotScale ?? step.devicePixelRatio}
                alt={`Step ${index + 1}`}
                fit="contain"
                className="w-full"
              />
            </button>
          )}
        </div>
        <CardContent>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveDescription}
            className="min-h-14 resize-none border-none px-0 shadow-none text-base focus-visible:ring-0"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex items-start gap-3 py-3">
      <Badge variant="secondary" className="mt-1 tabular-nums">
        {index + 1}
      </Badge>
      {thumbnail && (
        <HighlightThumbnail
          blob={step.screenshotBlob}
          bounds={step.bounds}
          screenshotScale={step.screenshotScale ?? step.devicePixelRatio}
          alt={`Step ${index + 1}`}
          className="w-[96px] h-[64px] shrink-0 overflow-hidden rounded-md border"
        />
      )}
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={saveDescription}
        className="min-h-12 text-xs"
      />
      <Button variant="ghost" size="icon" onClick={handleDelete} aria-label="刪除">
        <Trash2 className="text-muted-foreground" />
      </Button>
    </div>
  );
}

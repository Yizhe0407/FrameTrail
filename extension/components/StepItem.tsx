import { useEffect, useState, type ReactNode } from 'react';
import { Trash2, ZoomIn } from 'lucide-react';
import { updateStep, deleteStep, type Step } from '@/lib/db';
import { HIGHLIGHT_COLOR } from '@/lib/annotate';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import HighlightThumbnail from './HighlightThumbnail';

interface Props {
  step: Step;
  index: number;
  onChange: () => void;
  onZoom?: () => void;
  /** Ready-made drag handle from SortableItem — placed in the card's
   * right-side control column, vertically centered. */
  dragHandle: ReactNode;
  /** false hides the per-step thumbnail and switches to a compact row layout
   * — used for a group's annotation list, where the combined image is
   * already shown once above. */
  thumbnail?: boolean;
  /** Renders the number chip in the highlight red so an annotation row maps
   * visually to the matching red badge drawn on the snapshot image. */
  accent?: boolean;
}

const TEXTAREA_CLASS =
  'hover:border-input focus-visible:border-ring resize-none border-transparent bg-transparent px-2 shadow-none transition-colors';

export default function StepItem({ step, index, onChange, onZoom, dragHandle, thumbnail = true, accent = false }: Props) {
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

  if (thumbnail) {
    return (
      <Card className="group flex-row items-stretch gap-0 overflow-hidden py-0 transition-shadow hover:shadow-md">
        <div className="bg-muted relative w-1/2 shrink-0">
          <Badge className="absolute top-3 left-3 z-10 size-7 justify-center rounded-full p-0 text-xs font-semibold tabular-nums shadow-md">
            {index + 1}
          </Badge>
          <button type="button" onClick={onZoom} className="block h-full w-full cursor-zoom-in" aria-label="放大圖片">
            <HighlightThumbnail
              blob={step.screenshotBlob}
              bounds={step.bounds}
              screenshotScale={step.screenshotScale ?? step.devicePixelRatio}
              alt={`步驟 ${index + 1}`}
              fit="contain"
              imgClassName="block h-full w-full"
              className="h-full w-full"
            />
            <span className="bg-background/90 pointer-events-none absolute right-3 bottom-3 z-10 flex items-center gap-1 rounded-md px-2 py-1 text-xs opacity-0 shadow backdrop-blur transition-opacity group-hover:opacity-100">
              <ZoomIn className="size-3.5" />
              放大
            </span>
          </button>
        </div>
        <div className="relative min-w-0 flex-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            aria-label="刪除步驟"
            className="absolute top-2 right-10 z-10 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Trash2 className="text-destructive" />
          </Button>
          <div className="absolute top-1/2 right-2 z-10 -translate-y-1/2">{dragHandle}</div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveDescription}
            placeholder="輸入步驟說明…"
            className={`${TEXTAREA_CLASS} min-h-[120px] py-3 pr-11 pl-3 text-sm`}
          />
        </div>
      </Card>
    );
  }

  return (
    <div className="group flex items-start gap-2 py-2">
      {accent ? (
        <span
          className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums text-white"
          style={{ backgroundColor: HIGHLIGHT_COLOR }}
        >
          {index + 1}
        </span>
      ) : (
        <Badge variant="secondary" className="mt-1.5 tabular-nums">
          {index + 1}
        </Badge>
      )}
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={saveDescription}
        placeholder="輸入步驟說明…"
        className={`${TEXTAREA_CLASS} min-h-9 py-1.5 text-sm`}
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDelete}
          aria-label="刪除步驟"
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Trash2 className="text-muted-foreground" />
        </Button>
        {dragHandle}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { EyeOff, Pencil, Plus, Redo2, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react';
import {
  getEffectiveBounds,
  getEntryImageOwner,
  getEntryPrivacyState,
  StepUpdateConflictError,
  type Bounds,
  type Redaction,
  type Step,
  type StepEntry,
  type StepUpdate,
} from '@/lib/db';
import {
  boundsEqual,
  boundsFromPoints,
  clampBounds,
  moveBounds,
  resizeBounds,
  type ResizeHandle,
  type ViewportSize,
} from '@/lib/visual-editing';
import { useObjectUrl } from '@/lib/useObjectUrl';
import { getValidScreenshotScale } from '@/lib/image-utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import ConfirmationDialog from './ConfirmationDialog';

interface HighlightDraft {
  id: string;
  label: string;
  originalBounds: Bounds | null;
  bounds: Bounds | null;
  previousManualBounds: Bounds | null | undefined;
}

interface Draft {
  highlights: HighlightDraft[];
  redactions: Redaction[];
}

export interface VisualEditCommit {
  updates: StepUpdate[];
  restoreUpdates: StepUpdate[];
}

interface Props {
  entry: StepEntry;
  open: boolean;
  saving?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (commit: VisualEditCommit) => Promise<void>;
}

type Tool = 'highlight' | 'redaction';
type Selection = { kind: 'highlight' | 'redaction'; id: string } | null;
type Interaction =
  | { kind: 'draw'; tool: Tool; selection: NonNullable<Selection>; pointerId: number; start: { x: number; y: number }; baseline: Draft }
  | {
      kind: 'move' | 'resize';
      selection: NonNullable<Selection>;
      pointerId: number;
      start: { x: number; y: number };
      initial: Bounds;
      handle?: ResizeHandle;
      baseline: Draft;
    };

const HANDLES: Array<{ handle: ResizeHandle; x: 0 | 0.5 | 1; y: 0 | 0.5 | 1 }> = [
  { handle: 'nw', x: 0, y: 0 },
  { handle: 'n', x: 0.5, y: 0 },
  { handle: 'ne', x: 1, y: 0 },
  { handle: 'e', x: 1, y: 0.5 },
  { handle: 'se', x: 1, y: 1 },
  { handle: 's', x: 0.5, y: 1 },
  { handle: 'sw', x: 0, y: 1 },
  { handle: 'w', x: 0, y: 0.5 },
];

function cloneDraft(draft: Draft): Draft {
  return {
    highlights: draft.highlights.map((highlight) => ({
      ...highlight,
      originalBounds: highlight.originalBounds ? { ...highlight.originalBounds } : null,
      bounds: highlight.bounds ? { ...highlight.bounds } : null,
      previousManualBounds: highlight.previousManualBounds ? { ...highlight.previousManualBounds } : highlight.previousManualBounds,
    })),
    redactions: draft.redactions.map((redaction) => ({ ...redaction, bounds: { ...redaction.bounds } })),
  };
}

function createDraft(entry: StepEntry): Draft {
  const steps = entry.kind === 'single' ? [entry.step] : entry.annotations;
  return {
    highlights: steps.map((step, index) => ({
      id: step.id,
      label: entry.kind === 'single' ? '框選範圍' : `標註 ${index + 1}`,
      originalBounds: step.bounds ? { ...step.bounds } : null,
      bounds: getEffectiveBounds(step),
      previousManualBounds: step.manualBounds,
    })),
    redactions: getEntryPrivacyState(entry).redactions.map((redaction) => ({
      ...redaction,
      bounds: { ...redaction.bounds },
    })),
  };
}

function selectedBounds(draft: Draft, selection: Selection): Bounds | null {
  if (!selection) return null;
  if (selection.kind === 'highlight') {
    return draft.highlights.find((item) => item.id === selection.id)?.bounds ?? null;
  }
  return draft.redactions.find((item) => item.id === selection.id)?.bounds ?? null;
}

function setSelectedBounds(draft: Draft, selection: NonNullable<Selection>, bounds: Bounds): Draft {
  if (selection.kind === 'highlight') {
    return {
      ...draft,
      highlights: draft.highlights.map((item) => (item.id === selection.id ? { ...item, bounds } : item)),
    };
  }
  return {
    ...draft,
    redactions: draft.redactions.map((item) => (item.id === selection.id ? { ...item, bounds } : item)),
  };
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function VisualEditDialog({ entry, open, saving = false, onOpenChange, onSave }: Props) {
  const owner = getEntryImageOwner(entry);
  const privacy = getEntryPrivacyState(entry);
  const imageUrl = useObjectUrl(owner.screenshotBlob);
  const screenshotScale = getValidScreenshotScale(owner.screenshotScale ?? owner.devicePixelRatio);
  const initialDraft = useMemo(() => createDraft(entry), [entry]);
  const [baseline, setBaseline] = useState(initialDraft);
  const [draft, setDraft] = useState(initialDraft);
  const [past, setPast] = useState<Draft[]>([]);
  const [future, setFuture] = useState<Draft[]>([]);
  const [tool, setTool] = useState<Tool>('highlight');
  const [selection, setSelection] = useState<Selection>(() =>
    initialDraft.highlights[0] ? { kind: 'highlight', id: initialDraft.highlights[0].id } : null,
  );
  const [viewport, setViewport] = useState<ViewportSize | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const interactionRef = useRef<Interaction | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = createDraft(entry);
    setBaseline(next);
    setDraft(next);
    setPast([]);
    setFuture([]);
    setTool('highlight');
    setSelection(next.highlights[0] ? { kind: 'highlight', id: next.highlights[0].id } : null);
    setViewport(null);
    setImageReady(false);
    setError(null);
    setDiscardConfirmationOpen(false);
  }, [entry, open]);

  const dirty = !draftsEqual(draft, baseline) || privacy.reviewRequired;
  const activeBounds = selectedBounds(draft, selection);

  function pointFromEvent(event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } | null {
    if (!viewport) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(viewport.width, Math.max(0, ((event.clientX - rect.left) / rect.width) * viewport.width)),
      y: Math.min(viewport.height, Math.max(0, ((event.clientY - rect.top) / rect.height) * viewport.height)),
    };
  }

  function recordChange(next: Draft) {
    if (draftsEqual(draft, next)) return;
    setPast((history) => [...history.slice(-49), cloneDraft(draft)]);
    setDraft(next);
    setFuture([]);
  }

  function undo() {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((history) => history.slice(0, -1));
    setFuture((history) => [cloneDraft(draft), ...history].slice(0, 50));
    setDraft(previous);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((history) => history.slice(1));
    setPast((history) => [...history.slice(-49), cloneDraft(draft)]);
    setDraft(next);
  }

  function requestClose() {
    if (saving) return;
    if (dirty) {
      setDiscardConfirmationOpen(true);
      return;
    }
    onOpenChange(false);
  }

  function discardAndClose() {
    setDiscardConfirmationOpen(false);
    onOpenChange(false);
  }

  function beginDraw(event: ReactPointerEvent<SVGSVGElement>) {
    if (!viewport || saving) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const baselineDraft = cloneDraft(draft);
    let drawSelection: NonNullable<Selection>;
    if (tool === 'highlight') {
      const target =
        selection?.kind === 'highlight'
          ? selection
          : draft.highlights[0]
            ? ({ kind: 'highlight', id: draft.highlights[0].id } as const)
            : null;
      if (!target) return;
      drawSelection = target;
      setSelection(target);
      setDraft(setSelectedBounds(draft, target, clampBounds({ ...point, width: 4, height: 4 }, viewport)));
    } else {
      const id = crypto.randomUUID();
      const nextSelection = { kind: 'redaction', id } as const;
      drawSelection = nextSelection;
      setSelection(nextSelection);
      setDraft({
        ...draft,
        redactions: [...draft.redactions, { id, kind: 'solid', bounds: clampBounds({ ...point, width: 4, height: 4 }, viewport) }],
      });
    }
    interactionRef.current = { kind: 'draw', tool, selection: drawSelection!, pointerId: event.pointerId, start: point, baseline: baselineDraft };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginTransform(
    event: ReactPointerEvent<SVGElement>,
    nextSelection: NonNullable<Selection>,
    kind: 'move' | 'resize',
    handle?: ResizeHandle,
  ) {
    if (!viewport || saving) return;
    event.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * viewport.width,
      y: ((event.clientY - rect.top) / rect.height) * viewport.height,
    };
    const bounds = selectedBounds(draft, nextSelection);
    if (!bounds) return;
    setSelection(nextSelection);
    interactionRef.current = {
      kind,
      selection: nextSelection,
      pointerId: event.pointerId,
      start: point,
      initial: { ...bounds },
      handle,
      baseline: cloneDraft(draft),
    };
    svg.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || !viewport) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (interaction.kind === 'draw') {
      const bounds = boundsFromPoints(interaction.start, point, viewport);
      setDraft((current) => setSelectedBounds(current, interaction.selection, bounds));
      return;
    }
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const bounds =
      interaction.kind === 'move'
        ? moveBounds(interaction.initial, dx, dy, viewport)
        : resizeBounds(interaction.initial, interaction.handle!, dx, dy, viewport);
    setDraft((current) => setSelectedBounds(current, interaction.selection, bounds));
  }

  function endInteraction(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (!draftsEqual(interaction.baseline, draft)) {
      setPast((history) => [...history.slice(-49), interaction.baseline]);
      setFuture([]);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function updateGeometry(field: keyof Bounds, rawValue: string) {
    if (!selection || !activeBounds || !viewport) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    recordChange(setSelectedBounds(draft, selection, clampBounds({ ...activeBounds, [field]: value }, viewport)));
  }

  function deleteSelection() {
    if (!selection || selection.kind !== 'redaction') return;
    recordChange({ ...draft, redactions: draft.redactions.filter((redaction) => redaction.id !== selection.id) });
    setSelection(null);
  }

  function restoreAutomaticBounds() {
    if (!selection || selection.kind !== 'highlight' || !viewport) return;
    const highlight = draft.highlights.find((item) => item.id === selection.id);
    if (!highlight?.originalBounds) return;
    recordChange(setSelectedBounds(draft, selection, clampBounds(highlight.originalBounds, viewport)));
  }

  async function save() {
    if (!dirty || saving) return;
    setError(null);
    const ownerId = owner.id;
    const highlightUpdates = draft.highlights.map((highlight) => ({
      id: highlight.id,
      changes: {
        manualBounds: boundsEqual(highlight.bounds, highlight.originalBounds) ? null : highlight.bounds,
      } satisfies Partial<Step>,
    }));
    const restoreHighlights = baseline.highlights.map((highlight) => ({
      id: highlight.id,
      changes: { manualBounds: highlight.previousManualBounds ?? null } satisfies Partial<Step>,
    }));
    try {
      await onSave({
        updates: [
          ...highlightUpdates,
          {
            id: ownerId,
            expectedCaptureRevision: owner.captureRevision ?? 0,
            changes: { redactions: draft.redactions, redactionReviewRequired: false },
          },
        ],
        restoreUpdates: [
          ...restoreHighlights,
          {
            id: ownerId,
            expectedCaptureRevision: owner.captureRevision ?? 0,
            changes: {
              redactions: baseline.redactions,
              redactionReviewRequired: privacy.reviewRequired,
            },
          },
        ],
      });
    } catch (saveError) {
      setError(
        saveError instanceof StepUpdateConflictError
          ? '圖片已在其他操作中更新，請關閉後重新開啟以確認新圖片的遮罩。'
          : '儲存失敗。你的修改仍保留在這裡，請再試一次。',
      );
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (!selection || !activeBounds || !viewport) return;
    const delta = event.shiftKey ? 10 : 1;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const vector = movement[event.key];
    if (!vector) return;
    event.preventDefault();
    recordChange(setSelectedBounds(draft, selection, moveBounds(activeBounds, vector[0], vector[1], viewport)));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          requestClose();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="flex h-[min(94vh,900px)] w-[min(96vw,1320px)] max-w-none flex-col overflow-hidden border border-stone-300 bg-stone-50 p-0 dark:border-stone-700 dark:bg-stone-900"
      >
        <DialogHeader className="shrink-0 border-b border-stone-200 px-5 py-4 pr-12 dark:border-stone-700">
          <DialogTitle>修正框選與敏感資訊遮罩</DialogTitle>
          <DialogDescription>
            遮罩是可編輯圖層；原始截圖仍保留在此裝置，預覽、複製與匯出都會套用完全不透明色塊。原始框選也會保留，可隨時還原。
          </DialogDescription>
        </DialogHeader>
        {privacy.reviewRequired && (
          <div role="alert" className="shrink-0 border-b border-amber-300 bg-amber-50 px-5 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            補拍或資料驗證後需要重新確認遮罩；按下「確認並儲存」前，其他預覽、複製與匯出會維持隱私封鎖。
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <section className="flex min-h-[320px] min-w-0 flex-1 flex-col bg-stone-200/60 p-3 dark:bg-stone-950">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant={tool === 'highlight' ? 'default' : 'outline'} aria-pressed={tool === 'highlight'} onClick={() => setTool('highlight')}>
                <Pencil />調整框選
              </Button>
              <Button size="sm" variant={tool === 'redaction' ? 'default' : 'outline'} aria-pressed={tool === 'redaction'} onClick={() => setTool('redaction')}>
                <EyeOff />加入遮罩
              </Button>
              <span className="text-xs text-stone-500">在圖片上拖曳建立範圍；拖曳現有範圍可移動。</span>
              <div className="ml-auto flex gap-1">
                <Button size="icon" variant="outline" onClick={undo} disabled={past.length === 0} aria-label="復原">
                  <Undo2 />
                </Button>
                <Button size="icon" variant="outline" onClick={redo} disabled={future.length === 0} aria-label="重做">
                  <Redo2 />
                </Button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-stone-300 bg-stone-950 p-2 dark:border-stone-700">
              <div className="relative inline-block max-h-full max-w-full leading-none">
                <img
                  src={imageUrl}
                  alt="待編輯的步驟截圖"
                  draggable={false}
                  className={cn('block h-auto w-auto max-h-[calc(94vh-190px)] max-w-full select-none object-contain', !imageReady && 'invisible')}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    if (!image.naturalWidth || !image.naturalHeight) {
                      setError('無法讀取此截圖，請關閉後再試一次。');
                      return;
                    }
                    setViewport({
                      width: image.naturalWidth / screenshotScale,
                      height: image.naturalHeight / screenshotScale,
                    });
                    setImageReady(true);
                  }}
                  onError={() => setError('無法載入此截圖，請關閉後再試一次。')}
                />
                {viewport && (
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${viewport.width} ${viewport.height}`}
                    preserveAspectRatio="none"
                    className="absolute inset-0 size-full touch-none outline-none"
                    role="group"
                    aria-label="框選與遮罩畫布；方向鍵移動所選圖層，Shift 加速移動"
                    aria-keyshortcuts="Control+S Meta+S Control+Z Meta+Z Control+Y Meta+Y"
                    tabIndex={0}
                    onPointerDown={beginDraw}
                    onPointerMove={handlePointerMove}
                    onPointerUp={endInteraction}
                    onPointerCancel={endInteraction}
                    onKeyDown={handleKeyDown}
                  >
                    {draft.highlights.map((highlight) =>
                      highlight.bounds ? (
                        <EditableRect
                          key={`highlight-${highlight.id}`}
                          bounds={highlight.bounds}
                          selected={selection?.kind === 'highlight' && selection.id === highlight.id}
                          kind="highlight"
                          onSelect={(event, transform, handle) =>
                            beginTransform(event, { kind: 'highlight', id: highlight.id }, transform, handle)
                          }
                        />
                      ) : null,
                    )}
                    {draft.redactions.map((redaction) => (
                      <EditableRect
                        key={`redaction-${redaction.id}`}
                        bounds={redaction.bounds}
                        selected={selection?.kind === 'redaction' && selection.id === redaction.id}
                        kind="redaction"
                        onSelect={(event, transform, handle) =>
                          beginTransform(event, { kind: 'redaction', id: redaction.id }, transform, handle)
                        }
                      />
                    ))}
                  </svg>
                )}
              </div>
            </div>
          </section>

          <aside className="w-full shrink-0 overflow-y-auto border-t border-stone-200 bg-white p-4 lg:w-[330px] lg:border-t-0 lg:border-l dark:border-stone-700 dark:bg-stone-900">
            <h3 className="mb-2 text-sm font-semibold">圖層</h3>
            <div className="space-y-1">
              {draft.highlights.map((highlight) => (
                <button
                  key={highlight.id}
                  type="button"
                  aria-pressed={selection?.kind === 'highlight' && selection.id === highlight.id}
                  onClick={() => {
                    setTool('highlight');
                    setSelection({ kind: 'highlight', id: highlight.id });
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    selection?.kind === 'highlight' && selection.id === highlight.id
                      ? 'bg-stone-800 text-white dark:bg-stone-100 dark:text-stone-900'
                      : 'hover:bg-stone-100 dark:hover:bg-stone-800',
                  )}
                >
                  <Pencil className="size-4" /> {highlight.label}
                </button>
              ))}
              {draft.redactions.map((redaction, index) => (
                <button
                  key={redaction.id}
                  type="button"
                  aria-pressed={selection?.kind === 'redaction' && selection.id === redaction.id}
                  onClick={() => {
                    setTool('redaction');
                    setSelection({ kind: 'redaction', id: redaction.id });
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    selection?.kind === 'redaction' && selection.id === redaction.id
                      ? 'bg-stone-800 text-white dark:bg-stone-100 dark:text-stone-900'
                      : 'hover:bg-stone-100 dark:hover:bg-stone-800',
                  )}
                >
                  <EyeOff className="size-4" /> 遮罩 {index + 1}
                </button>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                onClick={() => {
                  setTool('redaction');
                  if (!viewport) return;
                  const id = crypto.randomUUID();
                  const bounds = clampBounds(
                    { x: viewport.width * 0.35, y: viewport.height * 0.4, width: viewport.width * 0.3, height: viewport.height * 0.12 },
                    viewport,
                  );
                  recordChange({ ...draft, redactions: [...draft.redactions, { id, kind: 'solid', bounds }] });
                  setSelection({ kind: 'redaction', id });
                }}
                disabled={!viewport}
              >
                <Plus />新增遮罩
              </Button>
            </div>

            {selection && activeBounds && (
              <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-700">
                <h3 className="mb-3 text-sm font-semibold">精確位置（CSS px）</h3>
                <div className="grid grid-cols-2 gap-3">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <label key={field} className="space-y-1 text-xs text-stone-500">
                      <span>{{ x: 'X', y: 'Y', width: '寬', height: '高' }[field]}</span>
                      <input
                        type="number"
                        step="0.25"
                        min={field === 'width' || field === 'height' ? 1 : 0}
                        value={activeBounds[field]}
                        onChange={(event) => updateGeometry(field, event.target.value)}
                        className="h-9 w-full rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus:ring-2 focus:ring-stone-500 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
                      />
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-stone-500">方向鍵移動 1 px；Shift + 方向鍵移動 10 px。</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selection.kind === 'highlight' ? (
                    <Button size="sm" variant="outline" onClick={restoreAutomaticBounds}>
                      <RotateCcw />還原自動框選
                    </Button>
                  ) : (
                    <Button size="sm" variant="destructive" onClick={deleteSelection}>
                      <Trash2 />刪除遮罩
                    </Button>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-stone-200 px-5 py-3 dark:border-stone-700">
          {error && <span role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">{error}</span>}
          <Button variant="outline" onClick={requestClose} disabled={saving}>取消</Button>
          <Button onClick={() => void save()} disabled={saving || !viewport || !dirty}>
            <Save />{saving ? '儲存中…' : privacy.reviewRequired ? '確認並儲存' : '儲存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmationDialog
        open={discardConfirmationOpen}
        title="捨棄未儲存的修改？"
        description="框選與敏感資訊遮罩的修改尚未儲存；離開後這些修改會遺失。"
        confirmLabel="捨棄修改"
        onOpenChange={setDiscardConfirmationOpen}
        onConfirm={discardAndClose}
      />
    </Dialog>
  );
}

function EditableRect({
  bounds,
  selected,
  kind,
  onSelect,
}: {
  bounds: Bounds;
  selected: boolean;
  kind: 'highlight' | 'redaction';
  onSelect: (
    event: ReactPointerEvent<SVGElement>,
    transform: 'move' | 'resize',
    handle?: ResizeHandle,
  ) => void;
}) {
  const color = kind === 'redaction' ? '#171717' : '#f43f5e';
  return (
    <g>
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill={kind === 'redaction' ? color : 'rgba(244,63,94,0.08)'}
        fillOpacity={1}
        stroke={selected ? '#84cc16' : color}
        strokeWidth={selected ? 3 : 2}
        vectorEffect="non-scaling-stroke"
        className="cursor-move"
        onPointerDown={(event) => onSelect(event, 'move')}
      />
      {selected &&
        HANDLES.map(({ handle, x, y }) => {
          const cx = bounds.x + bounds.width * x;
          const cy = bounds.y + bounds.height * y;
          return (
            <g key={handle} onPointerDown={(event) => onSelect(event, 'resize', handle)} className="cursor-pointer">
              <circle cx={cx} cy={cy} r={12} fill="transparent" vectorEffect="non-scaling-stroke" />
              <circle cx={cx} cy={cy} r={4} fill="#ffffff" stroke="#65a30d" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
    </g>
  );
}

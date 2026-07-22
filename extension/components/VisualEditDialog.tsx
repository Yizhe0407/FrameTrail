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
  const [tool, setTool] = useState<Tool>('redaction');
  const [selection, setSelection] = useState<Selection>(() =>
    initialDraft.redactions[0] ? { kind: 'redaction', id: initialDraft.redactions[0].id } : null,
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
    setTool('redaction');
    setSelection(next.redactions[0] ? { kind: 'redaction', id: next.redactions[0].id } : null);
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

  function addRedaction() {
    if (!viewport || saving) return;
    const id = crypto.randomUUID();
    const bounds = clampBounds(
      { x: viewport.width * 0.35, y: viewport.height * 0.4, width: viewport.width * 0.3, height: viewport.height * 0.12 },
      viewport,
    );
    recordChange({ ...draft, redactions: [...draft.redactions, { id, kind: 'solid', bounds }] });
    setTool('redaction');
    setSelection({ kind: 'redaction', id });
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

  const toolHint =
    tool === 'redaction'
      ? '拖曳要隱藏的資訊以新增遮罩；點選現有遮罩即可移動或調整大小。'
      : '拖曳圖片以重新設定框選範圍；點選框選後可移動或調整大小。';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          requestClose();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="flex h-[min(94vh,900px)] w-[min(96vw,1320px)] max-w-none flex-col overflow-hidden border border-stone-300 bg-stone-50 p-0 shadow-2xl dark:border-stone-700 dark:bg-stone-950"
      >
        <DialogHeader className="shrink-0 border-b border-stone-200 px-5 py-4 pr-12 dark:border-stone-800">
          <DialogTitle className="text-base font-semibold">編輯框選與遮罩</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            以框選標示操作位置，或以遮罩隱藏敏感資訊。
          </DialogDescription>
        </DialogHeader>
        {privacy.reviewRequired && (
          <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-sm text-amber-950 dark:border-amber-900/80 dark:bg-amber-950/30 dark:text-amber-100">
            截圖已更新，請確認遮罩仍涵蓋敏感資訊後再儲存。儲存前，預覽、複製與匯出會維持隱私保護。
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <section className="flex min-h-[340px] min-w-0 flex-1 flex-col bg-stone-100 p-3 sm:p-4 dark:bg-stone-950">
            <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1 rounded-lg border border-stone-200 bg-white p-1 shadow-sm dark:border-stone-800 dark:bg-stone-900" role="group" aria-label="編輯工具">
                <Button
                  size="sm"
                  variant={tool === 'highlight' ? 'default' : 'ghost'}
                  aria-pressed={tool === 'highlight'}
                  onClick={() => setTool('highlight')}
                  className="shrink-0"
                >
                  <Pencil />框選
                </Button>
                <Button
                  size="sm"
                  variant={tool === 'redaction' ? 'default' : 'ghost'}
                  aria-pressed={tool === 'redaction'}
                  onClick={() => setTool('redaction')}
                  className="shrink-0"
                >
                  <EyeOff />遮罩
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-1" aria-label="編輯紀錄">
                <Button size="icon" variant="ghost" onClick={undo} disabled={past.length === 0} aria-label="復原" title="復原（Ctrl/⌘ + Z）">
                  <Undo2 />
                </Button>
                <Button size="icon" variant="ghost" onClick={redo} disabled={future.length === 0} aria-label="重做" title="重做（Ctrl/⌘ + Shift + Z）">
                  <Redo2 />
                </Button>
              </div>
            </div>
            <p className="mb-3 px-1 text-sm text-stone-600 dark:text-stone-300" role="status" aria-live="polite">
              {toolHint}
            </p>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-xl border border-stone-200 bg-stone-900 p-4 shadow-inner dark:border-stone-800">
              <div className="relative inline-block max-h-full max-w-full overflow-visible leading-none">
                <img
                  src={imageUrl}
                  alt="待編輯的步驟截圖"
                  draggable={false}
                  className={cn('block h-auto w-auto max-h-[calc(94vh-224px)] max-w-full select-none object-contain', !imageReady && 'invisible')}
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
                    className="absolute inset-0 size-full touch-none overflow-visible outline-none"
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

          <aside className="w-full shrink-0 overflow-y-auto border-t border-stone-200 bg-white lg:w-[340px] lg:border-t-0 lg:border-l dark:border-stone-800 dark:bg-stone-950">
            <div className="border-b border-stone-200 p-4 dark:border-stone-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">圖層</h3>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">選擇要調整的框選或遮罩。</p>
                </div>
                <Button size="sm" onClick={addRedaction} disabled={!viewport || saving}>
                  <Plus />新增遮罩
                </Button>
              </div>
            </div>

            <div className="p-3" role="group" aria-label="圖層清單">
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
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-stone-500',
                      selection?.kind === 'highlight' && selection.id === highlight.id
                        ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950'
                        : 'border-transparent text-stone-700 hover:border-stone-200 hover:bg-stone-50 dark:text-stone-300 dark:hover:border-stone-800 dark:hover:bg-stone-900',
                    )}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-current/30"><Pencil className="size-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate">{highlight.label}</span>
                    <span className="text-xs opacity-65">框選</span>
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
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-stone-500',
                      selection?.kind === 'redaction' && selection.id === redaction.id
                        ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950'
                        : 'border-transparent text-stone-700 hover:border-stone-200 hover:bg-stone-50 dark:text-stone-300 dark:hover:border-stone-800 dark:hover:bg-stone-900',
                    )}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-slate-700 text-white"><EyeOff className="size-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate">遮罩 {index + 1}</span>
                    <span className="text-xs opacity-65">隱藏</span>
                  </button>
                ))}
                {draft.redactions.length === 0 && (
                  <div className="rounded-lg border border-dashed border-stone-300 px-3 py-3 text-sm text-stone-600 dark:border-stone-700 dark:text-stone-400">
                    <span className="block font-medium text-stone-800 dark:text-stone-200">還沒有遮罩</span>
                    <span className="mt-1 block text-xs">按上方「新增遮罩」，或選取遮罩工具後在圖片上拖曳。</span>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-stone-200 p-4 dark:border-stone-800">
              <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">所選項目</h3>
              {selection && activeBounds ? (
                <>
                  <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                    {selection.kind === 'redaction' ? '遮罩會在預覽、複製與匯出時完全遮住此區域。' : '此框選會標示使用者需要注意的操作位置。'}
                  </p>
                  <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">拖曳圖層可移動；拖曳圓點可調整大小。方向鍵可微調位置。</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selection.kind === 'highlight' ? (
                      <Button size="sm" variant="outline" onClick={restoreAutomaticBounds} disabled={!draft.highlights.find((item) => item.id === selection.id)?.originalBounds}>
                        <RotateCcw />還原原始框選
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={deleteSelection} className="text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300">
                        <Trash2 />刪除遮罩
                      </Button>
                    )}
                  </div>
                  <details className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-800">
                    <summary className="cursor-pointer text-sm text-stone-600 marker:text-stone-400 dark:text-stone-400">進階微調</summary>
                    <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">輸入圖片座標與大小（px）。</p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      {(['x', 'y', 'width', 'height'] as const).map((field) => (
                        <label key={field} className="space-y-1 text-xs text-stone-500 dark:text-stone-400">
                          <span>{{ x: 'X', y: 'Y', width: '寬', height: '高' }[field]}</span>
                          <input
                            type="number"
                            step="0.25"
                            min={field === 'width' || field === 'height' ? 1 : 0}
                            value={activeBounds[field]}
                            onChange={(event) => updateGeometry(field, event.target.value)}
                            className="h-9 w-full rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus:ring-2 focus:ring-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">從上方圖層選擇項目，或在圖片上建立新的遮罩。</p>
              )}
            </div>
          </aside>
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-stone-200 px-5 py-3 dark:border-stone-800">
          {error && <span role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">{error}</span>}
          <Button variant="ghost" onClick={requestClose} disabled={saving}>取消</Button>
          <Button onClick={() => void save()} disabled={saving || !viewport || !dirty}>
            <Save />{saving ? '儲存中…' : privacy.reviewRequired ? '確認並儲存' : '儲存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmationDialog
        open={discardConfirmationOpen}
        title="捨棄未儲存的修改？"
        description="框選與遮罩的修改尚未儲存；離開後這些修改會遺失。"
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
  const color = kind === 'redaction' ? '#334155' : '#d97706';
  const selectionColor = kind === 'redaction' ? '#f8fafc' : '#ffffff';
  return (
    <g>
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill={kind === 'redaction' ? color : 'rgba(217,119,6,0.10)'}
        fillOpacity={1}
        stroke={selected ? selectionColor : color}
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
              <circle cx={cx} cy={cy} r={11} fill="transparent" vectorEffect="non-scaling-stroke" />
              <circle cx={cx} cy={cy} r={4.5} fill="#ffffff" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
    </g>
  );
}

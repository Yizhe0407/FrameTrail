import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Bounds } from '@/lib/storage/models';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';
import {
  boundsFromPoints,
  clientToImagePoint,
  isUsableItemBounds,
  moveBounds,
  resizeBounds,
  RESIZE_HANDLES,
  type ImageCssSize,
  type Point,
  type ResizeHandle,
} from '@/lib/editor/image-edit-geometry';
import type { ImageEditItem, ImageEditItemKind } from '@/lib/editor/image-edit-items';
import { imageEditTool, type ImageEditToolId } from '@/lib/editor/image-edit-tools';

interface Props {
  items: readonly ImageEditItem[];
  tool: ImageEditToolId;
  /** The screenshot's size in CSS pixels — the coordinate space of every item. */
  size: ImageCssSize;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (kind: ImageEditItemKind, bounds: Bounds) => void;
  onUpdate: (id: string, bounds: Bounds) => void;
  onDelete: (id: string) => void;
  /** Dragging empty image with the pointer tool pans the workspace instead. */
  onPanStart?: (event: PointerEvent<HTMLElement>) => void;
  disabled?: boolean;
}

type Session =
  | { mode: 'create'; kind: ImageEditItemKind; origin: Point }
  | { mode: 'move'; id: string; origin: Point; start: Bounds }
  | { mode: 'resize'; id: string; handle: ResizeHandle; origin: Point; start: Bounds };

const HANDLE_POSITION: Record<ResizeHandle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  s: 'left-1/2 top-full -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  sw: 'left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

/** Pixels a keyboard nudge moves the selected item; Shift moves further. */
const NUDGE = 1;
const NUDGE_LARGE = 10;

function boxStyle(bounds: Bounds, size: ImageCssSize) {
  return {
    left: `${(bounds.x / size.width) * 100}%`,
    top: `${(bounds.y / size.height) * 100}%`,
    width: `${(bounds.width / size.width) * 100}%`,
    height: `${(bounds.height / size.height) * 100}%`,
  };
}

function itemLabel(item: ImageEditItem): string {
  return t().editor.imageEdit.itemLabel(item.kind);
}

/**
 * Interactive layer placed exactly over the screenshot. It owns pointer and
 * keyboard interaction for every item kind (create by dragging, select, move,
 * resize, nudge, delete) and reports finished gestures upward; it never
 * persists anything itself. While a gesture is in flight only an outline is
 * drawn here — the opaque masks underneath are the persisted ones, so source
 * pixels are never exposed by a half-applied preview.
 */
export default function ImageEditLayer({
  items,
  tool,
  size,
  selectedId,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onPanStart,
  disabled = false,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; bounds: Bounds } | null>(null);
  const creates = imageEditTool(tool).creates;

  function pointFromEvent(event: PointerEvent): Point {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return clientToImagePoint({ x: event.clientX, y: event.clientY }, rect, size);
  }

  function begin(event: PointerEvent, session: Session) {
    if (disabled || event.button !== 0) return;
    sessionRef.current = session;
    layerRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleLayerPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (creates === null) {
      onSelect(null);
      onPanStart?.(event);
      return;
    }
    onSelect(null);
    begin(event, { mode: 'create', kind: creates, origin: pointFromEvent(event) });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const session = sessionRef.current;
    if (!session) return;
    const point = pointFromEvent(event);
    if (session.mode === 'create') {
      setDraft({ id: null, bounds: boundsFromPoints(session.origin, point, size) });
    } else if (session.mode === 'move') {
      setDraft({
        id: session.id,
        bounds: moveBounds(session.start, point.x - session.origin.x, point.y - session.origin.y, size),
      });
    } else {
      setDraft({
        id: session.id,
        bounds: resizeBounds(session.start, session.handle, point.x - session.origin.x, point.y - session.origin.y, size),
      });
    }
  }

  function finish(commit: boolean) {
    const session = sessionRef.current;
    sessionRef.current = null;
    const result = draft;
    setDraft(null);
    if (!commit || !session || !result) return;
    if (session.mode === 'create') {
      if (isUsableItemBounds(result.bounds)) onCreate(session.kind, result.bounds);
    } else if (result.id) {
      onUpdate(result.id, result.bounds);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, item: ImageEditItem) {
    if (disabled) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDelete(item.id);
      return;
    }
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE;
    const delta: Record<string, Point | undefined> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    onUpdate(item.id, moveBounds(item.bounds, move.x, move.y, size));
  }

  return (
    <div
      ref={layerRef}
      data-stepmark-image-edit-layer
      className={cn(
        'pointer-events-auto absolute inset-0 touch-none select-none',
        disabled ? 'cursor-not-allowed' : creates ? 'cursor-crosshair' : 'cursor-default',
      )}
      onPointerDown={handleLayerPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
    >
      {items.map((item) => {
        const selected = item.id === selectedId;
        const bounds = draft?.id === item.id ? draft.bounds : item.bounds;
        return (
          <div
            key={item.id}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={itemLabel(item)}
            aria-pressed={selected}
            data-stepmark-edit-item={item.id}
            className={cn(
              'absolute box-border outline-none',
              selected ? 'border-2 border-focus' : 'border-2 border-dashed border-focus/70 hover:border-focus',
              !disabled && 'cursor-move',
            )}
            style={boxStyle(bounds, size)}
            onPointerDown={(event) => {
              if (disabled) return;
              onSelect(item.id);
              event.currentTarget.focus();
              begin(event, { mode: 'move', id: item.id, origin: pointFromEvent(event), start: item.bounds });
            }}
            onFocus={() => onSelect(item.id)}
            onKeyDown={(event) => handleKeyDown(event, item)}
          >
            {selected && !disabled && RESIZE_HANDLES.map((handle) => (
              <span
                key={handle}
                data-stepmark-edit-handle={handle}
                className={cn('absolute size-2.5 border-2 border-focus bg-card', HANDLE_POSITION[handle])}
                onPointerDown={(event) => begin(event, {
                  mode: 'resize',
                  id: item.id,
                  handle,
                  origin: pointFromEvent(event),
                  start: item.bounds,
                })}
              />
            ))}
          </div>
        );
      })}
      {draft && draft.id === null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute box-border border-2 border-dashed border-focus bg-black/40"
          style={boxStyle(draft.bounds, size)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import InlineAlert from '@/components/shared/InlineAlert';
import { Button } from '@/components/ui/button';
import { getEntryImageOwner, getEntryPrivacyState, type Bounds, type StepEntry } from '@/lib/storage/models';
import { itemsToRedactions, newImageEditItem, redactionsToItems, type ImageEditItemKind } from '@/lib/editor/image-edit-items';
import type { ImageEditToolId } from '@/lib/editor/image-edit-tools';
import { useImageEditSession } from '@/lib/editor/image-edit-session';
import { saveEntryRedactions } from '@/lib/editor/save-entry-redactions';
import { useImageCssSize } from '@/lib/editor/use-image-css-size';
import type { ImageCssSize } from '@/lib/editor/image-edit-geometry';
import {
  anchorAt,
  clampZoom,
  fitSize,
  MAX_ZOOM,
  MIN_ZOOM,
  scrollDeltaForAnchor,
  wheelZoomFactor,
  ZOOM_STEP,
  type ZoomAnchor,
} from '@/lib/editor/image-edit-viewport';
import { t } from '@/lib/shared/i18n';
import EntryThumbnail from './EntryThumbnail';
import ImageEditLayer from './ImageEditLayer';
import ImageEditToolbar from './ImageEditToolbar';

/** Breathing room kept around the fitted image so edge masks are easy to reach. */
const FIT_MARGIN = 24;

interface Props {
  entry: StepEntry;
  /** 1-based position of the entry, for the title. */
  number: number;
  /** Called once every change has been written. */
  onClose: () => void;
}

/**
 * Full-window image editor. The image is laid out at the fitted size times the
 * zoom inside a scrollable viewport, so scrolling pans, the wheel zooms around
 * the pointer, and outlines and handles keep their on-screen size at any zoom.
 * Edits live in a session draft (instant, with undo/redo) and are saved behind it.
 */
export default function ImageEditWorkspace({ entry, number, onClose }: Props) {
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const owner = getEntryImageOwner(entry);
  const [initialItems] = useState(() => redactionsToItems(getEntryPrivacyState(entry).redactions));
  const session = useImageEditSession({
    initialItems,
    persist: (items) => saveEntryRedactions(entryRef.current, itemsToRedactions(items)),
  });
  const draftRedactions = useMemo(() => itemsToRedactions(session.items), [session.items]);
  const imageSize = useImageCssSize(owner.screenshotBlob, owner.screenshotScale ?? owner.devicePixelRatio);

  const [tool, setTool] = useState<ImageEditToolId>('redact');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // --- viewport: fit, zoom, pan -------------------------------------------
  // The dialog content mounts through a portal after this component first renders,
  // so the elements are tracked as state: effects re-run when they actually exist.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<ImageCssSize | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const zoomRef = useRef(MIN_ZOOM);
  const anchorRef = useRef<ZoomAnchor | null>(null);

  // The fit is measured on a box that scrollbars cannot resize, otherwise the
  // scrollbar appearing would change the fit and with it the scrollbar.
  useLayoutEffect(() => {
    if (!frame) return undefined;
    const measure = () => setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  const fit = imageSize && frameSize ? fitSize(frameSize, imageSize, FIT_MARGIN) : null;

  const zoomTo = useCallback((nextZoom: number, client: { x: number; y: number } | null) => {
    const clamped = clampZoom(nextZoom);
    if (clamped === zoomRef.current) return;
    const canvas = canvasRef.current?.getBoundingClientRect();
    anchorRef.current = client && canvas ? anchorAt(client, canvas) : null;
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  const frameCenter = useCallback(() => {
    const rect = frame?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  }, [frame]);

  // After the zoom is laid out, scroll so the image point under the pointer stays under it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const canvas = canvasRef.current?.getBoundingClientRect();
    anchorRef.current = null;
    if (!anchor || !scroller || !canvas) return;
    const { dx, dy } = scrollDeltaForAnchor(anchor, canvas);
    scroller.scrollLeft += dx;
    scroller.scrollTop += dy;
  }, [zoom, scroller]);

  // Wheel zoom needs preventDefault, which React's passive wheel handler cannot do.
  useEffect(() => {
    if (!scroller) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode), { x: event.clientX, y: event.clientY });
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [scroller, zoomTo]);

  // Pan: middle button, Space + drag, or dragging empty space with the pointer tool.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);

  const startPan = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!scroller) return;
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.setPointerCapture(event.pointerId);
    setPanning(true);
  }, [scroller]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLButtonElement;
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // --- editing ----------------------------------------------------------------
  const { items, commit } = session;
  const createItem = (kind: ImageEditItemKind, bounds: Bounds) => {
    const item = newImageEditItem(kind, bounds);
    setSelectedId(item.id);
    commit([...items, item]);
  };
  const updateItem = (id: string, bounds: Bounds) => commit(items.map((item) => (item.id === id ? { ...item, bounds } : item)));
  const deleteItem = (id: string) => {
    setSelectedId(null);
    commit(items.filter((item) => item.id !== id));
  };

  const requestClose = async () => {
    if (closing) return;
    setClosing(true);
    try {
      await session.flush();
      onClose();
    } catch {
      // The failed save is reported in the header; the editor stays open with the draft intact.
    } finally {
      setClosing(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
    } else if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      session.redo();
    } else if (!modifier && (event.key === '+' || event.key === '=')) {
      zoomTo(zoomRef.current * ZOOM_STEP, frameCenter());
    } else if (!modifier && event.key === '-') {
      zoomTo(zoomRef.current / ZOOM_STEP, frameCenter());
    } else if (!modifier && event.key === '0') {
      zoomTo(MIN_ZOOM, frameCenter());
    }
  };

  const copy = t().editor.imageEdit;
  const canvasStyle = fit ? { width: fit.width * zoom, height: fit.height * zoom } : undefined;

  return (
    <Dialog open onOpenChange={(next) => !next && void requestClose()}>
      <DialogContent
        showClose={false}
        onKeyDown={handleKeyDown}
        // Land on the canvas, not on the first toolbar button (which would pop its tooltip over the title).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          scroller?.focus({ preventScroll: true });
        }}
        className="fixed inset-0 z-50 flex max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-none bg-background p-0 focus:outline-none"
      >
        <DialogTitle className="sr-only">{copy.title(number)}</DialogTitle>
        <DialogDescription className="sr-only">{copy.hints.navigate}</DialogDescription>

        <header className="flex shrink-0 flex-col gap-2 border-b-2 border-border-soft px-4 py-3 sm:px-6">
          <h2 className="text-base font-bold">{copy.title(number)}</h2>
          <ImageEditToolbar
            tool={tool}
            onToolChange={setTool}
            hasSelection={selectedId !== null}
            onDeleteSelected={() => selectedId && deleteItem(selectedId)}
            itemCount={items.length}
            canUndo={session.canUndo}
            canRedo={session.canRedo}
            onUndo={session.undo}
            onRedo={session.redo}
            zoom={zoom}
            canZoomIn={zoom < MAX_ZOOM}
            canZoomOut={zoom > MIN_ZOOM}
            onZoomIn={() => zoomTo(zoomRef.current * ZOOM_STEP, frameCenter())}
            onZoomOut={() => zoomTo(zoomRef.current / ZOOM_STEP, frameCenter())}
            onZoomFit={() => zoomTo(MIN_ZOOM, frameCenter())}
            saving={session.saving}
            onDone={() => void requestClose()}
            doneDisabled={closing}
          />
          {session.saveFailed && (
            <InlineAlert>
              <span className="flex flex-wrap items-center gap-3">
                {copy.saveFailed}
                <Button size="sm" variant="outline" onClick={() => void session.flush().catch(() => undefined)}>{copy.retry}</Button>
              </span>
            </InlineAlert>
          )}
        </header>

        <div ref={setFrame} className="relative min-h-0 flex-1">
          <div
            ref={setScroller}
            data-stepmark-edit-scroller=""
            className={`app-scrollbar absolute inset-0 overflow-auto outline-none ${panning ? 'cursor-grabbing' : spaceHeld ? 'cursor-grab' : ''}`}
            tabIndex={-1}
            onPointerDownCapture={(event) => {
              // Working on the canvas moves keyboard focus onto it (as in any editor), so
              // Space pans here instead of pressing whichever toolbar button was last used.
              event.currentTarget.focus({ preventScroll: true });
              if (event.button === 1 || (event.button === 0 && spaceHeld)) {
                event.preventDefault();
                event.stopPropagation();
                startPan(event);
              }
            }}
            onPointerMove={(event) => {
              const pan = panRef.current;
              if (!pan || !scroller || pan.pointerId !== event.pointerId) return;
              scroller.scrollLeft = pan.left - (event.clientX - pan.x);
              scroller.scrollTop = pan.top - (event.clientY - pan.y);
            }}
            onPointerUp={() => {
              panRef.current = null;
              setPanning(false);
            }}
            onPointerCancel={() => {
              panRef.current = null;
              setPanning(false);
            }}
          >
            <div className="flex min-h-full min-w-full">
              <div ref={canvasRef} className="relative m-auto shrink-0" style={canvasStyle}>
                {canvasStyle && (
                  <EntryThumbnail
                    entry={entry}
                    redactions={draftRedactions}
                    alt={copy.title(number)}
                    fit="contain"
                    exactBox
                    className="h-full w-full"
                    imgClassName="h-full w-full rounded-md object-contain outline-2 outline-border"
                    overlay={imageSize && (
                      <ImageEditLayer
                        items={items}
                        tool={tool}
                        size={imageSize}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onCreate={createItem}
                        onUpdate={updateItem}
                        onDelete={deleteItem}
                        onPanStart={startPan}
                      />
                    )}
                  />
                )}
                {(spaceHeld || panning) && <div className="absolute inset-0 z-30 cursor-[inherit]" aria-hidden="true" />}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import InlineAlert from "@/components/shared/InlineAlert";
import { Button } from "@/components/ui/button";
import {
  getEntryCrop,
  getEntryImageEdits,
  getEntryImageOwner,
  getEntryPrivacyState,
  type StepEntry,
} from "@/lib/storage/models";
import type { TextEdit } from "@/lib/storage/image-edit-model";
import {
  appendItem,
  CROP_ITEM_ID,
 
  reorderItem,
  splitItems,
  toItems,
  type ImageEditItem,
} from "@/lib/editor/image-edit-items";
import {
  isCopyable,
  PASTE_OFFSET,
  pasteItems,
} from "@/lib/editor/image-edit-clipboard";
import {
  applyStylePatch,
  DEFAULT_IMAGE_EDIT_STYLE,
  isStyledItem,
  STYLE_FIELDS,
  styleOfItem,
  type ImageEditStyle,
  type StylePatch,
} from "@/lib/editor/image-edit-style";
import { snapCrop } from "@/lib/editor/image-edit-crop";
import { fitTextHeight } from "@/lib/editor/image-edit-item-geometry";
import {
  imageEditTool,
  toolForShortcut,
  type ImageEditToolId,
} from "@/lib/editor/image-edit-tools";
import { useImageEditSession } from "@/lib/editor/image-edit-session";
import { saveEntryImageEdits } from "@/lib/editor/save-entry-image-edits";
import { useImageCssSize } from "@/lib/editor/use-image-css-size";
import type { ImageCssSize } from "@/lib/editor/image-edit-geometry";
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
} from "@/lib/editor/image-edit-viewport";
import { t } from "@/lib/shared/i18n";
import EntryThumbnail from "./EntryThumbnail";
import ImageEditLayer from "./ImageEditLayer";
import ImageEditStylePanel, {
  ImageEditCropPanel,
  ImageEditItemActions,
} from "./ImageEditStylePanel";
import ImageEditToolbar, { ImageEditHeaderActions } from "./ImageEditToolbar";

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
  const [initialItems] = useState(() =>
    toItems(
      getEntryPrivacyState(entry).redactions,
      getEntryImageEdits(entry),
      getEntryCrop(entry),
    ),
  );
  const session = useImageEditSession({
    initialItems,
    persist: (items) =>
      saveEntryImageEdits(entryRef.current, splitItems(items)),
  });
  const imageSize = useImageCssSize(
    owner.screenshotBlob,
    owner.screenshotScale ?? owner.devicePixelRatio,
  );

  const [tool, setTool] = useState<ImageEditToolId>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [style, setStyle] = useState<ImageEditStyle>(DEFAULT_IMAGE_EDIT_STYLE);
  /** What the gesture in progress would produce, so the image shows it live. */
  const [preview, setPreview] = useState<ImageEditItem | null>(null);
  /** The text being typed. `isNew` text exists only here until it has content. */
  const [editing, setEditing] = useState<{
    item: TextEdit;
    isNew: boolean;
  } | null>(null);

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
    const measure = () =>
      setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  const fit =
    imageSize && frameSize ? fitSize(frameSize, imageSize, FIT_MARGIN) : null;

  const zoomTo = useCallback(
    (nextZoom: number, client: { x: number; y: number } | null) => {
      const clamped = clampZoom(nextZoom);
      if (clamped === zoomRef.current) return;
      const canvas = canvasRef.current?.getBoundingClientRect();
      anchorRef.current = client && canvas ? anchorAt(client, canvas) : null;
      zoomRef.current = clamped;
      setZoom(clamped);
    },
    [],
  );

  const frameCenter = useCallback(() => {
    const rect = frame?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
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
      zoomTo(zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [scroller, zoomTo]);

  // Pan: middle button, Space + drag, or dragging empty space with the pointer tool.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const startPan = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!scroller) return;
      panRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
      };
      scroller.setPointerCapture(event.pointerId);
      setPanning(true);
    },
    [scroller],
  );

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLButtonElement ||
      target instanceof HTMLTextAreaElement;
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // --- editing ----------------------------------------------------------------
  const { items, commit } = session;
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const activeTool = imageEditTool(tool);

  /** What is on screen: the saved items, with the live gesture applied and the text being typed left to the editor. */
  const displayItems = useMemo(() => {
    let list: readonly ImageEditItem[] = items;
    if (editing && !editing.isNew)
      list = list.filter((item) => item.id !== editing.item.id);
    if (preview) {
      list = list.some((item) => item.id === preview.id)
        ? list.map((item) => (item.id === preview.id ? preview : item))
        : appendItem(list, preview);
    }
    return list;
  }, [items, preview, editing]);
  const shown = useMemo(() => splitItems(displayItems), [displayItems]);

  const screenshotScale = owner.screenshotScale ?? owner.devicePixelRatio;

  /** Picking a drawing tool means "draw something new": nothing stays selected, so the style
   * controls set how the next thing looks instead of restyling the last thing drawn. */
  const changeTool = (next: ImageEditToolId) => {
    setTool(next);
    if (imageEditTool(next).create) setSelectedId(null);
  };

  /** A crop is snapped to whole device pixels as it is stored, and disappears if it would cover the whole image. */
  const settle = (item: ImageEditItem): ImageEditItem | null => {
    if (item.kind !== "crop" || !imageSize) return item;
    const bounds = snapCrop(item.bounds, imageSize, screenshotScale);
    return bounds ? { ...item, bounds } : null;
  };
  const replaceItem = (next: ImageEditItem) => {
    const settled = settle(next);
    commit(
      settled
        ? items.map((item) => (item.id === settled.id ? settled : item))
        : items.filter((item) => item.id !== next.id),
    );
  };
  const deleteItem = (id: string) => {
    setSelectedId(null);
    commit(items.filter((item) => item.id !== id));
  };
  const createItem = (item: ImageEditItem) => {
    if (item.kind === "text") {
      setEditing({ item, isNew: true });
      return;
    }
    const settled = settle(item);
    if (!settled) return;
    setSelectedId(settled.kind === "crop" ? null : settled.id);
    commit(appendItem(items, settled));
  };
  const startTextEdit = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item?.kind !== "text") return;
    setSelectedId(id);
    setEditing({ item, isNew: false });
  };
  const finishTextEdit = (text: string | null) => {
    if (!editing) return;
    const { item, isNew } = editing;
    setEditing(null);
    if (text === null) return;
    // Trailing blank space is never wanted; an emptied text box is removed.
    const value = text.replace(/\s+$/u, "");
    if (value === "") {
      if (!isNew) deleteItem(item.id);
      return;
    }
    const next = fitTextHeight({ ...item, text: value });
    setSelectedId(next.id);
    commit(
      isNew
        ? appendItem(items, next)
        : items.map((candidate) =>
            candidate.id === next.id ? next : candidate,
          ),
    );
  };

  /** Changes what is selected (or being typed) and what is drawn next. The marker number belongs to one marker, so it is not remembered. */
  const applyStyle = (patch: StylePatch) => {
    const { number: _number, ...remembered } = patch;
    setStyle((current) => ({ ...current, ...remembered }));
    if (editing)
      setEditing({ ...editing, item: applyStylePatch(editing.item, patch) });
    else if (selectedItem && isStyledItem(selectedItem))
      replaceItem(applyStylePatch(selectedItem, patch));
  };

  /** Style controls follow the selection, or the active tool when nothing is selected. */
  const styleSource =
    editing?.item ??
    (selectedItem && isStyledItem(selectedItem) ? selectedItem : null);
  const styleFields = styleSource
    ? STYLE_FIELDS[styleSource.kind]
    : activeTool.styleFields;
  const shownStyle: ImageEditStyle = styleSource
    ? styleOfItem(styleSource, style)
    : style;
  const cropItem = items.find((item) => item.kind === "crop") ?? null;
  const cropPixels = cropItem
    ? {
        width: Math.round(cropItem.bounds.width * screenshotScale),
        height: Math.round(cropItem.bounds.height * screenshotScale),
      }
    : null;

  // --- clipboard and layer order -------------------------------------------
  const clipboardRef = useRef<{ items: ImageEditItem[]; pastes: number }>({
    items: [],
    pastes: 0,
  });
  const copySelection = () => {
    if (!selectedItem || !isCopyable(selectedItem)) return false;
    clipboardRef.current = { items: [selectedItem], pastes: 0 };
    return true;
  };
  const pasteClipboard = () => {
    const clipboard = clipboardRef.current;
    if (!imageSize || clipboard.items.length === 0) return;
    clipboard.pastes += 1;
    const { items: next, pasted } = pasteItems(
      items,
      clipboard.items,
      PASTE_OFFSET * clipboard.pastes,
      imageSize,
    );
    if (pasted.length === 0) return;
    commit(next);
    setSelectedId(pasted[pasted.length - 1].id);
    if (tool !== "select") setTool("select");
  };
  const duplicateSelection = () => {
    if (copySelection()) pasteClipboard();
  };
  const reorderSelection = (to: "front" | "back") => {
    if (selectedItem && isCopyable(selectedItem))
      commit(reorderItem(items, selectedItem.id, to));
  };
  const canActOnSelection = selectedItem !== null && isCopyable(selectedItem);

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
    if (
      event.nativeEvent.isComposing ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    )
      return;
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "c") {
      if (copySelection()) event.preventDefault();
    } else if (modifier && key === "v") {
      event.preventDefault();
      pasteClipboard();
    } else if (modifier && key === "d") {
      event.preventDefault();
      duplicateSelection();
    } else if (
      !modifier &&
      !event.altKey &&
      (event.key === "[" || event.key === "]")
    ) {
      reorderSelection(event.key === "]" ? "front" : "back");
    } else if (!modifier && !event.altKey && toolForShortcut(event.key)) {
      changeTool(toolForShortcut(event.key)!.id);
    } else if (modifier && key === "z") {
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
    } else if (modifier && key === "y") {
      event.preventDefault();
      session.redo();
    } else if (!modifier && (event.key === "+" || event.key === "=")) {
      zoomTo(zoomRef.current * ZOOM_STEP, frameCenter());
    } else if (!modifier && event.key === "-") {
      zoomTo(zoomRef.current / ZOOM_STEP, frameCenter());
    } else if (!modifier && event.key === "0") {
      zoomTo(MIN_ZOOM, frameCenter());
    }
  };

  const copy = t().editor.imageEdit;
  const canvasStyle = fit
    ? { width: fit.width * zoom, height: fit.height * zoom }
    : undefined;

  return (
    <Dialog open onOpenChange={(next) => !next && void requestClose()}>
      <DialogContent
        showClose={false}
        onKeyDown={handleKeyDown}
        // Escape while typing cancels the text, not the whole editor.
        onEscapeKeyDown={(event) => editing && event.preventDefault()}
        // Land on the canvas, not on the first toolbar button (which would pop its tooltip over the title).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          scroller?.focus({ preventScroll: true });
        }}
        className="fixed inset-0 z-50 flex max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-none bg-background p-0 focus:outline-none"
      >
        <DialogTitle className="sr-only">{copy.title(number)}</DialogTitle>
        <DialogDescription className="sr-only">
          {copy.hints.navigate}
        </DialogDescription>

        <header className="flex shrink-0 flex-col gap-2 border-b-2 border-border-soft px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="text-base font-bold">{copy.title(number)}</h2>
            <div className="min-w-0 flex-1">
              <ImageEditHeaderActions
                canUndo={session.canUndo}
                canRedo={session.canRedo}
                onUndo={session.undo}
                onRedo={session.redo}
                zoom={zoom}
                canZoomIn={zoom < MAX_ZOOM}
                canZoomOut={zoom > MIN_ZOOM}
                onZoomIn={() =>
                  zoomTo(zoomRef.current * ZOOM_STEP, frameCenter())
                }
                onZoomOut={() =>
                  zoomTo(zoomRef.current / ZOOM_STEP, frameCenter())
                }
                onZoomFit={() => zoomTo(MIN_ZOOM, frameCenter())}
                itemCount={items.length}
                saving={session.saving}
                onDone={() => void requestClose()}
                doneDisabled={closing}
              />
            </div>
          </div>
          {/* Always present, so showing or hiding controls never resizes the canvas below. */}
          <div className="flex min-h-10 flex-wrap items-center gap-x-5 gap-y-2">
            {tool === "crop" ? (
              <ImageEditCropPanel
                size={cropPixels}
                onClear={() => deleteItem(CROP_ITEM_ID)}
              />
            ) : (
              <>
                {styleFields.length > 0 && (
                  <ImageEditStylePanel
                    fields={styleFields}
                    style={shownStyle}
                    number={
                      styleSource?.kind === "step"
                        ? styleSource.number
                        : undefined
                    }
                    onChange={applyStyle}
                  />
                )}
                {canActOnSelection && (
                  <ImageEditItemActions
                    onDuplicate={duplicateSelection}
                    onBringToFront={() => reorderSelection("front")}
                    onSendToBack={() => reorderSelection("back")}
                    onDelete={() => deleteItem(selectedItem.id)}
                  />
                )}
              </>
            )}
          </div>
          {session.saveFailed && (
            <InlineAlert>
              <span className="flex flex-wrap items-center gap-3">
                {copy.saveFailed}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void session.flush().catch(() => undefined)}
                >
                  {copy.retry}
                </Button>
              </span>
            </InlineAlert>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="shrink-0 p-3">
            <ImageEditToolbar tool={tool} onToolChange={changeTool} />
          </div>
          <div ref={setFrame} className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={setScroller}
              data-stepmark-edit-scroller=""
              className={`app-scrollbar absolute inset-0 overflow-auto outline-none ${panning ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : ""}`}
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
                if (!pan || !scroller || pan.pointerId !== event.pointerId)
                  return;
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
                <div
                  ref={canvasRef}
                  className="relative m-auto shrink-0"
                  style={canvasStyle}
                >
                  {canvasStyle && (
                    <EntryThumbnail
                      entry={entry}
                      crop={null}
                      redactions={shown.redactions}
                      imageEdits={shown.imageEdits}
                      alt={copy.title(number)}
                      fit="contain"
                      exactBox
                      className="h-full w-full"
                      imgClassName="h-full w-full rounded-md object-contain outline-2 outline-border"
                      overlay={
                        imageSize && (
                          <ImageEditLayer
                            items={items}
                            tool={tool}
                            size={imageSize}
                            style={style}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                            onCreate={createItem}
                            onUpdate={replaceItem}
                            onDelete={deleteItem}
                            onDraft={setPreview}
                            editingText={editing?.item ?? null}
                            onStartTextEdit={startTextEdit}
                            onFinishTextEdit={finishTextEdit}
                            onPanStart={startPan}
                          />
                        )
                      }
                    />
                  )}
                  {(spaceHeld || panning) && (
                    <div
                      className="absolute inset-0 z-30 cursor-[inherit]"
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>
            </div>
            </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

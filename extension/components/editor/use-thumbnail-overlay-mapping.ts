import { useCallback, useEffect, useRef, useState } from 'react';
import { getExpandedRedactionBounds } from '@/lib/media/annotate';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import type { Redaction } from '@/lib/storage/db';

// Re-exported for the thumbnails: the drawable-frame guard is the raster
// compositor's contract, so the single definition lives with it.
export { isDrawableHighlightFrame } from '@/lib/media/annotation-contract';

export interface ImageContentFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RedactionStyle {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Everything needed to map screenshot CSS coordinates onto rendered pixels. */
export interface OverlayGeometry {
  naturalWidth: number;
  naturalHeight: number;
  dpr: number;
  scale: number;
  contentFrame: ImageContentFrame;
  /** Intersection of the content frame with the element box — the area actual
   * image pixels occupy on screen (differs from the content frame under
   * `cover`, where the content overflows and is cropped). */
  visibleLeft: number;
  visibleTop: number;
  visibleRight: number;
  visibleBottom: number;
  mapX: (x: number) => number;
  mapY: (y: number) => number;
}

/**
 * Content-frame math shared by the highlight thumbnails: where the image's
 * pixels actually land inside the (possibly letterboxed or cropped) element
 * box, and how a screenshot CSS coordinate maps onto those rendered pixels.
 */
export function computeOverlayGeometry(
  img: HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
  screenshotScale: number,
  fit: 'cover' | 'contain',
): OverlayGeometry {
  const dpr = getValidScreenshotScale(screenshotScale);
  const renderedBox = img.getBoundingClientRect();
  const boxWidth = renderedBox.width || naturalWidth;
  const boxHeight = renderedBox.height || naturalHeight;
  const scale = fit === 'cover'
    ? Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight)
    : Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const contentWidth = naturalWidth * scale;
  const contentHeight = naturalHeight * scale;
  const offsetLeft = img.offsetLeft + (boxWidth - contentWidth) / 2;
  const offsetTop = img.offsetTop + (boxHeight - contentHeight) / 2;
  return {
    naturalWidth,
    naturalHeight,
    dpr,
    scale,
    contentFrame: {
      left: offsetLeft,
      top: offsetTop,
      width: contentWidth,
      height: contentHeight,
    },
    visibleLeft: Math.max(offsetLeft, img.offsetLeft),
    visibleTop: Math.max(offsetTop, img.offsetTop),
    visibleRight: Math.min(offsetLeft + contentWidth, img.offsetLeft + boxWidth),
    visibleBottom: Math.min(offsetTop + contentHeight, img.offsetTop + boxHeight),
    mapX: (x: number) => offsetLeft + x * dpr * scale,
    mapY: (y: number) => offsetTop + y * dpr * scale,
  };
}

interface UseThumbnailOverlayMappingOptions {
  url: string | null;
  fit: 'cover' | 'contain';
  screenshotScale: number;
  /** Opaque masks in screenshot CSS coordinates. */
  redactions: Redaction[];
  privacyReviewRequired: boolean;
  /** Measure the mounted image, or return null while it has no usable size. */
  measure: (img: HTMLImageElement) => OverlayGeometry | null;
  /** Recompute the component's own overlays from fresh geometry. */
  mapOverlays: (geometry: OverlayGeometry) => void;
  /** Drop the component's own overlays when the image is unmeasurable. */
  clearOverlays: () => void;
}

/**
 * Shared overlay-mapping lifecycle for the highlight thumbnails: owns the
 * content frame, the redaction mask mapping, and the fail-closed contract that
 * no source pixel is shown while any redaction's on-screen position is stale
 * (`showPixels`). Remaps are coalesced into one animation frame per burst of
 * `ResizeObserver` notifications.
 */
export function useThumbnailOverlayMapping({
  url,
  fit,
  screenshotScale,
  redactions,
  privacyReviewRequired,
  measure,
  mapOverlays,
  clearOverlays,
}: UseThumbnailOverlayMappingOptions) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mapFrameRef = useRef<number | null>(null);
  const [contentFrame, setContentFrame] = useState<ImageContentFrame | null>(null);
  const [redactionBoxes, setRedactionBoxes] = useState<RedactionStyle[]>([]);
  const [mappedRedactionKey, setMappedRedactionKey] = useState<string | null>(null);

  const redactionSignature = redactions.map((redaction) => `${redaction.id}:${redaction.bounds.x},${redaction.bounds.y},${redaction.bounds.width},${redaction.bounds.height}`).join('|');
  const redactionMapKey = `${url ?? ''}:${fit}:${screenshotScale}:${redactionSignature}`;
  const redactionReady = redactions.length === 0 || mappedRedactionKey === redactionMapKey;
  const showPixels = !privacyReviewRequired && redactionReady;

  const remap = useCallback(() => {
    const img = imgRef.current;
    const geometry = img ? measure(img) : null;
    if (!geometry) {
      clearOverlays();
      setRedactionBoxes([]);
      setContentFrame(null);
      return;
    }
    setContentFrame(geometry.contentFrame);
    mapOverlays(geometry);
    setRedactionBoxes(
      redactions.flatMap((redaction) => {
        const expanded = getExpandedRedactionBounds(
          redaction.bounds,
          geometry.naturalWidth / geometry.dpr,
          geometry.naturalHeight / geometry.dpr,
        );
        return expanded
          ? [{
              id: redaction.id,
              left: geometry.mapX(expanded.x),
              top: geometry.mapY(expanded.y),
              width: expanded.width * geometry.dpr * geometry.scale,
              height: expanded.height * geometry.dpr * geometry.scale,
            }]
          : [];
      }),
    );
    setMappedRedactionKey(redactionMapKey);
  }, [clearOverlays, mapOverlays, measure, redactionMapKey, redactions]);

  const hasRedactions = redactions.length > 0;
  const scheduleMapping = useCallback(() => {
    // A resize invalidates pixel-space overlays immediately. Recompute on the
    // next frame so React can first hide the source image behind the black
    // fail-closed surface instead of briefly showing a stale mask position.
    if (hasRedactions && imgRef.current) imgRef.current.style.visibility = 'hidden';
    setMappedRedactionKey(null);
    if (mapFrameRef.current !== null) return;
    mapFrameRef.current = requestAnimationFrame(() => {
      mapFrameRef.current = null;
      remap();
    });
  }, [hasRedactions, remap]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(scheduleMapping);
    observer.observe(img);
    scheduleMapping();
    return () => {
      observer.disconnect();
      if (mapFrameRef.current !== null) cancelAnimationFrame(mapFrameRef.current);
      mapFrameRef.current = null;
    };
  }, [url, scheduleMapping]);

  return { imgRef, contentFrame, redactionBoxes, showPixels, remap };
}

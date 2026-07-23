import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  fitHighlightFrame,
  getExpandedRedactionBounds,
} from '@/lib/media/annotate';
import { useObjectUrl } from '@/lib/editor/useObjectUrl';
import { cn } from '@/lib/shared/utils';
import type { Bounds, Redaction } from '@/lib/storage/db';
import { getValidScreenshotScale } from '@/lib/media/image-utils';

const NO_REDACTIONS: Redaction[] = [];

interface Props {
  blob: Blob;
  bounds: Bounds | null;
  /** Opaque masks in screenshot CSS coordinates. */
  redactions?: Redaction[];
  /** Hide all source pixels until privacy metadata is explicitly reviewed. */
  privacyReviewRequired?: boolean;
  screenshotScale: number;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** 'cover' crops to fill a fixed box (popup thumbnails). 'contain' shows the
   * full uncropped screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
}

interface RedactionStyle {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BoxStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
}

/**
 * Renders a raw screenshot with the highlight box drawn as a CSS overlay (not
 * baked into the image). Position is a percentage of the screenshot's natural
 * size so it scales with whatever the thumbnail is sized to. Border width is
 * scaled by (rendered width / natural width) so it matches — proportionally —
 * the line the export path draws directly onto the full-resolution image;
 * otherwise a shrunk-down thumbnail makes a fixed CSS border look much
 * thicker than the one baked into the exported file.
 */
export default function HighlightThumbnail({
  blob,
  bounds,
  redactions = NO_REDACTIONS,
  privacyReviewRequired = false,
  screenshotScale,
  alt,
  className,
  imgClassName,
  fit = 'cover',
  loading = 'eager',
  decoding = 'async',
}: Props) {
  const url = useObjectUrl(blob);
  const [box, setBox] = useState<BoxStyle | null>(null);
  const [redactionBoxes, setRedactionBoxes] = useState<RedactionStyle[]>([]);
  const [mappedRedactionKey, setMappedRedactionKey] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const mapFrameRef = useRef<number | null>(null);

  const redactionSignature = redactions.map((redaction) => `${redaction.id}:${redaction.bounds.x},${redaction.bounds.y},${redaction.bounds.width},${redaction.bounds.height}`).join('|');
  const redactionMapKey = `${url ?? ''}:${fit}:${screenshotScale}:${redactionSignature}`;
  const redactionReady = redactions.length === 0 || mappedRedactionKey === redactionMapKey;
  const showPixels = !privacyReviewRequired && redactionReady;

  const computeBox = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setBox(null);
      setRedactionBoxes([]);
      return;
    }
    const dpr = getValidScreenshotScale(screenshotScale);
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const renderedBox = img.getBoundingClientRect();
    const boxWidth = renderedBox.width || nw;
    const boxHeight = renderedBox.height || nh;
    const scale = fit === 'cover' ? Math.max(boxWidth / nw, boxHeight / nh) : Math.min(boxWidth / nw, boxHeight / nh);
    const contentWidth = nw * scale;
    const contentHeight = nh * scale;
    const offsetLeft = img.offsetLeft + (boxWidth - contentWidth) / 2;
    const offsetTop = img.offsetTop + (boxHeight - contentHeight) / 2;
    const mapX = (x: number) => offsetLeft + x * dpr * scale;
    const mapY = (y: number) => offsetTop + y * dpr * scale;

    if (bounds) {
      const frame = fitHighlightFrame(bounds, nw / dpr, nh / dpr);
      setBox({
        left: mapX(frame.x),
        top: mapY(frame.y),
        width: frame.width * dpr * scale,
        height: frame.height * dpr * scale,
        borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
        borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
      });
    } else {
      setBox(null);
    }

    setRedactionBoxes(
      redactions.flatMap((redaction) => {
        const expanded = getExpandedRedactionBounds(redaction.bounds, nw / dpr, nh / dpr);
        return expanded
          ? [{
              id: redaction.id,
              left: mapX(expanded.x),
              top: mapY(expanded.y),
              width: expanded.width * dpr * scale,
              height: expanded.height * dpr * scale,
            }]
          : [];
      }),
    );
    setMappedRedactionKey(redactionMapKey);
  }, [bounds, fit, redactions, redactionMapKey, screenshotScale]);

  const scheduleMapping = useCallback(() => {
    // A resize invalidates pixel-space overlays immediately. Recompute on the
    // next frame so React can first hide the source image behind the black
    // fail-closed surface instead of briefly showing a stale mask position.
    if (redactions.length > 0 && imgRef.current) imgRef.current.style.visibility = 'hidden';
    setMappedRedactionKey(null);
    if (mapFrameRef.current !== null) return;
    mapFrameRef.current = requestAnimationFrame(() => {
      mapFrameRef.current = null;
      computeBox();
    });
  }, [computeBox]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(scheduleMapping);
    observer.observe(img);
    return () => {
      observer.disconnect();
      if (mapFrameRef.current !== null) cancelAnimationFrame(mapFrameRef.current);
      mapFrameRef.current = null;
    };
  }, [url, scheduleMapping]);

  const defaultImgClass = fit === 'contain' ? 'w-full h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block overflow-hidden leading-none', !showPixels && 'bg-black', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          loading={loading}
          decoding={decoding}
          alt={privacyReviewRequired ? '' : alt}
          aria-hidden={privacyReviewRequired || undefined}
          onLoad={computeBox}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={{
            ...(fit === 'cover' ? { objectFit: 'cover' } : {}),
            visibility: showPixels ? undefined : 'hidden',
          }}
        />
      )}
      {!privacyReviewRequired && box && (
        <div
          className="pointer-events-none absolute box-border"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: `${box.borderWidth}px solid ${HIGHLIGHT_COLOR}`,
            borderRadius: `${box.borderRadius}px`,
            backgroundColor: HIGHLIGHT_FILL_COLOR,
          }}
        />
      )}
      {!privacyReviewRequired && redactionBoxes.map((redaction) => (
        <div
          key={redaction.id}
          data-frametrail-redaction={redaction.id}
          className="pointer-events-none absolute z-10"
          style={{
            left: redaction.left,
            top: redaction.top,
            width: redaction.width,
            height: redaction.height,
            backgroundColor: '#000',
          }}
        />
      ))}
    </div>
  );
}

import { useCallback, useState, type ReactNode } from 'react';
import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  fitHighlightFrame,
} from '@/lib/media/annotate';
import { useObjectUrl } from '@/lib/editor/useObjectUrl';
import type { Bounds, Redaction } from '@/lib/storage/db';
import ThumbnailSurface from './ThumbnailSurface';
import {
  computeOverlayGeometry,
  isDrawableHighlightFrame,
  useThumbnailOverlayMapping,
  type OverlayGeometry,
} from './use-thumbnail-overlay-mapping';

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
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  /** 'cover' crops to fill a fixed box (popup thumbnails). 'contain' shows the
   * full uncropped screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
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
  overlay,
  fit = 'cover',
  loading = 'eager',
  decoding = 'async',
}: Props) {
  const url = useObjectUrl(blob);
  const [box, setBox] = useState<BoxStyle | null>(null);

  const measure = useCallback((img: HTMLImageElement) => (
    img.naturalWidth && img.naturalHeight
      ? computeOverlayGeometry(img, img.naturalWidth, img.naturalHeight, screenshotScale, fit)
      : null
  ), [fit, screenshotScale]);

  const mapOverlays = useCallback((geometry: OverlayGeometry) => {
    if (!bounds) {
      setBox(null);
      return;
    }
    const { dpr, scale, mapX, mapY } = geometry;
    const frame = fitHighlightFrame(bounds, geometry.naturalWidth / dpr, geometry.naturalHeight / dpr);
    if (!isDrawableHighlightFrame(frame)) {
      setBox(null);
      return;
    }
    setBox({
      left: mapX(frame.x),
      top: mapY(frame.y),
      width: frame.width * dpr * scale,
      height: frame.height * dpr * scale,
      borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
      borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
    });
  }, [bounds]);

  const clearOverlays = useCallback(() => setBox(null), []);

  const { imgRef, contentFrame, redactionBoxes, showPixels, remap } = useThumbnailOverlayMapping({
    url,
    fit,
    screenshotScale,
    redactions,
    privacyReviewRequired,
    measure,
    mapOverlays,
    clearOverlays,
  });

  return (
    <ThumbnailSurface
      url={url}
      imgRef={imgRef}
      showPixels={showPixels}
      privacyReviewRequired={privacyReviewRequired}
      alt={alt}
      fit={fit}
      loading={loading}
      decoding={decoding}
      className={className}
      imgClassName={imgClassName}
      // Single-image mode remaps synchronously on load; the multi variant
      // instead records the natural size and lets its layout memo drive the
      // remap. Deliberate divergence — see MultiHighlightThumbnail.
      onImageLoad={remap}
      contentFrame={contentFrame}
      redactionBoxes={redactionBoxes}
      overlay={overlay}
    >
      {box && (
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
    </ThumbnailSurface>
  );
}

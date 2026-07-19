import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_PADDING,
  HIGHLIGHT_RADIUS,
} from '@/lib/annotate';
import { useObjectUrl } from '@/lib/useObjectUrl';
import { cn } from '@/lib/utils';
import type { Bounds } from '@/lib/db';

interface Props {
  blob: Blob;
  bounds: Bounds | null;
  screenshotScale: number;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** 'cover' crops to fill a fixed box (popup thumbnails). 'contain' shows the
   * full uncropped screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
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
  screenshotScale,
  alt,
  className,
  imgClassName,
  fit = 'cover',
}: Props) {
  const url = useObjectUrl(blob);
  const [box, setBox] = useState<BoxStyle | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const computeBox = useCallback(() => {
    const img = imgRef.current;
    if (!img || !bounds || !img.naturalWidth || !img.naturalHeight) {
      setBox(null);
      return;
    }
    const dpr = screenshotScale || 1;
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

    setBox({
      left: offsetLeft + (bounds.x - HIGHLIGHT_PADDING) * dpr * scale,
      top: offsetTop + (bounds.y - HIGHLIGHT_PADDING) * dpr * scale,
      width: (bounds.width + HIGHLIGHT_PADDING * 2) * dpr * scale,
      height: (bounds.height + HIGHLIGHT_PADDING * 2) * dpr * scale,
      borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
      borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
    });
  }, [bounds, fit, screenshotScale]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(() => computeBox());
    observer.observe(img);
    return () => observer.disconnect();
  }, [url, computeBox]);

  const defaultImgClass = fit === 'contain' ? 'w-full h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          onLoad={computeBox}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={fit === 'cover' ? { objectFit: 'cover' } : undefined}
        />
      )}
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
    </div>
  );
}

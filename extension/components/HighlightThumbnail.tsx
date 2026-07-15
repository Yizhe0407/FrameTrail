import { useEffect, useRef, useState } from 'react';
import { HIGHLIGHT_COLOR, HIGHLIGHT_LINE_WIDTH, HIGHLIGHT_PADDING, HIGHLIGHT_RADIUS } from '@/lib/annotate';
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
  left: string;
  top: string;
  width: string;
  height: string;
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
  const [url, setUrl] = useState('');
  const [box, setBox] = useState<BoxStyle | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  function computeBox() {
    const img = imgRef.current;
    if (!img || !bounds || !img.naturalWidth || !img.naturalHeight) {
      setBox(null);
      return;
    }
    const dpr = screenshotScale || 1;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const renderedWidth = img.getBoundingClientRect().width || nw;
    const scale = renderedWidth / nw;

    const left = ((bounds.x - HIGHLIGHT_PADDING) * dpr) / nw;
    const top = ((bounds.y - HIGHLIGHT_PADDING) * dpr) / nh;
    const width = ((bounds.width + HIGHLIGHT_PADDING * 2) * dpr) / nw;
    const height = ((bounds.height + HIGHLIGHT_PADDING * 2) * dpr) / nh;

    setBox({
      left: `${left * 100}%`,
      top: `${top * 100}%`,
      width: `${width * 100}%`,
      height: `${height * 100}%`,
      borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
      borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
    });
  }

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(() => computeBox());
    observer.observe(img);
    return () => observer.disconnect();
    // computeBox reads current props via closure; re-run whenever inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, bounds, screenshotScale]);

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
          style={{ objectFit: fit }}
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
          }}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  BADGE_RADIUS,
  BADGE_TEXT_COLOR,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  findQuietCalloutSlots,
  layoutAnnotations,
  type Annotation,
  type AnnotationPoint,
} from '@/lib/annotate';
import { cn } from '@/lib/utils';

interface Props {
  blob: Blob;
  annotations: Annotation[];
  screenshotScale: number;
  numbered: boolean;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** 'cover' crops to fill a fixed box. 'contain' shows the full uncropped
   * screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
}

interface BoxStyle {
  order: number;
  markerOnly: boolean;
  left: string;
  top: string;
  width: string;
  height: string;
  anchorLeft: string;
  anchorTop: string;
  badgeAnchorLeft: string;
  badgeAnchorTop: string;
  calloutLeft: string | null;
  calloutTop: string | null;
  borderWidth: number;
  borderRadius: number;
  badgeSize: number;
  badgeFontSize: number;
  markerSize: number;
  leaderWidth: number;
  leaderPoints: string;
}

/**
 * Single-image mode counterpart of HighlightThumbnail: draws every
 * annotation's box (and, if numbered, its order badge) as CSS overlays on top
 * of one shared screenshot. Mirrors compositeMultiHighlight's geometry so the
 * live preview matches the exported image.
 */
export default function MultiHighlightThumbnail({
  blob,
  annotations,
  screenshotScale,
  numbered,
  alt,
  className,
  imgClassName,
  fit = 'cover',
}: Props) {
  const [url, setUrl] = useState('');
  const [boxes, setBoxes] = useState<BoxStyle[]>([]);
  const [quietSlots, setQuietSlots] = useState<AnnotationPoint[] | undefined>();
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setQuietSlots(undefined);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  function analyzeQuietSlots() {
    const img = imgRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(img, 0, 0);
    try {
      setQuietSlots(findQuietCalloutSlots(ctx.getImageData(0, 0, canvas.width, canvas.height), canvas.width / (screenshotScale || 1), canvas.height / (screenshotScale || 1), annotations));
    } catch {
      // Keep the geometric fallback when the browser does not allow pixel reads.
      setQuietSlots(undefined);
    }
  }

  function computeBoxes() {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setBoxes([]);
      return;
    }
    const dpr = screenshotScale || 1;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const renderedWidth = img.getBoundingClientRect().width || nw;
    const scale = renderedWidth / nw;

    const layouts = layoutAnnotations(annotations, nw / dpr, nh / dpr, quietSlots);
    setBoxes(
      layouts.map((layout) => {
        const left = (layout.frame.x * dpr) / nw;
        const top = (layout.frame.y * dpr) / nh;
        const width = (layout.frame.width * dpr) / nw;
        const height = (layout.frame.height * dpr) / nh;
        const badgeSize = Math.max(BADGE_RADIUS * 2 * dpr * scale, 14);

        return {
          order: layout.order,
          markerOnly: layout.markerOnly,
          left: `${left * 100}%`,
          top: `${top * 100}%`,
          width: `${width * 100}%`,
          height: `${height * 100}%`,
          anchorLeft: `${(layout.anchor.x * dpr * 100) / nw}%`,
          anchorTop: `${(layout.anchor.y * dpr * 100) / nh}%`,
          badgeAnchorLeft: `${(layout.badgeAnchor.x * dpr * 100) / nw}%`,
          badgeAnchorTop: `${(layout.badgeAnchor.y * dpr * 100) / nh}%`,
          calloutLeft: layout.callout ? `${(layout.callout.x * dpr * 100) / nw}%` : null,
          calloutTop: layout.callout ? `${(layout.callout.y * dpr * 100) / nh}%` : null,
          borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
          borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
          badgeSize,
          badgeFontSize: Math.max(badgeSize * 0.55, 9),
          markerSize: Math.max(12 * dpr * scale, 10),
          leaderWidth: Math.max((1.5 * dpr * 100) / nw, 0.2),
          leaderPoints: layout.leader
            .map((point) => `${(point.x * dpr * 100) / nw},${(point.y * dpr * 100) / nh}`)
            .join(' '),
        };
      }),
    );
  }

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(() => computeBoxes());
    observer.observe(img);
    return () => observer.disconnect();
    // computeBoxes reads current props via closure; re-run whenever inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, annotations, screenshotScale, quietSlots]);

  useEffect(() => {
    analyzeQuietSlots();
    // analyzeQuietSlots intentionally runs after the image URL/annotation set
    // changes; quietSlots itself is its output, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, annotations, screenshotScale]);

  const defaultImgClass = fit === 'contain' ? 'w-full h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          onLoad={() => {
            computeBoxes();
            analyzeQuietSlots();
          }}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={{ objectFit: fit }}
        />
      )}
      <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {boxes.map(
          (box) =>
            box.calloutLeft && box.calloutTop && (
              <polyline
                key={`leader-${box.order}`}
                points={box.leaderPoints}
                fill="none"
                stroke={HIGHLIGHT_COLOR}
                strokeWidth={box.leaderWidth}
              />
            ),
        )}
      </svg>
      {boxes.map((box) => (
        <div key={box.order}>
          {box.markerOnly ? (
            <div
              className="pointer-events-none absolute rounded-full border-2 bg-white"
              style={{
                left: box.anchorLeft,
                top: box.anchorTop,
                width: box.markerSize,
                height: box.markerSize,
                marginLeft: -box.markerSize / 2,
                marginTop: -box.markerSize / 2,
                borderColor: HIGHLIGHT_COLOR,
              }}
            >
              <div
                className="absolute rounded-full"
                style={{
                  inset: '30%',
                  backgroundColor: HIGHLIGHT_COLOR,
                }}
              />
            </div>
          ) : (
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
          {(numbered || box.calloutLeft) && (
            <div
              className="pointer-events-none absolute flex items-center justify-center rounded-full font-semibold shadow"
              style={{
                left: box.calloutLeft ?? box.badgeAnchorLeft,
                top: box.calloutTop ?? box.badgeAnchorTop,
                width: box.badgeSize,
                height: box.badgeSize,
                marginLeft: -box.badgeSize / 2,
                marginTop: -box.badgeSize / 2,
                backgroundColor: HIGHLIGHT_COLOR,
                color: BADGE_TEXT_COLOR,
                fontSize: box.badgeFontSize,
              }}
            >
              {box.order}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

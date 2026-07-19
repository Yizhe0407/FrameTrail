import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BADGE_RADIUS,
  BADGE_TEXT_COLOR,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  getBadgeFontSize,
  layoutAnnotations,
  type Annotation,
} from '@/lib/annotate';
import { cn } from '@/lib/utils';
import { useObjectUrl } from '@/lib/useObjectUrl';

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
  left: number;
  top: number;
  width: number;
  height: number;
  anchorLeft: number;
  anchorTop: number;
  badgeAnchorLeft: number;
  badgeAnchorTop: number;
  calloutLeft: number | null;
  calloutTop: number | null;
  borderWidth: number;
  borderRadius: number;
  badgeSize: number;
  badgeFontSize: number;
  markerSize: number;
  markerRingWidth: number;
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
  const url = useObjectUrl(blob);
  const [boxes, setBoxes] = useState<BoxStyle[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const annotationSignature = useMemo(
    () =>
      annotations
        .map(({ bounds, order }) => `${order}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
        .join('|'),
    [annotations],
  );

  const computeBoxes = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setBoxes([]);
      return;
    }
    const dpr = screenshotScale || 1;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const renderedBox = img.getBoundingClientRect();
    const boxWidth = renderedBox.width || nw;
    const boxHeight = renderedBox.height || nh;
    const scale = fit === 'cover' ? Math.max(boxWidth / nw, boxHeight / nh) : Math.min(boxWidth / nw, boxHeight / nh);
    const offsetLeft = img.offsetLeft + (boxWidth - nw * scale) / 2;
    const offsetTop = img.offsetTop + (boxHeight - nh * scale) / 2;
    const mapX = (x: number) => offsetLeft + x * dpr * scale;
    const mapY = (y: number) => offsetTop + y * dpr * scale;

    const layouts = layoutAnnotations(annotationsRef.current, nw / dpr, nh / dpr);
    setBoxes(
      layouts.map((layout) => {
        const badgeSize = Math.max(BADGE_RADIUS * 2 * dpr * scale, 14);

        return {
          order: layout.order,
          markerOnly: layout.markerOnly,
          left: mapX(layout.frame.x),
          top: mapY(layout.frame.y),
          width: layout.frame.width * dpr * scale,
          height: layout.frame.height * dpr * scale,
          anchorLeft: mapX(layout.anchor.x),
          anchorTop: mapY(layout.anchor.y),
          badgeAnchorLeft: mapX(layout.badgeAnchor.x),
          badgeAnchorTop: mapY(layout.badgeAnchor.y),
          calloutLeft: layout.callout ? mapX(layout.callout.x) : null,
          calloutTop: layout.callout ? mapY(layout.callout.y) : null,
          borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
          borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
          badgeSize,
          badgeFontSize: Math.max(getBadgeFontSize(layout.order, badgeSize), 7),
          markerSize: Math.max(MARKER_RADIUS * 2 * dpr * scale, 10),
          markerRingWidth: Math.max(MARKER_RING_WIDTH * dpr * scale, 1),
          leaderWidth: Math.max(LEADER_LINE_WIDTH * dpr * scale, 1),
          leaderPoints: layout.leader
            .map((point) => `${mapX(point.x)},${mapY(point.y)}`)
            .join(' '),
        };
      }),
    );
  }, [annotationSignature, fit, screenshotScale]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(() => computeBoxes());
    observer.observe(img);
    return () => observer.disconnect();
  }, [url, computeBoxes]);

  const defaultImgClass = fit === 'contain' ? 'w-full h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          onLoad={() => computeBoxes()}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={imgClassName ? { objectFit: fit } : fit === 'cover' ? { objectFit: 'cover' } : undefined}
        />
      )}
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        {boxes.map(
          (box) =>
            box.calloutLeft !== null && box.calloutTop !== null && (
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
              className="pointer-events-none absolute rounded-full bg-white"
              style={{
                left: box.anchorLeft,
                top: box.anchorTop,
                width: box.markerSize,
                height: box.markerSize,
                marginLeft: -box.markerSize / 2,
                marginTop: -box.markerSize / 2,
                borderStyle: 'solid',
                borderWidth: box.markerRingWidth,
                borderColor: HIGHLIGHT_COLOR,
              }}
            >
              <div
                className="absolute rounded-full"
                style={{
                  inset: `${(1 - MARKER_INNER_RADIUS / MARKER_RADIUS) * 50}%`,
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
                backgroundColor: HIGHLIGHT_FILL_COLOR,
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

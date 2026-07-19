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
  const [imageSize, setImageSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const mapFrameRef = useRef<number | null>(null);
  const annotationSignature = useMemo(
    () =>
      annotations
        .map(({ bounds, order }) => `${order}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
        .join('|'),
    [annotations],
  );
  const stableAnnotations = useMemo(
    () => annotations.map(({ bounds, order }) => ({ bounds: { ...bounds }, order })),
    [annotationSignature],
  );
  const dpr = screenshotScale || 1;
  const layouts = useMemo(() => {
    if (!url || imageSize?.url !== url || !imageSize.width || !imageSize.height) return [];
    return layoutAnnotations(stableAnnotations, imageSize.width / dpr, imageSize.height / dpr);
  }, [dpr, imageSize, stableAnnotations, url]);

  const mapBoxes = useCallback(() => {
    const img = imgRef.current;
    if (!img || imageSize?.url !== url || !imageSize.width || !imageSize.height) {
      setBoxes([]);
      return;
    }
    const nw = imageSize.width;
    const nh = imageSize.height;
    const renderedBox = img.getBoundingClientRect();
    const boxWidth = renderedBox.width || nw;
    const boxHeight = renderedBox.height || nh;
    const scale = fit === 'cover' ? Math.max(boxWidth / nw, boxHeight / nh) : Math.min(boxWidth / nw, boxHeight / nh);
    const contentWidth = nw * scale;
    const contentHeight = nh * scale;
    const offsetLeft = img.offsetLeft + (boxWidth - contentWidth) / 2;
    const offsetTop = img.offsetTop + (boxHeight - contentHeight) / 2;
    const visibleLeft = Math.max(offsetLeft, img.offsetLeft);
    const visibleTop = Math.max(offsetTop, img.offsetTop);
    const visibleRight = Math.min(offsetLeft + contentWidth, img.offsetLeft + boxWidth);
    const visibleBottom = Math.min(offsetTop + contentHeight, img.offsetTop + boxHeight);
    const mapX = (x: number) => offsetLeft + x * dpr * scale;
    const mapY = (y: number) => offsetTop + y * dpr * scale;
    const fitCenter = (value: number, radius: number, start: number, end: number) => {
      const extent = Math.max(end - start, 0);
      return extent <= radius * 2
        ? start + extent / 2
        : Math.min(Math.max(value, start + radius), end - radius);
    };

    setBoxes(
      layouts.map((layout) => {
        const badgeSize = Math.max(BADGE_RADIUS * 2 * dpr * scale, 14);
        const markerSize = Math.max(MARKER_RADIUS * 2 * dpr * scale, 10);
        const anchorLeft = fitCenter(mapX(layout.anchor.x), markerSize / 2, visibleLeft, visibleRight);
        const anchorTop = fitCenter(mapY(layout.anchor.y), markerSize / 2, visibleTop, visibleBottom);
        const badgeAnchorLeft = fitCenter(mapX(layout.badgeAnchor.x), badgeSize / 2, visibleLeft, visibleRight);
        const badgeAnchorTop = fitCenter(mapY(layout.badgeAnchor.y), badgeSize / 2, visibleTop, visibleBottom);
        const calloutLeft = layout.callout
          ? fitCenter(mapX(layout.callout.x), badgeSize / 2, visibleLeft, visibleRight)
          : null;
        const calloutTop = layout.callout
          ? fitCenter(mapY(layout.callout.y), badgeSize / 2, visibleTop, visibleBottom)
          : null;
        let leaderPoints = '';
        if (layout.leader.length >= 2 && calloutLeft !== null && calloutTop !== null) {
          const dx = calloutLeft - anchorLeft;
          const dy = calloutTop - anchorTop;
          const length = Math.hypot(dx, dy);
          if (length > markerSize / 2 + badgeSize / 2) {
            const ux = dx / length;
            const uy = dy / length;
            leaderPoints = [
              `${anchorLeft + ux * markerSize / 2},${anchorTop + uy * markerSize / 2}`,
              `${calloutLeft - ux * badgeSize / 2},${calloutTop - uy * badgeSize / 2}`,
            ].join(' ');
          }
        }

        return {
          order: layout.order,
          markerOnly: layout.markerOnly,
          left: mapX(layout.frame.x),
          top: mapY(layout.frame.y),
          width: layout.frame.width * dpr * scale,
          height: layout.frame.height * dpr * scale,
          anchorLeft,
          anchorTop,
          badgeAnchorLeft,
          badgeAnchorTop,
          calloutLeft,
          calloutTop,
          borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
          borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
          badgeSize,
          badgeFontSize: Math.max(getBadgeFontSize(layout.order, badgeSize), 7),
          markerSize,
          markerRingWidth: Math.max(MARKER_RING_WIDTH * dpr * scale, 1),
          leaderWidth: Math.max(LEADER_LINE_WIDTH * dpr * scale, 1),
          leaderPoints,
        };
      }),
    );
  }, [dpr, fit, imageSize, layouts, url]);

  const scheduleMapping = useCallback(() => {
    if (mapFrameRef.current !== null) return;
    mapFrameRef.current = requestAnimationFrame(() => {
      mapFrameRef.current = null;
      mapBoxes();
    });
  }, [mapBoxes]);

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
  }, [scheduleMapping, url]);

  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img || !url) return;
    setImageSize((current) => {
      if (current?.url === url && current.width === img.naturalWidth && current.height === img.naturalHeight) {
        return current;
      }
      return { url, width: img.naturalWidth, height: img.naturalHeight };
    });
  }, [url]);

  const defaultImgClass = fit === 'contain' ? 'w-full h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          onLoad={onImageLoad}
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
              data-frametrail-annotation-frame={box.order}
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

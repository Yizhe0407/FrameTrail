import type { ReactNode, RefObject } from 'react';
import { cn } from '@/lib/shared/utils';
import type { ImageContentFrame, RedactionStyle } from './use-thumbnail-overlay-mapping';

interface Props {
  url: string | null;
  imgRef: RefObject<HTMLImageElement | null>;
  /** From useThumbnailOverlayMapping: false hides source pixels fail-closed
   * (privacy review pending, or redaction positions not yet remapped). */
  showPixels: boolean;
  privacyReviewRequired: boolean;
  alt: string;
  fit: 'cover' | 'contain';
  loading: 'lazy' | 'eager';
  decoding: 'async' | 'sync' | 'auto';
  className?: string;
  imgClassName?: string;
  onImageLoad: () => void;
  contentFrame: ImageContentFrame | null;
  redactionBoxes: RedactionStyle[];
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  /** The component-specific highlight overlays; hidden with the pixels while
   * privacy review is pending, like everything derived from the screenshot. */
  children?: ReactNode;
}

/**
 * The rendered surface shared by the highlight thumbnails: the screenshot img
 * with its privacy-gated alt/visibility, the component-specific overlays, the
 * opaque redaction boxes, and the content-frame overlay slot. Layer order is
 * load-bearing — redactions (z-10) must cover the highlight overlays, and the
 * content frame (z-20) sits above both.
 */
export default function ThumbnailSurface({
  url,
  imgRef,
  showPixels,
  privacyReviewRequired,
  alt,
  fit,
  loading,
  decoding,
  className,
  imgClassName,
  onImageLoad,
  contentFrame,
  redactionBoxes,
  overlay,
  children,
}: Props) {
  const defaultImgClass = fit === 'contain' ? 'max-h-full max-w-full w-auto h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', !showPixels && 'bg-black', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          loading={loading}
          decoding={decoding}
          alt={privacyReviewRequired ? '' : alt}
          aria-hidden={privacyReviewRequired || undefined}
          onLoad={onImageLoad}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={{
            ...(imgClassName ? { objectFit: fit } : fit === 'cover' ? { objectFit: 'cover' } : {}),
            visibility: showPixels ? undefined : 'hidden',
          }}
        />
      )}
      {!privacyReviewRequired && children}
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
      {overlay && contentFrame && (
        <div
          data-frametrail-image-content-frame
          className="pointer-events-none absolute z-20"
          style={contentFrame}
        >
          <div className="relative h-full w-full">{overlay}</div>
        </div>
      )}
    </div>
  );
}

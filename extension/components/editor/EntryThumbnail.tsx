import type { ReactNode } from 'react';
import { getEffectiveBounds, getEntryPrivacyState, getOrderedAnnotations, type StepEntry } from '@/lib/storage/models';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';

interface Props {
  entry: StepEntry;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
}

/** Renders a timeline entry's preview and derives blob/bounds/privacy so callers don't drift in wiring these up. */
export default function EntryThumbnail({ entry, ...presentation }: Props) {
  const privacy = getEntryPrivacyState(entry);
  if (entry.kind === 'single') {
    return (
      <HighlightThumbnail
        blob={entry.step.screenshotBlob}
        bounds={getEffectiveBounds(entry.step)}
        redactions={privacy.redactions}
        privacyReviewRequired={privacy.reviewRequired}
        screenshotScale={entry.step.screenshotScale ?? entry.step.devicePixelRatio}
        {...presentation}
      />
    );
  }
  return (
    <MultiHighlightThumbnail
      blob={entry.anchor.screenshotBlob}
      annotations={getOrderedAnnotations(entry.annotations)}
      redactions={privacy.redactions}
      privacyReviewRequired={privacy.reviewRequired}
      screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
      numbered={entry.anchor.numbered ?? false}
      {...presentation}
    />
  );
}

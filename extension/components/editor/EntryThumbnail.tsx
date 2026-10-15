import type { ReactNode } from 'react';
import { getEffectiveBounds, getEntryImageEdits, getEntryPrivacyState, getOrderedAnnotations, type ImageEdit, type Redaction, type StepEntry } from '@/lib/storage/models';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';

interface Props {
  entry: StepEntry;
  /** Masks to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  redactions?: Redaction[];
  /** Image edits to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  imageEdits?: ImageEdit[];
  /** The image element is exactly the image's box, so masks can be placed in percentages. */
  exactBox?: boolean;
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
export default function EntryThumbnail({ entry, redactions, imageEdits, ...presentation }: Props) {
  const privacy = getEntryPrivacyState(entry);
  const shownRedactions = redactions ?? privacy.redactions;
  const shownImageEdits = imageEdits ?? getEntryImageEdits(entry);
  if (entry.kind === 'single') {
    return (
      <HighlightThumbnail
        blob={entry.step.screenshotBlob}
        bounds={getEffectiveBounds(entry.step)}
        redactions={shownRedactions}
        imageEdits={shownImageEdits}
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
      redactions={shownRedactions}
      imageEdits={shownImageEdits}
      privacyReviewRequired={privacy.reviewRequired}
      screenshotScale={entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio}
      numbered={entry.anchor.numbered ?? false}
      {...presentation}
    />
  );
}

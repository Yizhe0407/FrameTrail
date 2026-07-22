import { compositeHighlight, compositeMultiHighlight } from './annotate';
import {
  getEffectiveBounds,
  getEntryPrivacyState,
  getOrderedAnnotations,
  type StepEntry,
} from './db';
import { getValidScreenshotScale } from './image-utils';

export type CompositeImageFormat = 'image/jpeg' | 'image/png';

/**
 * Produces the one raster image represented by a timeline entry. Clipboard and
 * ZIP export both call this function so they share screenshot ownership,
 * effective/manual bounds, group numbering, and final privacy redactions.
 */
export async function compositeStepEntry(entry: StepEntry, format: CompositeImageFormat): Promise<Blob> {
  const imageOwner = entry.kind === 'single' ? entry.step : entry.anchor;
  const screenshotScale = getValidScreenshotScale(imageOwner.screenshotScale ?? imageOwner.devicePixelRatio);
  const privacy = getEntryPrivacyState(entry);

  if (entry.kind === 'single') {
    return compositeHighlight(
      imageOwner.screenshotBlob,
      getEffectiveBounds(entry.step),
      screenshotScale,
      format,
      privacy.redactions,
      privacy.reviewRequired,
    );
  }

  return compositeMultiHighlight(
    imageOwner.screenshotBlob,
    getOrderedAnnotations(entry.annotations),
    screenshotScale,
    imageOwner.numbered ?? false,
    format,
    privacy.redactions,
    privacy.reviewRequired,
  );
}

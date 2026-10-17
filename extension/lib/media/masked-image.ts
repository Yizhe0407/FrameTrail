import type { Redaction } from '../storage/models';
import { compositeHighlight } from './annotation-composite';
import { getValidScreenshotScale } from './image-utils';

/**
 * Preview rasters with every privacy mask burned into the pixels. Previews
 * show these instead of the stored screenshot, so whatever a person can do
 * with a preview image (save, copy, open, drag it out) only ever yields
 * pixels the masks have already covered. They are made by the same
 * compositor as clipboard copies and exports, so a mask hides exactly the
 * same pixels everywhere.
 */

/** Matches the source screenshots (captured as JPEG) and encodes far faster than PNG. */
const PREVIEW_FORMAT = 'image/jpeg';

/** A preview shows one mask set at a time per image; a few extra entries keep
 * a quick back-and-forth (undo, an edit and its revert) from re-compositing. */
const MAX_RESULTS_PER_SOURCE = 4;

interface CacheEntry {
  promise: Promise<Blob>;
  /** Set once compositing has finished, so renders can read it without waiting. */
  settled?: Blob;
}

/** Keyed by the source Blob, which is immutable, so a result is valid for as
 * long as the source lives and is collected with it. */
const cache = new WeakMap<Blob, Map<string, CacheEntry>>();

/** Identifies everything that changes the masked pixels: the masks' boxes, the
 * capture scale they are mapped with, and whether the whole image is blocked. */
export function maskedImageKey(
  redactions: readonly Redaction[],
  screenshotScale: number,
  privacyBlockRequired: boolean,
): string {
  const masks = redactions
    .map(({ bounds }) => `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
    .join('|');
  return `${privacyBlockRequired ? 'blocked' : 'open'}@${getValidScreenshotScale(screenshotScale)}:${masks}`;
}

/**
 * The source image with `redactions` burned in, or entirely black when
 * `privacyBlockRequired`. Results are shared per (source, masks) so every
 * preview of an image decodes and encodes it once, and keep a stable Blob
 * identity so they can share one object URL. A failure is not remembered,
 * so the next request tries again; callers show nothing meanwhile. Only ask
 * when there is something to hide: a result is never the source itself.
 */
export function getMaskedImage(
  source: Blob,
  redactions: readonly Redaction[],
  screenshotScale: number,
  privacyBlockRequired: boolean,
): Promise<Blob> {
  const key = maskedImageKey(redactions, screenshotScale, privacyBlockRequired);
  let results = cache.get(source);
  const existing = results?.get(key);
  if (existing) {
    // Most recently used goes last, so eviction drops the stalest result.
    results!.delete(key);
    results!.set(key, existing);
    return existing.promise;
  }
  if (!results) {
    results = new Map();
    cache.set(source, results);
  }
  const owner = results;
  const entry: CacheEntry = {
    promise: compositeHighlight(
      source,
      null,
      screenshotScale,
      PREVIEW_FORMAT,
      redactions,
      privacyBlockRequired,
    ),
  };
  entry.promise = entry.promise.then(
    (blob) => {
      // Never hand back the unmasked source as a "masked" result.
      if (blob === source) throw new Error('Masking returned the unmasked source image.');
      entry.settled = blob;
      return blob;
    },
    (error) => {
      if (owner.get(key) === entry) owner.delete(key);
      throw error;
    },
  );
  owner.set(key, entry);
  while (owner.size > MAX_RESULTS_PER_SOURCE) owner.delete(owner.keys().next().value!);
  return entry.promise;
}

/** The finished result if it has already been computed, so a render can use it immediately. */
export function peekMaskedImage(source: Blob, key: string): Blob | undefined {
  return cache.get(source)?.get(key)?.settled;
}

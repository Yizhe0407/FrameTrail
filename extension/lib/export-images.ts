import { Zip, ZipPassThrough } from 'fflate';
import { browser } from 'wxt/browser';
import { compositeStepEntry } from './entry-render';
import { buildStepEntries, getEntryPrivacyState, type Step } from './db';

export const IMAGE_ZIP_EXPORT_LIMITS = Object.freeze({
  maxEntries: 2_000,
  maxImageBytes: 16 * 1024 * 1024,
  maxTotalImageBytes: 128 * 1024 * 1024,
});

export class ImageZipExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageZipExportLimitError';
  }
}

export class RedactionReviewRequiredError extends Error {
  constructor() {
    super('Sensitive-information masks must be reviewed before export.');
    this.name = 'RedactionReviewRequiredError';
  }
}

export function localDateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface ExportImagesResult {
  filename: string;
  itemCount: number;
}

export function isExportCancelledError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Export cancelled', 'AbortError');
}

function assertImageZipBudget(imageBytes: number, totalImageBytes: number, ordinal: number): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > IMAGE_ZIP_EXPORT_LIMITS.maxImageBytes) {
    throw new ImageZipExportLimitError(`Image ${ordinal} exceeds the per-image ZIP export limit.`);
  }
  if (totalImageBytes + imageBytes > IMAGE_ZIP_EXPORT_LIMITS.maxTotalImageBytes) {
    throw new ImageZipExportLimitError('Images exceed the total ZIP export limit.');
  }
}

function createStreamingZip() {
  const chunks: ArrayBuffer[] = [];
  let resolveZip!: (value: Blob) => void;
  let rejectZip!: (reason: unknown) => void;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });

  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectZip(error);
      return;
    }
    // fflate may reuse its output buffer after this callback. Keep one owned
    // copy per emitted chunk, but avoid the previous final contiguous copy that
    // temporarily doubled the entire archive in memory.
    const owned = new Uint8Array(chunk.byteLength);
    owned.set(chunk);
    chunks.push(owned.buffer);
    if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
  });

  return { archive, result };
}

/**
 * Composites each entry's annotations and privacy redactions onto its screenshot and packs them
 * into a single ZIP (01.jpg, 02.jpg, …), then triggers a download. Gives the
 * user the raw annotated images to assemble a doc however they like. Each
 * single-image group collapses to one file (all its click boxes on the one
 * shared screenshot); each ordinary step produces its own file.
 */
export async function exportImagesAsZip(
  steps: Step[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportImagesResult | null> {
  throwIfCancelled(signal);
  if (steps.length === 0) return null;

  const entries = buildStepEntries(steps);
  if (entries.length === 0) return null;
  if (entries.length > IMAGE_ZIP_EXPORT_LIMITS.maxEntries) {
    throw new ImageZipExportLimitError('Guide contains too many images to export safely.');
  }
  if (entries.some((entry) => getEntryPrivacyState(entry).reviewRequired)) {
    throw new RedactionReviewRequiredError();
  }
  const pad = String(entries.length).length;
  let done = 0;
  let declaredImageBytes = 0;
  let actualImageBytes = 0;
  const { archive, result } = createStreamingZip();

  try {
    // Process one bitmap/canvas at a time. The ZIP stream can release each
    // annotated JPEG as soon as it has emitted the corresponding archive
    // chunks, avoiding a decoded image for every step at once.
    for (const [index, entry] of entries.entries()) {
      throwIfCancelled(signal);
      const annotated = await compositeStepEntry(entry, 'image/jpeg');
      throwIfCancelled(signal);
      const ordinal = index + 1;
      // Reject from Blob metadata before arrayBuffer() duplicates the image in
      // memory, then verify the owned buffer before adding it to the archive.
      assertImageZipBudget(annotated.size, declaredImageBytes, ordinal);
      declaredImageBytes += annotated.size;
      const bytes = new Uint8Array(await annotated.arrayBuffer());
      throwIfCancelled(signal);
      assertImageZipBudget(bytes.byteLength, actualImageBytes, ordinal);
      actualImageBytes += bytes.byteLength;
      const file = new ZipPassThrough(`${String(index + 1).padStart(pad, '0')}.jpg`);
      archive.add(file);
      file.push(bytes, true);
      onProgress?.(++done, entries.length);
    }
    throwIfCancelled(signal);
    archive.end();
  } catch (error) {
    archive.terminate();
    throw error;
  }

  const blob = await result;
  throwIfCancelled(signal);

  const url = URL.createObjectURL(blob);
  const filename = `frame-trail-images-${localDateStamp()}.zip`;
  try {
    throwIfCancelled(signal);
    await browser.downloads.download({ url, filename, saveAs: true });
  } finally {
    URL.revokeObjectURL(url);
  }
  return { filename, itemCount: entries.length };
}

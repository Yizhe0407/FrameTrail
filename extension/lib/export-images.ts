import { Zip, ZipPassThrough } from 'fflate';
import { browser } from 'wxt/browser';
import { compositeHighlight, compositeMultiHighlight } from './annotate';
import { buildStepEntries, getOrderedAnnotations, type Step } from './db';

export function localDateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createStreamingZip() {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let resolveZip!: (value: Uint8Array) => void;
  let rejectZip!: (reason: unknown) => void;
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });

  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectZip(error);
      return;
    }
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    if (!final) return;

    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of chunks) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    resolveZip(output);
  });

  return { archive, result };
}

/**
 * Composites the highlight(s) onto each entry's screenshot(s) and packs them
 * into a single ZIP (01.jpg, 02.jpg, …), then triggers a download. Gives the
 * user the raw annotated images to assemble a doc however they like. Each
 * single-image group collapses to one file (all its click boxes on the one
 * shared screenshot); each ordinary step produces its own file.
 */
export async function exportImagesAsZip(
  steps: Step[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (steps.length === 0) return;

  const entries = buildStepEntries(steps);
  if (entries.length === 0) return;
  const pad = String(entries.length).length;
  let done = 0;
  const { archive, result } = createStreamingZip();

  try {
    // Process one bitmap/canvas at a time. The ZIP stream can release each
    // annotated JPEG as soon as it has emitted the corresponding archive
    // chunks, avoiding a decoded image for every step at once.
    for (const [index, entry] of entries.entries()) {
      const annotated =
        entry.kind === 'single'
          ? await compositeHighlight(
              entry.step.screenshotBlob,
              entry.step.bounds,
              entry.step.screenshotScale ?? entry.step.devicePixelRatio,
            )
          : await compositeMultiHighlight(
              entry.anchor.screenshotBlob,
              getOrderedAnnotations(entry.annotations),
              entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio,
              entry.anchor.numbered ?? false,
            );
      const bytes = new Uint8Array(await annotated.arrayBuffer());
      const file = new ZipPassThrough(`${String(index + 1).padStart(pad, '0')}.jpg`);
      archive.add(file);
      file.push(bytes, true);
      onProgress?.(++done, entries.length);
    }
    archive.end();
  } catch (error) {
    archive.terminate();
    throw error;
  }

  const zipped = await result;

  const blob = new Blob([zipped.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename: `frame-trail-images-${localDateStamp()}.zip`, saveAs: true });
  } finally {
    URL.revokeObjectURL(url);
  }
}

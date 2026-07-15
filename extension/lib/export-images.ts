import { zip } from 'fflate';
import { browser } from 'wxt/browser';
import { compositeHighlight, compositeMultiHighlight } from './annotate';
import { buildStepEntries, type Step } from './db';

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
  const files: Record<string, Uint8Array> = {};
  const pad = String(entries.length).length;
  let done = 0;

  await Promise.all(
    entries.map(async (entry, index) => {
      const annotated =
        entry.kind === 'single'
          ? await compositeHighlight(
              entry.step.screenshotBlob,
              entry.step.bounds,
              entry.step.screenshotScale ?? entry.step.devicePixelRatio,
            )
          : await compositeMultiHighlight(
              entry.anchor.screenshotBlob,
              entry.annotations.map((s, i) => ({ bounds: s.bounds!, order: i + 1 })),
              entry.anchor.screenshotScale ?? entry.anchor.devicePixelRatio,
              entry.anchor.numbered ?? false,
            );
      const bytes = new Uint8Array(await annotated.arrayBuffer());
      files[`${String(index + 1).padStart(pad, '0')}.jpg`] = bytes;
      onProgress?.(++done, entries.length);
    }),
  );

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  const blob = new Blob([zipped.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({ url, filename: `frame-trail-images-${todayStamp()}.zip`, saveAs: true });
}

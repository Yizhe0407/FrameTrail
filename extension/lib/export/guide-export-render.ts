import { encodeBase64 } from './base64';
import { compositeStepEntry } from './entry-render';
import type { Step, StepEntry } from '../storage/db';
import {
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  IMAGE_MIME_TYPE,
  textValue,
  throwIfAborted,
} from './guide-export-contract';

export type RenderedEntryContent = {
  entryId: string;
  ordinal: number;
  description: string;
  annotations: readonly Step[];
};

export type RenderedEntry = RenderedEntryContent & {
  imageDataUri: string;
};

export type RenderedEntryImage = {
  content: RenderedEntryContent;
  imageBytes: Uint8Array;
};

export type RenderedMarkdownEntry = RenderedEntryContent & {
  imageReference: string;
};

function sortedAnnotations(entry: StepEntry): readonly Step[] {
  if (entry.kind === 'single') return [];
  return [...entry.annotations].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function entryOwner(entry: StepEntry): Step {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function assertGuideImageBudget(imageBytes: number, totalImageBytes: number, ordinal: number): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > GUIDE_EXPORT_LIMITS.maxImageBytes) {
    throw new GuideExportLimitError(`Step ${ordinal} exceeds the per-image guide export limit.`);
  }
  if (totalImageBytes + imageBytes > GUIDE_EXPORT_LIMITS.maxTotalImageBytes) {
    throw new GuideExportLimitError('Guide images exceed the total export limit.');
  }
}

export async function* renderEntryImages(
  entries: readonly StepEntry[],
  signal?: AbortSignal,
): AsyncGenerator<RenderedEntryImage> {
  if (entries.length > GUIDE_EXPORT_LIMITS.maxEntries) {
    throw new GuideExportLimitError('Guide contains too many entries to export safely.');
  }

  let declaredImageBytes = 0;
  let actualImageBytes = 0;

  // Deliberately sequential: a large guide never holds decoded canvases for
  // multiple screenshots while an image is being composited.
  for (const [index, entry] of entries.entries()) {
    throwIfAborted(signal);
    // This is the single rasterization path used by previews/image exports.
    // In particular, it refuses redaction-review-required entries fail-closed.
    const image = await compositeStepEntry(entry, IMAGE_MIME_TYPE);
    throwIfAborted(signal);
    const ordinal = index + 1;

    // Blob.size is available without allocating another full copy, so reject
    // oversized output before arrayBuffer() and base64's ~4/3 expansion.
    assertGuideImageBudget(image.size, declaredImageBytes, ordinal);
    declaredImageBytes += image.size;
    const bytes = new Uint8Array(await image.arrayBuffer());
    throwIfAborted(signal);
    // Recheck the owned buffer as defense-in-depth for non-native Blob-like
    // implementations used by tests or future adapters.
    assertGuideImageBudget(bytes.byteLength, actualImageBytes, ordinal);
    actualImageBytes += bytes.byteLength;

    const owner = entryOwner(entry);
    yield {
      content: {
        entryId: owner.id,
        ordinal,
        description: textValue(owner.description),
        annotations: sortedAnnotations(entry),
      },
      imageBytes: bytes,
    };
  }
}

export async function renderEntries(entries: readonly StepEntry[], signal?: AbortSignal): Promise<RenderedEntry[]> {
  const rendered: RenderedEntry[] = [];
  for await (const entry of renderEntryImages(entries, signal)) {
    const imageDataUri = `data:${IMAGE_MIME_TYPE};base64,${encodeBase64(entry.imageBytes, signal)}`;
    throwIfAborted(signal);
    rendered.push({ ...entry.content, imageDataUri });
  }
  return rendered;
}

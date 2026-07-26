import { throwIfAborted } from '../shared/abort';
import { encodeBase64 } from './base64';
import { compositeStepEntry } from './entry-render';
import type { Step, StepEntry } from '../storage/db';
import {
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  IMAGE_MIME_TYPE,
  textValue,
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

export type EntryImageBudgetViolation =
  | { kind: 'entry-count' }
  | { kind: 'image-bytes'; ordinal: number }
  | { kind: 'total-bytes'; ordinal: number };

/**
 * Limits plus an error factory so every consumer of the shared sequential
 * rendering loop (guide publications, image ZIP export) enforces the same
 * budget checks while surfacing its own error class and wording.
 */
export interface EntryImageBudget {
  maxEntries: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  createLimitError: (violation: EntryImageBudgetViolation) => Error;
}

const GUIDE_ENTRY_IMAGE_BUDGET: EntryImageBudget = {
  maxEntries: GUIDE_EXPORT_LIMITS.maxEntries,
  maxImageBytes: GUIDE_EXPORT_LIMITS.maxImageBytes,
  maxTotalImageBytes: GUIDE_EXPORT_LIMITS.maxTotalImageBytes,
  createLimitError: (violation) => {
    switch (violation.kind) {
      case 'entry-count':
        return new GuideExportLimitError('Guide contains too many entries to export safely.');
      case 'image-bytes':
        return new GuideExportLimitError(`Step ${violation.ordinal} exceeds the per-image guide export limit.`);
      case 'total-bytes':
        return new GuideExportLimitError('Guide images exceed the total export limit.');
    }
  },
};

function assertEntryImageBudget(
  budget: EntryImageBudget,
  imageBytes: number,
  totalImageBytes: number,
  ordinal: number,
): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > budget.maxImageBytes) {
    throw budget.createLimitError({ kind: 'image-bytes', ordinal });
  }
  if (totalImageBytes + imageBytes > budget.maxTotalImageBytes) {
    throw budget.createLimitError({ kind: 'total-bytes', ordinal });
  }
}

export async function* renderEntryImages(
  entries: readonly StepEntry[],
  signal?: AbortSignal,
  budget: EntryImageBudget = GUIDE_ENTRY_IMAGE_BUDGET,
): AsyncGenerator<RenderedEntryImage> {
  if (entries.length > budget.maxEntries) {
    throw budget.createLimitError({ kind: 'entry-count' });
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
    assertEntryImageBudget(budget, image.size, declaredImageBytes, ordinal);
    declaredImageBytes += image.size;
    const bytes = new Uint8Array(await image.arrayBuffer());
    throwIfAborted(signal);
    // Recheck the owned buffer as defense-in-depth for non-native Blob-like
    // implementations used by tests or future adapters.
    assertEntryImageBudget(budget, bytes.byteLength, actualImageBytes, ordinal);
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

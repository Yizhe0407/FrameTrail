import { throwIfAborted } from '../shared/abort';
import { encodeBase64 } from './base64';
import { type Step } from '../storage/models';
import {
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_MIME_TYPE,
  PROJECT_ARCHIVE_VERSION,
  type ArchiveBlobV1,
  type ArchiveEnvelopeV2,
  type ArchiveStepV1,
  type ProjectArchiveOptions,
} from './project-archive-contract';
import {
  archiveMetadataFromInput,
  canonicalStepComparator,
  fail,
  validateGroups,
  validateRuntimeStep,
  validateScreenshotRaster,
} from './project-archive-validation';

function archiveStepFromRuntime(step: Step, screenshotBlobId?: string): ArchiveStepV1 {
  const archived: ArchiveStepV1 = {
    id: step.id,
    sessionId: step.sessionId,
    order: step.order,
    bounds: step.bounds,
    devicePixelRatio: step.devicePixelRatio,
    description: step.description,
    url: step.url,
    timestamp: step.timestamp,
  };
  if (step.runId !== undefined) archived.runId = step.runId;
  if (screenshotBlobId !== undefined) archived.screenshotBlobId = screenshotBlobId;
  if (step.manualBounds !== undefined) archived.manualBounds = step.manualBounds;
  if (step.redactions !== undefined) archived.redactions = step.redactions;
  if (step.redactionReviewRequired !== undefined) archived.redactionReviewRequired = step.redactionReviewRequired;
  if (step.screenshotScale !== undefined) archived.screenshotScale = step.screenshotScale;
  if (step.captureRevision !== undefined) archived.captureRevision = step.captureRevision;
  if (step.lastCaptureRunId !== undefined) archived.lastCaptureRunId = step.lastCaptureRunId;
  if (step.groupId !== undefined) archived.groupId = step.groupId;
  if (step.numbered !== undefined) archived.numbered = step.numbered;
  return archived;
}

/**
 * Serializes the archive as an ordered list of JSON fragments instead of one
 * `JSON.stringify(envelope)` string. The fragments concatenate to exactly the
 * canonical minified JSON, but each multi-MB base64 screenshot stays its own
 * string, so the Blob export path never materializes the whole archive as a
 * single contiguous JS string (up to maxArchiveBytes) on the heap.
 */
async function buildArchiveParts(stepsInput: readonly Step[], options: ProjectArchiveOptions = {}): Promise<string[]> {
  const { signal } = options;
  throwIfAborted(signal);
  if (!Array.isArray(stepsInput)) fail('INVALID_ARCHIVE', 'steps must be an array.');
  if (stepsInput.length > PROJECT_ARCHIVE_LIMITS.maxSteps) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxSteps} steps.`);
  }

  const steps = stepsInput.map((step, index) => validateRuntimeStep(step, `steps[${index}]`));
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) fail('DUPLICATE_ID', `Duplicate step id ${JSON.stringify(step.id)}.`);
    ids.add(step.id);
  }
  validateGroups(steps);
  steps.sort(canonicalStepComparator);
  const metadata = archiveMetadataFromInput(options.metadata, steps);

  const archivedSteps: ArchiveStepV1[] = [];
  const blobParts: string[] = [];
  let blobCount = 0;
  let totalScreenshotBytes = 0;
  for (let index = 0; index < steps.length; index += 1) {
    throwIfAborted(signal);
    const step = steps[index];
    let blobId: string | undefined;
    if (step.screenshotBlob) {
      if (blobCount >= PROJECT_ARCHIVE_LIMITS.maxScreenshots) {
        fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxScreenshots} screenshots.`);
      }
      totalScreenshotBytes += step.screenshotBlob.size;
      if (totalScreenshotBytes > PROJECT_ARCHIVE_LIMITS.maxTotalScreenshotBytes) {
        fail('LIMIT_EXCEEDED', 'The screenshots exceed the total archive byte limit.');
      }
      blobCount += 1;
      blobId = `screenshot-${String(blobCount).padStart(6, '0')}`;
      await validateScreenshotRaster(step.screenshotBlob, `steps[${index}].screenshotBlob`);
      throwIfAborted(signal);
      const bytes = new Uint8Array(await step.screenshotBlob.arrayBuffer());
      throwIfAborted(signal);
      blobParts.push(serializeArchiveBlob(blobId, step.screenshotBlob.type, bytes, signal));
    }
    archivedSteps.push(archiveStepFromRuntime(step, blobId));
  }

  const manifest: ArchiveEnvelopeV2['manifest'] = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    stepCount: archivedSteps.length,
    blobCount,
    steps: archivedSteps,
    metadata,
  };
  const parts = ['{"manifest":', JSON.stringify(manifest), ',"blobs":['];
  for (const [index, blobPart] of blobParts.entries()) {
    if (index > 0) parts.push(',');
    parts.push(blobPart);
  }
  parts.push(']}');
  // The parts now carry the only copy the archive needs; drop the per-blob
  // fragments' extra references before the size check instead of keeping the
  // whole payload reachable twice until this function returns.
  blobParts.length = 0;
  archivedSteps.length = 0;
  throwIfAborted(signal);
  assertArchiveWithinLimit(parts);
  return parts;
}

/** One blob object's canonical JSON. Assembled by hand only to splice the raw
 * base64 payload in directly: it uses no characters JSON would escape, so
 * running the multi-MB string through JSON.stringify would merely copy it. */
function serializeArchiveBlob(id: string, mediaType: string, bytes: Uint8Array, signal?: AbortSignal): string {
  const blob: Omit<ArchiveBlobV1, 'data'> = { id, mediaType, size: bytes.byteLength, encoding: 'base64' };
  return `${JSON.stringify(blob).slice(0, -1)},"data":"${encodeBase64(bytes, signal)}"}`;
}

/**
 * Enforces maxArchiveBytes (UTF-8 encoded size) without materializing another
 * full copy of the archive on the JS heap: UTF-8 needs between one and three
 * bytes per UTF-16 code unit, so the combined character length bounds the
 * encoded size from below and length * 3 bounds it from above. Only the
 * narrow band in between needs an exact measurement, which Blob provides
 * off-heap.
 */
function assertArchiveWithinLimit(parts: readonly string[]): void {
  const limit = PROJECT_ARCHIVE_LIMITS.maxArchiveBytes;
  let length = 0;
  for (const part of parts) length += part.length;
  if (length * 3 <= limit) return;
  if (length > limit || new Blob([...parts]).size > limit) {
    fail('ARCHIVE_TOO_LARGE', 'The encoded project archive is too large.');
  }
}

/** Returns canonical JSON. Step and blob ordering is stable for the same project data. */
export async function serializeProjectArchive(
  steps: readonly Step[],
  options: ProjectArchiveOptions = {},
): Promise<string> {
  return (await buildArchiveParts(steps, options)).join('');
}

/** Creates a self-contained project file containing JSON metadata and base64
 * raster screenshots. Streams the JSON fragments straight into the Blob so the
 * complete archive text never exists as one contiguous JS string. */
export async function exportProjectArchive(
  steps: readonly Step[],
  options: ProjectArchiveOptions = {},
): Promise<Blob> {
  return new Blob(await buildArchiveParts(steps, options), { type: PROJECT_ARCHIVE_MIME_TYPE });
}

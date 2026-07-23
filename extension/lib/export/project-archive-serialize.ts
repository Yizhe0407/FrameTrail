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
  throwIfAborted,
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

async function buildArchiveText(stepsInput: readonly Step[], options: ProjectArchiveOptions = {}): Promise<string> {
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
  const blobs: ArchiveBlobV1[] = [];
  let totalScreenshotBytes = 0;
  for (let index = 0; index < steps.length; index += 1) {
    throwIfAborted(signal);
    const step = steps[index];
    let blobId: string | undefined;
    if (step.screenshotBlob) {
      if (blobs.length >= PROJECT_ARCHIVE_LIMITS.maxScreenshots) {
        fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxScreenshots} screenshots.`);
      }
      totalScreenshotBytes += step.screenshotBlob.size;
      if (totalScreenshotBytes > PROJECT_ARCHIVE_LIMITS.maxTotalScreenshotBytes) {
        fail('LIMIT_EXCEEDED', 'The screenshots exceed the total archive byte limit.');
      }
      blobId = `screenshot-${String(blobs.length + 1).padStart(6, '0')}`;
      await validateScreenshotRaster(step.screenshotBlob, `steps[${index}].screenshotBlob`);
      throwIfAborted(signal);
      const bytes = new Uint8Array(await step.screenshotBlob.arrayBuffer());
      throwIfAborted(signal);
      blobs.push({
        id: blobId,
        mediaType: step.screenshotBlob.type,
        size: bytes.byteLength,
        encoding: 'base64',
        data: encodeBase64(bytes, signal),
      });
    }
    archivedSteps.push(archiveStepFromRuntime(step, blobId));
  }

  const envelope: ArchiveEnvelopeV2 = {
    manifest: {
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      stepCount: archivedSteps.length,
      blobCount: blobs.length,
      steps: archivedSteps,
      metadata,
    },
    blobs,
  };
  const text = JSON.stringify(envelope);
  if (new TextEncoder().encode(text).byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    fail('ARCHIVE_TOO_LARGE', 'The encoded project archive is too large.');
  }
  throwIfAborted(signal);
  return text;
}

/** Returns canonical JSON. Step and blob ordering is stable for the same project data. */
export async function serializeProjectArchive(
  steps: readonly Step[],
  options: ProjectArchiveOptions = {},
): Promise<string> {
  return buildArchiveText(steps, options);
}

/** Creates a self-contained project file containing JSON metadata and base64 raster screenshots. */
export async function exportProjectArchive(
  steps: readonly Step[],
  options: ProjectArchiveOptions = {},
): Promise<Blob> {
  return new Blob([await buildArchiveText(steps, options)], { type: PROJECT_ARCHIVE_MIME_TYPE });
}

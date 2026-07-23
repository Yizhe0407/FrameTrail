import { type Step } from '../storage/models';
import {
  BLOB_KEYS,
  ENVELOPE_KEYS,
  MANIFEST_V1_KEYS,
  MANIFEST_V2_KEYS,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LEGACY_VERSION,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_VERSION,
  SAFE_SCREENSHOT_MEDIA_TYPES,
  STEP_KEYS,
  type ImportedProjectArchive,
  type JsonRecord,
  type ProjectArchiveImportOptions,
  type ProjectArchiveImportWithMetadataOptions,
  type ProjectArchiveSource,
} from './project-archive-contract';
import {
  assertExactKeys,
  base64ToBytes,
  canonicalStepComparator,
  expectArray,
  expectIdentifier,
  expectRecord,
  expectSafeInteger,
  expectString,
  fail,
  hasOwn,
  parseArchiveMetadata,
  remapImportedProject,
  throwIfAborted,
  validateGroups,
  validateRuntimeStep,
  validateScreenshotRaster,
} from './project-archive-validation';

async function sourceToText(source: ProjectArchiveSource, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  let bytes: Uint8Array;
  if (typeof source === 'string') {
    // Every UTF-16 code unit needs at least one UTF-8 byte, so this cheap check
    // avoids allocating another huge buffer for an obviously oversized string.
    if (source.length > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
    }
    bytes = new TextEncoder().encode(source);
  } else if (source instanceof Blob) {
    if (source.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
    }
    bytes = new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else if (ArrayBuffer.isView(source)) {
    if (source.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
    }
    bytes = new Uint8Array(source.byteLength);
    bytes.set(new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength));
  } else {
    fail('INVALID_ARCHIVE', 'The project archive source has an unsupported type.');
  }
  throwIfAborted(signal);
  if (bytes.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_JSON', 'The project archive is not valid UTF-8.');
  }
}

function parseArchiveStep(recordValue: unknown, path: string, blobs: Map<string, Blob>, usedBlobs: Set<string>): Step {
  const record = expectRecord(recordValue, path);
  assertExactKeys(record, STEP_KEYS, path);

  const runtime: JsonRecord = { ...record };
  delete runtime.screenshotBlobId;
  if (hasOwn(record, 'screenshotBlobId')) {
    const blobId = expectIdentifier(record.screenshotBlobId, `${path}.screenshotBlobId`);
    const blob = blobs.get(blobId);
    if (!blob) fail('INVALID_BLOB', `${path} references missing screenshot ${JSON.stringify(blobId)}.`);
    runtime.screenshotBlob = blob;
    usedBlobs.add(blobId);
  }
  return validateRuntimeStep(runtime, path);
}

async function parseBlobRecords(value: unknown, expectedCount: number, signal?: AbortSignal): Promise<Map<string, Blob>> {
  const records = expectArray(value, 'blobs');
  if (records.length !== expectedCount) fail('INVALID_ARCHIVE', 'manifest.blobCount does not match blobs.length.');
  if (records.length > PROJECT_ARCHIVE_LIMITS.maxScreenshots) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxScreenshots} screenshots.`);
  }

  const result = new Map<string, Blob>();
  let totalSize = 0;
  for (let index = 0; index < records.length; index += 1) {
    throwIfAborted(signal);
    const path = `blobs[${index}]`;
    const record = expectRecord(records[index], path);
    assertExactKeys(record, BLOB_KEYS, path);
    const id = expectIdentifier(record.id, `${path}.id`);
    if (result.has(id)) fail('DUPLICATE_ID', `Duplicate screenshot id ${JSON.stringify(id)}.`);
    const mediaType = expectString(record.mediaType, `${path}.mediaType`, 64, false);
    if (!SAFE_SCREENSHOT_MEDIA_TYPES.has(mediaType)) {
      fail('INVALID_BLOB', `${path}.mediaType is not a supported raster screenshot type.`);
    }
    const size = expectSafeInteger(record.size, `${path}.size`, 1, PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes);
    totalSize += size;
    if (totalSize > PROJECT_ARCHIVE_LIMITS.maxTotalScreenshotBytes) {
      fail('LIMIT_EXCEEDED', 'The screenshots exceed the total archive byte limit.');
    }
    if (record.encoding !== 'base64') fail('INVALID_BLOB', `${path}.encoding must be "base64".`);
    const data = expectString(
      record.data,
      `${path}.data`,
      Math.ceil(PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes / 3) * 4,
      false,
    );
    const blob = new Blob([base64ToBytes(data, size, `${path}.data`, signal)], { type: mediaType });
    await validateScreenshotRaster(blob, path);
    throwIfAborted(signal);
    result.set(id, blob);
  }
  return result;
}

/** Strictly parses an archive into fresh, collision-resistant Step ids and screenshot Blobs. */
export function importProjectArchive(
  source: ProjectArchiveSource,
  options: ProjectArchiveImportWithMetadataOptions,
): Promise<ImportedProjectArchive>;
export function importProjectArchive(
  source: ProjectArchiveSource,
  options?: ProjectArchiveImportOptions,
): Promise<Step[]>;
export async function importProjectArchive(
  source: ProjectArchiveSource,
  options: ProjectArchiveImportOptions | ProjectArchiveImportWithMetadataOptions = {},
): Promise<Step[] | ImportedProjectArchive> {
  const { signal } = options;
  const text = await sourceToText(source, signal);
  throwIfAborted(signal);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail('INVALID_JSON', 'The project archive is not valid JSON.');
  }

  const envelope = expectRecord(parsed, 'archive');
  const manifest = expectRecord(envelope.manifest, 'manifest');

  // Read format/version before applying a concrete schema so future versions
  // fail explicitly instead of being misreported as an unknown-field error.
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) fail('INVALID_ARCHIVE', 'Unrecognized project archive format.');
  if (!Number.isSafeInteger(manifest.version)) fail('INVALID_ARCHIVE', 'manifest.version must be an integer.');
  if (manifest.version !== PROJECT_ARCHIVE_LEGACY_VERSION && manifest.version !== PROJECT_ARCHIVE_VERSION) {
    fail('UNSUPPORTED_VERSION', `Project archive version ${String(manifest.version)} is not supported.`);
  }
  const version = manifest.version as ImportedProjectArchive['version'];
  assertExactKeys(envelope, ENVELOPE_KEYS, 'archive');
  assertExactKeys(
    manifest,
    version === PROJECT_ARCHIVE_LEGACY_VERSION ? MANIFEST_V1_KEYS : MANIFEST_V2_KEYS,
    'manifest',
  );

  const stepCount = expectSafeInteger(manifest.stepCount, 'manifest.stepCount', 0, PROJECT_ARCHIVE_LIMITS.maxSteps);
  const blobCount = expectSafeInteger(
    manifest.blobCount,
    'manifest.blobCount',
    0,
    PROJECT_ARCHIVE_LIMITS.maxScreenshots,
  );
  const rawSteps = expectArray(manifest.steps, 'manifest.steps');
  if (rawSteps.length !== stepCount) fail('INVALID_ARCHIVE', 'manifest.stepCount does not match manifest.steps.length.');
  if (rawSteps.length > PROJECT_ARCHIVE_LIMITS.maxSteps) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxSteps} steps.`);
  }

  const blobs = await parseBlobRecords(envelope.blobs, blobCount, signal);
  const usedBlobs = new Set<string>();
  const steps = rawSteps.map((step, index) => {
    throwIfAborted(signal);
    return parseArchiveStep(step, `manifest.steps[${index}]`, blobs, usedBlobs);
  });

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) fail('DUPLICATE_ID', `Duplicate step id ${JSON.stringify(step.id)}.`);
    ids.add(step.id);
  }
  for (const blobId of blobs.keys()) {
    if (!usedBlobs.has(blobId)) fail('INVALID_BLOB', `Screenshot ${JSON.stringify(blobId)} is not referenced by a step.`);
  }
  validateGroups(steps);
  steps.sort(canonicalStepComparator);

  const metadata = version === PROJECT_ARCHIVE_VERSION
    ? parseArchiveMetadata(manifest.metadata, steps)
    : { title: '', description: '', sections: [] };
  const remapped = remapImportedProject(steps, metadata);
  throwIfAborted(signal);

  return options.includeMetadata
    ? { version, steps: remapped.steps, metadata: remapped.metadata }
    : remapped.steps;
}

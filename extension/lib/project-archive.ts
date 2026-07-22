import { encodeBase64 } from './base64';
import { buildStepEntries, type Bounds, type Redaction, type Step } from './db';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
import { RasterImageValidationError, validateRasterImageBlob } from './raster-image-validation';
import {
  GUIDE_SECTION_LIMITS,
  repairGuideSections,
  sanitizeGuideSectionTitle,
  type GuideSection,
} from './guide-sections';

export const PROJECT_ARCHIVE_FORMAT = 'frametrail-project';
export const PROJECT_ARCHIVE_LEGACY_VERSION = 1;
export const PROJECT_ARCHIVE_VERSION = 2;
export const PROJECT_ARCHIVE_MIME_TYPE = 'application/vnd.frametrail.project+json';

/** Public limits are exported so callers can explain rejected imports before retrying. */
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxTotalScreenshotBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes,
  maxScreenshotBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxSteps: PERSISTED_STEP_LIMITS.maxStepsPerGuide,
  maxScreenshots: PERSISTED_STEP_LIMITS.maxStepsPerGuide,
  maxRedactionsPerStep: PERSISTED_STEP_LIMITS.maxRedactionsPerStep,
  maxIdLength: PERSISTED_STEP_LIMITS.maxIdLength,
  maxTitleLength: 120,
  maxDescriptionLength: PERSISTED_STEP_LIMITS.maxDescriptionLength,
  maxGuideDescriptionLength: 2_000,
  maxSections: GUIDE_SECTION_LIMITS.maxSections,
  maxSectionTitleLength: GUIDE_SECTION_LIMITS.maxTitleLength,
  maxUrlLength: PERSISTED_STEP_LIMITS.maxUrlLength,
  maxCoordinateMagnitude: PERSISTED_STEP_LIMITS.maxCoordinateMagnitude,
  maxBoundsDimension: PERSISTED_STEP_LIMITS.maxBoundsDimension,
  maxPixelRatio: PERSISTED_STEP_LIMITS.maxPixelRatio,
});

export type ProjectArchiveErrorCode =
  | 'ARCHIVE_TOO_LARGE'
  | 'BROKEN_GROUP_REFERENCE'
  | 'DUPLICATE_ID'
  | 'INVALID_ARCHIVE'
  | 'INVALID_BLOB'
  | 'INVALID_JSON'
  | 'INVALID_REDACTION'
  | 'LIMIT_EXCEEDED'
  | 'UNSAFE_URL'
  | 'UNSUPPORTED_VERSION';

export class ProjectArchiveError extends Error {
  constructor(
    public readonly code: ProjectArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectArchiveError';
  }
}

export interface ProjectArchiveOptions {
  signal?: AbortSignal;
  /** Safe guide metadata included in newly-created v2 archives. */
  metadata?: ProjectArchiveMetadataInput;
}

export interface ProjectArchiveImportOptions {
  signal?: AbortSignal;
  includeMetadata?: false;
}

export interface ProjectArchiveImportWithMetadataOptions {
  signal?: AbortSignal;
  includeMetadata: true;
}

export interface ProjectArchiveMetadataInput {
  title?: string;
  description?: string;
  sections?: readonly GuideSection[];
}

export interface ProjectArchiveMetadata {
  title: string;
  description: string;
  sections: GuideSection[];
}

export interface ImportedProjectArchive {
  version: typeof PROJECT_ARCHIVE_LEGACY_VERSION | typeof PROJECT_ARCHIVE_VERSION;
  steps: Step[];
  /** Section start ids already refer to the remapped ids in `steps`. */
  metadata: ProjectArchiveMetadata;
}

export type ProjectArchiveSource = string | Blob | ArrayBuffer | ArrayBufferView;

type JsonRecord = Record<string, unknown>;

type ArchiveBounds = Bounds;
type ArchiveRedaction = Redaction;

interface ArchiveStepV1 {
  id: string;
  sessionId: string;
  runId?: string;
  order: number;
  screenshotBlobId?: string;
  bounds: ArchiveBounds | null;
  manualBounds?: ArchiveBounds | null;
  redactions?: ArchiveRedaction[];
  redactionReviewRequired?: boolean;
  devicePixelRatio: number;
  screenshotScale?: number;
  description: string;
  url: string;
  timestamp: number;
  captureRevision?: number;
  lastCaptureRunId?: string;
  groupId?: string;
  numbered?: boolean;
}

interface ArchiveBlobV1 {
  id: string;
  mediaType: string;
  size: number;
  encoding: 'base64';
  data: string;
}

interface ArchiveManifestV1 {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: typeof PROJECT_ARCHIVE_LEGACY_VERSION;
  stepCount: number;
  blobCount: number;
  steps: ArchiveStepV1[];
}

interface ArchiveEnvelopeV1 {
  manifest: ArchiveManifestV1;
  blobs: ArchiveBlobV1[];
}

interface ArchiveMetadataV2 {
  title: string;
  description: string;
  sections: GuideSection[];
}

interface ArchiveManifestV2 extends Omit<ArchiveManifestV1, 'version'> {
  version: typeof PROJECT_ARCHIVE_VERSION;
  metadata: ArchiveMetadataV2;
}

interface ArchiveEnvelopeV2 {
  manifest: ArchiveManifestV2;
  blobs: ArchiveBlobV1[];
}

const ENVELOPE_KEYS = ['manifest', 'blobs'] as const;
const MANIFEST_V1_KEYS = ['format', 'version', 'stepCount', 'blobCount', 'steps'] as const;
const MANIFEST_V2_KEYS = [...MANIFEST_V1_KEYS, 'metadata'] as const;
const METADATA_KEYS = ['title', 'description', 'sections'] as const;
const SECTION_KEYS = ['id', 'title', 'startEntryId'] as const;
const BLOB_KEYS = ['id', 'mediaType', 'size', 'encoding', 'data'] as const;
const BOUNDS_KEYS = ['x', 'y', 'width', 'height'] as const;
const REDACTION_KEYS = ['id', 'bounds', 'kind'] as const;
const STEP_KEYS = [
  'id',
  'sessionId',
  'runId',
  'order',
  'screenshotBlobId',
  'bounds',
  'manualBounds',
  'redactions',
  'redactionReviewRequired',
  'devicePixelRatio',
  'screenshotScale',
  'description',
  'url',
  'timestamp',
  'captureRevision',
  'lastCaptureRunId',
  'groupId',
  'numbered',
] as const;
const RUNTIME_STEP_KEYS = STEP_KEYS.map((key) => (key === 'screenshotBlobId' ? 'screenshotBlob' : key));
const SAFE_SCREENSHOT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
}

function fail(code: ProjectArchiveErrorCode, message: string): never {
  throw new ProjectArchiveError(code, message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail('INVALID_ARCHIVE', `${path} must be an object.`);
  return value;
}

function assertExactKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('INVALID_ARCHIVE', `${path} contains unknown field ${JSON.stringify(key)}.`);
  }
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_ARCHIVE', `${path} must be an array.`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ARCHIVE', `${path} must be a boolean.`);
  return value;
}

function expectSafeInteger(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('INVALID_ARCHIVE', `${path} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function expectFiniteNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_ARCHIVE', `${path} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function expectString(value: unknown, path: string, maximumLength: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximumLength || (!allowEmpty && value.length === 0)) {
    fail(
      'INVALID_ARCHIVE',
      `${path} must be ${allowEmpty ? '' : 'a non-empty '}string no longer than ${maximumLength} characters.`,
    );
  }
  return value;
}

function expectIdentifier(value: unknown, path: string): string {
  const identifier = expectString(value, path, PROJECT_ARCHIVE_LIMITS.maxIdLength, false);
  if (identifier.trim() !== identifier || /[\u0000-\u001f\u007f-\u009f]/u.test(identifier)) {
    fail('INVALID_ARCHIVE', `${path} contains invalid whitespace or control characters.`);
  }
  return identifier;
}

function expectText(value: unknown, path: string, maximumLength: number): string {
  const text = expectString(value, path, maximumLength);
  // Keep ordinary editing whitespace while rejecting NUL and non-text controls.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    fail('INVALID_ARCHIVE', `${path} contains invalid control characters.`);
  }
  return text;
}

function expectUrl(value: unknown, path: string): string {
  const raw = expectString(value, path, PROJECT_ARCHIVE_LIMITS.maxUrlLength, false);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(raw)) fail('UNSAFE_URL', `${path} contains control characters.`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('UNSAFE_URL', `${path} is not a valid absolute URL.`);
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    fail('UNSAFE_URL', `${path} must use http or https.`);
  }
  if (parsed.username || parsed.password) fail('UNSAFE_URL', `${path} must not contain embedded credentials.`);
  return raw;
}

function expectBounds(value: unknown, path: string): Bounds {
  const record = expectRecord(value, path);
  assertExactKeys(record, BOUNDS_KEYS, path);
  return {
    x: expectFiniteNumber(
      record.x,
      `${path}.x`,
      -PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
      PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
    ),
    y: expectFiniteNumber(
      record.y,
      `${path}.y`,
      -PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
      PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
    ),
    width: expectFiniteNumber(
      record.width,
      `${path}.width`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxBoundsDimension,
    ),
    height: expectFiniteNumber(
      record.height,
      `${path}.height`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxBoundsDimension,
    ),
  };
}

function expectNullableBounds(value: unknown, path: string): Bounds | null {
  return value === null ? null : expectBounds(value, path);
}

function expectRedactions(value: unknown, path: string): Redaction[] {
  const input = expectArray(value, path);
  if (input.length > PROJECT_ARCHIVE_LIMITS.maxRedactionsPerStep) {
    fail('LIMIT_EXCEEDED', `${path} contains too many redactions.`);
  }

  const ids = new Set<string>();
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    assertExactKeys(record, REDACTION_KEYS, itemPath);
    const id = expectIdentifier(record.id, `${itemPath}.id`);
    if (ids.has(id)) fail('DUPLICATE_ID', `${path} contains duplicate redaction id ${JSON.stringify(id)}.`);
    ids.add(id);
    if (record.kind !== 'solid') fail('INVALID_REDACTION', `${itemPath}.kind must be "solid".`);
    let bounds: Bounds;
    try {
      bounds = expectBounds(record.bounds, `${itemPath}.bounds`);
    } catch (error) {
      if (error instanceof ProjectArchiveError) {
        throw new ProjectArchiveError('INVALID_REDACTION', `${itemPath} has malformed bounds: ${error.message}`);
      }
      throw error;
    }
    return { id, bounds, kind: 'solid' };
  });
}

function expectOptionalString(record: JsonRecord, key: string, path: string): string | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectIdentifier(record[key], `${path}.${key}`);
}

function expectOptionalBoolean(record: JsonRecord, key: string, path: string): boolean | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectBoolean(record[key], `${path}.${key}`);
}

function expectOptionalNumber(
  record: JsonRecord,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectFiniteNumber(record[key], `${path}.${key}`, minimum, maximum);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalStepComparator(
  a: Pick<Step, 'sessionId' | 'order' | 'id'>,
  b: Pick<Step, 'sessionId' | 'order' | 'id'>,
): number {
  return compareStrings(a.sessionId, b.sessionId) || a.order - b.order || compareStrings(a.id, b.id);
}

function validateGroups(steps: readonly Step[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.groupId === undefined) continue;
    const anchor = byId.get(step.groupId);
    if (!anchor || anchor.groupId !== anchor.id || anchor.sessionId !== step.sessionId) {
      fail('BROKEN_GROUP_REFERENCE', `Step ${JSON.stringify(step.id)} has a broken group reference.`);
    }
    if (!anchor.screenshotBlob || anchor.bounds !== null) {
      fail('BROKEN_GROUP_REFERENCE', `Group anchor ${JSON.stringify(anchor.id)} is malformed.`);
    }
    if (anchor.numbered !== step.numbered) {
      fail('BROKEN_GROUP_REFERENCE', `Step ${JSON.stringify(step.id)} disagrees with its group anchor numbering.`);
    }
  }
}

function parseMetadataText(value: unknown, path: string, maximumLength: number): string {
  return expectText(value, path, maximumLength).trim();
}

function parseSectionRecords(value: unknown, path: string, steps: readonly Step[]): GuideSection[] {
  const records = expectArray(value, path);
  if (records.length > PROJECT_ARCHIVE_LIMITS.maxSections) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxSections} sections.`);
  }

  const sections: GuideSection[] = records.map((section, index) => {
    const sectionPath = `${path}[${index}]`;
    const record = expectRecord(section, sectionPath);
    assertExactKeys(record, SECTION_KEYS, sectionPath);
    const id = expectString(record.id, `${sectionPath}.id`, PROJECT_ARCHIVE_LIMITS.maxIdLength);
    const title = expectString(
      record.title,
      `${sectionPath}.title`,
      PROJECT_ARCHIVE_LIMITS.maxSectionTitleLength,
    );
    const startEntryId = expectString(
      record.startEntryId,
      `${sectionPath}.startEntryId`,
      PROJECT_ARCHIVE_LIMITS.maxIdLength,
    );
    return { id, title: sanitizeGuideSectionTitle(title), startEntryId };
  });

  return repairGuideSections(sections, buildStepEntries([...steps]));
}

function parseArchiveMetadata(value: unknown, steps: readonly Step[], path = 'manifest.metadata'): ProjectArchiveMetadata {
  const record = expectRecord(value, path);
  assertExactKeys(record, METADATA_KEYS, path);
  return {
    title: parseMetadataText(record.title, `${path}.title`, PROJECT_ARCHIVE_LIMITS.maxTitleLength),
    description: parseMetadataText(
      record.description,
      `${path}.description`,
      PROJECT_ARCHIVE_LIMITS.maxGuideDescriptionLength,
    ),
    sections: parseSectionRecords(record.sections, `${path}.sections`, steps),
  };
}

function archiveMetadataFromInput(value: ProjectArchiveMetadataInput | undefined, steps: readonly Step[]): ArchiveMetadataV2 {
  const record = expectRecord(value ?? {}, 'metadata');
  assertExactKeys(record, METADATA_KEYS, 'metadata');
  const title = hasOwn(record, 'title')
    ? parseMetadataText(record.title, 'metadata.title', PROJECT_ARCHIVE_LIMITS.maxTitleLength)
    : '';
  const description = hasOwn(record, 'description')
    ? parseMetadataText(
        record.description,
        'metadata.description',
        PROJECT_ARCHIVE_LIMITS.maxGuideDescriptionLength,
      )
    : '';
  const sections = hasOwn(record, 'sections')
    ? parseSectionRecords(record.sections, 'metadata.sections', steps)
    : [];
  return { title, description, sections };
}

function freshImportId(used: Set<string>): string {
  let id: string;
  do id = crypto.randomUUID();
  while (used.has(id));
  used.add(id);
  return id;
}

function remapImportedProject(
  steps: readonly Step[],
  metadata: ProjectArchiveMetadata,
): { steps: Step[]; metadata: ProjectArchiveMetadata } {
  const used = new Set<string>();
  const stepIds = new Map<string, string>();
  const sessionIds = new Map<string, string>();

  for (const step of steps) stepIds.set(step.id, freshImportId(used));
  for (const step of steps) {
    if (!sessionIds.has(step.sessionId)) sessionIds.set(step.sessionId, freshImportId(used));
  }

  const remappedSteps = steps.map((step) => ({
    ...step,
    id: stepIds.get(step.id)!,
    sessionId: sessionIds.get(step.sessionId)!,
    groupId: step.groupId === undefined ? undefined : stepIds.get(step.groupId),
  }));
  const remappedSections = metadata.sections.map((section) => ({
    ...section,
    startEntryId: stepIds.get(section.startEntryId) ?? '',
  }));

  return {
    steps: remappedSteps,
    metadata: {
      title: metadata.title,
      description: metadata.description,
      sections: repairGuideSections(remappedSections, buildStepEntries(remappedSteps)),
    },
  };
}

function validateRuntimeStep(stepValue: unknown, path: string): Step {
  const record = expectRecord(stepValue, path);
  assertExactKeys(record, RUNTIME_STEP_KEYS, path);

  const id = expectIdentifier(record.id, `${path}.id`);
  const sessionId = expectIdentifier(record.sessionId, `${path}.sessionId`);
  const bounds = expectNullableBounds(record.bounds, `${path}.bounds`);
  const screenshotBlob = hasOwn(record, 'screenshotBlob') && record.screenshotBlob !== undefined
    ? record.screenshotBlob
    : undefined;
  if (screenshotBlob !== undefined && !(screenshotBlob instanceof Blob)) {
    fail('INVALID_BLOB', `${path}.screenshotBlob must be a Blob.`);
  }
  if (screenshotBlob) validateScreenshotBlob(screenshotBlob, `${path}.screenshotBlob`);

  const step: Step = {
    id,
    sessionId,
    order: expectSafeInteger(record.order, `${path}.order`),
    bounds,
    devicePixelRatio: expectFiniteNumber(
      record.devicePixelRatio,
      `${path}.devicePixelRatio`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxPixelRatio,
    ),
    description: expectText(record.description, `${path}.description`, PROJECT_ARCHIVE_LIMITS.maxDescriptionLength),
    url: expectUrl(record.url, `${path}.url`),
    timestamp: expectSafeInteger(record.timestamp, `${path}.timestamp`),
  };

  if (screenshotBlob) step.screenshotBlob = screenshotBlob;
  const runId = expectOptionalString(record, 'runId', path);
  if (runId !== undefined) step.runId = runId;
  if (hasOwn(record, 'manualBounds') && record.manualBounds !== undefined) {
    step.manualBounds = expectNullableBounds(record.manualBounds, `${path}.manualBounds`);
  }
  if (hasOwn(record, 'redactions') && record.redactions !== undefined) {
    step.redactions = expectRedactions(record.redactions, `${path}.redactions`);
  }
  const redactionReviewRequired = expectOptionalBoolean(record, 'redactionReviewRequired', path);
  if (redactionReviewRequired !== undefined) step.redactionReviewRequired = redactionReviewRequired;
  const screenshotScale = expectOptionalNumber(
    record,
    'screenshotScale',
    path,
    Number.MIN_VALUE,
    PROJECT_ARCHIVE_LIMITS.maxPixelRatio,
  );
  if (screenshotScale !== undefined) step.screenshotScale = screenshotScale;
  if (hasOwn(record, 'captureRevision') && record.captureRevision !== undefined) {
    step.captureRevision = expectSafeInteger(record.captureRevision, `${path}.captureRevision`);
  }
  const lastCaptureRunId = expectOptionalString(record, 'lastCaptureRunId', path);
  if (lastCaptureRunId !== undefined) step.lastCaptureRunId = lastCaptureRunId;
  const groupId = expectOptionalString(record, 'groupId', path);
  if (groupId !== undefined) step.groupId = groupId;
  const numbered = expectOptionalBoolean(record, 'numbered', path);
  if (numbered !== undefined) step.numbered = numbered;
  return step;
}

function validateScreenshotBlob(blob: Blob, path: string): void {
  if (blob.size <= 0 || blob.size > PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes) {
    fail('INVALID_BLOB', `${path} must contain between 1 and ${PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes} bytes.`);
  }
  if (!SAFE_SCREENSHOT_MEDIA_TYPES.has(blob.type)) {
    fail('INVALID_BLOB', `${path} has unsupported media type ${JSON.stringify(blob.type)}.`);
  }
}

async function validateScreenshotRaster(blob: Blob, path: string): Promise<void> {
  try {
    await validateRasterImageBlob(blob);
  } catch (error) {
    if (error instanceof RasterImageValidationError) fail('INVALID_BLOB', `${path}: ${error.message}`);
    throw error;
  }
}

function decodedBase64Size(data: string, path: string): number {
  if (data.length === 0 || data.length % 4 !== 0) fail('INVALID_BLOB', `${path} is not canonical base64.`);
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = (data.length / 4) * 3 - padding;
  if (size <= 0 || size > PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes) {
    fail('INVALID_BLOB', `${path} decodes to an invalid screenshot size.`);
  }
  return size;
}

function base64ToBytes(
  data: string,
  expectedSize: number,
  path: string,
  signal?: AbortSignal,
): Uint8Array<ArrayBuffer> {
  const size = decodedBase64Size(data, path);
  if (size !== expectedSize) fail('INVALID_BLOB', `${path} does not match its declared size.`);

  const output = new Uint8Array(size);
  let outputIndex = 0;
  for (let index = 0; index < data.length; index += 4) {
    if ((index & 0xffff) === 0) throwIfAborted(signal);
    const isLast = index + 4 === data.length;
    const c0 = data.charCodeAt(index);
    const c1 = data.charCodeAt(index + 1);
    const c2 = data.charCodeAt(index + 2);
    const c3 = data.charCodeAt(index + 3);
    const v0 = c0 < 128 ? BASE64_VALUES[c0] : -1;
    const v1 = c1 < 128 ? BASE64_VALUES[c1] : -1;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? BASE64_VALUES[c2] : -1;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? BASE64_VALUES[c3] : -1;
    if (
      v0 < 0 ||
      v1 < 0 ||
      v2 < 0 ||
      v3 < 0 ||
      (!isLast && (c2 === 61 || c3 === 61)) ||
      (c2 === 61 && c3 !== 61)
    ) {
      fail('INVALID_BLOB', `${path} is not canonical base64.`);
    }
    const combined = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outputIndex < size) output[outputIndex++] = (combined >>> 16) & 255;
    if (outputIndex < size) output[outputIndex++] = (combined >>> 8) & 255;
    if (outputIndex < size) output[outputIndex++] = combined & 255;
  }

  // Canonical padding bits must be zero, preventing multiple encodings of the same bytes.
  const finalQuartet = data.slice(-4);
  if (
    (finalQuartet.endsWith('==') && (BASE64_VALUES[finalQuartet.charCodeAt(1)] & 15) !== 0) ||
    (finalQuartet.endsWith('=') && !finalQuartet.endsWith('==') && (BASE64_VALUES[finalQuartet.charCodeAt(2)] & 3) !== 0)
  ) {
    fail('INVALID_BLOB', `${path} has non-canonical padding bits.`);
  }
  return output;
}

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

/** Naming aliases for callers that prefer create/parse terminology. */
export const createProjectArchive = exportProjectArchive;
export const parseProjectArchive = importProjectArchive;

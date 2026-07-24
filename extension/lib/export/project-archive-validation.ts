import { buildStepEntries, type Bounds, type Redaction, type Step } from '../storage/models';
import { RasterImageValidationError, validateRasterImageBlob } from '../capture/raster-image-validation';
import {
  repairGuideSections,
  sanitizeGuideSectionTitle,
  type GuideSection,
} from '../guide/guide-sections';
import {
  BASE64_VALUES,
  BOUNDS_KEYS,
  METADATA_KEYS,
  PROJECT_ARCHIVE_LIMITS,
  REDACTION_KEYS,
  RUNTIME_STEP_KEYS,
  SAFE_SCREENSHOT_MEDIA_TYPES,
  SECTION_KEYS,
  ProjectArchiveError,
  type ArchiveMetadataV2,
  type JsonRecord,
  type ProjectArchiveErrorCode,
  type ProjectArchiveMetadata,
  type ProjectArchiveMetadataInput,
} from './project-archive-contract';

export function fail(code: ProjectArchiveErrorCode, message: string): never {
  throw new ProjectArchiveError(code, message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail('INVALID_ARCHIVE', `${path} must be an object.`);
  return value;
}

export function assertExactKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('INVALID_ARCHIVE', `${path} contains unknown field ${JSON.stringify(key)}.`);
  }
}

export function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_ARCHIVE', `${path} must be an array.`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ARCHIVE', `${path} must be a boolean.`);
  return value;
}

export function expectSafeInteger(
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

export function expectString(value: unknown, path: string, maximumLength: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximumLength || (!allowEmpty && value.length === 0)) {
    fail(
      'INVALID_ARCHIVE',
      `${path} must be ${allowEmpty ? '' : 'a non-empty '}string no longer than ${maximumLength} characters.`,
    );
  }
  return value;
}

export function expectIdentifier(value: unknown, path: string): string {
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

export function canonicalStepComparator(
  a: Pick<Step, 'sessionId' | 'order' | 'id'>,
  b: Pick<Step, 'sessionId' | 'order' | 'id'>,
): number {
  return compareStrings(a.sessionId, b.sessionId) || a.order - b.order || compareStrings(a.id, b.id);
}

export function validateGroups(steps: readonly Step[]): void {
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

export function parseArchiveMetadata(value: unknown, steps: readonly Step[], path = 'manifest.metadata'): ProjectArchiveMetadata {
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

export function archiveMetadataFromInput(value: ProjectArchiveMetadataInput | undefined, steps: readonly Step[]): ArchiveMetadataV2 {
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

export function remapImportedProject(
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

export function validateRuntimeStep(stepValue: unknown, path: string): Step {
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

export async function validateScreenshotRaster(blob: Blob, path: string): Promise<void> {
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

export function base64ToBytes(
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

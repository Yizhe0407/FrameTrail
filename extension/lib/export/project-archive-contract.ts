import type { Bounds, Redaction, Step } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { GUIDE_SECTION_LIMITS, type GuideSection } from '../guide/guide-section-model';

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

export type JsonRecord = Record<string, unknown>;

export type ArchiveBounds = Bounds;
export type ArchiveRedaction = Redaction;

export interface ArchiveStepV1 {
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

export interface ArchiveBlobV1 {
  id: string;
  mediaType: string;
  size: number;
  encoding: 'base64';
  data: string;
}

export interface ArchiveManifestV1 {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: typeof PROJECT_ARCHIVE_LEGACY_VERSION;
  stepCount: number;
  blobCount: number;
  steps: ArchiveStepV1[];
}

export interface ArchiveEnvelopeV1 {
  manifest: ArchiveManifestV1;
  blobs: ArchiveBlobV1[];
}

export interface ArchiveMetadataV2 {
  title: string;
  description: string;
  sections: GuideSection[];
}

export interface ArchiveManifestV2 extends Omit<ArchiveManifestV1, 'version'> {
  version: typeof PROJECT_ARCHIVE_VERSION;
  metadata: ArchiveMetadataV2;
}

export interface ArchiveEnvelopeV2 {
  manifest: ArchiveManifestV2;
  blobs: ArchiveBlobV1[];
}

export const ENVELOPE_KEYS = ['manifest', 'blobs'] as const;
export const MANIFEST_V1_KEYS = ['format', 'version', 'stepCount', 'blobCount', 'steps'] as const;
export const MANIFEST_V2_KEYS = [...MANIFEST_V1_KEYS, 'metadata'] as const;
export const METADATA_KEYS = ['title', 'description', 'sections'] as const;
export const SECTION_KEYS = ['id', 'title', 'startEntryId'] as const;
export const BLOB_KEYS = ['id', 'mediaType', 'size', 'encoding', 'data'] as const;
export const BOUNDS_KEYS = ['x', 'y', 'width', 'height'] as const;
export const REDACTION_KEYS = ['id', 'bounds', 'kind'] as const;
export const STEP_KEYS = [
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
export const RUNTIME_STEP_KEYS = STEP_KEYS.map((key) => (key === 'screenshotBlobId' ? 'screenshotBlob' : key));
export const SAFE_SCREENSHOT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
}

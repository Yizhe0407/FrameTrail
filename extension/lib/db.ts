import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  GUIDE_SECTION_LIMITS,
  repairGuideSections,
  sanitizeGuideSectionTitle,
  type GuideSection,
} from './guide-sections';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
export type { GuideSection } from './guide-sections';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isValidBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    Math.abs(bounds.x) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    Math.abs(bounds.y) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.width <= STEP_STORAGE_LIMITS.maxBoundsDimension &&
    bounds.height <= STEP_STORAGE_LIMITS.maxBoundsDimension &&
    Math.abs(bounds.x + bounds.width) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    Math.abs(bounds.y + bounds.height) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude
  );
}

export interface Redaction {
  id: string;
  bounds: Bounds;
  /** Privacy-safe v1 intentionally supports only a fully opaque fill. */
  kind: 'solid';
}

export interface OrderedAnnotation {
  bounds: Bounds;
  order: number;
}

export interface Step {
  id: string;
  sessionId: string;
  /** Recording run that created this row. Legacy/editor-created rows omit it. */
  runId?: string;
  order: number;
  /** Raw (un-annotated) screenshot — the highlight box is drawn at render/export time. */
  /** Only ordinary steps and snapshot anchors own image data. Snapshot
   * annotations refer to their anchor through groupId. Older recordings may
   * still contain a duplicate blob on annotations; writes strip it. */
  screenshotBlob?: Blob;
  /** Clicked element rect in CSS px, relative to the viewport at capture time. */
  bounds: Bounds | null;
  /** Non-destructive editor override. The original detected bounds stay intact
   * so a user can always restore the automatic selection. */
  manualBounds?: Bounds | null;
  /** Opaque privacy masks in screenshot CSS coordinates. Ordinary steps own
   * their masks; snapshot groups store them only on the shared anchor. */
  redactions?: Redaction[];
  /** Blocks normal preview/copy/export until masks are explicitly reviewed.
   * Set after recapturing an image that previously contained redactions, and
   * when malformed privacy metadata is detected during a write. */
  redactionReviewRequired?: boolean;
  devicePixelRatio: number;
  /** Actual screenshot pixels per CSS pixel, measured from the captured image. */
  screenshotScale?: number;
  description: string;
  url: string;
  timestamp: number;
  /** Incremented whenever a recapture replaces the screenshot Blob. */
  captureRevision?: number;
  /** Durable marker used to recover a recapture after service-worker restart. */
  lastCaptureRunId?: string;
  /** Present when this step is part of a single-image annotation group: the id
   * of the group's anchor step, which holds the shared screenshotBlob and
   * screenshot scale (every other member's own screenshotBlob is unused). The
   * anchor step's own groupId equals its own id (self-reference) and its
   * bounds is null — it's just the shared base image, not a clicked box.
   * A session can freely mix ordinary steps (groupId undefined, own
   * screenshot) and any number of these groups; each "start recording" in
   * snapshot mode begins a brand-new group rather than resuming an old one. */
  groupId?: string;
  /** Snapshot mode only: whether the group renders order-number badges.
   * Same value denormalized across every step sharing a groupId. */
  numbered?: boolean;
}

/** A locally persisted, editable guide. `id` intentionally remains identical
 * to the legacy Step.sessionId so existing recordings need no destructive
 * migration and all capture transaction guards keep their current semantics. */
export interface Guide {
  id: string;
  title: string;
  description: string;
  sections: GuideSection[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Monotonic guide-content generation. Metadata-only edits do not change it. */
  contentRevision: number;
  /** Denormalized summary fields kept transactionally in sync with `steps`. */
  stepCount: number;
  entryCount: number;
  storageBytes: number;
}

/** Kept as a named API type for compatibility; summaries are now guide rows. */
export interface GuideSummary extends Guide {}

export const GUIDE_TITLE_MAX_LENGTH = 120;
export const GUIDE_DESCRIPTION_MAX_LENGTH = 2_000;

/** Runtime persistence limits mirror the portable project format so data that
 * can be recorded locally can always be backed up without unbounded memory or
 * IndexedDB growth. */
export const STEP_STORAGE_LIMITS = Object.freeze({
  ...PERSISTED_STEP_LIMITS,
  maxMutationItems: PERSISTED_STEP_LIMITS.maxStepsPerGuide,
});

export class StepStorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepStorageValidationError';
  }
}

function storageError(message: string): never {
  throw new StepStorageValidationError(message);
}

function requireStorageIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > STEP_STORAGE_LIMITS.maxIdLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return storageError(`${field} is not a valid storage identifier.`);
  }
  return value;
}

function sanitizeStepText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || value.length > maximum) {
    return storageError(`${field} exceeds its storage limit.`);
  }
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function sanitizeStepUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > STEP_STORAGE_LIMITS.maxUrlLength) {
    return storageError('Step URL exceeds its storage limit.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return storageError('Step URL must be a valid HTTP(S) URL.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return storageError('Step URL must be a credential-free HTTP(S) URL.');
  }
  return parsed.href;
}

function sanitizeNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return storageError(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function sanitizePixelRatio(value: unknown, field: string): number {
  if (!Number.isFinite(value) || (value as number) <= 0 || (value as number) > STEP_STORAGE_LIMITS.maxPixelRatio) {
    return storageError(`${field} is outside the supported range.`);
  }
  return value as number;
}

function assertMutationItems(
  values: readonly unknown[],
  field: string,
  identifiers = false,
): void {
  if (values.length > STEP_STORAGE_LIMITS.maxMutationItems) {
    storageError(`${field} exceeds the mutation item limit.`);
  }
  if (identifiers) {
    for (const value of values) requireStorageIdentifier(value, `${field} item`);
  }
}

function sanitizeGuideText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maximum)
    : '';
}

function defaultGuideTitle(createdAt: number): string {
  const date = new Date(createdAt);
  const stamp = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
  return stamp ? `未命名教學 · ${stamp}` : '未命名教學';
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function sanitizeGuideSectionsShape(value: unknown): GuideSection[] {
  if (!Array.isArray(value)) return [];
  const sections: GuideSection[] = [];
  const seenIds = new Set<string>();
  const seenStarts = new Set<string>();
  for (const raw of value.slice(0, GUIDE_SECTION_LIMITS.maxSections)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Partial<GuideSection>;
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const startEntryId = typeof candidate.startEntryId === 'string' ? candidate.startEntryId : '';
    const title = sanitizeGuideSectionTitle(candidate.title);
    const validId = (identifier: string) => (
      identifier.length > 0
      && identifier.length <= GUIDE_SECTION_LIMITS.maxIdLength
      && identifier.trim() === identifier
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(identifier)
    );
    if (!validId(id) || !validId(startEntryId) || !title || seenIds.has(id) || seenStarts.has(startEntryId)) continue;
    seenIds.add(id);
    seenStarts.add(startEntryId);
    sections.push({ id, title, startEntryId });
  }
  return sections;
}

function sanitizeGuide(guide: Guide): Guide {
  const createdAt = Number.isFinite(guide.createdAt) ? guide.createdAt : Date.now();
  const updatedAt = Number.isFinite(guide.updatedAt) ? Math.max(guide.updatedAt, createdAt) : createdAt;
  const title = sanitizeGuideText(guide.title, GUIDE_TITLE_MAX_LENGTH) || defaultGuideTitle(createdAt);
  return {
    id: guide.id,
    title,
    description: sanitizeGuideText(guide.description, GUIDE_DESCRIPTION_MAX_LENGTH),
    sections: sanitizeGuideSectionsShape((guide as Guide & { sections?: unknown }).sections),
    createdAt,
    updatedAt,
    archivedAt: Number.isFinite(guide.archivedAt) ? guide.archivedAt : null,
    contentRevision: nonNegativeInteger(guide.contentRevision),
    stepCount: nonNegativeInteger(guide.stepCount),
    entryCount: nonNegativeInteger(guide.entryCount),
    storageBytes: nonNegativeInteger(guide.storageBytes),
  };
}

/** One renderable unit in a session's timeline: either an ordinary per-click
 * step, or a whole single-image group collapsed into its shared image plus
 * the ordered list of click annotations on it. */
export type ScreenshotStep = Step & { screenshotBlob: Blob };

export type StepEntry =
  | { kind: 'single'; step: ScreenshotStep }
  | { kind: 'group'; anchor: ScreenshotStep; annotations: Step[] };

export function getEffectiveBounds(step: Pick<Step, 'bounds' | 'manualBounds'>): Bounds | null {
  if (step.manualBounds && isValidBounds(step.manualBounds)) return step.manualBounds;
  return step.bounds && isValidBounds(step.bounds) ? step.bounds : null;
}

export function getEntryImageOwner(entry: StepEntry): ScreenshotStep {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function isValidRedaction(value: unknown): value is Redaction {
  if (!value || typeof value !== 'object') return false;
  const redaction = value as Partial<Redaction>;
  return (
    typeof redaction.id === 'string' &&
    redaction.id.length > 0 &&
    redaction.id.length <= STEP_STORAGE_LIMITS.maxIdLength &&
    redaction.id.trim() === redaction.id &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(redaction.id) &&
    redaction.kind === 'solid' &&
    Boolean(redaction.bounds) &&
    isValidBounds(redaction.bounds as Bounds)
  );
}

export interface EntryPrivacyState {
  redactions: Redaction[];
  reviewRequired: boolean;
}

/** Validates privacy metadata without silently treating corrupt masks as absent.
 * Any malformed record blocks ordinary rendering until the visual editor saves
 * a repaired, explicitly reviewed set. */
export function getEntryPrivacyState(entry: StepEntry): EntryPrivacyState {
  const owner = getEntryImageOwner(entry);
  const raw: unknown = owner.redactions;
  if (raw === undefined) {
    return { redactions: [], reviewRequired: owner.redactionReviewRequired === true };
  }
  if (!Array.isArray(raw)) return { redactions: [], reviewRequired: true };
  const rawItems = raw as unknown[];
  const redactions = rawItems.filter(isValidRedaction);
  if (redactions.length === rawItems.length) {
    // Keep the already-sanitized array identity on the hot preview path. This
    // avoids allocating a new array on every editor render, which otherwise
    // causes thumbnail overlay mapping observers to be torn down and rebuilt.
    return { redactions: owner.redactions as Redaction[], reviewRequired: owner.redactionReviewRequired === true };
  }
  return {
    redactions,
    reviewRequired: owner.redactionReviewRequired === true || redactions.length !== rawItems.length,
  };
}

export function getEntryRedactions(entry: StepEntry): Redaction[] {
  return getEntryPrivacyState(entry).redactions;
}

function sanitizeStepForStorage(step: Step): Step {
  const id = requireStorageIdentifier(step.id, 'Step id');
  const sessionId = requireStorageIdentifier(step.sessionId, 'Step session id');
  const groupId = step.groupId === undefined
    ? undefined
    : requireStorageIdentifier(step.groupId, 'Step group id');
  const isSnapshotAnnotation = groupId !== undefined && id !== groupId;

  if (step.screenshotBlob !== undefined && !(step.screenshotBlob instanceof Blob)) {
    storageError('Step screenshot must be a Blob.');
  }
  if (step.screenshotBlob && step.screenshotBlob.size > STEP_STORAGE_LIMITS.maxScreenshotBytes) {
    storageError('Step screenshot exceeds the per-image storage limit.');
  }

  let redactions: Redaction[] | undefined;
  let redactionReviewRequired = step.redactionReviewRequired === true;
  if (!isSnapshotAnnotation && step.redactions !== undefined) {
    if (!Array.isArray(step.redactions)) {
      redactions = [];
      redactionReviewRequired = true;
    } else {
      if (step.redactions.length > STEP_STORAGE_LIMITS.maxRedactionsPerStep) {
        storageError('Step contains too many privacy redactions.');
      }
      const seen = new Set<string>();
      redactions = [];
      for (const redaction of step.redactions as unknown[]) {
        if (!isValidRedaction(redaction) || seen.has(redaction.id)) {
          redactionReviewRequired = true;
          continue;
        }
        seen.add(redaction.id);
        redactions.push({ id: redaction.id, kind: 'solid', bounds: { ...redaction.bounds } });
      }
    }
  }

  const sanitized: Step = {
    id,
    sessionId,
    order: sanitizeNonNegativeSafeInteger(step.order, 'Step order'),
    bounds: step.bounds === null || step.bounds === undefined
      ? null
      : isValidBounds(step.bounds) ? { ...step.bounds } : null,
    devicePixelRatio: sanitizePixelRatio(step.devicePixelRatio, 'Step device pixel ratio'),
    description: sanitizeStepText(step.description, STEP_STORAGE_LIMITS.maxDescriptionLength, 'Step description'),
    url: sanitizeStepUrl(step.url),
    timestamp: sanitizeNonNegativeSafeInteger(step.timestamp, 'Step timestamp'),
  };

  if (step.runId !== undefined) sanitized.runId = requireStorageIdentifier(step.runId, 'Step run id');
  if (!isSnapshotAnnotation && step.screenshotBlob !== undefined) sanitized.screenshotBlob = step.screenshotBlob;
  if (step.manualBounds !== undefined) {
    sanitized.manualBounds = step.manualBounds !== null && isValidBounds(step.manualBounds)
      ? { ...step.manualBounds }
      : null;
  }
  if (redactions !== undefined) sanitized.redactions = redactions;
  if (!isSnapshotAnnotation && redactionReviewRequired) sanitized.redactionReviewRequired = true;
  if (step.screenshotScale !== undefined) {
    sanitized.screenshotScale = sanitizePixelRatio(step.screenshotScale, 'Step screenshot scale');
  }
  if (step.captureRevision !== undefined) {
    sanitized.captureRevision = sanitizeNonNegativeSafeInteger(step.captureRevision, 'Step capture revision');
  }
  if (step.lastCaptureRunId !== undefined) {
    sanitized.lastCaptureRunId = requireStorageIdentifier(step.lastCaptureRunId, 'Step last capture run id');
  }
  if (groupId !== undefined) sanitized.groupId = groupId;
  if (step.numbered !== undefined) sanitized.numbered = step.numbered === true;
  return sanitized;
}


/**
 * Groups a session's flat, order-sorted step list into displayable entries.
 * A group's anchor always has the lowest `order` among its members (it's
 * created first), so it's always the first occurrence of its groupId in the
 * sorted array — that's what keeps each group's entry positioned correctly
 * relative to ordinary steps around it.
 */
export function buildStepEntries(steps: Step[]): StepEntry[] {
  const entries: StepEntry[] = [];
  const seenGroups = new Set<string>();
  const groups = new Map<string, Step[]>();

  for (const step of steps) {
    if (!step.groupId) continue;
    const members = groups.get(step.groupId);
    if (members) members.push(step);
    else groups.set(step.groupId, [step]);
  }

  for (const step of steps) {
    if (!step.groupId) {
      // A partially-written/corrupt record without image data cannot be
      // rendered. Ignoring it keeps the rest of the session usable.
      if (step.screenshotBlob) entries.push({ kind: 'single', step: step as ScreenshotStep });
      continue;
    }
    if (seenGroups.has(step.groupId)) continue;
    seenGroups.add(step.groupId);
    const groupSteps = groups.get(step.groupId) ?? [];
    const anchor = groupSteps.find(
      (candidate): candidate is ScreenshotStep =>
        candidate.id === step.groupId && candidate.screenshotBlob !== undefined,
    );

    if (anchor) {
      // An anchor without any surviving annotation has no renderable content.
      // Do not surface it as a phantom snapshot whose old pixels can be
      // mistaken for a current annotation; deletion and stop cleanup remove
      // the rows, while this also sanitizes legacy empty groups on read.
      const annotations = groupSteps.filter(
        (candidate) => candidate.id !== step.groupId && getEffectiveBounds(candidate) !== null,
      );
      if (annotations.length === 0) continue;
      entries.push({
        kind: 'group',
        anchor,
        annotations,
      });
      continue;
    }

    // Salvage legacy members with their own screenshots when an anchor is
    // missing. New annotations have no blob and are safely omitted.
    for (const member of groupSteps) {
      if (member.screenshotBlob) entries.push({ kind: 'single', step: member as ScreenshotStep });
    }
  }

  return entries;
}

/** Stable id for a timeline entry — an ordinary step's own id, or a group's
 * anchor id — used as the @dnd-kit sortable key and as a selection key. */
export function entryId(entry: StepEntry): string {
  return entry.kind === 'single' ? entry.step.id : entry.anchor.id;
}

/** Flattens entries back into the complete, order-sorted list of step ids —
 * the shape reorderSteps needs (it must receive every id in the session, or
 * the steps left out keep their old `order` and can collide with the ones
 * renumbered here). */
export function flattenEntries(entries: StepEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'single' ? [entry.step.id] : [entry.anchor.id, ...entry.annotations.map((s) => s.id)],
  );
}


export class GuideStructureIntegrityError extends Error {
  constructor(message = 'Guide timeline contains incomplete or split entries.') {
    super(message);
    this.name = 'GuideStructureIntegrityError';
  }
}

function orderedSessionSteps(steps: readonly Step[]): Step[] {
  return [...steps].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** DB mutations use a strict topology parser instead of the UI's fail-soft
 * buildStepEntries(). Every persisted row must belong to exactly one complete,
 * contiguous entry so a snapshot can never be partially mutated. */
function buildCompleteStepEntries(steps: readonly Step[], expectedSessionId?: string): StepEntry[] {
  const sorted = orderedSessionSteps(steps);
  const entries: StepEntry[] = [];
  const seenGroups = new Set<string>();
  const seenIds = new Set<string>();

  for (let index = 0; index < sorted.length;) {
    const step = sorted[index];
    if (seenIds.has(step.id)) throw new GuideStructureIntegrityError('Guide contains duplicate step ids.');
    seenIds.add(step.id);
    if (expectedSessionId && step.sessionId !== expectedSessionId) {
      throw new GuideStructureIntegrityError('Guide contains a row from another session.');
    }
    if (!step.groupId) {
      if (!(step.screenshotBlob instanceof Blob)) {
        throw new GuideStructureIntegrityError('An ordinary entry is missing its screenshot.');
      }
      entries.push({ kind: 'single', step: step as ScreenshotStep });
      index += 1;
      continue;
    }

    const groupId = step.groupId;
    if (seenGroups.has(groupId) || step.id !== groupId || !(step.screenshotBlob instanceof Blob)) {
      throw new GuideStructureIntegrityError('A snapshot group is missing its leading image anchor.');
    }
    seenGroups.add(groupId);
    const anchor = step as ScreenshotStep;
    const annotations: Step[] = [];
    index += 1;
    while (index < sorted.length && sorted[index].groupId === groupId) {
      const annotation = sorted[index];
      if (seenIds.has(annotation.id) || annotation.id === groupId || !getEffectiveBounds(annotation)) {
        throw new GuideStructureIntegrityError('A snapshot group contains an invalid annotation.');
      }
      if (expectedSessionId && annotation.sessionId !== expectedSessionId) {
        throw new GuideStructureIntegrityError('A snapshot group crosses Guide boundaries.');
      }
      if (Boolean(annotation.numbered) !== Boolean(anchor.numbered)) {
        throw new GuideStructureIntegrityError('A snapshot group has inconsistent numbering metadata.');
      }
      seenIds.add(annotation.id);
      annotations.push(annotation);
      index += 1;
    }
    if (annotations.length === 0) {
      throw new GuideStructureIntegrityError('A snapshot group has no complete annotation.');
    }
    if (sorted.slice(index).some((candidate) => candidate.groupId === groupId)) {
      throw new GuideStructureIntegrityError('A snapshot group is split across the timeline.');
    }
    entries.push({ kind: 'group', anchor, annotations });
  }
  return entries;
}

function entrySteps(entry: StepEntry): Step[] {
  return entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations];
}

function flattenEntrySteps(entries: readonly StepEntry[]): Step[] {
  return entries.flatMap(entrySteps);
}

function assertExactEntryIds(actualEntries: readonly StepEntry[], requestedIds: readonly string[]): void {
  if (requestedIds.length !== actualEntries.length || new Set(requestedIds).size !== requestedIds.length) {
    throw new GuideStructureIntegrityError('Entry order must contain every entry exactly once.');
  }
  const actual = new Set(actualEntries.map(entryId));
  if (requestedIds.some((id) => !actual.has(id))) {
    throw new GuideStructureIntegrityError('Entry order contains an unknown or annotation id.');
  }
}

/** Converts persisted annotation steps into the geometry contract shared by
 * previews, clipboard compositing, and exports. Invalid legacy rows are
 * skipped instead of leaking non-null assertions into every caller. */
export function getOrderedAnnotations(steps: Step[]): OrderedAnnotation[] {
  const annotations: OrderedAnnotation[] = [];
  for (const step of steps) {
    const bounds = getEffectiveBounds(step);
    if (bounds) annotations.push({ bounds, order: annotations.length + 1 });
  }
  return annotations;
}

interface FrameTrailDB extends DBSchema {
  steps: {
    key: string;
    value: Step;
    indexes: { 'by-session': string };
  };
  guides: {
    key: string;
    value: Guide;
    indexes: { 'by-updated-at': number };
  };
}

type GuideStepsTransaction = IDBPTransaction<FrameTrailDB, ['guides', 'steps'], 'readwrite'>;
type ReadonlyGuideStepsTransaction = IDBPTransaction<FrameTrailDB, ['guides', 'steps'], 'readonly'>;

interface GroupSummaryAccumulator {
  hasAnchorImage: boolean;
  validAnnotationCount: number;
  fallbackImageCount: number;
}

interface SummaryAccumulator {
  stepCount: number;
  ordinaryEntryCount: number;
  storageBytes: number;
  groups: Map<string, GroupSummaryAccumulator>;
}

function createSummaryAccumulator(): SummaryAccumulator {
  return { stepCount: 0, ordinaryEntryCount: 0, storageBytes: 0, groups: new Map() };
}

function addStepToSummary(summary: SummaryAccumulator, step: Step): void {
  if (!step.groupId || step.id !== step.groupId) summary.stepCount += 1;
  summary.storageBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    summary.storageBytes + (step.screenshotBlob?.size ?? 0),
  );

  if (!step.groupId) {
    if (step.screenshotBlob) summary.ordinaryEntryCount += 1;
    return;
  }

  let group = summary.groups.get(step.groupId);
  if (!group) {
    group = { hasAnchorImage: false, validAnnotationCount: 0, fallbackImageCount: 0 };
    summary.groups.set(step.groupId, group);
  }
  if (step.id === step.groupId && step.screenshotBlob) group.hasAnchorImage = true;
  if (step.id !== step.groupId && getEffectiveBounds(step)) group.validAnnotationCount += 1;
  if (step.screenshotBlob) group.fallbackImageCount += 1;
}

function finishSummary(summary: SummaryAccumulator): Pick<Guide, 'stepCount' | 'entryCount' | 'storageBytes'> {
  let entryCount = summary.ordinaryEntryCount;
  for (const group of summary.groups.values()) {
    entryCount += group.hasAnchorImage
      ? Number(group.validAnnotationCount > 0)
      : group.fallbackImageCount;
  }
  return {
    stepCount: summary.stepCount,
    entryCount,
    storageBytes: summary.storageBytes,
  };
}

function summarizeSteps(steps: Iterable<Step>): Pick<Guide, 'stepCount' | 'entryCount' | 'storageBytes'> {
  const summary = createSummaryAccumulator();
  for (const step of steps) addStepToSummary(summary, step);
  return finishSummary(summary);
}

function assertGuideStorageLimits(
  summary: Pick<Guide, 'stepCount' | 'storageBytes'>,
  baseline?: Pick<Guide, 'stepCount' | 'storageBytes'>,
): void {
  if (
    summary.stepCount > STEP_STORAGE_LIMITS.maxStepsPerGuide &&
    (!baseline || summary.stepCount > baseline.stepCount)
  ) {
    storageError('Guide exceeds the maximum persisted step count.');
  }
  if (
    summary.storageBytes > STEP_STORAGE_LIMITS.maxTotalScreenshotBytes &&
    (!baseline || summary.storageBytes > baseline.storageBytes)
  ) {
    storageError('Guide exceeds the total screenshot storage limit.');
  }
}

function newGuide(
  id: string,
  now: number,
  initial?: Partial<Pick<Guide, 'title' | 'description'>>,
  summary: Pick<Guide, 'stepCount' | 'entryCount' | 'storageBytes'> = {
    stepCount: 0,
    entryCount: 0,
    storageBytes: 0,
  },
  contentRevision = 0,
): Guide {
  return sanitizeGuide({
    id: requireStorageIdentifier(id, 'Guide id'),
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    sections: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    contentRevision,
    ...summary,
  });
}

async function requireWritableGuide(tx: GuideStepsTransaction, id: string): Promise<Guide> {
  const guide = await tx.objectStore('guides').get(id);
  if (!guide) throw new Error('Guide not found.');
  const sanitized = sanitizeGuide(guide);
  if (sanitized.archivedAt !== null) throw new Error('Archived guides cannot be modified.');
  return sanitized;
}

async function refreshGuideSummary(
  tx: GuideStepsTransaction,
  guide: Guide,
  timestamp = Date.now(),
): Promise<Guide> {
  const summary = createSummaryAccumulator();
  let cursor = await tx.objectStore('steps').index('by-session').openCursor(guide.id);
  while (cursor) {
    addStepToSummary(summary, cursor.value);
    cursor = await cursor.continue();
  }
  const finishedSummary = finishSummary(summary);
  assertGuideStorageLimits(finishedSummary, guide);
  const updated = sanitizeGuide({
    ...guide,
    ...finishedSummary,
    updatedAt: Math.max(guide.updatedAt, timestamp, Date.now()),
    contentRevision: guide.contentRevision + 1,
  });
  await tx.objectStore('guides').put(updated);
  return updated;
}

async function abortTransaction(tx: GuideStepsTransaction, error: unknown): Promise<never> {
  try {
    tx.abort();
  } catch {
    // The transaction may already have been aborted by IndexedDB.
  }
  await tx.done.catch(() => undefined);
  throw error;
}

// Keep the original IndexedDB name to retain recordings made before the
// product rename. Guide ids intentionally reuse legacy session ids.
let databasePromise: Promise<IDBPDatabase<FrameTrailDB>> | undefined;
let databaseConnection: IDBPDatabase<FrameTrailDB> | undefined;

function getDatabase(): Promise<IDBPDatabase<FrameTrailDB>> {
  if (databasePromise) return databasePromise;
  databasePromise = openDB<FrameTrailDB>('scribe', 4, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const store = db.createObjectStore('steps', { keyPath: 'id' });
        store.createIndex('by-session', 'sessionId');
      }
      // v2 adds bounds/devicePixelRatio; v3 adds snapshot groups. Those rows
      // remain byte-for-byte untouched. v4 adds guide metadata and summaries.
      if (oldVersion < 4) {
        const guides = db.createObjectStore('guides', { keyPath: 'id' });
        guides.createIndex('by-updated-at', 'updatedAt');

        interface MigrationState {
          createdAt: number;
          updatedAt: number;
          summary: SummaryAccumulator;
        }
        const now = Date.now();
        const states = new Map<string, MigrationState>();
        // Cursor values are inspected only to derive metadata. We never getAll,
        // put, or otherwise rewrite the Blob-bearing legacy step records.
        let cursor = await transaction.objectStore('steps').openCursor();
        while (cursor) {
          const step = cursor.value;
          const timestamp = Number.isFinite(step.timestamp) ? step.timestamp : now;
          let state = states.get(step.sessionId);
          if (!state) {
            state = { createdAt: timestamp, updatedAt: timestamp, summary: createSummaryAccumulator() };
            states.set(step.sessionId, state);
          } else {
            state.createdAt = Math.min(state.createdAt, timestamp);
            state.updatedAt = Math.max(state.updatedAt, timestamp);
          }
          addStepToSummary(state.summary, step);
          cursor = await cursor.continue();
        }
        for (const [id, state] of states) {
          await guides.add(sanitizeGuide({
            id,
            title: defaultGuideTitle(state.createdAt),
            description: '',
            sections: [],
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            archivedAt: null,
            contentRevision: 0,
            ...finishSummary(state.summary),
          }));
        }
      }
    },
    blocked(currentVersion, blockedVersion) {
      console.warn(`FrameTrail database upgrade to ${blockedVersion ?? 'unknown'} is blocked by version ${currentVersion}.`);
    },
    blocking(currentVersion, blockedVersion) {
      // A versionchange must never remain blocked by this long-lived extension
      // context. Closing here lets the newer worker/page finish its upgrade.
      databaseConnection?.close();
      databaseConnection = undefined;
      databasePromise = undefined;
      console.warn(`FrameTrail database version ${currentVersion} closed for version ${blockedVersion ?? 'unknown'}.`);
    },
    terminated() {
      databaseConnection = undefined;
      databasePromise = undefined;
    },
  }).then((db) => {
    databaseConnection = db;
    return db;
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

/** Closes the shared connection. Primarily useful for tests and graceful teardown. */
export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = undefined;
  const db = databaseConnection ?? (pending ? await pending.catch(() => undefined) : undefined);
  databaseConnection = undefined;
  db?.close();
}

export async function createGuide(initial?: Partial<Pick<Guide, 'title' | 'description'>>): Promise<Guide> {
  const db = await getDatabase();
  const guide = newGuide(crypto.randomUUID(), Date.now(), initial);
  await db.add('guides', guide);
  return guide;
}

/** Explicit legacy/bootstrap primitive. Ordinary step mutations never call it. */
export async function ensureGuide(id: string, createdAt = Date.now()): Promise<Guide> {
  if (!id) throw new Error('Guide id is required.');
  const db = await getDatabase();
  const tx = db.transaction('guides', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing) {
    await tx.done;
    return sanitizeGuide(existing);
  }
  const guide = newGuide(id, createdAt);
  try {
    await tx.store.add(guide);
    await tx.done;
    return guide;
  } catch (error) {
    await tx.done.catch(() => undefined);
    // A concurrent explicit bootstrap may have won the add race.
    const winner = await db.get('guides', id);
    if (winner) return sanitizeGuide(winner);
    throw error;
  }
}

export async function getGuide(id: string): Promise<Guide | undefined> {
  const db = await getDatabase();
  const guide = await db.get('guides', id);
  return guide ? sanitizeGuide(guide) : undefined;
}

export async function updateGuide(
  id: string,
  changes: Partial<Pick<Guide, 'title' | 'description' | 'archivedAt'>>,
): Promise<Guide> {
  const db = await getDatabase();
  const tx = db.transaction('guides', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('Guide not found.');
  }
  const patch: Partial<Guide> = {};
  if (changes.title !== undefined) patch.title = changes.title;
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.archivedAt !== undefined) patch.archivedAt = changes.archivedAt;
  const updated = sanitizeGuide({ ...existing, ...patch, updatedAt: Math.max(existing.updatedAt, Date.now()) });
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/** Metadata-only touch. Missing guides are never recreated. */
export async function touchGuide(id: string, timestamp = Date.now()): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction('guides', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('Guide not found.');
  }
  await tx.store.put(sanitizeGuide({
    ...existing,
    updatedAt: Math.max(existing.updatedAt, timestamp),
  }));
  await tx.done;
}

/** Reads only denormalized guide rows; no step cursor or screenshot Blob is opened. */
export async function getGuideSummaries(includeArchived = false): Promise<GuideSummary[]> {
  const db = await getDatabase();
  const guides = (await db.getAllFromIndex('guides', 'by-updated-at'))
    .map(sanitizeGuide)
    .filter((guide) => includeArchived || guide.archivedAt === null);
  return guides.sort((first, second) => second.updatedAt - first.updatedAt);
}

interface PreparedGuideClone {
  guide: Guide;
  steps: Step[];
}

export interface CreateGuideFromStepsOptions {
  sections?: readonly GuideSection[];
}

function prepareGuideClone(
  sourceSteps: readonly Step[],
  initial?: Partial<Pick<Guide, 'title' | 'description'>>,
  options: CreateGuideFromStepsOptions = {},
): PreparedGuideClone {
  if (sourceSteps.length > STEP_STORAGE_LIMITS.maxStepsPerGuide) {
    storageError('Guide exceeds the maximum persisted step count.');
  }
  const now = Date.now();
  const guideId = crypto.randomUUID();
  const ids = new Map<string, string>();
  for (const step of sourceSteps) {
    if (ids.has(step.id)) throw new Error('Guide contains duplicate step ids.');
    ids.set(step.id, crypto.randomUUID());
  }
  for (const step of sourceSteps) {
    if (step.groupId && !ids.has(step.groupId)) throw new Error('Guide contains a broken snapshot reference.');
  }
  const sourceEntries = buildCompleteStepEntries(sourceSteps);
  const repairedSourceSections = repairGuideSections(options.sections ?? [], sourceEntries);
  const steps = [...sourceSteps]
    .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id))
    .map((step, order) => sanitizeStepForStorage({
      ...step,
      id: ids.get(step.id)!,
      sessionId: guideId,
      runId: undefined,
      order,
      groupId: step.groupId ? ids.get(step.groupId) : undefined,
      lastCaptureRunId: undefined,
      timestamp: Number.isFinite(step.timestamp) ? step.timestamp : now,
    }));
  const sections = repairedSourceSections.map((section) => ({
    id: crypto.randomUUID(),
    title: section.title,
    startEntryId: ids.get(section.startEntryId)!,
  }));
  const summary = summarizeSteps(steps);
  assertGuideStorageLimits(summary);
  const guide = newGuide(guideId, now, initial, summary, steps.length > 0 ? 1 : 0);
  guide.sections = sections;
  return { guide, steps };
}

async function storePreparedGuide(tx: GuideStepsTransaction, prepared: PreparedGuideClone): Promise<void> {
  await tx.objectStore('guides').add(prepared.guide);
  for (const step of prepared.steps) await tx.objectStore('steps').add(step);
}

export async function createGuideFromSteps(
  sourceSteps: readonly Step[],
  initial?: Partial<Pick<Guide, 'title' | 'description'>>,
  options: CreateGuideFromStepsOptions = {},
): Promise<Guide> {
  const prepared = prepareGuideClone(sourceSteps, initial, options);
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    await storePreparedGuide(tx, prepared);
    await tx.done;
    return prepared.guide;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Reads the source snapshot and writes its clone in one serializable transaction. */
export async function duplicateGuide(sourceId: string, title?: string): Promise<Guide> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const source = await tx.objectStore('guides').get(sourceId);
    if (!source) throw new Error('Guide not found.');
    const sourceSteps = await tx.objectStore('steps').index('by-session').getAll(sourceId);
    const sanitizedSource = sanitizeGuide(source);
    const prepared = prepareGuideClone(sourceSteps, {
      title: title ?? `${sanitizedSource.title}（副本）`,
      description: sanitizedSource.description,
    }, { sections: sanitizedSource.sections });
    await storePreparedGuide(tx, prepared);
    await tx.done;
    return prepared.guide;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

export async function deleteGuidePermanently(id: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  let cursor = await tx.objectStore('steps').index('by-session').openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore('guides').delete(id);
  await tx.done;
}

/** Atomically clears guide content while preserving identity and metadata. */
export async function resetGuide(id: string): Promise<Guide> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, id);
    let cursor = await tx.objectStore('steps').index('by-session').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    const reset = sanitizeGuide({
      ...guide,
      updatedAt: Math.max(guide.updatedAt, Date.now()),
      contentRevision: guide.contentRevision + 1,
      sections: [],
      stepCount: 0,
      entryCount: 0,
      storageBytes: 0,
    });
    await tx.objectStore('guides').put(reset);
    await tx.done;
    return reset;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

export type InsertionSide = 'before' | 'after';

export type InsertionErrorCode =
  | 'GUIDE_NOT_FOUND'
  | 'GUIDE_ARCHIVED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_CHANGED'
  | 'RUN_STATE_CHANGED';

export class InsertionRecordingError extends Error {
  constructor(public readonly code: InsertionErrorCode, message: string) {
    super(message);
    this.name = 'InsertionRecordingError';
  }
}


export class GuideContentConflictError extends Error {
  constructor(
    public readonly guideId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super('Guide content changed before the operation was committed.');
    this.name = 'GuideContentConflictError';
  }
}

export interface GuideStructureSnapshot {
  guide: Guide;
  entries: StepEntry[];
  entryIds: string[];
}

export interface GuideStructureMutationResult {
  guide: Guide;
  entryIds: string[];
  affectedEntryIds: string[];
}

export interface ReorderGuideEntriesResult extends GuideStructureMutationResult {
  /** Fresh transaction-local order, suitable for an undo CAS. */
  previousEntryIds: string[];
  /** Fresh transaction-local section metadata, before reorder repair/sorting. */
  previousSections: GuideSection[];
}

export interface DeleteGuideAnnotationResult extends GuideStructureMutationResult {
  /** Canonical snapshot read in the same transaction before any rows changed. */
  beforeSnapshot: GuideStructureSnapshot;
  /** Annotation order read from the persisted group, never from editor state. */
  previousAnnotationIds: string[];
  previousEntryIds: string[];
  previousSections: GuideSection[];
  /** One annotation normally; anchor + annotation when the group became empty. */
  deletedSteps: Step[];
  removedEntry: boolean;
}

export interface ReorderGuideAnnotationsResult extends GuideStructureMutationResult {
  previousAnnotationIds: string[];
}

export interface DuplicateGuideEntryResult extends GuideStructureMutationResult {
  createdEntryId: string;
}

interface WritableGuideStructure extends GuideStructureSnapshot {
  steps: Step[];
}

function structureSnapshot(guide: Guide, steps: readonly Step[]): GuideStructureSnapshot {
  const entries = buildCompleteStepEntries(steps, guide.id);
  const repairedGuide = sanitizeGuide({
    ...guide,
    sections: repairGuideSections(guide.sections, entries),
  });
  return { guide: repairedGuide, entries, entryIds: entries.map(entryId) };
}

function copyStructureSnapshot(structure: GuideStructureSnapshot): GuideStructureSnapshot {
  return {
    guide: {
      ...structure.guide,
      sections: structure.guide.sections.map((section) => ({ ...section })),
    },
    entries: structure.entries.map((entry): StepEntry => (
      entry.kind === 'single'
        ? { kind: 'single', step: { ...entry.step } }
        : {
            kind: 'group',
            anchor: { ...entry.anchor },
            annotations: entry.annotations.map((annotation) => ({ ...annotation })),
          }
    )),
    entryIds: [...structure.entryIds],
  };
}

function requireSnapshotGroup(entries: readonly StepEntry[], anchorId: string): Extract<StepEntry, { kind: 'group' }> {
  const entry = entries.find((candidate) => entryId(candidate) === anchorId);
  if (!entry || entry.kind !== 'group' || entry.anchor.id !== anchorId) {
    throw new GuideStructureIntegrityError('Snapshot anchor was not found or no longer owns a complete group.');
  }
  return entry;
}

function assertExactAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  orderedAnnotationIds: readonly string[],
): void {
  const actualIds = group.annotations.map((annotation) => annotation.id);
  if (
    orderedAnnotationIds.length !== actualIds.length
    || new Set(orderedAnnotationIds).size !== orderedAnnotationIds.length
  ) {
    throw new GuideStructureIntegrityError('Annotation order must contain every group annotation exactly once.');
  }
  const actual = new Set(actualIds);
  if (orderedAnnotationIds.some((id) => !actual.has(id))) {
    throw new GuideStructureIntegrityError('Annotation order contains an anchor or an annotation from another group.');
  }
}

function assertExactRestoredAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  restoredAnnotationId: string,
  previousAnnotationIds: readonly string[],
): void {
  const expectedIds = new Set([
    ...group.annotations.map((annotation) => annotation.id),
    restoredAnnotationId,
  ]);
  if (
    previousAnnotationIds.length !== group.annotations.length + 1
    || new Set(previousAnnotationIds).size !== previousAnnotationIds.length
    || expectedIds.size !== group.annotations.length + 1
    || previousAnnotationIds.some((id) => !expectedIds.has(id))
  ) {
    throw new GuideStructureIntegrityError(
      'Previous annotation order must contain the current group plus the restored annotation exactly once.',
    );
  }
}

async function requireWritableGuideStructure(
  tx: GuideStepsTransaction,
  sessionId: string,
  expectedContentRevision: number,
): Promise<WritableGuideStructure> {
  if (!Number.isSafeInteger(expectedContentRevision) || expectedContentRevision < 0) {
    throw new TypeError('Expected content revision must be a non-negative integer.');
  }
  const guide = await requireWritableGuide(tx, sessionId);
  if (guide.contentRevision !== expectedContentRevision) {
    throw new GuideContentConflictError(sessionId, expectedContentRevision, guide.contentRevision);
  }
  const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
  return { ...structureSnapshot(guide, steps), steps: orderedSessionSteps(steps) };
}

async function commitGuideStructure(
  tx: GuideStepsTransaction,
  structure: WritableGuideStructure,
  nextEntries: readonly StepEntry[],
  nextSections: readonly GuideSection[],
  affectedEntryIds: readonly string[],
): Promise<GuideStructureMutationResult> {
  const denseSteps = flattenEntrySteps(nextEntries).map((step, order) => (
    step.order === order ? step : { ...step, order }
  ));
  const completeEntries = buildCompleteStepEntries(denseSteps, structure.guide.id);
  const previousById = new Map(structure.steps.map((step) => [step.id, step]));
  const nextIds = new Set(denseSteps.map((step) => step.id));

  for (const previous of structure.steps) {
    if (!nextIds.has(previous.id)) await tx.objectStore('steps').delete(previous.id);
  }
  for (const step of denseSteps) {
    const previous = previousById.get(step.id);
    if (previous !== step) await tx.objectStore('steps').put(sanitizeStepForStorage(step));
  }

  const now = Date.now();
  const guide = sanitizeGuide({
    ...structure.guide,
    ...summarizeSteps(denseSteps),
    sections: repairGuideSections(nextSections, completeEntries),
    updatedAt: Math.max(structure.guide.updatedAt, now),
    contentRevision: structure.guide.contentRevision + 1,
  });
  await tx.objectStore('guides').put(guide);
  return {
    guide,
    entryIds: completeEntries.map(entryId),
    affectedEntryIds: [...new Set(affectedEntryIds)],
  };
}

async function runGuideStructureMutation<T extends GuideStructureMutationResult>(
  sessionId: string,
  expectedContentRevision: number,
  mutate: (tx: GuideStepsTransaction, structure: WritableGuideStructure) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const structure = await requireWritableGuideStructure(tx, sessionId, expectedContentRevision);
    const result = await mutate(tx, structure);
    await tx.done;
    return result;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

function requireEntrySelection(
  entries: readonly StepEntry[],
  requestedIds: readonly string[],
  allowEmpty = false,
): { selectedIds: Set<string>; byId: Map<string, StepEntry> } {
  const selectedIds = new Set(requestedIds);
  if ((!allowEmpty && selectedIds.size === 0) || selectedIds.size !== requestedIds.length) {
    throw new GuideStructureIntegrityError('Entry selection must contain unique entry ids.');
  }
  const byId = new Map(entries.map((entry) => [entryId(entry), entry]));
  if ([...selectedIds].some((id) => !byId.has(id))) {
    throw new GuideStructureIntegrityError('Entry selection contains an unknown or annotation id.');
  }
  return { selectedIds, byId };
}

function rebaseSectionsAfterDelete(
  sections: readonly GuideSection[],
  previousEntryIds: readonly string[],
  survivingEntryIds: ReadonlySet<string>,
): GuideSection[] {
  const starts = new Map(previousEntryIds.map((id, index) => [id, index]));
  const orderedSections = [...sections]
    .map((section) => ({ section, index: starts.get(section.startEntryId) }))
    .filter((item): item is { section: GuideSection; index: number } => item.index !== undefined)
    .sort((left, right) => left.index - right.index);
  const rebased: GuideSection[] = [];
  for (let index = 0; index < orderedSections.length; index += 1) {
    const current = orderedSections[index];
    const end = orderedSections[index + 1]?.index ?? previousEntryIds.length;
    const nextStart = previousEntryIds.slice(current.index, end).find((id) => survivingEntryIds.has(id));
    if (nextStart) rebased.push({ ...current.section, startEntryId: nextStart });
  }
  return rebased;
}

export async function getGuideStructureSnapshot(sessionId: string): Promise<GuideStructureSnapshot> {
  const db = await getDatabase();
  const tx: ReadonlyGuideStepsTransaction = db.transaction(['guides', 'steps'], 'readonly');
  const rawGuide = await tx.objectStore('guides').get(sessionId);
  if (!rawGuide) {
    await tx.done;
    throw new Error('Guide not found.');
  }
  const guide = sanitizeGuide(rawGuide);
  const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
  const snapshot = structureSnapshot(guide, steps);
  await tx.done;
  return snapshot;
}

export async function reorderGuideEntriesAtomically(
  sessionId: string,
  orderedEntryIds: readonly string[],
  expectedContentRevision: number,
): Promise<ReorderGuideEntriesResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    assertExactEntryIds(structure.entries, orderedEntryIds);
    const byId = new Map(structure.entries.map((entry) => [entryId(entry), entry]));
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.guide.sections.map((section) => ({ ...section }));
    const result = await commitGuideStructure(
      tx,
      structure,
      orderedEntryIds.map((id) => byId.get(id)!),
      structure.guide.sections,
      orderedEntryIds,
    );
    return { ...result, previousEntryIds, previousSections };
  });
}

export async function deleteGuideAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  annotationId: string,
  expectedContentRevision: number,
): Promise<DeleteGuideAnnotationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    const annotationIndex = group.annotations.findIndex((annotation) => annotation.id === annotationId);
    if (annotationIndex < 0) {
      throw new GuideStructureIntegrityError('Annotation does not belong to the requested snapshot group.');
    }

    const beforeSnapshot = copyStructureSnapshot(structure);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.guide.sections.map((section) => ({ ...section }));
    const removedEntry = group.annotations.length === 1;
    let nextEntries: StepEntry[];
    let nextSections: GuideSection[] = structure.guide.sections;
    let deletedSteps: Step[];

    if (removedEntry) {
      nextEntries = structure.entries.filter((entry) => entryId(entry) !== anchorId);
      const survivingIds = new Set(nextEntries.map(entryId));
      nextSections = rebaseSectionsAfterDelete(
        structure.guide.sections,
        structure.entryIds,
        survivingIds,
      );
      deletedSteps = [group.anchor, group.annotations[annotationIndex]];
    } else {
      const annotations = group.annotations.filter((annotation) => annotation.id !== annotationId);
      nextEntries = structure.entries.map((entry): StepEntry => (
        entryId(entry) === anchorId ? { kind: 'group', anchor: group.anchor, annotations } : entry
      ));
      deletedSteps = [group.annotations[annotationIndex]];
    }

    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      nextSections,
      [anchorId],
    );
    return {
      ...result,
      beforeSnapshot,
      previousAnnotationIds,
      previousEntryIds,
      previousSections,
      deletedSteps,
      removedEntry,
    };
  });
}

export async function reorderGuideAnnotationsAtomically(
  sessionId: string,
  anchorId: string,
  orderedAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<ReorderGuideAnnotationsResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    assertExactAnnotationIds(group, orderedAnnotationIds);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    const reorderedGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: orderedAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? reorderedGroup : entry
    ));
    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [anchorId],
    );
    return { ...result, previousAnnotationIds };
  });
}

/** Strict inverse of a non-terminal annotation delete. The restored row's old
 * numeric order is deliberately ignored: the transaction reconstructs the
 * complete group from previousAnnotationIds and then commits dense orders. */
export async function restoreGuideAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  restoredAnnotation: Step,
  previousAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    if (
      typeof restoredAnnotation.id !== 'string'
      || restoredAnnotation.id.length === 0
      || restoredAnnotation.id === anchorId
      || restoredAnnotation.sessionId !== sessionId
      || restoredAnnotation.groupId !== anchorId
    ) {
      throw new GuideStructureIntegrityError(
        'Restored annotation must be a distinct member of the requested snapshot group.',
      );
    }
    if (await tx.objectStore('steps').get(restoredAnnotation.id)) {
      throw new GuideStructureIntegrityError('Restored annotation id already exists.');
    }
    assertExactRestoredAnnotationIds(group, restoredAnnotation.id, previousAnnotationIds);

    const restored = sanitizeStepForStorage(restoredAnnotation);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    byId.set(restored.id, restored);
    const restoredGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: previousAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? restoredGroup : entry
    ));
    return commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [anchorId],
    );
  });
}

export async function deleteGuideEntriesAtomically(
  sessionId: string,
  entryIdsToDelete: readonly string[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToDelete);
    const nextEntries = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const survivingIds = new Set(nextEntries.map(entryId));
    const sections = rebaseSectionsAfterDelete(structure.guide.sections, structure.entryIds, survivingIds);
    return commitGuideStructure(tx, structure, nextEntries, sections, entryIdsToDelete);
  });
}

export async function restoreGuideEntriesAtomically(
  sessionId: string,
  restoredSteps: readonly Step[],
  previousEntryIds: readonly string[],
  previousSections: readonly GuideSection[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    if (restoredSteps.length === 0) throw new GuideStructureIntegrityError('No entries were provided for restore.');
    const currentStepIds = new Set(structure.steps.map((step) => step.id));
    if (restoredSteps.some((step) => step.sessionId !== sessionId || currentStepIds.has(step.id))) {
      throw new GuideStructureIntegrityError('Restored rows conflict with the current Guide.');
    }
    const restoredEntries = buildCompleteStepEntries(restoredSteps, sessionId);
    const allEntries = [...structure.entries, ...restoredEntries];
    assertExactEntryIds(allEntries, previousEntryIds);
    const byId = new Map(allEntries.map((entry) => [entryId(entry), entry]));
    const nextEntries = previousEntryIds.map((id) => byId.get(id)!);
    return commitGuideStructure(
      tx,
      structure,
      nextEntries,
      repairGuideSections(previousSections, nextEntries),
      restoredEntries.map(entryId),
    );
  });
}

export async function moveGuideEntriesAtomically(
  sessionId: string,
  entryIdsToMove: readonly string[],
  destination: 'start' | 'end',
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  if (destination !== 'start' && destination !== 'end') throw new TypeError('Invalid move destination.');
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToMove);
    const selected = structure.entries.filter((entry) => selectedIds.has(entryId(entry)));
    const unselected = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const nextEntries = destination === 'start' ? [...selected, ...unselected] : [...unselected, ...selected];
    return commitGuideStructure(tx, structure, nextEntries, structure.guide.sections, entryIdsToMove);
  });
}

export async function setGuideEntriesNumberedAtomically(
  sessionId: string,
  entryIdsToUpdate: readonly string[],
  numbered: boolean,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToUpdate);
    const affected: string[] = [];
    const nextEntries = structure.entries.map((entry): StepEntry => {
      const id = entryId(entry);
      if (!selectedIds.has(id) || entry.kind === 'single') return entry;
      affected.push(id);
      return {
        kind: 'group',
        anchor: { ...entry.anchor, numbered },
        annotations: entry.annotations.map((annotation) => ({ ...annotation, numbered })),
      };
    });
    if (affected.length === 0) {
      return { guide: structure.guide, entryIds: structure.entryIds, affectedEntryIds: [] };
    }
    return commitGuideStructure(tx, structure, nextEntries, structure.guide.sections, affected);
  });
}

export async function duplicateGuideEntryAtomically(
  sessionId: string,
  sourceEntryId: string,
  expectedContentRevision: number,
): Promise<DuplicateGuideEntryResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { byId } = requireEntrySelection(structure.entries, [sourceEntryId]);
    const source = byId.get(sourceEntryId)!;
    let duplicate: StepEntry;
    if (source.kind === 'single') {
      const id = crypto.randomUUID();
      duplicate = {
        kind: 'single',
        step: sanitizeStepForStorage({
          ...source.step,
          id,
          sessionId,
          runId: undefined,
          order: source.step.order + 1,
          captureRevision: 0,
          lastCaptureRunId: undefined,
        }) as ScreenshotStep,
      };
    } else {
      const anchorId = crypto.randomUUID();
      const anchor = sanitizeStepForStorage({
        ...source.anchor,
        id: anchorId,
        sessionId,
        runId: undefined,
        groupId: anchorId,
        captureRevision: 0,
        lastCaptureRunId: undefined,
      }) as ScreenshotStep;
      const annotations = source.annotations.map((annotation) => sanitizeStepForStorage({
        ...annotation,
        id: crypto.randomUUID(),
        sessionId,
        runId: undefined,
        groupId: anchorId,
        captureRevision: 0,
        lastCaptureRunId: undefined,
      }));
      duplicate = { kind: 'group', anchor, annotations };
    }
    const sourceIndex = structure.entries.findIndex((entry) => entryId(entry) === sourceEntryId);
    const nextEntries = [...structure.entries];
    nextEntries.splice(sourceIndex + 1, 0, duplicate);
    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [entryId(duplicate)],
    );
    return { ...result, createdEntryId: entryId(duplicate) };
  });
}

export async function addGuideSectionAtomically(
  sessionId: string,
  startEntryId: string,
  title: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    requireEntrySelection(structure.entries, [startEntryId]);
    const sanitizedTitle = sanitizeGuideSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    if (structure.guide.sections.some((section) => section.startEntryId === startEntryId)) {
      throw new GuideStructureIntegrityError('An entry can begin only one section.');
    }
    if (structure.guide.sections.length >= GUIDE_SECTION_LIMITS.maxSections) {
      throw new GuideStructureIntegrityError(
        `Guide cannot contain more than ${GUIDE_SECTION_LIMITS.maxSections} sections.`,
      );
    }
    const sections = [...structure.guide.sections, {
      id: crypto.randomUUID(),
      title: sanitizedTitle,
      startEntryId,
    }];
    return commitGuideStructure(tx, structure, structure.entries, sections, [startEntryId]);
  });
}

export async function renameGuideSectionAtomically(
  sessionId: string,
  sectionId: string,
  title: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sanitizedTitle = sanitizeGuideSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    let found = false;
    const sections = structure.guide.sections.map((section) => {
      if (section.id !== sectionId) return section;
      found = true;
      return { ...section, title: sanitizedTitle };
    });
    if (!found) throw new GuideStructureIntegrityError('Section not found.');
    return commitGuideStructure(tx, structure, structure.entries, sections, []);
  });
}

export async function deleteGuideSectionAtomically(
  sessionId: string,
  sectionId: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sections = structure.guide.sections.filter((section) => section.id !== sectionId);
    if (sections.length === structure.guide.sections.length) {
      throw new GuideStructureIntegrityError('Section not found.');
    }
    return commitGuideStructure(tx, structure, structure.entries, sections, []);
  });
}

export interface InsertionAnchor {
  anchorEntryId: string;
  kind: 'single' | 'group';
  sourceUrl: string;
  memberIds: string[];
}

export interface InsertStepsAtEntryBoundaryInput {
  sessionId: string;
  runId: string;
  anchorEntryId: string;
  side: InsertionSide;
  expectedRunBlockIds: string[];
  newSteps: Step[];
}

function insertionError(code: InsertionErrorCode, message: string): never {
  throw new InsertionRecordingError(code, message);
}

function assertUniqueIds(ids: string[], label: string): void {
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    insertionError('RUN_STATE_CHANGED', `${label} contains invalid or duplicate ids.`);
  }
}

function requireInsertionGuide(guide: Guide | undefined): Guide {
  if (!guide) return insertionError('GUIDE_NOT_FOUND', 'Guide not found.');
  const sanitized = sanitizeGuide(guide);
  if (sanitized.archivedAt !== null) {
    return insertionError('GUIDE_ARCHIVED', 'Archived guides cannot be modified.');
  }
  return sanitized;
}

function resolveInsertionAnchorFromSteps(
  sessionId: string,
  anchorEntryId: string,
  sortedSteps: Step[],
): InsertionAnchor {
  const anchor = sortedSteps.find((step) => step.id === anchorEntryId);
  if (!anchor || anchor.sessionId !== sessionId) {
    return insertionError('ANCHOR_NOT_FOUND', 'The insertion anchor no longer exists.');
  }

  if (!anchor.groupId) {
    if (!anchor.screenshotBlob || !anchor.url) {
      return insertionError('ANCHOR_CHANGED', 'The insertion anchor is no longer a complete ordinary entry.');
    }
    return {
      anchorEntryId,
      kind: 'single',
      sourceUrl: anchor.url,
      memberIds: [anchor.id],
    };
  }

  if (anchor.groupId !== anchor.id || !anchor.screenshotBlob || !anchor.url) {
    return insertionError('ANCHOR_CHANGED', 'The insertion anchor is no longer a snapshot entry.');
  }
  const members = sortedSteps.filter((step) => step.groupId === anchor.id);
  const annotations = members.filter((step) => step.id !== anchor.id && getEffectiveBounds(step));
  if (annotations.length === 0) {
    return insertionError('ANCHOR_CHANGED', 'The insertion snapshot no longer has a complete annotation.');
  }
  const positions = members.map((member) => sortedSteps.indexOf(member)).sort((a, b) => a - b);
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    return insertionError('ANCHOR_CHANGED', 'The insertion snapshot is no longer contiguous.');
  }
  return {
    anchorEntryId,
    kind: 'group',
    sourceUrl: anchor.url,
    memberIds: members.map((step) => step.id),
  };
}

function validateInsertionRunBlock(steps: Step[], runId: string, runBlockIds: string[]): Step[] {
  assertUniqueIds(runBlockIds, 'Insertion run block');
  const byId = new Map(steps.map((step) => [step.id, step]));
  const block = runBlockIds.map((id) => {
    const step = byId.get(id);
    if (!step || step.runId !== runId) {
      return insertionError('RUN_STATE_CHANGED', 'The insertion run block no longer matches persisted data.');
    }
    return step;
  });
  const actualRunIds = steps.filter((step) => step.runId === runId).map((step) => step.id);
  const expectedSet = new Set(runBlockIds);
  if (actualRunIds.length !== runBlockIds.length || actualRunIds.some((id) => !expectedSet.has(id))) {
    return insertionError('RUN_STATE_CHANGED', 'The insertion run changed without a matching durable state update.');
  }
  return block;
}

function validateInsertionBlockEntries(block: Step[]): void {
  const blockIds = new Set(block.map((step) => step.id));
  const groupPositions = new Map<string, number[]>();
  block.forEach((step, index) => {
    if (!step.groupId) {
      if (!step.screenshotBlob) {
        insertionError('RUN_STATE_CHANGED', 'An ordinary inserted entry is missing its screenshot.');
      }
      return;
    }
    if (!blockIds.has(step.groupId)) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot refers outside its recording block.');
    }
    const positions = groupPositions.get(step.groupId) ?? [];
    positions.push(index);
    groupPositions.set(step.groupId, positions);
  });
  for (const [groupId, positions] of groupPositions) {
    const anchor = block.find((step) => step.id === groupId);
    if (!anchor || anchor.groupId !== anchor.id || !anchor.screenshotBlob) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot is missing its image anchor.');
    }
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot group is not contiguous.');
    }
  }
}

function insertionOrderedIds(
  sortedSteps: Step[],
  anchor: InsertionAnchor,
  side: InsertionSide,
  runBlockIds: string[],
): string[] {
  const blockSet = new Set(runBlockIds);
  if (anchor.memberIds.some((id) => blockSet.has(id))) {
    return insertionError('RUN_STATE_CHANGED', 'The insertion anchor cannot belong to the inserted run.');
  }
  const base = sortedSteps.filter((step) => !blockSet.has(step.id));
  const positions = anchor.memberIds
    .map((id) => base.findIndex((step) => step.id === id))
    .sort((a, b) => a - b);
  if (positions.some((position) => position < 0)) {
    return insertionError('ANCHOR_NOT_FOUND', 'The insertion anchor changed during the transaction.');
  }
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    return insertionError('ANCHOR_CHANGED', 'The insertion anchor group is no longer contiguous.');
  }
  const insertionIndex = side === 'before' ? positions[0] : positions.at(-1)! + 1;
  return [
    ...base.slice(0, insertionIndex).map((step) => step.id),
    ...runBlockIds,
    ...base.slice(insertionIndex).map((step) => step.id),
  ];
}

/** Resolves an insertion target and source URL in one DB transaction. The URL
 * always comes from the persisted image owner; callers must not accept one
 * from an editor message. */
export async function getInsertionAnchor(sessionId: string, anchorEntryId: string): Promise<InsertionAnchor> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    requireInsertionGuide(await tx.objectStore('guides').get(sessionId));
    const steps = (await tx.objectStore('steps').index('by-session').getAll(sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(sessionId, anchorEntryId, steps);
    await tx.done;
    return anchor;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Adds capture rows directly at a fresh-read entry boundary. Existing rows
 * from the same insertion run are removed from the ordering calculation and
 * reinserted as one contiguous block, so repeated captures never split a
 * snapshot group or temporarily append at the tail. */
export async function insertStepsAtEntryBoundary(
  input: InsertStepsAtEntryBoundaryInput,
): Promise<{ runBlockIds: string[] }> {
  assertMutationItems(input.expectedRunBlockIds, 'Expected insertion run block', true);
  assertMutationItems(input.newSteps, 'New insertion rows');
  if (input.side !== 'before' && input.side !== 'after') {
    return insertionError('RUN_STATE_CHANGED', 'Invalid insertion side.');
  }
  assertUniqueIds(input.expectedRunBlockIds, 'Expected insertion run block');
  assertUniqueIds(input.newSteps.map((step) => step.id), 'New insertion rows');
  if (input.newSteps.some((step) => step.sessionId !== input.sessionId || step.runId !== input.runId)) {
    return insertionError('RUN_STATE_CHANGED', 'New insertion rows do not belong to the active Guide and run.');
  }

  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = requireInsertionGuide(await tx.objectStore('guides').get(input.sessionId));
    const existing = (await tx.objectStore('steps').index('by-session').getAll(input.sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(input.sessionId, input.anchorEntryId, existing);
    const currentBlock = validateInsertionRunBlock(existing, input.runId, input.expectedRunBlockIds);
    const existingIds = new Set(existing.map((step) => step.id));
    if (input.newSteps.some((step) => existingIds.has(step.id))) {
      return insertionError('RUN_STATE_CHANGED', 'A new insertion row id already exists.');
    }

    const sanitizedNewSteps = input.newSteps.map(sanitizeStepForStorage);
    const combinedBlock = [...currentBlock, ...sanitizedNewSteps];
    validateInsertionBlockEntries(combinedBlock);
    const runBlockIds = combinedBlock.map((step) => step.id);
    const combinedSteps = [...existing, ...sanitizedNewSteps];
    const orderedIds = insertionOrderedIds(combinedSteps, anchor, input.side, runBlockIds);
    let insertedEntries: StepEntry[] | null = null;
    try {
      insertedEntries = buildCompleteStepEntries(
        combinedBlock.map((step, order) => ({ ...step, order })),
        input.sessionId,
      );
    } catch (error) {
      // Snapshot insertion persists its image anchor before the first annotation.
      // That temporary run block is intentionally incomplete; preserve section
      // metadata until a later call commits the first complete inserted entry.
      if (!(error instanceof GuideStructureIntegrityError)) throw error;
    }
    let guideWithSections = guide;
    if (insertedEntries) {
      const orderedById = new Map(combinedSteps.map((step) => [step.id, step]));
      const finalSteps = orderedIds.map((id, order) => ({ ...orderedById.get(id)!, order }));
      const finalEntries = buildCompleteStepEntries(finalSteps, input.sessionId);
      const firstInsertedEntryId = entryId(insertedEntries[0]);
      const sections = input.side === 'before'
        ? guide.sections.map((section) => (
          section.startEntryId === input.anchorEntryId
            ? { ...section, startEntryId: firstInsertedEntryId }
            : section
        ))
        : guide.sections;
      guideWithSections = sanitizeGuide({
        ...guide,
        sections: repairGuideSections(sections, finalEntries),
      });
    }

    for (const step of sanitizedNewSteps) await tx.objectStore('steps').add(step);
    await writeDenseOrder(tx, combinedSteps, orderedIds);
    await refreshGuideSummary(tx, guideWithSections, Math.max(0, ...sanitizedNewSteps.map((step) => step.timestamp)));
    await tx.done;
    return { runBlockIds };
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Validates persisted insertion state after an MV3 worker restart. */
export async function validateInsertionRunState(input: {
  sessionId: string;
  runId: string;
  anchorEntryId: string;
  side: InsertionSide;
  runBlockIds: string[];
}): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    requireInsertionGuide(await tx.objectStore('guides').get(input.sessionId));
    const steps = (await tx.objectStore('steps').index('by-session').getAll(input.sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(input.sessionId, input.anchorEntryId, steps);
    const block = validateInsertionRunBlock(steps, input.runId, input.runBlockIds);
    validateInsertionBlockEntries(block);
    const expectedOrder = insertionOrderedIds(steps, anchor, input.side, input.runBlockIds);
    if (expectedOrder.some((id, index) => steps[index]?.id !== id)) {
      return insertionError('RUN_STATE_CHANGED', 'The insertion block is no longer at its durable anchor boundary.');
    }
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

export async function addStep(step: Step): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, step.sessionId);
    await tx.objectStore('steps').add(sanitizeStepForStorage(step));
    await refreshGuideSummary(tx, guide, step.timestamp);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

export async function getSteps(sessionId: string): Promise<Step[]> {
  const db = await getDatabase();
  const steps = await db.getAllFromIndex('steps', 'by-session', sessionId);
  return steps.sort((a, b) => a.order - b.order);
}

export async function getStep(id: string): Promise<Step | undefined> {
  const db = await getDatabase();
  return db.get('steps', id);
}

/** Applies a visual edit as one IndexedDB transaction. Each row is re-read in
 * the transaction, so description autosaves and reorders cannot be lost by a
 * stale editor draft. Missing or cross-session rows abort the whole commit. */
export interface CaptureReplacement {
  screenshotBlob: Blob;
  bounds: Bounds;
  devicePixelRatio: number;
  screenshotScale: number;
  url: string;
  timestamp: number;
}

export type StepRecaptureTarget =
  | { kind: 'single'; stepId: string }
  | { kind: 'snapshot-singleton'; anchorId: string; annotationId: string };

export class StepRecaptureError extends Error {
  constructor(
    public readonly code:
      | 'TARGET_NOT_FOUND'
      | 'TARGET_CHANGED'
      | 'UNSUPPORTED_SNAPSHOT_GROUP',
    message: string,
  ) {
    super(message);
    this.name = 'StepRecaptureError';
  }
}

export interface StepUpdate {
  id: string;
  changes: Partial<Step>;
  /** Optional compare-and-set guard for privacy-sensitive edits. */
  expectedCaptureRevision?: number;
}

/** Strict visual-edit path: every target row must carry a capture-generation
 * CAS in addition to the guide content-generation CAS on the API call. */
export interface GuideVisualStepUpdate extends StepUpdate {
  expectedCaptureRevision: number;
}

export interface GuideVisualMutationResult {
  guide: Guide;
  /** Fresh rows read before mutation, in first-target order, for deterministic undo. */
  previousSteps: Step[];
  /** Sanitized rows committed by this mutation, with their post-mutation capture revisions. */
  steps: Step[];
}

export class StepUpdateConflictError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly expectedCaptureRevision: number,
    public readonly actualCaptureRevision: number,
  ) {
    super('This screenshot changed before the edit was saved.');
    this.name = 'StepUpdateConflictError';
  }
}

function applyStepChanges(existing: Step, changes: Partial<Step>): Step {
  const { id: _id, sessionId: _sessionId, order: _order, ...mutableChanges } = changes;
  return sanitizeStepForStorage({ ...existing, ...mutableChanges });
}

export async function updateStepsAtomically(sessionId: string, updates: StepUpdate[]): Promise<void> {
  assertMutationItems(updates, 'Step updates');
  if (updates.length === 0) return;
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    for (const update of updates) {
      const existing = await tx.objectStore('steps').get(update.id);
      if (!existing || existing.sessionId !== sessionId) {
        throw new Error(`Step ${update.id} is no longer available.`);
      }
      if (
        update.expectedCaptureRevision !== undefined &&
        (existing.captureRevision ?? 0) !== update.expectedCaptureRevision
      ) {
        throw new StepUpdateConflictError(
          update.id,
          update.expectedCaptureRevision,
          existing.captureRevision ?? 0,
        );
      }
      await tx.objectStore('steps').put(applyStepChanges(existing, update.changes));
    }
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Strict visual edit commit. Guide and capture revisions are checked against
 * fresh values in the same guides+steps transaction that writes every row and
 * advances contentRevision. Duplicate updates for one row are applied in input
 * order, but each must assert the same fresh capture generation. */
export async function updateGuideVisualsAtomically(
  sessionId: string,
  updates: readonly GuideVisualStepUpdate[],
  expectedContentRevision: number,
): Promise<GuideVisualMutationResult> {
  if (updates.length === 0) throw new TypeError('A visual edit must update at least one step.');
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const structure = await requireWritableGuideStructure(tx, sessionId, expectedContentRevision);
    const originalById = new Map(structure.steps.map((step) => [step.id, step]));
    const nextById = new Map(originalById);
    const targetIds: string[] = [];
    const seenTargetIds = new Set<string>();

    for (const update of updates) {
      if (!Number.isSafeInteger(update.expectedCaptureRevision) || update.expectedCaptureRevision < 0) {
        throw new TypeError('Expected capture revision must be a non-negative integer.');
      }
      const original = originalById.get(update.id);
      if (!original) throw new Error(`Step ${update.id} is no longer available.`);
      const actualCaptureRevision = original.captureRevision ?? 0;
      if (actualCaptureRevision !== update.expectedCaptureRevision) {
        throw new StepUpdateConflictError(
          update.id,
          update.expectedCaptureRevision,
          actualCaptureRevision,
        );
      }
      if (!seenTargetIds.has(update.id)) {
        seenTargetIds.add(update.id);
        targetIds.push(update.id);
      }
      nextById.set(update.id, applyStepChanges(nextById.get(update.id)!, update.changes));
    }

    const nextSteps = structure.steps.map((step) => nextById.get(step.id)!);
    const nextEntries = buildCompleteStepEntries(nextSteps, sessionId);
    const affectedEntryIds = targetIds.map((id) => {
      const step = nextById.get(id)!;
      return step.groupId ?? step.id;
    });
    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      affectedEntryIds,
    );
    const previousSteps = targetIds.map((id) => ({ ...originalById.get(id)! }));
    const committedSteps = targetIds.map((id) => ({ ...nextById.get(id)! }));
    await tx.done;
    return { guide: result.guide, previousSteps, steps: committedSteps };
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Replaces only capture-owned fields while preserving identity, description,
 * order and recording provenance. Snapshot replacement is allowed only when
 * the shared image has exactly one annotation, otherwise old coordinates
 * would silently point at unrelated pixels. */
export async function replaceStepCaptureAtomically(
  sessionId: string,
  target: StepRecaptureTarget,
  capture: CaptureReplacement,
  recaptureRunId: string,
): Promise<{ entryId: string; captureRevision: number }> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    if (target.kind === 'single') {
      const step = await tx.objectStore('steps').get(target.stepId);
      if (!step || step.sessionId !== sessionId) {
        throw new StepRecaptureError('TARGET_NOT_FOUND', 'The step no longer exists.');
      }
      if (step.groupId) {
        throw new StepRecaptureError('TARGET_CHANGED', 'The step is no longer an ordinary step.');
      }
      const captureRevision = (step.captureRevision ?? 0) + 1;
      await tx.objectStore('steps').put(sanitizeStepForStorage({
        ...step,
        ...capture,
        manualBounds: null,
        redactions: Array.isArray(step.redactions) ? step.redactions : [],
        redactionReviewRequired:
          step.redactionReviewRequired === true ||
          (Array.isArray(step.redactions) ? step.redactions.length > 0 : step.redactions !== undefined),
        captureRevision,
        lastCaptureRunId: recaptureRunId,
      }));
      await refreshGuideSummary(tx, guide, capture.timestamp);
      await tx.done;
      return { entryId: step.id, captureRevision };
    }

    const anchor = await tx.objectStore('steps').get(target.anchorId);
    const annotation = await tx.objectStore('steps').get(target.annotationId);
    if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
      throw new StepRecaptureError('TARGET_NOT_FOUND', 'The snapshot no longer exists.');
    }
    if (
      anchor.groupId !== anchor.id ||
      annotation.groupId !== anchor.id ||
      annotation.id === anchor.id ||
      !anchor.screenshotBlob
    ) {
      throw new StepRecaptureError('TARGET_CHANGED', 'The snapshot structure changed before recapture.');
    }
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    const annotations = sessionSteps.filter(
      (step) => step.groupId === anchor.id && step.id !== anchor.id && getEffectiveBounds(step),
    );
    if (annotations.length !== 1 || annotations[0].id !== annotation.id) {
      throw new StepRecaptureError(
        'UNSUPPORTED_SNAPSHOT_GROUP',
        'A snapshot with multiple annotations must be rebuilt as a whole.',
      );
    }
    const captureRevision = (anchor.captureRevision ?? 0) + 1;
    await tx.objectStore('steps').put(sanitizeStepForStorage({
      ...anchor,
      screenshotBlob: capture.screenshotBlob,
      devicePixelRatio: capture.devicePixelRatio,
      screenshotScale: capture.screenshotScale,
      url: capture.url,
      timestamp: capture.timestamp,
      redactions: Array.isArray(anchor.redactions) ? anchor.redactions : [],
      redactionReviewRequired:
        anchor.redactionReviewRequired === true ||
        (Array.isArray(anchor.redactions) ? anchor.redactions.length > 0 : anchor.redactions !== undefined),
      captureRevision,
      lastCaptureRunId: recaptureRunId,
    }));
    await tx.objectStore('steps').put(sanitizeStepForStorage({
      ...annotation,
      bounds: capture.bounds,
      manualBounds: null,
      devicePixelRatio: capture.devicePixelRatio,
      screenshotScale: capture.screenshotScale,
      url: capture.url,
      timestamp: capture.timestamp,
    }));
    await refreshGuideSummary(tx, guide, capture.timestamp);
    await tx.done;
    return { entryId: anchor.id, captureRevision };
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

export async function updateStep(id: string, changes: Partial<Step>): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const existing = await tx.objectStore('steps').get(id);
    if (!existing) {
      await tx.done;
      return;
    }
    const guide = await requireWritableGuide(tx, existing.sessionId);
    await tx.objectStore('steps').put(applyStepChanges(existing, changes));
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

function sortSessionSteps(sessionSteps: Step[], orderedIds: string[]): Step[] {
  const byId = new Map(sessionSteps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const reordered: Step[] = [];

  for (const id of orderedIds) {
    const step = byId.get(id);
    if (step && !seen.has(id)) {
      reordered.push(step);
      seen.add(id);
    }
  }
  for (const step of [...sessionSteps].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    if (!seen.has(step.id)) reordered.push(step);
  }
  return reordered;
}

async function writeDenseOrder(tx: GuideStepsTransaction, steps: Step[], orderedIds: string[]): Promise<void> {
  const reordered = sortSessionSteps(steps, orderedIds);
  for (let order = 0; order < reordered.length; order += 1) {
    const step = reordered[order];
    if (step.order !== order) await tx.objectStore('steps').put({ ...step, order });
  }
}

export async function deleteStep(id: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const existing = await tx.objectStore('steps').get(id);
    if (!existing) {
      await tx.done;
      return;
    }
    const guide = await requireWritableGuide(tx, existing.sessionId);
    await tx.objectStore('steps').delete(id);
    const remaining = await tx.objectStore('steps').index('by-session').getAll(existing.sessionId);
    await writeDenseOrder(tx, remaining, []);
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Compatibility wrapper; new RESET_GUIDE callers should use resetGuide. */
export async function deleteStepsForSession(sessionId: string): Promise<void> {
  await resetGuide(sessionId);
}

/** Deletes only one recording run and closes order gaps without disturbing
 * content from earlier runs that share the same editor session. */
export async function deleteStepsForRun(sessionId: string, runId: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    const removedIds = new Set(sessionSteps.filter((step) => step.runId === runId).map((step) => step.id));
    for (const id of removedIds) await tx.objectStore('steps').delete(id);
    const remaining = sessionSteps.filter((step) => !removedIds.has(step.id));
    await writeDenseOrder(tx, remaining, []);
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Persists a dense new step order, appending rows omitted by a stale editor. */
export async function reorderSteps(sessionId: string, orderedIds: string[]): Promise<void> {
  assertMutationItems(orderedIds, 'Step reorder', true);
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    await writeDenseOrder(tx, sessionSteps, orderedIds);
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Atomically removes editor-selected rows and closes every remaining order gap. */
export async function deleteStepsAndReorder(
  sessionId: string,
  deletedIds: string[],
  orderedIds: string[],
): Promise<void> {
  assertMutationItems(deletedIds, 'Deleted step ids', true);
  assertMutationItems(orderedIds, 'Step reorder', true);
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    for (const id of new Set(deletedIds)) {
      const step = await tx.objectStore('steps').get(id);
      if (step && step.sessionId !== sessionId) throw new Error(`Step ${id} belongs to another guide.`);
      if (step) await tx.objectStore('steps').delete(id);
    }
    const remaining = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    await writeDenseOrder(tx, remaining, orderedIds);
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Restores editor-deleted rows and reapplies the requested order atomically. */
export async function restoreStepsAndReorder(
  sessionId: string,
  restoredSteps: Step[],
  orderedIds: string[],
): Promise<void> {
  assertMutationItems(restoredSteps, 'Restored steps');
  assertMutationItems(orderedIds, 'Step reorder', true);
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = await requireWritableGuide(tx, sessionId);
    for (const step of restoredSteps) {
      if (step.sessionId !== sessionId) throw new Error(`Step ${step.id} belongs to another guide.`);
      await tx.objectStore('steps').add(sanitizeStepForStorage(step));
    }
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    await writeDenseOrder(tx, sessionSteps, orderedIds);
    await refreshGuideSummary(tx, guide);
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

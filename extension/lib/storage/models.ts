import {
  GUIDE_SECTION_LIMITS,
  sanitizeGuideSectionTitle,
  type GuideSection,
} from '../guide/guide-section-model';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
export type { GuideSection } from '../guide/guide-section-model';

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

export function storageError(message: string): never {
  throw new StepStorageValidationError(message);
}

export function requireStorageIdentifier(value: unknown, field: string): string {
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

export function assertMutationItems(
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

export function defaultGuideTitle(createdAt: number): string {
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

export function sanitizeGuide(guide: Guide): Guide {
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

export function sanitizeStepForStorage(step: Step): Step {
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

export function orderedSessionSteps(steps: readonly Step[]): Step[] {
  return [...steps].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** DB mutations use a strict topology parser instead of the UI's fail-soft
 * buildStepEntries(). Every persisted row must belong to exactly one complete,
 * contiguous entry so a snapshot can never be partially mutated. */
export function buildCompleteStepEntries(steps: readonly Step[], expectedSessionId?: string): StepEntry[] {
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

export function entrySteps(entry: StepEntry): Step[] {
  return entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations];
}

export function flattenEntrySteps(entries: readonly StepEntry[]): Step[] {
  return entries.flatMap(entrySteps);
}

export function assertExactEntryIds(actualEntries: readonly StepEntry[], requestedIds: readonly string[]): void {
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

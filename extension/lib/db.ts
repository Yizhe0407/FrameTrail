import { openDB, type DBSchema } from 'idb';

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
    bounds.width > 0 &&
    bounds.height > 0
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
    redaction.id.trim().length > 0 &&
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
  const sanitized = { ...step };
  if (sanitized.groupId && sanitized.id !== sanitized.groupId) {
    delete sanitized.screenshotBlob;
    delete sanitized.redactions;
    delete sanitized.redactionReviewRequired;
  }
  if (sanitized.manualBounds != null && !isValidBounds(sanitized.manualBounds)) {
    sanitized.manualBounds = null;
  }
  if (sanitized.redactions !== undefined) {
    if (!Array.isArray(sanitized.redactions)) {
      // Treat malformed legacy/runtime data as a privacy incident, not as an
      // empty mask list. The editor must explicitly repair and confirm it.
      sanitized.redactions = [];
      sanitized.redactionReviewRequired = true;
    } else {
      const originalCount = sanitized.redactions.length;
      sanitized.redactions = sanitized.redactions.filter(isValidRedaction);
      if (sanitized.redactions.length !== originalCount) sanitized.redactionReviewRequired = true;
    }
  }
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
}

// Keep the original IndexedDB name to retain recordings made before the
// product rename. The schema and data model are unchanged.
const dbPromise = openDB<FrameTrailDB>('scribe', 3, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const store = db.createObjectStore('steps', { keyPath: 'id' });
      store.createIndex('by-session', 'sessionId');
    }
    // v2 adds bounds/devicePixelRatio; pre-existing steps simply render without
    // a highlight box (their screenshot may already have one baked in).
    // v3 adds groupId/numbered for single-image annotation groups;
    // pre-existing steps are simply untouched (groupId undefined => ordinary step).
  },
});

export async function addStep(step: Step): Promise<void> {
  const db = await dbPromise;
  await db.put('steps', sanitizeStepForStorage(step));
}

export async function getSteps(sessionId: string): Promise<Step[]> {
  const db = await dbPromise;
  const steps = await db.getAllFromIndex('steps', 'by-session', sessionId);
  return steps.sort((a, b) => a.order - b.order);
}

export async function getStep(id: string): Promise<Step | undefined> {
  const db = await dbPromise;
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

export async function updateStepsAtomically(sessionId: string, updates: StepUpdate[]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  for (const update of updates) {
    const existing = await tx.store.get(update.id);
    if (!existing || existing.sessionId !== sessionId) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error(`Step ${update.id} is no longer available.`);
    }
    if (
      update.expectedCaptureRevision !== undefined &&
      (existing.captureRevision ?? 0) !== update.expectedCaptureRevision
    ) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new StepUpdateConflictError(
        update.id,
        update.expectedCaptureRevision,
        existing.captureRevision ?? 0,
      );
    }
    await tx.store.put(sanitizeStepForStorage({ ...existing, ...update.changes }));
  }
  await tx.done;
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
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  try {
    if (target.kind === 'single') {
      const step = await tx.store.get(target.stepId);
      if (!step || step.sessionId !== sessionId) {
        throw new StepRecaptureError('TARGET_NOT_FOUND', 'The step no longer exists.');
      }
      if (step.groupId) {
        throw new StepRecaptureError('TARGET_CHANGED', 'The step is no longer an ordinary step.');
      }
      const captureRevision = (step.captureRevision ?? 0) + 1;
      await tx.store.put(
        sanitizeStepForStorage({
          ...step,
          ...capture,
          manualBounds: null,
          redactions: Array.isArray(step.redactions) ? step.redactions : [],
          redactionReviewRequired:
            step.redactionReviewRequired === true ||
            (Array.isArray(step.redactions) ? step.redactions.length > 0 : step.redactions !== undefined),
          captureRevision,
          lastCaptureRunId: recaptureRunId,
        }),
      );
      await tx.done;
      return { entryId: step.id, captureRevision };
    }

    const anchor = await tx.store.get(target.anchorId);
    const annotation = await tx.store.get(target.annotationId);
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
    const sessionSteps = await tx.store.index('by-session').getAll(sessionId);
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
    await tx.store.put(
      sanitizeStepForStorage({
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
      }),
    );
    await tx.store.put(
      sanitizeStepForStorage({
        ...annotation,
        bounds: capture.bounds,
        manualBounds: null,
        devicePixelRatio: capture.devicePixelRatio,
        screenshotScale: capture.screenshotScale,
        url: capture.url,
        timestamp: capture.timestamp,
      }),
    );
    await tx.done;
    return { entryId: anchor.id, captureRevision };
  } catch (error) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function updateStep(id: string, changes: Partial<Step>): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return;
  }
  const updated = sanitizeStepForStorage({ ...existing, ...changes });
  await tx.store.put(updated);
  await tx.done;
}

export async function deleteStep(id: string): Promise<void> {
  const db = await dbPromise;
  await db.delete('steps', id);
}

export async function deleteStepsForSession(sessionId: string): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  let cursor = await tx.store.index('by-session').openCursor(sessionId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Deletes only one recording run and closes order gaps without disturbing
 * content from earlier runs that share the same editor session. */
export async function deleteStepsForRun(sessionId: string, runId: string): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  const sessionSteps = await tx.store.index('by-session').getAll(sessionId);
  const removedIds = new Set(sessionSteps.filter((step) => step.runId === runId).map((step) => step.id));
  await Promise.all([...removedIds].map((id) => tx.store.delete(id)));
  const remaining = sessionSteps
    .filter((step) => !removedIds.has(step.id))
    .sort((first, second) => first.order - second.order);
  await Promise.all(remaining.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
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

  // A recorder can append a step while the editor holds an older list. Keep
  // such steps after the requested order so every order remains unique.
  for (const step of sessionSteps.sort((a, b) => a.order - b.order)) {
    if (!seen.has(step.id)) reordered.push(step);
  }
  return reordered;
}

/** Persists a new step order for a session. orderedIds must be every step id in
 * the session (e.g. via flattenEntries) — any id left out keeps its old order
 * value and can collide with the ones renumbered here. */
export async function reorderSteps(sessionId: string, orderedIds: string[]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  const sessionSteps = await tx.store.index('by-session').getAll(sessionId);
  const reordered = sortSessionSteps(sessionSteps, orderedIds);
  await Promise.all(reordered.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
}

/** Atomically removes editor-selected rows and closes every remaining order
 * gap. A failed transaction cannot leave half a snapshot group deleted. */
export async function deleteStepsAndReorder(
  sessionId: string,
  deletedIds: string[],
  orderedIds: string[],
): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  await Promise.all(deletedIds.map((id) => tx.store.delete(id)));
  const remaining = await tx.store.index('by-session').getAll(sessionId);
  const reordered = sortSessionSteps(remaining, orderedIds);
  await Promise.all(reordered.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
}

/** Restores editor-deleted rows and reapplies the requested order atomically.
 * This is intentionally a short-lived UI undo primitive, not a persistent
 * history system. */
export async function restoreStepsAndReorder(
  sessionId: string,
  restoredSteps: Step[],
  orderedIds: string[],
): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  await Promise.all(
    restoredSteps.map((step) => tx.store.put(sanitizeStepForStorage(step))),
  );
  const sessionSteps = await tx.store.index('by-session').getAll(sessionId);
  const reordered = sortSessionSteps(sessionSteps, orderedIds);
  await Promise.all(reordered.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
}

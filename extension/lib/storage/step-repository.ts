import {
  assertMutationItems,
  buildCompleteStepEntries,
  getEffectiveBounds,
  sanitizeStepForStorage,
  type Bounds,
  type Guide,
  type Redaction,
  type Step,
} from './models';
import {
  abortTransaction,
  getDatabase,
  refreshGuideSummary,
  requireWritableGuide,
  writeDenseOrder,
} from './database';
import {
  commitGuideStructure,
  requireWritableGuideStructure,
} from './guide-structure';
import { resetGuide } from './guide-repository';

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

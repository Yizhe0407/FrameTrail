import type { IDBPTransaction } from 'idb';
import { repairGuideSections, type GuideSection } from '../guide/guide-sections';
import {
  buildCompleteStepEntries,
  sanitizeGuide,
  STEP_STORAGE_LIMITS,
  storageError,
  sanitizeStepForStorage,
  type Guide,
  type GuideSummary,
  type Step,
} from './models';
import {
  assertGuideStorageLimits,
  isPristineGuide,
  newGuide,
  requireWritableGuide,
  runGuideStepsWrite,
  runWithDatabase,
  summarizeSteps,
  type FrameTrailDB,
  type GuideStepsTransaction,
} from './database';
import { clearActiveGuideId } from './storage';

export async function createGuide(initial?: Partial<Pick<Guide, 'title' | 'description' | 'tags'>>): Promise<Guide> {
  const guide = newGuide(crypto.randomUUID(), Date.now(), initial);
  await runWithDatabase((db) => db.add('guides', guide));
  return guide;
}

/** Explicit bootstrap primitive. Ordinary step mutations never call it. */
export async function ensureGuide(id: string, createdAt = Date.now()): Promise<Guide> {
  if (!id) throw new Error('Guide id is required.');
  return runWithDatabase(async (db) => {
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
  });
}

export async function getGuide(id: string): Promise<Guide | undefined> {
  const guide = await runWithDatabase((db) => db.get('guides', id));
  return guide ? sanitizeGuide(guide) : undefined;
}

type GuideOnlyTransaction = IDBPTransaction<FrameTrailDB, ['guides'], 'readwrite'>;

/** Loads a guide row inside a guides-only readwrite transaction, aborting the
 * transaction when the row is gone so the thrown error can never leave a
 * partial write behind. Returns the raw row; callers sanitize on write. */
async function requireGuideInTx(tx: GuideOnlyTransaction, id: string): Promise<Guide> {
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('Guide not found.');
  }
  return existing;
}

export async function updateGuide(
  id: string,
  changes: Partial<Pick<Guide, 'title' | 'description' | 'tags'>>,
): Promise<Guide> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction('guides', 'readwrite');
    const existing = await requireGuideInTx(tx, id);
    const patch: Partial<Guide> = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.tags !== undefined) patch.tags = changes.tags;
    const updated = sanitizeGuide({ ...existing, ...patch, updatedAt: Math.max(existing.updatedAt, Date.now()) });
    await tx.store.put(updated);
    await tx.done;
    return updated;
  });
}

/** Reads only denormalized guide rows; no step cursor or screenshot Blob is opened. */
export async function getGuideSummaries(): Promise<GuideSummary[]> {
  const guides = (await runWithDatabase((db) => db.getAllFromIndex('guides', 'by-updated-at')))
    .map(sanitizeGuide);
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
  initial?: Partial<Pick<Guide, 'title' | 'description' | 'tags'>>,
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
  initial?: Partial<Pick<Guide, 'title' | 'description' | 'tags'>>,
  options: CreateGuideFromStepsOptions = {},
): Promise<Guide> {
  const prepared = prepareGuideClone(sourceSteps, initial, options);
  return runGuideStepsWrite(async (tx) => {
    await storePreparedGuide(tx, prepared);
    return prepared.guide;
  });
}

/** Reads the source snapshot and writes its clone in one serializable transaction. */
export async function duplicateGuide(sourceId: string, title?: string): Promise<Guide> {
  return runGuideStepsWrite(async (tx) => {
    const source = await tx.objectStore('guides').get(sourceId);
    if (!source) throw new Error('Guide not found.');
    const sourceSteps = await tx.objectStore('steps').index('by-session').getAll(sourceId);
    const sanitizedSource = sanitizeGuide(source);
    const prepared = prepareGuideClone(sourceSteps, {
      title: title ?? `${sanitizedSource.title}（副本）`,
      description: sanitizedSource.description,
      tags: sanitizedSource.tags,
    }, { sections: sanitizedSource.sections });
    await storePreparedGuide(tx, prepared);
    return prepared.guide;
  });
}

/**
 * Reclaims a Guide that was auto-created for a run which never produced
 * anything: deletes it and compare-and-clears the matching UI selection, but
 * only while it is still a pristine empty shell (see isPristineGuide), so a
 * guide the user has meanwhile named or filled is never destroyed. Callers
 * must only pass ids they themselves auto-created — an explicitly created
 * 作品庫 guide shares the same empty shape and must never reach this.
 * Returns whether it deleted.
 */
export async function discardPristineGuide(guideId: string): Promise<boolean> {
  const guide = await getGuide(guideId);
  if (!guide || !isPristineGuide(guide)) return false;
  await deleteGuidePermanently(guideId);
  await clearActiveGuideId(guideId);
  return true;
}

export async function deleteGuidePermanently(id: string): Promise<void> {
  await runGuideStepsWrite(async (tx) => {
    let cursor = await tx.objectStore('steps').index('by-session').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore('guides').delete(id);
  });
}

/** Atomically clears guide content while preserving identity and metadata. */
export async function resetGuide(id: string): Promise<Guide> {
  return runGuideStepsWrite(async (tx) => {
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
    return reset;
  });
}

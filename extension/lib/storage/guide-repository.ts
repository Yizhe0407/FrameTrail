import { repairGuideSections, type GuideSection } from '../guide/guide-sections';
import {
  buildCompleteStepEntries,
  defaultGuideTitle,
  sanitizeGuide,
  STEP_STORAGE_LIMITS,
  storageError,
  sanitizeStepForStorage,
  type Guide,
  type GuideSummary,
  type Step,
} from './models';
import {
  abortTransaction,
  assertGuideStorageLimits,
  getDatabase,
  newGuide,
  requireWritableGuide,
  summarizeSteps,
  type GuideStepsTransaction,
} from './database';

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

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  STEP_STORAGE_LIMITS,
  defaultGuideTitle,
  getEffectiveBounds,
  requireStorageIdentifier,
  sanitizeGuide,
  stepRole,
  storageError,
  type Guide,
  type Step,
} from './models';

export interface FrameTrailDB extends DBSchema {
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

export type GuideStepsTransaction = IDBPTransaction<FrameTrailDB, ['guides', 'steps'], 'readwrite'>;
export type ReadonlyGuideStepsTransaction = IDBPTransaction<FrameTrailDB, ['guides', 'steps'], 'readonly'>;

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
  const role = stepRole(step);
  // Anchors are shared base images, not user-visible steps.
  if (role !== 'anchor') summary.stepCount += 1;
  summary.storageBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    summary.storageBytes + (step.screenshotBlob?.size ?? 0),
  );

  if (role === 'ordinary') {
    if (step.screenshotBlob) summary.ordinaryEntryCount += 1;
    return;
  }

  const groupId = step.groupId!; // anchors and annotations always carry one
  let group = summary.groups.get(groupId);
  if (!group) {
    group = { hasAnchorImage: false, validAnnotationCount: 0, fallbackImageCount: 0 };
    summary.groups.set(groupId, group);
  }
  if (role === 'anchor' && step.screenshotBlob) group.hasAnchorImage = true;
  if (role === 'annotation' && getEffectiveBounds(step)) group.validAnnotationCount += 1;
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

export function summarizeSteps(steps: Iterable<Step>): Pick<Guide, 'stepCount' | 'entryCount' | 'storageBytes'> {
  const summary = createSummaryAccumulator();
  for (const step of steps) addStepToSummary(summary, step);
  return finishSummary(summary);
}

export function assertGuideStorageLimits(
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

export function newGuide(
  id: string,
  now: number,
  initial?: Partial<Pick<Guide, 'title' | 'description' | 'tags'>>,
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
    tags: initial?.tags ? [...initial.tags] : [],
    createdAt: now,
    updatedAt: now,
    contentRevision,
    ...summary,
  });
}

/**
 * True while a (sanitized) Guide is still exactly the empty shell newGuide
 * leaves behind with no initial metadata: nothing recorded, and no
 * user-entered title, description, tags, or sections. sanitizeGuide always
 * substitutes the timestamped 未命名教學 placeholder for an empty title, so on
 * a sanitized guide "unnamed" is exactly the placeholder derived from
 * createdAt — any user-typed title differs from it. contentRevision is
 * deliberately not consulted: transient rows such as a snapshot run's deleted
 * empty anchor bump it without leaving any user content behind.
 */
export function isPristineGuide(guide: Guide): boolean {
  return (
    guide.stepCount === 0 &&
    guide.entryCount === 0 &&
    guide.title === defaultGuideTitle(guide.createdAt) &&
    guide.description === '' &&
    guide.tags.length === 0 &&
    guide.sections.length === 0
  );
}

export async function requireWritableGuide(tx: GuideStepsTransaction, id: string): Promise<Guide> {
  const guide = await tx.objectStore('guides').get(id);
  if (!guide) throw new Error('Guide not found.');
  return sanitizeGuide(guide);
}

export async function refreshGuideSummary(
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

export async function abortTransaction(tx: GuideStepsTransaction, error: unknown): Promise<never> {
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

export function getDatabase(): Promise<IDBPDatabase<FrameTrailDB>> {
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
            tags: [],
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
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

function isClosedConnectionError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}

/** Runs one repository operation against the shared connection. The `blocking`
 * handler above (and browser `terminated`) may close that connection while a
 * caller still holds the awaited db, making its next transaction()/request
 * throw InvalidStateError before any work commits. Because nothing was
 * committed, retrying once against a freshly opened connection is safe and
 * transparently recovers autosaves and other in-flight callers. */
export async function runWithDatabase<T>(
  operation: (db: IDBPDatabase<FrameTrailDB>) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  try {
    return await operation(db);
  } catch (error) {
    if (!isClosedConnectionError(error)) throw error;
    const reopened = await getDatabase();
    // Same connection means it was never closed; the error has another cause.
    if (reopened === db) throw error;
    return operation(reopened);
  }
}

/** Standard guides+steps readwrite transaction: closed-connection retry, one
 * commit, and rollback through abortTransaction so a failing body can never
 * leak an unhandled tx.done rejection. */
export async function runGuideStepsWrite<T>(
  operation: (tx: GuideStepsTransaction) => Promise<T>,
): Promise<T> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction(['guides', 'steps'], 'readwrite');
    try {
      const result = await operation(tx);
      await tx.done;
      return result;
    } catch (error) {
      return abortTransaction(tx, error);
    }
  });
}

/** Closes the shared connection. Primarily useful for tests and graceful teardown. */
export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = undefined;
  const db = databaseConnection ?? (pending ? await pending.catch(() => undefined) : undefined);
  databaseConnection = undefined;
  db?.close();
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

export async function writeDenseOrder(tx: GuideStepsTransaction, steps: Step[], orderedIds: string[]): Promise<void> {
  const reordered = sortSessionSteps(steps, orderedIds);
  for (let order = 0; order < reordered.length; order += 1) {
    const step = reordered[order];
    if (step.order !== order) await tx.objectStore('steps').put({ ...step, order });
  }
}

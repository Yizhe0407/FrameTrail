import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { repairGuideSections } from '../guide/guide-sections';
import {
  STEP_STORAGE_LIMITS,
  defaultGuideTitle,
  getEffectiveBounds,
  requireStorageIdentifier,
  sanitizeGuide,
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

export async function requireWritableGuide(tx: GuideStepsTransaction, id: string): Promise<Guide> {
  const guide = await tx.objectStore('guides').get(id);
  if (!guide) throw new Error('Guide not found.');
  const sanitized = sanitizeGuide(guide);
  if (sanitized.archivedAt !== null) throw new Error('Archived guides cannot be modified.');
  return sanitized;
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


export function sortSessionSteps(sessionSteps: Step[], orderedIds: string[]): Step[] {
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

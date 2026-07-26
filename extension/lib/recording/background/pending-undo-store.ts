import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Step } from '../../storage/db';

/**
 * Durable copy of the one step an in-flight undo removed from the guide. The
 * in-memory pendingUndo slot in the background is authoritative while the
 * service worker lives, but MV3 may terminate it inside the short restore
 * window — this record is then the only surviving copy of the screenshot, so
 * startup can rehydrate the window instead of losing the image forever. It is
 * hard-deleted lazily: on restore, on the next undo/capture/lifecycle change,
 * or at startup once the window has expired.
 */
export interface PendingUndoRecord {
  token: string;
  runId: string;
  step: Step;
  expectedItemCount: number;
  expiresAt: number;
}

interface PendingUndoDB extends DBSchema {
  'pending-undo': {
    key: string;
    value: PendingUndoRecord;
  };
}

const DB_NAME = 'frametrail-pending-undo';
const STORE_NAME = 'pending-undo';
/** Undo is single-slot by design; a fixed key makes every save an overwrite. */
const RECORD_KEY = 'current';

let dbPromise: Promise<IDBPDatabase<PendingUndoDB>> | null = null;

function openPendingUndoDb(): Promise<IDBPDatabase<PendingUndoDB>> {
  dbPromise ??= openDB<PendingUndoDB>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE_NAME);
    },
  });
  return dbPromise;
}

function isPendingUndoRecord(value: unknown): value is PendingUndoRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingUndoRecord>;
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof record.runId === 'string' &&
    record.runId.length > 0 &&
    typeof record.expectedItemCount === 'number' &&
    Number.isSafeInteger(record.expectedItemCount) &&
    record.expectedItemCount >= 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    record.step != null &&
    typeof record.step === 'object'
  );
}

export async function savePendingUndoRecord(record: PendingUndoRecord): Promise<void> {
  const db = await openPendingUndoDb();
  await db.put(STORE_NAME, record, RECORD_KEY);
}

export async function readPendingUndoRecord(): Promise<PendingUndoRecord | null> {
  const db = await openPendingUndoDb();
  const record = await db.get(STORE_NAME, RECORD_KEY);
  return isPendingUndoRecord(record) ? record : null;
}

export async function clearPendingUndoRecord(): Promise<void> {
  const db = await openPendingUndoDb();
  await db.delete(STORE_NAME, RECORD_KEY);
}

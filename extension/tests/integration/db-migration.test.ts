import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterAll, describe, expect, it, vi } from 'vitest';

const DB_NAME = 'scribe';

function deleteLegacyDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Legacy database deletion was blocked.'));
  });
}

describe('v3 to v4 guide migration', () => {
  it('derives guide summaries with cursors without rewriting screenshot Blobs', async () => {
    await deleteLegacyDatabase();
    const legacy = await openDB(DB_NAME, 3, {
      upgrade(db) {
        const steps = db.createObjectStore('steps', { keyPath: 'id' });
        steps.createIndex('by-session', 'sessionId');
      },
    });
    const sessionId = 'legacy-guide';
    const originalBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const originalBlob = new Blob([originalBytes], { type: 'image/png' });
    await legacy.put('steps', {
      id: 'legacy-step',
      sessionId,
      order: 0,
      screenshotBlob: originalBlob,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 1,
      description: 'legacy',
      url: 'https://example.com',
      timestamp: 1_700_000_000_000,
    });
    legacy.close();

    const nativePut = IDBObjectStore.prototype.put;
    const nativeGetAll = IDBObjectStore.prototype.getAll;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'steps') throw new Error('migration attempted to rewrite a legacy step');
      return nativePut.apply(this, args as Parameters<IDBObjectStore['put']>);
    });
    const getAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'steps') throw new Error('migration attempted to getAll legacy steps');
      return nativeGetAll.apply(this, args as Parameters<IDBObjectStore['getAll']>);
    });

    try {
      const db = await import('@/lib/storage/db');
      const guide = await db.getGuide(sessionId);
      const migrated = await db.getStep('legacy-step');

      expect(guide).toMatchObject({
        id: sessionId,
        contentRevision: 0,
        sections: [],
        stepCount: 1,
        entryCount: 1,
        storageBytes: originalBlob.size,
      });
      expect(migrated?.screenshotBlob).toBeInstanceOf(Blob);
      expect(migrated?.screenshotBlob?.type).toBe(originalBlob.type);
      expect(new Uint8Array(await migrated!.screenshotBlob!.arrayBuffer())).toEqual(originalBytes);
      await db.closeDatabase();
    } finally {
      putSpy.mockRestore();
      getAllSpy.mockRestore();
    }
  });
});

afterAll(async () => {
  await deleteLegacyDatabase();
});

import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStep,
  closeDatabase,
  deleteGuidePermanently,
  deleteStep,
  ensureGuide,
  getInsertionAnchor,
  getSteps,
  insertStepsAtEntryBoundary,
  InsertionRecordingError,
  updateGuide,
  validateInsertionRunState,
  type Step,
} from '@/lib/db';

function step(sessionId: string, id: string, order: number, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId,
    order,
    screenshotBlob: new Blob([id], { type: 'image/jpeg' }),
    bounds: { x: 1, y: 2, width: 30, height: 20 },
    devicePixelRatio: 1,
    description: id,
    url: `https://example.com/${sessionId}`,
    timestamp: order + 1,
    ...overrides,
  };
}

async function seed(rows: Step[]): Promise<void> {
  await ensureGuide(rows[0].sessionId, 1);
  for (const row of rows) await addStep(row);
}

function ids(rows: Step[]): string[] {
  return rows.map((row) => row.id);
}

function expectDense(rows: Step[]): void {
  expect(rows.map((row) => row.order)).toEqual(rows.map((_, index) => index));
}

async function deleteTestDatabase(): Promise<void> {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('scribe');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database deletion was blocked.'));
  });
}

beforeEach(deleteTestDatabase);
afterAll(closeDatabase);

describe('transactional insertion recording', () => {
  it.each([
    ['before', ['left', 'capture-1', 'anchor', 'right']],
    ['after', ['left', 'anchor', 'capture-1', 'right']],
  ] as const)('inserts %s a single entry with dense order', async (side, expected) => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([
      step(sessionId, 'left', 0),
      step(sessionId, 'anchor', 1),
      step(sessionId, 'right', 2),
    ]);

    const committed = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side,
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'capture-1', 99, { runId })],
    });

    expect(committed.runBlockIds).toEqual(['capture-1']);
    const stored = await getSteps(sessionId);
    expect(ids(stored)).toEqual(expected);
    expectDense(stored);
  });

  it.each([
    ['before', ['left', 'capture', 'snap', 'annotation', 'right']],
    ['after', ['left', 'snap', 'annotation', 'capture', 'right']],
  ] as const)('uses the complete snapshot entry boundary when inserting %s', async (side, expected) => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([
      step(sessionId, 'left', 0),
      step(sessionId, 'snap', 1, { groupId: 'snap', bounds: null }),
      step(sessionId, 'annotation', 2, { groupId: 'snap', screenshotBlob: undefined }),
      step(sessionId, 'right', 3),
    ]);

    const anchor = await getInsertionAnchor(sessionId, 'snap');
    expect(anchor).toMatchObject({ kind: 'group', memberIds: ['snap', 'annotation'] });
    await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'snap',
      side,
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'capture', 50, { runId })],
    });

    const stored = await getSteps(sessionId);
    expect(ids(stored)).toEqual(expected);
    expectDense(stored);
  });

  it('keeps repeated captures from one run as one chronological contiguous block', async () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([step(sessionId, 'left', 0), step(sessionId, 'anchor', 1), step(sessionId, 'right', 2)]);

    const first = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'capture-1', 10, { runId })],
    });
    const second = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      expectedRunBlockIds: first.runBlockIds,
      newSteps: [step(sessionId, 'capture-2', 11, { runId })],
    });

    expect(second.runBlockIds).toEqual(['capture-1', 'capture-2']);
    const stored = await getSteps(sessionId);
    expect(ids(stored)).toEqual(['left', 'capture-1', 'capture-2', 'anchor', 'right']);
    expectDense(stored);
    await validateInsertionRunState({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      runBlockIds: second.runBlockIds,
    });
  });

  it('inserts a snapshot anchor and annotations as a complete contiguous run block', async () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([step(sessionId, 'anchor', 0), step(sessionId, 'right', 1)]);

    const base = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'after',
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'new-snap', 10, { runId, groupId: 'new-snap', bounds: null })],
    });
    const complete = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'after',
      expectedRunBlockIds: base.runBlockIds,
      newSteps: [
        step(sessionId, 'new-annotation-1', 11, { runId, groupId: 'new-snap', screenshotBlob: undefined }),
        step(sessionId, 'new-annotation-2', 12, { runId, groupId: 'new-snap', screenshotBlob: undefined }),
      ],
    });

    expect(complete.runBlockIds).toEqual(['new-snap', 'new-annotation-1', 'new-annotation-2']);
    const stored = await getSteps(sessionId);
    expect(ids(stored)).toEqual(['anchor', 'new-snap', 'new-annotation-1', 'new-annotation-2', 'right']);
    expectDense(stored);
  });

  it('aborts without writing when the anchor is deleted, Guide is archived, or Guide is deleted', async () => {
    const deletedAnchorSession = crypto.randomUUID();
    await seed([step(deletedAnchorSession, 'anchor-a', 0)]);
    await deleteStep('anchor-a');
    await expect(insertStepsAtEntryBoundary({
      sessionId: deletedAnchorSession,
      runId: 'run-a',
      anchorEntryId: 'anchor-a',
      side: 'before',
      expectedRunBlockIds: [],
      newSteps: [step(deletedAnchorSession, 'never-a', 1, { runId: 'run-a' })],
    })).rejects.toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
    expect(await getSteps(deletedAnchorSession)).toEqual([]);

    const archivedSession = crypto.randomUUID();
    await seed([step(archivedSession, 'anchor-b', 0)]);
    await updateGuide(archivedSession, { archivedAt: Date.now() });
    await expect(insertStepsAtEntryBoundary({
      sessionId: archivedSession,
      runId: 'run-b',
      anchorEntryId: 'anchor-b',
      side: 'after',
      expectedRunBlockIds: [],
      newSteps: [step(archivedSession, 'never-b', 1, { runId: 'run-b' })],
    })).rejects.toMatchObject({ code: 'GUIDE_ARCHIVED' });
    expect(ids(await getSteps(archivedSession))).toEqual(['anchor-b']);

    const deletedGuideSession = crypto.randomUUID();
    await seed([step(deletedGuideSession, 'anchor-c', 0)]);
    await deleteGuidePermanently(deletedGuideSession);
    await expect(getInsertionAnchor(deletedGuideSession, 'anchor-c')).rejects.toMatchObject({
      code: 'GUIDE_NOT_FOUND',
    });
  });

  it('rejects stale durable run ids and detects restart mismatches', async () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([step(sessionId, 'anchor', 0)]);
    const committed = await insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'capture', 1, { runId })],
    });

    await expect(insertStepsAtEntryBoundary({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      expectedRunBlockIds: [],
      newSteps: [step(sessionId, 'stale-write', 2, { runId })],
    })).rejects.toMatchObject({ code: 'RUN_STATE_CHANGED' });
    expect(ids(await getSteps(sessionId))).toEqual(['capture', 'anchor']);

    await validateInsertionRunState({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'before',
      runBlockIds: committed.runBlockIds,
    });
    await expect(validateInsertionRunState({
      sessionId,
      runId,
      anchorEntryId: 'anchor',
      side: 'after',
      runBlockIds: committed.runBlockIds,
    })).rejects.toBeInstanceOf(InsertionRecordingError);
  });

  it('serializes an archive race and never commits a partial capture', async () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await seed([step(sessionId, 'anchor', 0), step(sessionId, 'right', 1)]);

    const [archiveResult, insertResult] = await Promise.allSettled([
      updateGuide(sessionId, { archivedAt: Date.now() }),
      insertStepsAtEntryBoundary({
        sessionId,
        runId,
        anchorEntryId: 'anchor',
        side: 'after',
        expectedRunBlockIds: [],
        newSteps: [step(sessionId, 'racing-capture', 3, { runId })],
      }),
    ]);

    expect(archiveResult.status).toBe('fulfilled');
    const stored = await getSteps(sessionId);
    expectDense(stored);
    if (insertResult.status === 'fulfilled') {
      expect(ids(stored)).toEqual(['anchor', 'racing-capture', 'right']);
    } else {
      expect(insertResult.reason).toMatchObject({ code: 'GUIDE_ARCHIVED' });
      expect(ids(stored)).toEqual(['anchor', 'right']);
    }
  });
});

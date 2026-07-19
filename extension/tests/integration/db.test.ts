import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  addStep,
  buildStepEntries,
  deleteStepsAndReorder,
  deleteStepsForRun,
  getOrderedAnnotations,
  getSteps,
  reorderSteps,
  restoreStepsAndReorder,
  updateStep,
  type Step,
} from '@/lib/db';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/jpeg' }),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildStepEntries', () => {
  it('groups in linear input order and excludes corrupt annotations', () => {
    const groupId = crypto.randomUUID();
    const anchor = makeStep({ id: groupId, groupId, bounds: null, order: 0 });
    const annotation = makeStep({ groupId, screenshotBlob: undefined, order: 1 });
    const corrupt = makeStep({ groupId, screenshotBlob: undefined, bounds: null, order: 2 });
    const ordinary = makeStep({ order: 3 });

    const entries = buildStepEntries([anchor, annotation, corrupt, ordinary]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'group', anchor: { id: groupId } });
    expect(entries[0].kind === 'group' && entries[0].annotations).toEqual([annotation]);
    expect(entries[1]).toMatchObject({ kind: 'single', step: { id: ordinary.id } });
  });

  it('does not crash on a missing anchor and salvages legacy image-bearing members', () => {
    const missingAnchorId = crypto.randomUUID();
    const legacyAnnotation = makeStep({ groupId: missingAnchorId });
    const modernAnnotation = makeStep({ groupId: missingAnchorId, screenshotBlob: undefined });

    const entries = buildStepEntries([legacyAnnotation, modernAnnotation]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'single', step: { id: legacyAnnotation.id } });
  });

  it('does not render an empty snapshot anchor as a phantom annotated entry', () => {
    const groupId = crypto.randomUUID();
    const anchor = makeStep({ id: groupId, groupId, bounds: null, order: 0 });

    expect(buildStepEntries([anchor])).toEqual([]);
  });
});

describe('getOrderedAnnotations', () => {
  it('centralizes contiguous display ordering and ignores invalid rows', () => {
    const first = makeStep({ bounds: { x: 1, y: 2, width: 3, height: 4 } });
    const invalid = makeStep({ bounds: null });
    const nonFinite = makeStep({ bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } });
    const empty = makeStep({ bounds: { x: 0, y: 0, width: 0, height: 10 } });
    const second = makeStep({ bounds: { x: 5, y: 6, width: 7, height: 8 } });

    expect(getOrderedAnnotations([first, invalid, nonFinite, empty, second])).toEqual([
      { bounds: first.bounds, order: 1 },
      { bounds: second.bounds, order: 2 },
    ]);
  });
});

describe('step persistence', () => {
  it('does not persist duplicate screenshot blobs on snapshot annotations', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    await addStep(makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null }));
    const annotation = makeStep({ sessionId, groupId: anchorId, order: 1 });
    await addStep(annotation);

    const stored = await getSteps(sessionId);

    expect(stored.find((step) => step.id === anchorId)?.screenshotBlob).toBeInstanceOf(Blob);
    expect(stored.find((step) => step.id === annotation.id)?.screenshotBlob).toBeUndefined();
  });

  it('preserves concurrent field updates in one-store transactions', async () => {
    const step = makeStep();
    await addStep(step);

    await Promise.all([
      updateStep(step.id, { description: 'updated' }),
      updateStep(step.id, { numbered: false }),
    ]);

    expect((await getSteps(step.sessionId))[0]).toMatchObject({ description: 'updated', numbered: false });
  });

  it('appends steps missing from a stale reorder request without order collisions', async () => {
    const sessionId = crypto.randomUUID();
    const first = makeStep({ sessionId, order: 0, description: 'keep me' });
    const second = makeStep({ sessionId, order: 1 });
    const newlyRecorded = makeStep({ sessionId, order: 2 });
    await Promise.all([addStep(first), addStep(second), addStep(newlyRecorded)]);

    await reorderSteps(sessionId, [second.id, first.id]);

    const stored = await getSteps(sessionId);
    expect(stored.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: second.id, order: 0 },
      { id: first.id, order: 1 },
      { id: newlyRecorded.id, order: 2 },
    ]);
    expect(stored[1].description).toBe('keep me');
  });

  it('deletes multiple rows and closes order gaps in one transaction', async () => {
    const sessionId = crypto.randomUUID();
    const first = makeStep({ sessionId, order: 0 });
    const removedA = makeStep({ sessionId, order: 1 });
    const removedB = makeStep({ sessionId, order: 2 });
    const last = makeStep({ sessionId, order: 3 });
    await Promise.all([first, removedA, removedB, last].map(addStep));

    await deleteStepsAndReorder(sessionId, [removedA.id, removedB.id], [last.id, first.id]);

    expect((await getSteps(sessionId)).map(({ id, order }) => ({ id, order }))).toEqual([
      { id: last.id, order: 0 },
      { id: first.id, order: 1 },
    ]);
  });

  it('discards only the selected recording run and closes remaining order gaps', async () => {
    const sessionId = crypto.randomUUID();
    const previous = makeStep({ sessionId, runId: 'previous-run', order: 0, description: 'keep' });
    const discardedAnchorId = crypto.randomUUID();
    const discardedAnchor = makeStep({
      id: discardedAnchorId,
      sessionId,
      runId: 'discarded-run',
      groupId: discardedAnchorId,
      bounds: null,
      order: 1,
    });
    const discardedAnnotation = makeStep({
      sessionId,
      runId: 'discarded-run',
      groupId: discardedAnchorId,
      screenshotBlob: undefined,
      order: 2,
    });
    const later = makeStep({ sessionId, runId: 'later-run', order: 3, description: 'also keep' });
    await Promise.all([previous, discardedAnchor, discardedAnnotation, later].map(addStep));

    await deleteStepsForRun(sessionId, 'discarded-run');

    expect((await getSteps(sessionId)).map(({ id, order, description }) => ({ id, order, description }))).toEqual([
      { id: previous.id, order: 0, description: 'keep' },
      { id: later.id, order: 1, description: 'also keep' },
    ]);
  });

  it('restores deleted rows and their original order in one transaction', async () => {
    const sessionId = crypto.randomUUID();
    const first = makeStep({ sessionId, order: 0 });
    const restored = makeStep({ sessionId, order: 1, description: 'restore me' });
    const last = makeStep({ sessionId, order: 2 });
    await Promise.all([first, restored, last].map(addStep));
    await deleteStepsAndReorder(sessionId, [restored.id], [first.id, last.id]);

    await restoreStepsAndReorder(sessionId, [restored], [first.id, restored.id, last.id]);

    expect((await getSteps(sessionId)).map(({ id, order, description }) => ({ id, order, description }))).toEqual([
      { id: first.id, order: 0, description: '' },
      { id: restored.id, order: 1, description: 'restore me' },
      { id: last.id, order: 2, description: '' },
    ]);
  });
});

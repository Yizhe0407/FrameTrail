import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  addStep,
  buildStepEntries,
  deleteStepsAndReorder,
  deleteStepsForRun,
  getEffectiveBounds,
  getOrderedAnnotations,
  getSteps,
  reorderSteps,
  replaceStepCaptureAtomically,
  restoreStepsAndReorder,
  updateStep,
  updateStepsAtomically,
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

describe('effective visual data', () => {
  it('prefers a valid manual override and can restore the detected bounds', () => {
    const step = makeStep({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      manualBounds: { x: 10, y: 20, width: 30, height: 40 },
    });
    expect(getEffectiveBounds(step)).toEqual(step.manualBounds);
    expect(getEffectiveBounds({ ...step, manualBounds: null })).toEqual(step.bounds);
  });

  it('uses manual bounds when building snapshot annotation order', () => {
    const step = makeStep({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      manualBounds: { x: 9, y: 8, width: 7, height: 6 },
    });
    expect(getOrderedAnnotations([step])).toEqual([{ bounds: step.manualBounds, order: 1 }]);
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

  it('sanitizes malformed manual bounds and redaction records before storage', async () => {
    const step = makeStep({
      manualBounds: { x: 1, y: 2, width: Number.NaN, height: 4 },
      redactions: [
        { id: '   ', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } },
        { id: 'invalid-bounds', kind: 'solid', bounds: { x: 1, y: 1, width: 0, height: 2 } },
        { id: 'valid-mask', kind: 'solid', bounds: { x: 3, y: 4, width: 5, height: 6 } },
      ],
    });

    await addStep(step);

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored.manualBounds).toBeNull();
    expect(stored.redactions).toEqual([
      { id: 'valid-mask', kind: 'solid', bounds: { x: 3, y: 4, width: 5, height: 6 } },
    ]);
    expect(stored.redactionReviewRequired).toBe(true);
  });

});


describe('atomic visual edits and recapture', () => {
  it('stores redactions only on the screenshot owner and preserves concurrent metadata', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null });
    const annotation = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    await Promise.all([addStep(anchor), addStep(annotation)]);

    await Promise.all([
      updateStep(annotation.id, { description: 'new description' }),
      updateStepsAtomically(sessionId, [
        { id: annotation.id, changes: { manualBounds: { x: 4, y: 5, width: 6, height: 7 }, redactions: [{ id: 'wrong-owner', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }] } },
        { id: anchor.id, changes: { redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 8, y: 9, width: 10, height: 11 } }] } },
      ]),
    ]);

    const stored = await getSteps(sessionId);
    expect(stored.find((step) => step.id === annotation.id)).toMatchObject({
      description: 'new description',
      manualBounds: { x: 4, y: 5, width: 6, height: 7 },
    });
    expect(stored.find((step) => step.id === annotation.id)?.redactions).toBeUndefined();
    expect(stored.find((step) => step.id === anchor.id)?.redactions?.[0].id).toBe('mask');
  });

  it('recaptures an ordinary step without changing its identity, order, description or provenance', async () => {
    const step = makeStep({ order: 7, description: 'keep', runId: 'original-run', manualBounds: { x: 9, y: 9, width: 9, height: 9 }, redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }] });
    await addStep(step);
    const screenshotBlob = new Blob(['replacement'], { type: 'image/jpeg' });

    await replaceStepCaptureAtomically(step.sessionId, { kind: 'single', stepId: step.id }, {
      screenshotBlob,
      bounds: { x: 20, y: 30, width: 40, height: 50 },
      devicePixelRatio: 2,
      screenshotScale: 1.5,
      url: 'https://example.com/recaptured',
      timestamp: 123,
    }, 'recapture-run');

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored).toMatchObject({
      id: step.id,
      sessionId: step.sessionId,
      order: 7,
      description: 'keep',
      runId: 'original-run',
      bounds: { x: 20, y: 30, width: 40, height: 50 },
      manualBounds: null,
      redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }],
      redactionReviewRequired: true,
      captureRevision: 1,
      lastCaptureRunId: 'recapture-run',
    });
    expect(await stored.screenshotBlob?.text()).toBe('replacement');
  });


  it('rejects a stale visual save after ordinary recapture without clearing the privacy gate', async () => {
    const step = makeStep({
      redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }],
    });
    await addStep(step);
    await replaceStepCaptureAtomically(
      step.sessionId,
      { kind: 'single', stepId: step.id },
      {
        screenshotBlob: new Blob(['replacement']),
        bounds: { x: 20, y: 30, width: 40, height: 50 },
        devicePixelRatio: 1,
        screenshotScale: 1,
        url: step.url,
        timestamp: 123,
      },
      'recapture-run',
    );

    await expect(
      updateStepsAtomically(step.sessionId, [
        { id: step.id, changes: { manualBounds: { x: 7, y: 7, width: 7, height: 7 } } },
        {
          id: step.id,
          expectedCaptureRevision: 0,
          changes: { redactions: [], redactionReviewRequired: false },
        },
      ]),
    ).rejects.toMatchObject({ name: 'StepUpdateConflictError' });

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored.captureRevision).toBe(1);
    expect(stored.manualBounds).toBeNull();
    expect(stored.redactions?.[0]?.id).toBe('old-mask');
    expect(stored.redactionReviewRequired).toBe(true);
  });

  it('rolls back stale snapshot annotation edits when the anchor revision changed', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({
      id: anchorId,
      sessionId,
      groupId: anchorId,
      bounds: null,
      redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }],
    });
    const annotation = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    await Promise.all([addStep(anchor), addStep(annotation)]);
    await replaceStepCaptureAtomically(
      sessionId,
      { kind: 'snapshot-singleton', anchorId, annotationId: annotation.id },
      {
        screenshotBlob: new Blob(['replacement']),
        bounds: { x: 20, y: 30, width: 40, height: 50 },
        devicePixelRatio: 1,
        screenshotScale: 1,
        url: anchor.url,
        timestamp: 123,
      },
      'recapture-run',
    );

    await expect(
      updateStepsAtomically(sessionId, [
        { id: annotation.id, changes: { manualBounds: { x: 7, y: 7, width: 7, height: 7 } } },
        {
          id: anchorId,
          expectedCaptureRevision: 0,
          changes: { redactions: [], redactionReviewRequired: false },
        },
      ]),
    ).rejects.toMatchObject({ name: 'StepUpdateConflictError' });

    const stored = await getSteps(sessionId);
    const storedAnchor = stored.find((item) => item.id === anchorId)!;
    const storedAnnotation = stored.find((item) => item.id === annotation.id)!;
    expect(storedAnchor.captureRevision).toBe(1);
    expect(storedAnchor.redactions?.[0]?.id).toBe('old-mask');
    expect(storedAnchor.redactionReviewRequired).toBe(true);
    expect(storedAnnotation.manualBounds).toBeNull();
    expect(storedAnnotation.bounds).toEqual({ x: 20, y: 30, width: 40, height: 50 });
  });

  it('rejects recapturing a snapshot that has multiple annotations without writing', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null });
    const first = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    const second = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 2 });
    await Promise.all([anchor, first, second].map(addStep));

    await expect(replaceStepCaptureAtomically(sessionId, { kind: 'snapshot-singleton', anchorId, annotationId: first.id }, {
      screenshotBlob: new Blob(['replacement']),
      bounds: { x: 10, y: 10, width: 10, height: 10 },
      devicePixelRatio: 1,
      screenshotScale: 1,
      url: anchor.url,
      timestamp: 999,
    }, 'recapture-run')).rejects.toMatchObject({ code: 'UNSUPPORTED_SNAPSHOT_GROUP' });

    expect(await (await getSteps(sessionId)).find((step) => step.id === anchorId)?.screenshotBlob?.text()).toBe('image');
  });
});

import 'fake-indexeddb/auto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  GuideContentConflictError,
  GuideStructureIntegrityError,
  addGuideSectionAtomically,
  closeDatabase,
  createGuideFromSteps,
  deleteGuideAnnotationAtomically,
  deleteGuideEntriesAtomically,
  deleteGuidePermanently,
  deleteGuideSectionAtomically,
  duplicateGuide,
  duplicateGuideEntryAtomically,
  getGuideStructureSnapshot,
  getGuideSummaries,
  getSteps,
  moveGuideEntriesAtomically,
  renameGuideSectionAtomically,
  reorderGuideAnnotationsAtomically,
  reorderGuideEntriesAtomically,
  resetGuide,
  restoreGuideAnnotationAtomically,
  restoreGuideEntriesAtomically,
  setGuideEntriesNumberedAtomically,
  type GuideSection,
  type Step,
} from '@/lib/storage/db';

const createdGuideIds = new Set<string>();

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(), sessionId: 'source-guide', order: 0,
    screenshotBlob: new Blob(['pixels'], { type: 'image/png' }),
    bounds: { x: 1, y: 2, width: 30, height: 40 }, devicePixelRatio: 1,
    description: '', url: 'https://example.com/path', timestamp: Date.now(), ...overrides,
  };
}

function makeSingleSteps(count: number): Step[] {
  return Array.from({ length: count }, (_, order) => makeStep({ order }));
}

function makeMixedSteps(): Step[] {
  const sessionId = 'source-guide';
  const first = makeStep({ sessionId, order: 0 });
  const anchorId = crypto.randomUUID();
  const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null, numbered: false, order: 1 });
  const a1 = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, numbered: false, order: 2 });
  const a2 = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, numbered: false, order: 3 });
  const last = makeStep({ sessionId, order: 4 });
  return [first, anchor, a1, a2, last];
}

async function createTrackedGuide(steps: readonly Step[], options: { sections?: readonly GuideSection[] } = {}) {
  const guide = await createGuideFromSteps(steps, undefined, options);
  createdGuideIds.add(guide.id);
  return { guide, snapshot: await getGuideStructureSnapshot(guide.id) };
}

afterEach(async () => {
  for (const id of [...createdGuideIds]) {
    await deleteGuidePermanently(id).catch(() => undefined);
    createdGuideIds.delete(id);
  }
});
afterAll(closeDatabase);

describe('Guide entry-safe atomic structure', () => {
  it('rejects stale revisions and rolls the whole mutation back', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(3));
    const moved = await moveGuideEntriesAtomically(guide.id, [snapshot.entryIds[2]], 'start', snapshot.guide.contentRevision);
    await expect(deleteGuideEntriesAtomically(guide.id, [snapshot.entryIds[0]], snapshot.guide.contentRevision))
      .rejects.toBeInstanceOf(GuideContentConflictError);
    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect(after.guide.contentRevision).toBe(moved.guide.contentRevision);
  });

  it('treats snapshot groups as indivisible and rejects annotation ids', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries.find((entry) => entry.kind === 'group');
    const annotationId = group?.kind === 'group' ? group.annotations[0].id : '';
    await expect(deleteGuideEntriesAtomically(guide.id, [annotationId], snapshot.guide.contentRevision))
      .rejects.toBeInstanceOf(GuideStructureIntegrityError);
    await expect(reorderGuideEntriesAtomically(
      guide.id, [snapshot.entryIds[0], annotationId, snapshot.entryIds[2]], snapshot.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);
    expect((await getGuideStructureSnapshot(guide.id)).entryIds).toEqual(snapshot.entryIds);
  });

  it('rebases a deleted section start only within its old chapter', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(5));
    const first = await addGuideSectionAtomically(guide.id, snapshot.entryIds[1], ' 第一章 ', snapshot.guide.contentRevision);
    const second = await addGuideSectionAtomically(guide.id, snapshot.entryIds[3], '第二章', first.guide.contentRevision);
    const deletedStart = await deleteGuideEntriesAtomically(guide.id, [snapshot.entryIds[1]], second.guide.contentRevision);
    expect(deletedStart.guide.sections.map((s) => s.startEntryId)).toEqual([snapshot.entryIds[2], snapshot.entryIds[3]]);
    const deletedChapter = await deleteGuideEntriesAtomically(guide.id, [snapshot.entryIds[2]], deletedStart.guide.contentRevision);
    expect(deletedChapter.guide.sections).toEqual([
      expect.objectContaining({ title: '第二章', startEntryId: snapshot.entryIds[3] }),
    ]);
  });

  it('moves entries densely while headings follow entry identity', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(4));
    const sectioned = await addGuideSectionAtomically(guide.id, snapshot.entryIds[1], '設定', snapshot.guide.contentRevision);
    const moved = await moveGuideEntriesAtomically(
      guide.id, [snapshot.entryIds[1], snapshot.entryIds[2]], 'end', sectioned.guide.contentRevision,
    );
    expect(moved.entryIds).toEqual([snapshot.entryIds[0], snapshot.entryIds[3], snapshot.entryIds[1], snapshot.entryIds[2]]);
    expect(moved.guide.sections[0].startEntryId).toBe(snapshot.entryIds[1]);
    expect((await getSteps(guide.id)).map((step) => step.order)).toEqual([0, 1, 2, 3]);
  });

  it('updates every snapshot member in one revision', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const groupId = snapshot.entryIds[1];
    const result = await setGuideEntriesNumberedAtomically(guide.id, [groupId], true, snapshot.guide.contentRevision);
    const rows = (await getSteps(guide.id)).filter((step) => step.groupId === groupId);
    expect(rows).toHaveLength(3);
    expect(rows.every((step) => step.numbered === true)).toBe(true);
    expect(result.guide.contentRevision).toBe(snapshot.guide.contentRevision + 1);
  });

  it('duplicates a complete snapshot with fresh ids without copying its heading', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const sectioned = await addGuideSectionAtomically(guide.id, snapshot.entryIds[1], '快照章節', snapshot.guide.contentRevision);
    const duplicated = await duplicateGuideEntryAtomically(guide.id, snapshot.entryIds[1], sectioned.guide.contentRevision);
    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.entryIds).toEqual([snapshot.entryIds[0], snapshot.entryIds[1], duplicated.createdEntryId, snapshot.entryIds[2]]);
    const copy = after.entries.find((entry) => entry.kind === 'group' && entry.anchor.id === duplicated.createdEntryId);
    expect(copy?.kind).toBe('group');
    if (copy?.kind === 'group') {
      expect(copy.anchor.groupId).toBe(copy.anchor.id);
      expect(copy.annotations.every((step) => step.groupId === copy.anchor.id && step.screenshotBlob === undefined)).toBe(true);
      expect(new Set(copy.annotations.map((step) => step.id)).size).toBe(2);
    }
    expect(after.guide.sections).toHaveLength(1);
    expect(after.guide.sections[0].startEntryId).toBe(snapshot.entryIds[1]);
  });

  it('remaps section boundaries for import-style clone and duplicate Guide', async () => {
    const source = makeMixedSteps();
    const sourceSection = { id: crypto.randomUUID(), title: '匯入章節', startEntryId: source[1].id };
    const { guide, snapshot } = await createTrackedGuide(source, { sections: [sourceSection] });
    expect(snapshot.guide.sections[0].id).not.toBe(sourceSection.id);
    expect(snapshot.guide.sections[0].startEntryId).toBe(snapshot.entryIds[1]);
    expect(snapshot.guide.sections[0].startEntryId).not.toBe(sourceSection.startEntryId);
    const duplicate = await duplicateGuide(guide.id);
    createdGuideIds.add(duplicate.id);
    const copy = await getGuideStructureSnapshot(duplicate.id);
    expect(copy.guide.sections[0].id).not.toBe(snapshot.guide.sections[0].id);
    expect(copy.guide.sections[0].startEntryId).toBe(copy.entryIds[1]);
    expect(copy.guide.sections[0].startEntryId).not.toBe(snapshot.entryIds[1]);
  });

  it('restores deleted entries, order, and sections against the post-delete revision', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(3));
    const sectioned = await addGuideSectionAtomically(guide.id, snapshot.entryIds[1], '可復原章節', snapshot.guide.contentRevision);
    const before = await getGuideStructureSnapshot(guide.id);
    const removed = before.entries[1];
    const rows = removed.kind === 'single' ? [removed.step] : [removed.anchor, ...removed.annotations];
    const deleted = await deleteGuideEntriesAtomically(guide.id, [before.entryIds[1]], sectioned.guide.contentRevision);
    const restored = await restoreGuideEntriesAtomically(
      guide.id, rows, before.entryIds, before.guide.sections, deleted.guide.contentRevision,
    );
    expect(restored.entryIds).toEqual(before.entryIds);
    expect(restored.guide.sections).toEqual(before.guide.sections);
  });

  it('sanitizes section titles and supports atomic rename/delete', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(1));
    const added = await addGuideSectionAtomically(guide.id, snapshot.entryIds[0], ' 章\n節 ', snapshot.guide.contentRevision);
    expect(added.guide.sections[0].title).toBe('章節');
    const renamed = await renameGuideSectionAtomically(guide.id, added.guide.sections[0].id, ' 新名稱 ', added.guide.contentRevision);
    expect(renamed.guide.sections[0].title).toBe('新名稱');
    const removed = await deleteGuideSectionAtomically(guide.id, renamed.guide.sections[0].id, renamed.guide.contentRevision);
    expect(removed.guide.sections).toEqual([]);
  });

  it('clears sections on reset', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(2));
    await addGuideSectionAtomically(guide.id, snapshot.entryIds[0], '開始', snapshot.guide.contentRevision);
    const reset = await resetGuide(guide.id);
    expect(reset.sections).toEqual([]);
    expect(reset.entryCount).toBe(0);
    expect((await getGuideStructureSnapshot(guide.id)).entries).toEqual([]);
  });


  it('keeps summaries on the guide store without opening step rows or blobs', async () => {
    const { guide } = await createTrackedGuide(makeSingleSteps(1));
    const indexSpy = vi.spyOn(IDBObjectStore.prototype, 'index');
    try {
      const summaries = await getGuideSummaries();
      expect(summaries.find((summary) => summary.id === guide.id)?.sections).toEqual([]);
      expect(indexSpy.mock.calls.some(([name]) => name === 'by-session')).toBe(false);
    } finally { indexSpy.mockRestore(); }
  });
});

describe('strict annotation and visual CAS mutations', () => {
  it('deletes one annotation from a fresh complete group and returns transaction-local undo data', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const previousRevision = snapshot.guide.contentRevision;

    const result = await deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      previousRevision,
    );

    expect(result.guide.contentRevision).toBe(previousRevision + 1);
    expect(result.previousAnnotationIds).toEqual(group.annotations.map((annotation) => annotation.id));
    expect(result.previousEntryIds).toEqual(snapshot.entryIds);
    expect(result.previousSections).toEqual(snapshot.guide.sections);
    expect(result.beforeSnapshot.entryIds).toEqual(snapshot.entryIds);
    expect(result.beforeSnapshot.entries[1]).toEqual(group);
    expect(result.deletedSteps.map((step) => step.id)).toEqual([group.annotations[0].id]);
    expect(result.removedEntry).toBe(false);

    const stored = await getSteps(guide.id);
    expect(stored.map((step) => step.order)).toEqual([0, 1, 2, 3]);
    expect(stored.map((step) => step.id)).toEqual([
      snapshot.entryIds[0],
      group.anchor.id,
      group.annotations[1].id,
      snapshot.entryIds[2],
    ]);
    expect(result.guide).toMatchObject({ stepCount: 3, entryCount: 3 });
  });

  it('deletes the complete snapshot entry for its last annotation and deterministically rebases sections', async () => {
    const steps = makeMixedSteps().filter((step) => step.order !== 3);
    steps.forEach((step, order) => { step.order = order; });
    const { guide, snapshot } = await createTrackedGuide(steps);
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const sectioned = await addGuideSectionAtomically(
      guide.id,
      group.anchor.id,
      '快照章節',
      snapshot.guide.contentRevision,
    );

    const result = await deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      sectioned.guide.contentRevision,
    );

    expect(result.removedEntry).toBe(true);
    expect(result.deletedSteps.map((step) => step.id)).toEqual([group.anchor.id, group.annotations[0].id]);
    expect(result.entryIds).toEqual([snapshot.entryIds[0], snapshot.entryIds[2]]);
    expect(result.guide.sections).toEqual([
      expect.objectContaining({ title: '快照章節', startEntryId: snapshot.entryIds[2] }),
    ]);
    expect(result.guide).toMatchObject({ stepCount: 2, entryCount: 2 });
    expect((await getSteps(guide.id)).map((step) => step.order)).toEqual([0, 1]);
  });

  it('rejects stale or cross-group annotation deletes without partial writes', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const moved = await reorderGuideEntriesAtomically(
      guide.id,
      [...snapshot.entryIds].reverse(),
      snapshot.guide.contentRevision,
    );

    await expect(deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      snapshot.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideContentConflictError);
    await expect(deleteGuideAnnotationAtomically(
      guide.id,
      snapshot.entryIds[0],
      group.annotations[0].id,
      moved.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);

    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect(after.guide.contentRevision).toBe(moved.guide.contentRevision);
    expect(after.entries.find((entry) => entry.kind === 'group')).toMatchObject({
      annotations: [expect.objectContaining({ id: group.annotations[0].id }), expect.objectContaining({ id: group.annotations[1].id })],
    });
  });

  it('restores a deleted annotation at the exact transaction-provided prior position with dense orders', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      snapshot.guide.contentRevision,
    );
    const restoredAnnotation = deleted.deletedSteps[0];

    const restored = await restoreGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      restoredAnnotation,
      deleted.previousAnnotationIds,
      deleted.guide.contentRevision,
    );

    expect(restored.guide.contentRevision).toBe(deleted.guide.contentRevision + 1);
    expect(restored.guide).toMatchObject({
      stepCount: snapshot.guide.stepCount,
      entryCount: snapshot.guide.entryCount,
      storageBytes: snapshot.guide.storageBytes,
    });
    const after = await getGuideStructureSnapshot(guide.id);
    const restoredGroup = after.entries[1];
    expect(restoredGroup.kind).toBe('group');
    if (restoredGroup.kind !== 'group') throw new Error('Expected restored snapshot group.');
    expect(restoredGroup.annotations.map((annotation) => annotation.id)).toEqual(
      group.annotations.map((annotation) => annotation.id),
    );
    expect((await getSteps(guide.id)).map((step) => step.order)).toEqual([0, 1, 2, 3, 4]);
    expect((await getSteps(guide.id)).map((step) => step.id)).toEqual(
      snapshot.entries.flatMap((entry) => (
        entry.kind === 'single'
          ? [entry.step.id]
          : [entry.anchor.id, ...entry.annotations.map((annotation) => annotation.id)]
      )),
    );
  });

  it('rejects stale annotation restore revisions without recreating the deleted row', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      snapshot.guide.contentRevision,
    );
    const moved = await reorderGuideEntriesAtomically(
      guide.id,
      [...deleted.entryIds].reverse(),
      deleted.guide.contentRevision,
    );

    await expect(restoreGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      deleted.deletedSteps[0],
      deleted.previousAnnotationIds,
      deleted.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideContentConflictError);

    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.guide.contentRevision).toBe(moved.guide.contentRevision);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect((await getSteps(guide.id)).some((step) => step.id === group.annotations[0].id)).toBe(false);
  });

  it('rolls back annotation restore for wrong groups, duplicate ids, and non-exact prior topology', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeMixedSteps());
    const group = snapshot.entries[1];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      group.annotations[0].id,
      snapshot.guide.contentRevision,
    );
    const deletedAnnotation = deleted.deletedSteps[0];
    const survivingId = group.annotations[1].id;

    await expect(restoreGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      { ...deletedAnnotation, groupId: 'another-anchor' },
      deleted.previousAnnotationIds,
      deleted.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);
    await expect(restoreGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      { ...deletedAnnotation, id: survivingId },
      [survivingId, survivingId],
      deleted.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);
    await expect(restoreGuideAnnotationAtomically(
      guide.id,
      group.anchor.id,
      deletedAnnotation,
      [survivingId, group.anchor.id],
      deleted.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);

    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.guide.contentRevision).toBe(deleted.guide.contentRevision);
    const currentGroup = after.entries.find((entry) => entry.kind === 'group');
    expect(currentGroup).toMatchObject({
      annotations: [expect.objectContaining({ id: survivingId })],
    });
    expect((await getSteps(guide.id)).some((step) => step.id === deletedAnnotation.id)).toBe(false);
  });

  it('reorders only the requested annotation group, keeps it contiguous, and returns the fresh prior order', async () => {
    const sessionId = 'source-guide';
    const firstAnchorId = crypto.randomUUID();
    const secondAnchorId = crypto.randomUUID();
    const firstAnchor = makeStep({ id: firstAnchorId, sessionId, groupId: firstAnchorId, bounds: null, order: 0 });
    const firstA = makeStep({ sessionId, groupId: firstAnchorId, screenshotBlob: undefined, order: 1 });
    const firstB = makeStep({ sessionId, groupId: firstAnchorId, screenshotBlob: undefined, order: 2 });
    const secondAnchor = makeStep({ id: secondAnchorId, sessionId, groupId: secondAnchorId, bounds: null, order: 3 });
    const secondA = makeStep({ sessionId, groupId: secondAnchorId, screenshotBlob: undefined, order: 4 });
    const { guide, snapshot } = await createTrackedGuide([firstAnchor, firstA, firstB, secondAnchor, secondA]);
    const firstGroup = snapshot.entries[0];
    const secondGroup = snapshot.entries[1];
    expect(firstGroup.kind).toBe('group');
    expect(secondGroup.kind).toBe('group');
    if (firstGroup.kind !== 'group' || secondGroup.kind !== 'group') throw new Error('Expected groups.');

    await expect(reorderGuideAnnotationsAtomically(
      guide.id,
      firstGroup.anchor.id,
      [firstGroup.annotations[1].id, secondGroup.annotations[0].id],
      snapshot.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);
    await expect(reorderGuideAnnotationsAtomically(
      guide.id,
      firstGroup.anchor.id,
      [firstGroup.anchor.id, firstGroup.annotations[0].id],
      snapshot.guide.contentRevision,
    )).rejects.toBeInstanceOf(GuideStructureIntegrityError);

    const result = await reorderGuideAnnotationsAtomically(
      guide.id,
      firstGroup.anchor.id,
      [...firstGroup.annotations].reverse().map((annotation) => annotation.id),
      snapshot.guide.contentRevision,
    );
    expect(result.previousAnnotationIds).toEqual(firstGroup.annotations.map((annotation) => annotation.id));
    expect(result.guide.contentRevision).toBe(snapshot.guide.contentRevision + 1);
    const stored = await getSteps(guide.id);
    expect(stored.map((step) => step.id)).toEqual([
      firstGroup.anchor.id,
      firstGroup.annotations[1].id,
      firstGroup.annotations[0].id,
      secondGroup.anchor.id,
      secondGroup.annotations[0].id,
    ]);
    expect(stored.map((step) => step.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('fails closed at the section cap without advancing contentRevision', async () => {
    const steps = makeSingleSteps(201);
    const sections = steps.slice(0, 200).map((step, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: step.id,
    }));
    const { guide, snapshot } = await createTrackedGuide(steps, { sections });
    expect(snapshot.guide.sections).toHaveLength(200);

    await expect(addGuideSectionAtomically(
      guide.id,
      snapshot.entryIds[200],
      'Overflow',
      snapshot.guide.contentRevision,
    )).rejects.toThrow('Guide cannot contain more than 200 sections.');

    const after = await getGuideStructureSnapshot(guide.id);
    expect(after.guide.contentRevision).toBe(snapshot.guide.contentRevision);
    expect(after.guide.sections).toEqual(snapshot.guide.sections);
  });

  it('returns fresh previous entry order and sections from entry reorder transaction', async () => {
    const { guide, snapshot } = await createTrackedGuide(makeSingleSteps(3));
    const sectioned = await addGuideSectionAtomically(
      guide.id,
      snapshot.entryIds[1],
      'Middle',
      snapshot.guide.contentRevision,
    );
    const before = await getGuideStructureSnapshot(guide.id);
    const result = await reorderGuideEntriesAtomically(
      guide.id,
      [...before.entryIds].reverse(),
      sectioned.guide.contentRevision,
    );
    expect(result.previousEntryIds).toEqual(before.entryIds);
    expect(result.previousSections).toEqual(before.guide.sections);
    expect(result.guide.contentRevision).toBe(before.guide.contentRevision + 1);
  });
});

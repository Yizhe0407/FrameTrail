import {
  GUIDE_SECTION_LIMITS,
  repairGuideSections,
  sanitizeGuideSectionTitle,
  type GuideSection,
} from '../guide/guide-sections';
import {
  assertExactEntryIds,
  buildCompleteStepEntries,
  entryId,
  GuideStructureIntegrityError,
  flattenEntrySteps,
  orderedSessionSteps,
  sanitizeGuide,
  sanitizeStepForStorage,
  type Guide,
  type ScreenshotStep,
  type Step,
  type StepEntry,
} from './models';
import {
  abortTransaction,
  getDatabase,
  requireWritableGuide,
  summarizeSteps,
  type GuideStepsTransaction,
  type ReadonlyGuideStepsTransaction,
} from './database';

export class GuideContentConflictError extends Error {
  constructor(
    public readonly guideId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super('Guide content changed before the operation was committed.');
    this.name = 'GuideContentConflictError';
  }
}

export interface GuideStructureSnapshot {
  guide: Guide;
  entries: StepEntry[];
  entryIds: string[];
}

export interface GuideStructureMutationResult {
  guide: Guide;
  entryIds: string[];
  affectedEntryIds: string[];
}

export interface ReorderGuideEntriesResult extends GuideStructureMutationResult {
  /** Fresh transaction-local order, suitable for an undo CAS. */
  previousEntryIds: string[];
  /** Fresh transaction-local section metadata, before reorder repair/sorting. */
  previousSections: GuideSection[];
}

export interface DeleteGuideAnnotationResult extends GuideStructureMutationResult {
  /** Canonical snapshot read in the same transaction before any rows changed. */
  beforeSnapshot: GuideStructureSnapshot;
  /** Annotation order read from the persisted group, never from editor state. */
  previousAnnotationIds: string[];
  previousEntryIds: string[];
  previousSections: GuideSection[];
  /** One annotation normally; anchor + annotation when the group became empty. */
  deletedSteps: Step[];
  removedEntry: boolean;
}

export interface ReorderGuideAnnotationsResult extends GuideStructureMutationResult {
  previousAnnotationIds: string[];
}

export interface DuplicateGuideEntryResult extends GuideStructureMutationResult {
  createdEntryId: string;
}

interface WritableGuideStructure extends GuideStructureSnapshot {
  steps: Step[];
}

function structureSnapshot(guide: Guide, steps: readonly Step[]): GuideStructureSnapshot {
  const entries = buildCompleteStepEntries(steps, guide.id);
  const repairedGuide = sanitizeGuide({
    ...guide,
    sections: repairGuideSections(guide.sections, entries),
  });
  return { guide: repairedGuide, entries, entryIds: entries.map(entryId) };
}

function copyStructureSnapshot(structure: GuideStructureSnapshot): GuideStructureSnapshot {
  return {
    guide: {
      ...structure.guide,
      sections: structure.guide.sections.map((section) => ({ ...section })),
    },
    entries: structure.entries.map((entry): StepEntry => (
      entry.kind === 'single'
        ? { kind: 'single', step: { ...entry.step } }
        : {
            kind: 'group',
            anchor: { ...entry.anchor },
            annotations: entry.annotations.map((annotation) => ({ ...annotation })),
          }
    )),
    entryIds: [...structure.entryIds],
  };
}

function requireSnapshotGroup(entries: readonly StepEntry[], anchorId: string): Extract<StepEntry, { kind: 'group' }> {
  const entry = entries.find((candidate) => entryId(candidate) === anchorId);
  if (!entry || entry.kind !== 'group' || entry.anchor.id !== anchorId) {
    throw new GuideStructureIntegrityError('Snapshot anchor was not found or no longer owns a complete group.');
  }
  return entry;
}

function assertExactAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  orderedAnnotationIds: readonly string[],
): void {
  const actualIds = group.annotations.map((annotation) => annotation.id);
  if (
    orderedAnnotationIds.length !== actualIds.length
    || new Set(orderedAnnotationIds).size !== orderedAnnotationIds.length
  ) {
    throw new GuideStructureIntegrityError('Annotation order must contain every group annotation exactly once.');
  }
  const actual = new Set(actualIds);
  if (orderedAnnotationIds.some((id) => !actual.has(id))) {
    throw new GuideStructureIntegrityError('Annotation order contains an anchor or an annotation from another group.');
  }
}

function assertExactRestoredAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  restoredAnnotationId: string,
  previousAnnotationIds: readonly string[],
): void {
  const expectedIds = new Set([
    ...group.annotations.map((annotation) => annotation.id),
    restoredAnnotationId,
  ]);
  if (
    previousAnnotationIds.length !== group.annotations.length + 1
    || new Set(previousAnnotationIds).size !== previousAnnotationIds.length
    || expectedIds.size !== group.annotations.length + 1
    || previousAnnotationIds.some((id) => !expectedIds.has(id))
  ) {
    throw new GuideStructureIntegrityError(
      'Previous annotation order must contain the current group plus the restored annotation exactly once.',
    );
  }
}

export async function requireWritableGuideStructure(
  tx: GuideStepsTransaction,
  sessionId: string,
  expectedContentRevision: number,
): Promise<WritableGuideStructure> {
  if (!Number.isSafeInteger(expectedContentRevision) || expectedContentRevision < 0) {
    throw new TypeError('Expected content revision must be a non-negative integer.');
  }
  const guide = await requireWritableGuide(tx, sessionId);
  if (guide.contentRevision !== expectedContentRevision) {
    throw new GuideContentConflictError(sessionId, expectedContentRevision, guide.contentRevision);
  }
  const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
  return { ...structureSnapshot(guide, steps), steps: orderedSessionSteps(steps) };
}

export async function commitGuideStructure(
  tx: GuideStepsTransaction,
  structure: WritableGuideStructure,
  nextEntries: readonly StepEntry[],
  nextSections: readonly GuideSection[],
  affectedEntryIds: readonly string[],
): Promise<GuideStructureMutationResult> {
  const denseSteps = flattenEntrySteps(nextEntries).map((step, order) => (
    step.order === order ? step : { ...step, order }
  ));
  const completeEntries = buildCompleteStepEntries(denseSteps, structure.guide.id);
  const previousById = new Map(structure.steps.map((step) => [step.id, step]));
  const nextIds = new Set(denseSteps.map((step) => step.id));

  for (const previous of structure.steps) {
    if (!nextIds.has(previous.id)) await tx.objectStore('steps').delete(previous.id);
  }
  for (const step of denseSteps) {
    const previous = previousById.get(step.id);
    if (previous !== step) await tx.objectStore('steps').put(sanitizeStepForStorage(step));
  }

  const now = Date.now();
  const guide = sanitizeGuide({
    ...structure.guide,
    ...summarizeSteps(denseSteps),
    sections: repairGuideSections(nextSections, completeEntries),
    updatedAt: Math.max(structure.guide.updatedAt, now),
    contentRevision: structure.guide.contentRevision + 1,
  });
  await tx.objectStore('guides').put(guide);
  return {
    guide,
    entryIds: completeEntries.map(entryId),
    affectedEntryIds: [...new Set(affectedEntryIds)],
  };
}

async function runGuideStructureMutation<T extends GuideStructureMutationResult>(
  sessionId: string,
  expectedContentRevision: number,
  mutate: (tx: GuideStepsTransaction, structure: WritableGuideStructure) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const structure = await requireWritableGuideStructure(tx, sessionId, expectedContentRevision);
    const result = await mutate(tx, structure);
    await tx.done;
    return result;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

function requireEntrySelection(
  entries: readonly StepEntry[],
  requestedIds: readonly string[],
  allowEmpty = false,
): { selectedIds: Set<string>; byId: Map<string, StepEntry> } {
  const selectedIds = new Set(requestedIds);
  if ((!allowEmpty && selectedIds.size === 0) || selectedIds.size !== requestedIds.length) {
    throw new GuideStructureIntegrityError('Entry selection must contain unique entry ids.');
  }
  const byId = new Map(entries.map((entry) => [entryId(entry), entry]));
  if ([...selectedIds].some((id) => !byId.has(id))) {
    throw new GuideStructureIntegrityError('Entry selection contains an unknown or annotation id.');
  }
  return { selectedIds, byId };
}

function rebaseSectionsAfterDelete(
  sections: readonly GuideSection[],
  previousEntryIds: readonly string[],
  survivingEntryIds: ReadonlySet<string>,
): GuideSection[] {
  const starts = new Map(previousEntryIds.map((id, index) => [id, index]));
  const orderedSections = [...sections]
    .map((section) => ({ section, index: starts.get(section.startEntryId) }))
    .filter((item): item is { section: GuideSection; index: number } => item.index !== undefined)
    .sort((left, right) => left.index - right.index);
  const rebased: GuideSection[] = [];
  for (let index = 0; index < orderedSections.length; index += 1) {
    const current = orderedSections[index];
    const end = orderedSections[index + 1]?.index ?? previousEntryIds.length;
    const nextStart = previousEntryIds.slice(current.index, end).find((id) => survivingEntryIds.has(id));
    if (nextStart) rebased.push({ ...current.section, startEntryId: nextStart });
  }
  return rebased;
}

export async function getGuideStructureSnapshot(sessionId: string): Promise<GuideStructureSnapshot> {
  const db = await getDatabase();
  const tx: ReadonlyGuideStepsTransaction = db.transaction(['guides', 'steps'], 'readonly');
  const rawGuide = await tx.objectStore('guides').get(sessionId);
  if (!rawGuide) {
    await tx.done;
    throw new Error('Guide not found.');
  }
  const guide = sanitizeGuide(rawGuide);
  const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
  const snapshot = structureSnapshot(guide, steps);
  await tx.done;
  return snapshot;
}

export async function reorderGuideEntriesAtomically(
  sessionId: string,
  orderedEntryIds: readonly string[],
  expectedContentRevision: number,
): Promise<ReorderGuideEntriesResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    assertExactEntryIds(structure.entries, orderedEntryIds);
    const byId = new Map(structure.entries.map((entry) => [entryId(entry), entry]));
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.guide.sections.map((section) => ({ ...section }));
    const result = await commitGuideStructure(
      tx,
      structure,
      orderedEntryIds.map((id) => byId.get(id)!),
      structure.guide.sections,
      orderedEntryIds,
    );
    return { ...result, previousEntryIds, previousSections };
  });
}

export async function deleteGuideAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  annotationId: string,
  expectedContentRevision: number,
): Promise<DeleteGuideAnnotationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    const annotationIndex = group.annotations.findIndex((annotation) => annotation.id === annotationId);
    if (annotationIndex < 0) {
      throw new GuideStructureIntegrityError('Annotation does not belong to the requested snapshot group.');
    }

    const beforeSnapshot = copyStructureSnapshot(structure);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.guide.sections.map((section) => ({ ...section }));
    const removedEntry = group.annotations.length === 1;
    let nextEntries: StepEntry[];
    let nextSections: GuideSection[] = structure.guide.sections;
    let deletedSteps: Step[];

    if (removedEntry) {
      nextEntries = structure.entries.filter((entry) => entryId(entry) !== anchorId);
      const survivingIds = new Set(nextEntries.map(entryId));
      nextSections = rebaseSectionsAfterDelete(
        structure.guide.sections,
        structure.entryIds,
        survivingIds,
      );
      deletedSteps = [group.anchor, group.annotations[annotationIndex]];
    } else {
      const annotations = group.annotations.filter((annotation) => annotation.id !== annotationId);
      nextEntries = structure.entries.map((entry): StepEntry => (
        entryId(entry) === anchorId ? { kind: 'group', anchor: group.anchor, annotations } : entry
      ));
      deletedSteps = [group.annotations[annotationIndex]];
    }

    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      nextSections,
      [anchorId],
    );
    return {
      ...result,
      beforeSnapshot,
      previousAnnotationIds,
      previousEntryIds,
      previousSections,
      deletedSteps,
      removedEntry,
    };
  });
}

export async function reorderGuideAnnotationsAtomically(
  sessionId: string,
  anchorId: string,
  orderedAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<ReorderGuideAnnotationsResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    assertExactAnnotationIds(group, orderedAnnotationIds);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    const reorderedGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: orderedAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? reorderedGroup : entry
    ));
    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [anchorId],
    );
    return { ...result, previousAnnotationIds };
  });
}

/** Strict inverse of a non-terminal annotation delete. The restored row's old
 * numeric order is deliberately ignored: the transaction reconstructs the
 * complete group from previousAnnotationIds and then commits dense orders. */
export async function restoreGuideAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  restoredAnnotation: Step,
  previousAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    if (
      typeof restoredAnnotation.id !== 'string'
      || restoredAnnotation.id.length === 0
      || restoredAnnotation.id === anchorId
      || restoredAnnotation.sessionId !== sessionId
      || restoredAnnotation.groupId !== anchorId
    ) {
      throw new GuideStructureIntegrityError(
        'Restored annotation must be a distinct member of the requested snapshot group.',
      );
    }
    if (await tx.objectStore('steps').get(restoredAnnotation.id)) {
      throw new GuideStructureIntegrityError('Restored annotation id already exists.');
    }
    assertExactRestoredAnnotationIds(group, restoredAnnotation.id, previousAnnotationIds);

    const restored = sanitizeStepForStorage(restoredAnnotation);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    byId.set(restored.id, restored);
    const restoredGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: previousAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? restoredGroup : entry
    ));
    return commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [anchorId],
    );
  });
}

export async function deleteGuideEntriesAtomically(
  sessionId: string,
  entryIdsToDelete: readonly string[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToDelete);
    const nextEntries = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const survivingIds = new Set(nextEntries.map(entryId));
    const sections = rebaseSectionsAfterDelete(structure.guide.sections, structure.entryIds, survivingIds);
    return commitGuideStructure(tx, structure, nextEntries, sections, entryIdsToDelete);
  });
}

export async function restoreGuideEntriesAtomically(
  sessionId: string,
  restoredSteps: readonly Step[],
  previousEntryIds: readonly string[],
  previousSections: readonly GuideSection[],
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    if (restoredSteps.length === 0) throw new GuideStructureIntegrityError('No entries were provided for restore.');
    const currentStepIds = new Set(structure.steps.map((step) => step.id));
    if (restoredSteps.some((step) => step.sessionId !== sessionId || currentStepIds.has(step.id))) {
      throw new GuideStructureIntegrityError('Restored rows conflict with the current Guide.');
    }
    const restoredEntries = buildCompleteStepEntries(restoredSteps, sessionId);
    const allEntries = [...structure.entries, ...restoredEntries];
    assertExactEntryIds(allEntries, previousEntryIds);
    const byId = new Map(allEntries.map((entry) => [entryId(entry), entry]));
    const nextEntries = previousEntryIds.map((id) => byId.get(id)!);
    return commitGuideStructure(
      tx,
      structure,
      nextEntries,
      repairGuideSections(previousSections, nextEntries),
      restoredEntries.map(entryId),
    );
  });
}

export async function moveGuideEntriesAtomically(
  sessionId: string,
  entryIdsToMove: readonly string[],
  destination: 'start' | 'end',
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  if (destination !== 'start' && destination !== 'end') throw new TypeError('Invalid move destination.');
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToMove);
    const selected = structure.entries.filter((entry) => selectedIds.has(entryId(entry)));
    const unselected = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const nextEntries = destination === 'start' ? [...selected, ...unselected] : [...unselected, ...selected];
    return commitGuideStructure(tx, structure, nextEntries, structure.guide.sections, entryIdsToMove);
  });
}

export async function setGuideEntriesNumberedAtomically(
  sessionId: string,
  entryIdsToUpdate: readonly string[],
  numbered: boolean,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToUpdate);
    const affected: string[] = [];
    const nextEntries = structure.entries.map((entry): StepEntry => {
      const id = entryId(entry);
      if (!selectedIds.has(id) || entry.kind === 'single') return entry;
      affected.push(id);
      return {
        kind: 'group',
        anchor: { ...entry.anchor, numbered },
        annotations: entry.annotations.map((annotation) => ({ ...annotation, numbered })),
      };
    });
    if (affected.length === 0) {
      return { guide: structure.guide, entryIds: structure.entryIds, affectedEntryIds: [] };
    }
    return commitGuideStructure(tx, structure, nextEntries, structure.guide.sections, affected);
  });
}

export async function duplicateGuideEntryAtomically(
  sessionId: string,
  sourceEntryId: string,
  expectedContentRevision: number,
): Promise<DuplicateGuideEntryResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { byId } = requireEntrySelection(structure.entries, [sourceEntryId]);
    const source = byId.get(sourceEntryId)!;
    let duplicate: StepEntry;
    if (source.kind === 'single') {
      const id = crypto.randomUUID();
      duplicate = {
        kind: 'single',
        step: sanitizeStepForStorage({
          ...source.step,
          id,
          sessionId,
          runId: undefined,
          order: source.step.order + 1,
          captureRevision: 0,
          lastCaptureRunId: undefined,
        }) as ScreenshotStep,
      };
    } else {
      const anchorId = crypto.randomUUID();
      const anchor = sanitizeStepForStorage({
        ...source.anchor,
        id: anchorId,
        sessionId,
        runId: undefined,
        groupId: anchorId,
        captureRevision: 0,
        lastCaptureRunId: undefined,
      }) as ScreenshotStep;
      const annotations = source.annotations.map((annotation) => sanitizeStepForStorage({
        ...annotation,
        id: crypto.randomUUID(),
        sessionId,
        runId: undefined,
        groupId: anchorId,
        captureRevision: 0,
        lastCaptureRunId: undefined,
      }));
      duplicate = { kind: 'group', anchor, annotations };
    }
    const sourceIndex = structure.entries.findIndex((entry) => entryId(entry) === sourceEntryId);
    const nextEntries = [...structure.entries];
    nextEntries.splice(sourceIndex + 1, 0, duplicate);
    const result = await commitGuideStructure(
      tx,
      structure,
      nextEntries,
      structure.guide.sections,
      [entryId(duplicate)],
    );
    return { ...result, createdEntryId: entryId(duplicate) };
  });
}

export async function addGuideSectionAtomically(
  sessionId: string,
  startEntryId: string,
  title: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    requireEntrySelection(structure.entries, [startEntryId]);
    const sanitizedTitle = sanitizeGuideSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    if (structure.guide.sections.some((section) => section.startEntryId === startEntryId)) {
      throw new GuideStructureIntegrityError('An entry can begin only one section.');
    }
    if (structure.guide.sections.length >= GUIDE_SECTION_LIMITS.maxSections) {
      throw new GuideStructureIntegrityError(
        `Guide cannot contain more than ${GUIDE_SECTION_LIMITS.maxSections} sections.`,
      );
    }
    const sections = [...structure.guide.sections, {
      id: crypto.randomUUID(),
      title: sanitizedTitle,
      startEntryId,
    }];
    return commitGuideStructure(tx, structure, structure.entries, sections, [startEntryId]);
  });
}

export async function renameGuideSectionAtomically(
  sessionId: string,
  sectionId: string,
  title: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sanitizedTitle = sanitizeGuideSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    let found = false;
    const sections = structure.guide.sections.map((section) => {
      if (section.id !== sectionId) return section;
      found = true;
      return { ...section, title: sanitizedTitle };
    });
    if (!found) throw new GuideStructureIntegrityError('Section not found.');
    return commitGuideStructure(tx, structure, structure.entries, sections, []);
  });
}

export async function deleteGuideSectionAtomically(
  sessionId: string,
  sectionId: string,
  expectedContentRevision: number,
): Promise<GuideStructureMutationResult> {
  return runGuideStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sections = structure.guide.sections.filter((section) => section.id !== sectionId);
    if (sections.length === structure.guide.sections.length) {
      throw new GuideStructureIntegrityError('Section not found.');
    }
    return commitGuideStructure(tx, structure, structure.entries, sections, []);
  });
}

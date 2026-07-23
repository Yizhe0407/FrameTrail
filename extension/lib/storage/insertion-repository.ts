import { repairGuideSections } from '../guide/guide-sections';
import {
  assertMutationItems,
  buildCompleteStepEntries,
  entryId,
  entrySteps,
  getEffectiveBounds,
  GuideStructureIntegrityError,
  sanitizeGuide,
  sanitizeStepForStorage,
  type Guide,
  type Step,
  type StepEntry,
} from './models';
import {
  abortTransaction,
  getDatabase,
  refreshGuideSummary,
  writeDenseOrder,
  type GuideStepsTransaction,
} from './database';

export type InsertionSide = 'before' | 'after';

export type InsertionErrorCode =
  | 'GUIDE_NOT_FOUND'
  | 'GUIDE_ARCHIVED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_CHANGED'
  | 'RUN_STATE_CHANGED';

export class InsertionRecordingError extends Error {
  constructor(public readonly code: InsertionErrorCode, message: string) {
    super(message);
    this.name = 'InsertionRecordingError';
  }
}


export interface InsertionAnchor {
  anchorEntryId: string;
  kind: 'single' | 'group';
  sourceUrl: string;
  memberIds: string[];
}

export interface InsertStepsAtEntryBoundaryInput {
  sessionId: string;
  runId: string;
  anchorEntryId: string;
  side: InsertionSide;
  expectedRunBlockIds: string[];
  newSteps: Step[];
}

function insertionError(code: InsertionErrorCode, message: string): never {
  throw new InsertionRecordingError(code, message);
}

function assertUniqueIds(ids: string[], label: string): void {
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    insertionError('RUN_STATE_CHANGED', `${label} contains invalid or duplicate ids.`);
  }
}

function requireInsertionGuide(guide: Guide | undefined): Guide {
  if (!guide) return insertionError('GUIDE_NOT_FOUND', 'Guide not found.');
  const sanitized = sanitizeGuide(guide);
  if (sanitized.archivedAt !== null) {
    return insertionError('GUIDE_ARCHIVED', 'Archived guides cannot be modified.');
  }
  return sanitized;
}

function resolveInsertionAnchorFromSteps(
  sessionId: string,
  anchorEntryId: string,
  sortedSteps: Step[],
): InsertionAnchor {
  const anchor = sortedSteps.find((step) => step.id === anchorEntryId);
  if (!anchor || anchor.sessionId !== sessionId) {
    return insertionError('ANCHOR_NOT_FOUND', 'The insertion anchor no longer exists.');
  }

  if (!anchor.groupId) {
    if (!anchor.screenshotBlob || !anchor.url) {
      return insertionError('ANCHOR_CHANGED', 'The insertion anchor is no longer a complete ordinary entry.');
    }
    return {
      anchorEntryId,
      kind: 'single',
      sourceUrl: anchor.url,
      memberIds: [anchor.id],
    };
  }

  if (anchor.groupId !== anchor.id || !anchor.screenshotBlob || !anchor.url) {
    return insertionError('ANCHOR_CHANGED', 'The insertion anchor is no longer a snapshot entry.');
  }
  const members = sortedSteps.filter((step) => step.groupId === anchor.id);
  const annotations = members.filter((step) => step.id !== anchor.id && getEffectiveBounds(step));
  if (annotations.length === 0) {
    return insertionError('ANCHOR_CHANGED', 'The insertion snapshot no longer has a complete annotation.');
  }
  const positions = members.map((member) => sortedSteps.indexOf(member)).sort((a, b) => a - b);
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    return insertionError('ANCHOR_CHANGED', 'The insertion snapshot is no longer contiguous.');
  }
  return {
    anchorEntryId,
    kind: 'group',
    sourceUrl: anchor.url,
    memberIds: members.map((step) => step.id),
  };
}

function validateInsertionRunBlock(steps: Step[], runId: string, runBlockIds: string[]): Step[] {
  assertUniqueIds(runBlockIds, 'Insertion run block');
  const byId = new Map(steps.map((step) => [step.id, step]));
  const block = runBlockIds.map((id) => {
    const step = byId.get(id);
    if (!step || step.runId !== runId) {
      return insertionError('RUN_STATE_CHANGED', 'The insertion run block no longer matches persisted data.');
    }
    return step;
  });
  const actualRunIds = steps.filter((step) => step.runId === runId).map((step) => step.id);
  const expectedSet = new Set(runBlockIds);
  if (actualRunIds.length !== runBlockIds.length || actualRunIds.some((id) => !expectedSet.has(id))) {
    return insertionError('RUN_STATE_CHANGED', 'The insertion run changed without a matching durable state update.');
  }
  return block;
}

function validateInsertionBlockEntries(block: Step[]): void {
  const blockIds = new Set(block.map((step) => step.id));
  const groupPositions = new Map<string, number[]>();
  block.forEach((step, index) => {
    if (!step.groupId) {
      if (!step.screenshotBlob) {
        insertionError('RUN_STATE_CHANGED', 'An ordinary inserted entry is missing its screenshot.');
      }
      return;
    }
    if (!blockIds.has(step.groupId)) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot refers outside its recording block.');
    }
    const positions = groupPositions.get(step.groupId) ?? [];
    positions.push(index);
    groupPositions.set(step.groupId, positions);
  });
  for (const [groupId, positions] of groupPositions) {
    const anchor = block.find((step) => step.id === groupId);
    if (!anchor || anchor.groupId !== anchor.id || !anchor.screenshotBlob) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot is missing its image anchor.');
    }
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
      insertionError('RUN_STATE_CHANGED', 'An inserted snapshot group is not contiguous.');
    }
  }
}

function insertionOrderedIds(
  sortedSteps: Step[],
  anchor: InsertionAnchor,
  side: InsertionSide,
  runBlockIds: string[],
): string[] {
  const blockSet = new Set(runBlockIds);
  if (anchor.memberIds.some((id) => blockSet.has(id))) {
    return insertionError('RUN_STATE_CHANGED', 'The insertion anchor cannot belong to the inserted run.');
  }
  const base = sortedSteps.filter((step) => !blockSet.has(step.id));
  const positions = anchor.memberIds
    .map((id) => base.findIndex((step) => step.id === id))
    .sort((a, b) => a - b);
  if (positions.some((position) => position < 0)) {
    return insertionError('ANCHOR_NOT_FOUND', 'The insertion anchor changed during the transaction.');
  }
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    return insertionError('ANCHOR_CHANGED', 'The insertion anchor group is no longer contiguous.');
  }
  const insertionIndex = side === 'before' ? positions[0] : positions.at(-1)! + 1;
  return [
    ...base.slice(0, insertionIndex).map((step) => step.id),
    ...runBlockIds,
    ...base.slice(insertionIndex).map((step) => step.id),
  ];
}

/** Resolves an insertion target and source URL in one DB transaction. The URL
 * always comes from the persisted image owner; callers must not accept one
 * from an editor message. */
export async function getInsertionAnchor(sessionId: string, anchorEntryId: string): Promise<InsertionAnchor> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    requireInsertionGuide(await tx.objectStore('guides').get(sessionId));
    const steps = (await tx.objectStore('steps').index('by-session').getAll(sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(sessionId, anchorEntryId, steps);
    await tx.done;
    return anchor;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Adds capture rows directly at a fresh-read entry boundary. Existing rows
 * from the same insertion run are removed from the ordering calculation and
 * reinserted as one contiguous block, so repeated captures never split a
 * snapshot group or temporarily append at the tail. */
export async function insertStepsAtEntryBoundary(
  input: InsertStepsAtEntryBoundaryInput,
): Promise<{ runBlockIds: string[] }> {
  assertMutationItems(input.expectedRunBlockIds, 'Expected insertion run block', true);
  assertMutationItems(input.newSteps, 'New insertion rows');
  if (input.side !== 'before' && input.side !== 'after') {
    return insertionError('RUN_STATE_CHANGED', 'Invalid insertion side.');
  }
  assertUniqueIds(input.expectedRunBlockIds, 'Expected insertion run block');
  assertUniqueIds(input.newSteps.map((step) => step.id), 'New insertion rows');
  if (input.newSteps.some((step) => step.sessionId !== input.sessionId || step.runId !== input.runId)) {
    return insertionError('RUN_STATE_CHANGED', 'New insertion rows do not belong to the active Guide and run.');
  }

  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    const guide = requireInsertionGuide(await tx.objectStore('guides').get(input.sessionId));
    const existing = (await tx.objectStore('steps').index('by-session').getAll(input.sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(input.sessionId, input.anchorEntryId, existing);
    const currentBlock = validateInsertionRunBlock(existing, input.runId, input.expectedRunBlockIds);
    const existingIds = new Set(existing.map((step) => step.id));
    if (input.newSteps.some((step) => existingIds.has(step.id))) {
      return insertionError('RUN_STATE_CHANGED', 'A new insertion row id already exists.');
    }

    const sanitizedNewSteps = input.newSteps.map(sanitizeStepForStorage);
    const combinedBlock = [...currentBlock, ...sanitizedNewSteps];
    validateInsertionBlockEntries(combinedBlock);
    const runBlockIds = combinedBlock.map((step) => step.id);
    const combinedSteps = [...existing, ...sanitizedNewSteps];
    const orderedIds = insertionOrderedIds(combinedSteps, anchor, input.side, runBlockIds);
    let insertedEntries: StepEntry[] | null = null;
    try {
      insertedEntries = buildCompleteStepEntries(
        combinedBlock.map((step, order) => ({ ...step, order })),
        input.sessionId,
      );
    } catch (error) {
      // Snapshot insertion persists its image anchor before the first annotation.
      // That temporary run block is intentionally incomplete; preserve section
      // metadata until a later call commits the first complete inserted entry.
      if (!(error instanceof GuideStructureIntegrityError)) throw error;
    }
    let guideWithSections = guide;
    if (insertedEntries) {
      const orderedById = new Map(combinedSteps.map((step) => [step.id, step]));
      const finalSteps = orderedIds.map((id, order) => ({ ...orderedById.get(id)!, order }));
      const finalEntries = buildCompleteStepEntries(finalSteps, input.sessionId);
      const firstInsertedEntryId = entryId(insertedEntries[0]);
      const sections = input.side === 'before'
        ? guide.sections.map((section) => (
          section.startEntryId === input.anchorEntryId
            ? { ...section, startEntryId: firstInsertedEntryId }
            : section
        ))
        : guide.sections;
      guideWithSections = sanitizeGuide({
        ...guide,
        sections: repairGuideSections(sections, finalEntries),
      });
    }

    for (const step of sanitizedNewSteps) await tx.objectStore('steps').add(step);
    await writeDenseOrder(tx, combinedSteps, orderedIds);
    await refreshGuideSummary(tx, guideWithSections, Math.max(0, ...sanitizedNewSteps.map((step) => step.timestamp)));
    await tx.done;
    return { runBlockIds };
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

/** Validates persisted insertion state after an MV3 worker restart. */
export async function validateInsertionRunState(input: {
  sessionId: string;
  runId: string;
  anchorEntryId: string;
  side: InsertionSide;
  runBlockIds: string[];
}): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['guides', 'steps'], 'readwrite');
  try {
    requireInsertionGuide(await tx.objectStore('guides').get(input.sessionId));
    const steps = (await tx.objectStore('steps').index('by-session').getAll(input.sessionId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const anchor = resolveInsertionAnchorFromSteps(input.sessionId, input.anchorEntryId, steps);
    const block = validateInsertionRunBlock(steps, input.runId, input.runBlockIds);
    validateInsertionBlockEntries(block);
    const expectedOrder = insertionOrderedIds(steps, anchor, input.side, input.runBlockIds);
    if (expectedOrder.some((id, index) => steps[index]?.id !== id)) {
      return insertionError('RUN_STATE_CHANGED', 'The insertion block is no longer at its durable anchor boundary.');
    }
    await tx.done;
  } catch (error) {
    return abortTransaction(tx, error);
  }
}

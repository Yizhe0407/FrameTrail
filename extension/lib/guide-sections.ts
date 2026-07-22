import type { StepEntry } from './db';

export interface GuideSection {
  id: string;
  title: string;
  /** Stable id of a complete timeline entry (a single step or snapshot anchor). */
  startEntryId: string;
}

export const GUIDE_SECTION_LIMITS = Object.freeze({
  maxSections: 200,
  maxIdLength: 256,
  maxTitleLength: 200,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const IDENTIFIER_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

type UnknownRecord = Record<string, unknown>;

/**
 * Section titles are display-only text. Remove all control characters (including
 * newlines/tabs), trim surrounding whitespace, and cap storage/rendering cost.
 */
export function sanitizeGuideSectionTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(CONTROL_CHARACTERS, '').trim().slice(0, GUIDE_SECTION_LIMITS.maxTitleLength)
    : '';
}

/**
 * Repairs untrusted or stale section metadata against the current renderable
 * timeline. Invalid records and later duplicates are dropped deterministically;
 * surviving sections are sorted into timeline order.
 *
 * Only complete StepEntry owners are valid boundaries. Snapshot annotation ids
 * are deliberately not added to the boundary map, so a section can never begin
 * in the middle of a shared-image annotation group.
 */
export function repairGuideSections(
  value: unknown,
  entries: readonly StepEntry[],
): GuideSection[] {
  if (!Array.isArray(value) || value.length === 0 || entries.length === 0) return [];

  const boundaryOrder = collectEntryBoundaries(entries);
  if (boundaryOrder.size === 0) return [];

  const seenIds = new Set<string>();
  const seenStarts = new Set<string>();
  const repaired: Array<GuideSection & { timelineIndex: number; inputIndex: number }> = [];
  const count = Math.min(value.length, GUIDE_SECTION_LIMITS.maxSections);

  for (let inputIndex = 0; inputIndex < count; inputIndex += 1) {
    const raw = value[inputIndex];
    if (!isRecord(raw)) continue;

    const id = validIdentifier(raw.id);
    const startEntryId = validIdentifier(raw.startEntryId);
    const title = sanitizeGuideSectionTitle(raw.title);
    if (!id || !startEntryId || !title) continue;

    const timelineIndex = boundaryOrder.get(startEntryId);
    if (timelineIndex === undefined || seenIds.has(id) || seenStarts.has(startEntryId)) continue;

    seenIds.add(id);
    seenStarts.add(startEntryId);
    repaired.push({ id, title, startEntryId, timelineIndex, inputIndex });
  }

  repaired.sort((left, right) => left.timelineIndex - right.timelineIndex || left.inputIndex - right.inputIndex);
  return repaired.map(({ id, title, startEntryId }) => ({ id, title, startEntryId }));
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentifier(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > GUIDE_SECTION_LIMITS.maxIdLength ||
    value.trim() !== value ||
    IDENTIFIER_CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  return value;
}

function collectEntryBoundaries(entries: readonly StepEntry[]): Map<string, number> {
  const result = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const id = completeEntryBoundaryId(entry);
    if (id && !result.has(id)) result.set(id, index);
  }

  return result;
}

function completeEntryBoundaryId(entry: StepEntry): string | null {
  if (entry.kind === 'single') {
    return entry.step.screenshotBlob instanceof Blob ? validIdentifier(entry.step.id) : null;
  }

  const anchorId = validIdentifier(entry.anchor.id);
  if (
    !anchorId ||
    !(entry.anchor.screenshotBlob instanceof Blob) ||
    entry.anchor.groupId !== anchorId ||
    entry.annotations.length === 0 ||
    entry.annotations.some((annotation) => annotation.id === anchorId || annotation.groupId !== anchorId)
  ) {
    return null;
  }
  return anchorId;
}

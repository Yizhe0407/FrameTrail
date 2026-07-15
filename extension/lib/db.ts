import { openDB, type DBSchema } from 'idb';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Step {
  id: string;
  sessionId: string;
  order: number;
  /** Raw (un-annotated) screenshot — the highlight box is drawn at render/export time. */
  screenshotBlob: Blob;
  /** Clicked element rect in CSS px, relative to the viewport at capture time. */
  bounds: Bounds | null;
  devicePixelRatio: number;
  /** Actual screenshot pixels per CSS pixel, measured from the captured image. */
  screenshotScale?: number;
  description: string;
  url: string;
  timestamp: number;
  /** Present when this step is part of a single-image annotation group: the id
   * of the group's anchor step, which holds the shared screenshotBlob and
   * screenshot scale (every other member's own screenshotBlob is unused). The
   * anchor step's own groupId equals its own id (self-reference) and its
   * bounds is null — it's just the shared base image, not a clicked box.
   * A session can freely mix ordinary steps (groupId undefined, own
   * screenshot) and any number of these groups; each "start recording" in
   * single-image mode begins a brand-new group rather than resuming an old one. */
  groupId?: string;
  /** Single-image mode only: whether the group renders order-number badges.
   * Same value denormalized across every step sharing a groupId. */
  numbered?: boolean;
}

/** One renderable unit in a session's timeline: either an ordinary per-click
 * step, or a whole single-image group collapsed into its shared image plus
 * the ordered list of click annotations on it. */
export type StepEntry = { kind: 'single'; step: Step } | { kind: 'group'; anchor: Step; annotations: Step[] };

/**
 * Groups a session's flat, order-sorted step list into displayable entries.
 * A group's anchor always has the lowest `order` among its members (it's
 * created first), so it's always the first occurrence of its groupId in the
 * sorted array — that's what keeps each group's entry positioned correctly
 * relative to ordinary steps around it.
 */
export function buildStepEntries(steps: Step[]): StepEntry[] {
  const entries: StepEntry[] = [];
  const seenGroups = new Set<string>();

  for (const step of steps) {
    if (!step.groupId) {
      entries.push({ kind: 'single', step });
      continue;
    }
    if (seenGroups.has(step.groupId)) continue;
    seenGroups.add(step.groupId);
    const groupSteps = steps.filter((s) => s.groupId === step.groupId);
    entries.push({
      kind: 'group',
      anchor: groupSteps.find((s) => s.id === step.groupId)!,
      annotations: groupSteps.filter((s) => s.id !== step.groupId),
    });
  }

  return entries;
}

/** Flattens entries back into the complete, order-sorted list of step ids —
 * the shape reorderSteps needs (it must receive every id in the session, or
 * the steps left out keep their old `order` and can collide with the ones
 * renumbered here). */
export function flattenEntries(entries: StepEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'single' ? [entry.step.id] : [entry.anchor.id, ...entry.annotations.map((s) => s.id)],
  );
}

/** User-facing step count: each ordinary step and each group annotation counts
 * as one recorded click; a group's anchor (the shared base image) doesn't. */
export function countSteps(steps: Step[]): number {
  return buildStepEntries(steps).reduce((n, entry) => n + (entry.kind === 'single' ? 1 : entry.annotations.length), 0);
}

interface FrameTrailDB extends DBSchema {
  steps: {
    key: string;
    value: Step;
    indexes: { 'by-session': string };
  };
}

// Keep the original IndexedDB name to retain recordings made before the
// product rename. The schema and data model are unchanged.
const dbPromise = openDB<FrameTrailDB>('scribe', 3, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const store = db.createObjectStore('steps', { keyPath: 'id' });
      store.createIndex('by-session', 'sessionId');
    }
    // v2 adds bounds/devicePixelRatio; pre-existing steps simply render without
    // a highlight box (their screenshot may already have one baked in).
    // v3 adds groupId/numbered for single-image annotation groups;
    // pre-existing steps are simply untouched (groupId undefined => ordinary step).
  },
});

export async function addStep(step: Step): Promise<void> {
  const db = await dbPromise;
  await db.put('steps', step);
}

export async function getSteps(sessionId: string): Promise<Step[]> {
  const db = await dbPromise;
  const steps = await db.getAllFromIndex('steps', 'by-session', sessionId);
  return steps.sort((a, b) => a.order - b.order);
}

export async function updateStep(id: string, changes: Partial<Step>): Promise<void> {
  const db = await dbPromise;
  const existing = await db.get('steps', id);
  if (!existing) return;
  await db.put('steps', { ...existing, ...changes });
}

export async function deleteStep(id: string): Promise<void> {
  const db = await dbPromise;
  await db.delete('steps', id);
}

export async function deleteStepsForSession(sessionId: string): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  let cursor = await tx.store.index('by-session').openCursor(sessionId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Persists a new step order for a session. orderedIds must be every step id in
 * the session (e.g. via flattenEntries) — any id left out keeps its old order
 * value and can collide with the ones renumbered here. */
export async function reorderSteps(sessionId: string, orderedIds: string[]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  await Promise.all(
    orderedIds.map(async (id, index) => {
      const existing = await tx.store.get(id);
      if (existing && existing.sessionId === sessionId) {
        await tx.store.put({ ...existing, order: index });
      }
    }),
  );
  await tx.done;
}

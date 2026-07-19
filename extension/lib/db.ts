import { openDB, type DBSchema } from 'idb';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isValidBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

export interface OrderedAnnotation {
  bounds: Bounds;
  order: number;
}

export interface Step {
  id: string;
  sessionId: string;
  /** Recording run that created this row. Legacy/editor-created rows omit it. */
  runId?: string;
  order: number;
  /** Raw (un-annotated) screenshot — the highlight box is drawn at render/export time. */
  /** Only ordinary steps and snapshot anchors own image data. Snapshot
   * annotations refer to their anchor through groupId. Older recordings may
   * still contain a duplicate blob on annotations; writes strip it. */
  screenshotBlob?: Blob;
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
   * snapshot mode begins a brand-new group rather than resuming an old one. */
  groupId?: string;
  /** Snapshot mode only: whether the group renders order-number badges.
   * Same value denormalized across every step sharing a groupId. */
  numbered?: boolean;
}

/** One renderable unit in a session's timeline: either an ordinary per-click
 * step, or a whole single-image group collapsed into its shared image plus
 * the ordered list of click annotations on it. */
export type ScreenshotStep = Step & { screenshotBlob: Blob };

export type StepEntry =
  | { kind: 'single'; step: ScreenshotStep }
  | { kind: 'group'; anchor: ScreenshotStep; annotations: Step[] };

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
  const groups = new Map<string, Step[]>();

  for (const step of steps) {
    if (!step.groupId) continue;
    const members = groups.get(step.groupId);
    if (members) members.push(step);
    else groups.set(step.groupId, [step]);
  }

  for (const step of steps) {
    if (!step.groupId) {
      // A partially-written/corrupt record without image data cannot be
      // rendered. Ignoring it keeps the rest of the session usable.
      if (step.screenshotBlob) entries.push({ kind: 'single', step: step as ScreenshotStep });
      continue;
    }
    if (seenGroups.has(step.groupId)) continue;
    seenGroups.add(step.groupId);
    const groupSteps = groups.get(step.groupId) ?? [];
    const anchor = groupSteps.find(
      (candidate): candidate is ScreenshotStep =>
        candidate.id === step.groupId && candidate.screenshotBlob !== undefined,
    );

    if (anchor) {
      // An anchor without any surviving annotation has no renderable content.
      // Do not surface it as a phantom snapshot whose old pixels can be
      // mistaken for a current annotation; deletion and stop cleanup remove
      // the rows, while this also sanitizes legacy empty groups on read.
      const annotations = groupSteps.filter(
        (candidate) => candidate.id !== step.groupId && candidate.bounds !== null,
      );
      if (annotations.length === 0) continue;
      entries.push({
        kind: 'group',
        anchor,
        annotations,
      });
      continue;
    }

    // Salvage legacy members with their own screenshots when an anchor is
    // missing. New annotations have no blob and are safely omitted.
    for (const member of groupSteps) {
      if (member.screenshotBlob) entries.push({ kind: 'single', step: member as ScreenshotStep });
    }
  }

  return entries;
}

/** Stable id for a timeline entry — an ordinary step's own id, or a group's
 * anchor id — used as the @dnd-kit sortable key and as a selection key. */
export function entryId(entry: StepEntry): string {
  return entry.kind === 'single' ? entry.step.id : entry.anchor.id;
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

/** Converts persisted annotation steps into the geometry contract shared by
 * previews, clipboard compositing, and exports. Invalid legacy rows are
 * skipped instead of leaking non-null assertions into every caller. */
export function getOrderedAnnotations(steps: Step[]): OrderedAnnotation[] {
  const annotations: OrderedAnnotation[] = [];
  for (const step of steps) {
    if (step.bounds && isValidBounds(step.bounds)) {
      annotations.push({ bounds: step.bounds, order: annotations.length + 1 });
    }
  }
  return annotations;
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
  if (step.groupId && step.id !== step.groupId) {
    const { screenshotBlob: _duplicateScreenshot, ...annotation } = step;
    await db.put('steps', annotation);
    return;
  }
  await db.put('steps', step);
}

export async function getSteps(sessionId: string): Promise<Step[]> {
  const db = await dbPromise;
  const steps = await db.getAllFromIndex('steps', 'by-session', sessionId);
  return steps.sort((a, b) => a.order - b.order);
}

export async function updateStep(id: string, changes: Partial<Step>): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return;
  }
  const updated = { ...existing, ...changes };
  if (updated.groupId && updated.id !== updated.groupId) delete updated.screenshotBlob;
  await tx.store.put(updated);
  await tx.done;
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

function sortSessionSteps(sessionSteps: Step[], orderedIds: string[]): Step[] {
  const byId = new Map(sessionSteps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const reordered: Step[] = [];

  for (const id of orderedIds) {
    const step = byId.get(id);
    if (step && !seen.has(id)) {
      reordered.push(step);
      seen.add(id);
    }
  }

  // A recorder can append a step while the editor holds an older list. Keep
  // such steps after the requested order so every order remains unique.
  for (const step of sessionSteps.sort((a, b) => a.order - b.order)) {
    if (!seen.has(step.id)) reordered.push(step);
  }
  return reordered;
}

/** Persists a new step order for a session. orderedIds must be every step id in
 * the session (e.g. via flattenEntries) — any id left out keeps its old order
 * value and can collide with the ones renumbered here. */
export async function reorderSteps(sessionId: string, orderedIds: string[]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  const sessionSteps = await tx.store.index('by-session').getAll(sessionId);
  const reordered = sortSessionSteps(sessionSteps, orderedIds);
  await Promise.all(reordered.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
}

/** Atomically removes editor-selected rows and closes every remaining order
 * gap. A failed transaction cannot leave half a snapshot group deleted. */
export async function deleteStepsAndReorder(
  sessionId: string,
  deletedIds: string[],
  orderedIds: string[],
): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('steps', 'readwrite');
  await Promise.all(deletedIds.map((id) => tx.store.delete(id)));
  const remaining = await tx.store.index('by-session').getAll(sessionId);
  const reordered = sortSessionSteps(remaining, orderedIds);
  await Promise.all(reordered.map((step, order) => tx.store.put({ ...step, order })));
  await tx.done;
}

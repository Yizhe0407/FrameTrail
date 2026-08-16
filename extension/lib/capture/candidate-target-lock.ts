import {
  deepElementFromPoint,
  findVisualTargetCandidatesAtPoint,
  getVisibleHighlightBounds,
  ANNOTATION_TARGETING_POLICY,
  type SelectedVisualTargetCandidate,
  type VisualTargetPolicy,
  type VisualTargetCandidates,
} from './selector-utils';
import { isPointWithinCandidateLock } from './candidate-cycling';

interface LockedCandidateChain {
  elements: Element[];
  defaultIndex: number;
  selectedIndex: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface CandidateTargetLock {
  /** Resolves only an established explicit selection. This lets callers with
   * special targets (notably child frames and image maps) consult the shared
   * lock before falling back to their own hit-testing path. */
  resolveLockedAt(
    clientX: number,
    clientY: number,
    requestedOffset?: number,
  ): SelectedVisualTargetCandidate | null;
  /** Resolves a known hit through the canonical candidate chain. */
  resolveFromHit(
    hit: Element,
    clientX: number,
    clientY: number,
    requestedOffset?: number,
  ): SelectedVisualTargetCandidate | null;
  /** Resolves the current point, preserving an explicit element identity while
   * it remains visible and inside the hysteresis boundary. */
  resolveAt(clientX: number, clientY: number): SelectedVisualTargetCandidate | null;
  /** Moves one or more levels in the same retained candidate chain. */
  adjustAt(clientX: number, clientY: number, delta: number): SelectedVisualTargetCandidate | null;
  hasLock(): boolean;
  clear(): void;
}

function offsetRange(chain: Pick<LockedCandidateChain, 'elements' | 'defaultIndex'>) {
  return {
    min: -chain.defaultIndex || 0,
    max: chain.elements.length - 1 - chain.defaultIndex,
  };
}

function selectedFromChain(
  chain: LockedCandidateChain,
  clientX: number,
  clientY: number,
): SelectedVisualTargetCandidate | null {
  const element = chain.elements[chain.selectedIndex];
  if (!element?.isConnected) return null;
  const bounds = getVisibleHighlightBounds(element, clientX, clientY);
  // The previous bounds only establish continuity between samples. Requiring
  // the pointer to remain near the element's current geometry prevents a
  // layout jump from teleporting a retained selection to a distant box.
  if (!bounds || !isPointWithinCandidateLock(clientX, clientY, bounds)) return null;
  chain.bounds = bounds;
  return {
    element,
    bounds,
    candidateOffset: chain.selectedIndex - chain.defaultIndex,
    offsetRange: offsetRange(chain),
  };
}

function chainFromTargets(
  targets: VisualTargetCandidates,
  selectedIndex: number,
  bounds: { x: number; y: number; width: number; height: number },
): LockedCandidateChain {
  return {
    elements: targets.candidates.map((candidate) => candidate.element),
    defaultIndex: targets.defaultIndex,
    selectedIndex,
    bounds,
  };
}

/**
 * The single source of truth for sticky parent/child targeting.
 *
 * Numeric offsets are accepted only as an address into the retained chain;
 * they never identify the lock. The lock itself is always the concrete
 * Element plus the exact chain from which the user selected it. This prevents
 * wrapper-depth changes from moving the box while still allowing narrowing
 * back through the original chain.
 */
export function createCandidateTargetLock(
  policy: Readonly<VisualTargetPolicy> = ANNOTATION_TARGETING_POLICY,
): CandidateTargetLock {
  let locked: LockedCandidateChain | null = null;

  const clear = () => {
    locked = null;
  };

  const resolveLockedAt = (
    clientX: number,
    clientY: number,
    requestedOffset?: number,
  ): SelectedVisualTargetCandidate | null => {
    if (!locked) return null;
    if (!isPointWithinCandidateLock(clientX, clientY, locked.bounds)) {
      clear();
      return null;
    }

    if (requestedOffset !== undefined) {
      const range = offsetRange(locked);
      const clampedOffset = Math.max(range.min, Math.min(requestedOffset, range.max));
      locked.selectedIndex = locked.defaultIndex + clampedOffset;
    }

    const selected = selectedFromChain(locked, clientX, clientY);
    if (!selected) {
      clear();
      return null;
    }

    // A sticky parent/child choice must not outlive the paint stack that made
    // it valid. Re-check while the pointer is inside the selected box so a
    // newly opened modal, toast surface, or drag layer immediately releases a
    // now-occluded target. The 6px outside hysteresis intentionally skips this
    // check because the real hit there no longer belongs to the old box.
    const insideLockedBounds = isPointWithinCandidateLock(clientX, clientY, selected.bounds, 0);
    if (insideLockedBounds) {
      const hit = deepElementFromPoint(clientX, clientY);
      if (!hit) {
        clear();
        return null;
      }
      const currentTargets = findVisualTargetCandidatesAtPoint(
        hit,
        clientX,
        clientY,
        { width: window.innerWidth, height: window.innerHeight },
        policy,
      );
      if (!currentTargets.candidates.some((candidate) => candidate.element === selected.element)) {
        clear();
        return null;
      }
    }

    return selected;
  };

  const resolveFromHit = (
    hit: Element,
    clientX: number,
    clientY: number,
    requestedOffset = 0,
  ): SelectedVisualTargetCandidate | null => {
    const targets = findVisualTargetCandidatesAtPoint(
      hit,
      clientX,
      clientY,
      { width: window.innerWidth, height: window.innerHeight },
      policy,
    );
    if (targets.candidates.length === 0) return null;
    const range = {
      min: -targets.defaultIndex || 0,
      max: targets.candidates.length - 1 - targets.defaultIndex,
    };
    const candidateOffset = Math.max(range.min, Math.min(requestedOffset, range.max));
    const selectedIndex = targets.defaultIndex + candidateOffset;
    const candidate = targets.candidates[selectedIndex];
    if (!candidate) return null;
    const { element, bounds } = candidate;

    // Ordinary offset-zero hover remains fluid. Any explicit level choice is
    // retained by concrete identity, including later narrowing back to zero
    // while an existing lock is active.
    if (candidateOffset !== 0) {
      locked = chainFromTargets(targets, selectedIndex, bounds);
    }
    return { element, bounds, candidateOffset, offsetRange: range };
  };

  const resolveAt = (clientX: number, clientY: number): SelectedVisualTargetCandidate | null => {
    const retained = resolveLockedAt(clientX, clientY);
    if (retained) return retained;
    const hit = deepElementFromPoint(clientX, clientY);
    return hit ? resolveFromHit(hit, clientX, clientY) : null;
  };

  const adjustAt = (
    clientX: number,
    clientY: number,
    delta: number,
  ): SelectedVisualTargetCandidate | null => {
    if (!Number.isFinite(delta) || delta === 0) return resolveAt(clientX, clientY);

    const retained = resolveLockedAt(clientX, clientY);
    if (retained && locked) {
      const range = offsetRange(locked);
      const requestedOffset = Math.max(
        range.min,
        Math.min(retained.candidateOffset + Math.trunc(delta), range.max),
      );
      if (requestedOffset === retained.candidateOffset) return retained;
      const selected = resolveLockedAt(clientX, clientY, requestedOffset);
      if (selected) return selected;
      return resolveAt(clientX, clientY);
    }

    const hit = deepElementFromPoint(clientX, clientY);
    if (!hit) return null;
    const targets = findVisualTargetCandidatesAtPoint(
      hit,
      clientX,
      clientY,
      { width: window.innerWidth, height: window.innerHeight },
      policy,
    );
    if (targets.candidates.length === 0) return null;
    const range = {
      min: -targets.defaultIndex || 0,
      max: targets.candidates.length - 1 - targets.defaultIndex,
    };
    const requestedOffset = Math.max(range.min, Math.min(Math.trunc(delta), range.max));
    const selectedIndex = targets.defaultIndex + requestedOffset;
    const candidate = targets.candidates[selectedIndex];
    if (!candidate) return null;
    const { element, bounds } = candidate;
    if (requestedOffset !== 0) locked = chainFromTargets(targets, selectedIndex, bounds);
    return { element, bounds, candidateOffset: requestedOffset, offsetRange: range };
  };

  return {
    resolveLockedAt,
    resolveFromHit,
    resolveAt,
    adjustAt,
    hasLock: () => locked !== null,
    clear,
  };
}

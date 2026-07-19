export type FrameProbeOutcome<T> =
  | { kind: 'target'; target: T }
  | { kind: 'empty' }
  | { kind: 'fallback' };

/** A responsive child returning null is a valid empty hit, not evidence that
 * instrumentation is unavailable. Only transport timeout permits fallback. */
export function classifyFrameProbeOutcome<T>(target: T | null, timedOut: boolean): FrameProbeOutcome<T> {
  if (timedOut) return { kind: 'fallback' };
  return target === null ? { kind: 'empty' } : { kind: 'target', target };
}

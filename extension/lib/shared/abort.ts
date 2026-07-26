/**
 * One cancellation contract for every long-running operation (exports, archive
 * parsing, base64 encoding, publication snapshots). Five near-identical copies
 * of this used to disagree on which error surfaced, so a caller could not tell
 * a user-initiated cancel from a genuine failure without knowing which module
 * raised it.
 *
 * A caller's own `reason` always wins when it is an Error, so an abort carrying
 * a meaningful failure keeps it; anything else becomes a standard AbortError.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted.', 'AbortError');
}

/** True for the cancellation `throwIfAborted` raises, including a caller's own
 * AbortError reason. Cancellation is a normal outcome, not something to report. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

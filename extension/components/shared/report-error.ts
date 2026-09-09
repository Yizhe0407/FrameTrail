/**
 * Canonical UI catch-block: logs the failure, then returns the thrown Error's
 * own message if present, otherwise the caller's fallback — centralized so
 * call sites can't drop either the logging or the instanceof check.
 */
export function reportError(label: string, error: unknown, fallback: string): string {
  console.error(label, error);
  return error instanceof Error && error.message ? error.message : fallback;
}

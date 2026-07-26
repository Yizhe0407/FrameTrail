/**
 * Canonical UI catch-block: log the failure under a zh-Hant label, then return
 * the message to display — the thrown Error's own (already localized) message
 * when there is one, otherwise the caller's fallback. Individual call sites
 * had drifted into dropping either the console.error leg or the instanceof
 * leg; routing them through here keeps both.
 */
export function reportError(label: string, error: unknown, fallback: string): string {
  console.error(label, error);
  return error instanceof Error && error.message ? error.message : fallback;
}

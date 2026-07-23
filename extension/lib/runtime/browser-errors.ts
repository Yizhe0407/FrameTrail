/** Returns useful diagnostics even when an extension API rejects with a bare DOMException. */
export function describeBrowserError(error: unknown, fallback = 'Unknown browser API error'): string {
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
    if (name && message && message !== name) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
  }
  if (typeof error === 'string' && error.trim()) return error;
  const rendered = String(error);
  return rendered && rendered !== '[object Object]' && rendered !== '[object DOMException]'
    ? rendered
    : fallback;
}

/** Tab lifecycle events can race async reinjection/capture work. */
export function isMissingTabError(error: unknown): boolean {
  const message = describeBrowserError(error, '');
  return /(?:no tab with id|invalid tab id|tab (?:was |has been )?closed|tab not found)/i.test(message);
}

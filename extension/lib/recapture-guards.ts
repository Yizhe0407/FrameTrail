/** Minimal sender shape kept independent of the browser API so trust decisions
 * can be unit-tested without loading the MV3 background entrypoint. */
export interface RecaptureMessageSender {
  frameId?: number;
  url?: string;
  tab?: {
    id?: number;
    windowId?: number;
    url?: string;
  };
}

export interface RecaptureSourceContext {
  sourceTabId: number;
  sourceWindowId: number;
  sourceUrl: string;
}

function isSameExtensionPage(actualUrl: string | undefined, expectedUrl: string): boolean {
  if (!actualUrl) return false;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/** Only the top-level editor document may issue editor-control messages.
 * Checking both sender.url (the actual frame) and tab.url (the top-level page)
 * prevents a child frame from inheriting trust from an editor tab. */
export function isTrustedEditorSender(
  sender: RecaptureMessageSender,
  editorUrl: string,
): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id != null &&
    isSameExtensionPage(sender.url, editorUrl) &&
    isSameExtensionPage(sender.tab.url, editorUrl)
  );
}

/** Recapture target messages are accepted only from the persisted, exact
 * top-level source document. Message payload URLs remain an additional check. */
export function isTrustedRecaptureSourceSender(
  sender: RecaptureMessageSender,
  context: RecaptureSourceContext,
): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id === context.sourceTabId &&
    sender.tab.windowId === context.sourceWindowId &&
    sender.url === context.sourceUrl &&
    sender.tab.url === context.sourceUrl
  );
}

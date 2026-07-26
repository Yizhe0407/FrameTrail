import { browser } from 'wxt/browser';


/** Reads the Guide identity carried by an editor URL. The caller can pass the
 * result to useRecordingSession so URL navigation, not mutable global capture
 * state, chooses which Guide the editor renders. */
export function getEditorSessionIdFromUrl(url: string | URL): string | null {
  try {
    const sessionId = (url instanceof URL ? url : new URL(url)).searchParams.get('sessionId');
    return sessionId && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Brings a tab to the foreground: activates it, then focuses its window when
 * one is known. Activating first is the safe ordering — if the window focus
 * call fails (window closed mid-flight), the tab is still selected inside its
 * window. Callers without a windowId simply skip the window focus rather than
 * passing a guessed one.
 */
export async function focusTab(tabId: number, windowId?: number | null): Promise<void> {
  await browser.tabs.update(tabId, { active: true });
  if (windowId != null) await browser.windows.update(windowId, { focused: true });
}

async function openOrFocusExtensionPage(path: '/library.html'): Promise<void> {
  const url = browser.runtime.getURL(path);
  // Prefix match, like openOrFocusEditor: an exact-URL comparison misses tabs
  // that gained query params or a hash and would open a duplicate page.
  const tabs = await browser.tabs.query({ url: `${url}*` });
  const existing = tabs.find((tab) => tab.id != null);
  if (existing?.id != null) {
    await focusTab(existing.id, existing.windowId);
    return;
  }
  await browser.tabs.create({ url });
}

export function openLibrary(): Promise<void> {
  return openOrFocusExtensionPage('/library.html');
}

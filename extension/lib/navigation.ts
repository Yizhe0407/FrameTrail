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

async function openOrFocusExtensionPage(path: '/library.html'): Promise<void> {
  const url = browser.runtime.getURL(path);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url && tab.id != null);
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url });
}

export function openLibrary(): Promise<void> {
  return openOrFocusExtensionPage('/library.html');
}

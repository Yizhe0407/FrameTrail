import { browser, type Browser } from 'wxt/browser';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Waits until a tab is fully loaded without missing a completion transition
 * between the initial status check and listener registration. */
export async function waitForTabComplete(
  tabId: number,
  timeoutMs = 15_000,
): Promise<Browser.tabs.Tab> {
  const current = await browser.tabs.get(tabId);
  if (current.status === 'complete') return current;

  return new Promise<Browser.tabs.Tab>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (error: Error | null, tab?: Browser.tabs.Tab) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve(tab!);
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: { status?: string },
      tab: Browser.tabs.Tab,
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(null, tab);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(new Error('The source tab was closed while loading.'));
    };

    timeout = setTimeout(
      () => finish(new Error('Timed out while loading the source page.')),
      timeoutMs,
    );
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);

    // The tab can complete after the first get() but before listeners are
    // installed. Recheck after subscribing so that transition cannot be lost.
    void browser.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish(null, tab);
      })
      .catch((error: unknown) => finish(asError(error)));
  });
}

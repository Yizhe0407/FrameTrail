import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE_PATHS } from './extension-pages';

/**
 * The first-run page, opened by the background once on install — never on
 * updates, which would nag people who already know the extension. Settings
 * reopens it by navigating its own tab (lib/runtime/page-navigation.ts).
 */
export async function openWelcomePage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(EXTENSION_PAGE_PATHS.welcome), active: true });
}

export function opensWelcomeOnInstall(details: Pick<Browser.runtime.InstalledDetails, 'reason'>): boolean {
  return details.reason === 'install';
}

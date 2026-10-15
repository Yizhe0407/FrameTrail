import { browser, type Browser } from 'wxt/browser';

/**
 * The first-run page. Opened once on install — never on updates, which would
 * nag people who already know the extension — and on request from settings.
 */
export async function openWelcomePage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL('/welcome.html'), active: true });
}

export function opensWelcomeOnInstall(details: Pick<Browser.runtime.InstalledDetails, 'reason'>): boolean {
  return details.reason === 'install';
}

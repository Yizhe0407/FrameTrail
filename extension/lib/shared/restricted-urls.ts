/**
 * Pages the browser refuses to script, so no recording or recapture can run on
 * them. This list is policy shared by the background lifecycle and the popup's
 * pre-flight check — two copies of it used to drift apart, which would let the
 * popup offer to record a page the background then rejects. The extension's
 * own pages (editor, library, practice) fall under chrome-extension:// and are
 * deliberately restricted too: every layer rejects recording them, so the
 * popup must never present them as recordable.
 */
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

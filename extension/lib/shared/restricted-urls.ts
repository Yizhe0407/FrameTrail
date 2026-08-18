/**
 * Pages the browser refuses to script, so no recording or recapture can run on
 * them. This list is policy shared by the background lifecycle and the popup's
 * pre-flight check — two copies of it used to drift apart, which would let the
 * popup offer to record a page the background then rejects. The extension's
 * own pages (editor, library) fall under chrome-extension:// and are
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

/**
 * Whether a tab URL is one the recorder can actually run on: an ordinary
 * HTTP(S) page that is not on the restricted list. This is stricter than
 * `!isRestrictedUrl` alone — schemes like file: and data: are not restricted
 * by policy, but the recorder only ever targets web pages, so every layer
 * (background lifecycle, popup pre-flight, editor empty state) must apply the
 * same positive http/https requirement.
 */
export function isRecordableTabUrl(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  return (url.startsWith('http://') || url.startsWith('https://')) && !isRestrictedUrl(url);
}

/**
 * Whether a browser tab can be recorded into (or focused as a recording
 * target): it must have a real id and window, and carry a recordable URL.
 */
export function isRecordableTab(tab: { id?: number; windowId?: number; url?: string }): boolean {
  return tab.id != null && tab.windowId != null && isRecordableTabUrl(tab.url);
}

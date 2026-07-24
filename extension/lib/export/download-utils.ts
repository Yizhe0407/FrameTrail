export interface DownloadBlobOptions {
  signal?: AbortSignal;
  document?: Document;
}

const DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;
const PRINT_URL_REVOKE_FALLBACK_MS = 60_000;

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation cancelled', 'AbortError');
}

export function throwIfDownloadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Starts a browser download without retaining the object URL or a detached
 * anchor. The signal is checked until the irreversible click is dispatched.
 */
export async function downloadBlob(
  blob: Blob,
  filename: string,
  { signal, document: ownerDocument = globalThis.document }: DownloadBlobOptions = {},
): Promise<void> {
  throwIfDownloadAborted(signal);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = ownerDocument.createElement('a');

  let clickDispatched = false;
  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    ownerDocument.body.append(anchor);
    throwIfDownloadAborted(signal);
    anchor.click();
    clickDispatched = true;
  } finally {
    anchor.remove();
    if (clickDispatched) {
      // Firefox may not consume an anchor-backed Blob URL until after the
      // current task. Keep a bounded lease instead of revoking immediately.
      const timer = setTimeout(() => URL.revokeObjectURL(objectUrl), DOWNLOAD_URL_REVOKE_DELAY_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    } else {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export async function downloadText(
  text: string,
  filename: string,
  mimeType: string,
  options: DownloadBlobOptions = {},
): Promise<void> {
  return downloadBlob(new Blob([text], { type: mimeType }), filename, options);
}

/** Writes one rich clipboard item so paste targets can choose HTML or plain text. */
export async function copyRichText(
  html: string,
  plainText: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfDownloadAborted(signal);
  const ClipboardItemConstructor = globalThis.ClipboardItem;
  const clipboard = globalThis.navigator?.clipboard;
  if (!ClipboardItemConstructor || typeof clipboard?.write !== 'function') {
    throw new Error('Rich clipboard writing is not available.');
  }

  const item = new ClipboardItemConstructor({
    'text/html': new Blob([html], { type: 'text/html;charset=utf-8' }),
    'text/plain': new Blob([plainText], { type: 'text/plain;charset=utf-8' }),
  });
  throwIfDownloadAborted(signal);
  await clipboard.write([item]);
  throwIfDownloadAborted(signal);
}

const PRINT_PLACEHOLDER_STYLE = `
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f5f5f4; color: #1c1917; }
main { width: min(calc(100% - 32px), 420px); padding: 32px; border: 1px solid #e7e5e4; border-radius: 14px; background: #fff; box-shadow: 0 16px 44px rgb(28 25 23 / .1); text-align: center; }
span { display: grid; width: 48px; height: 48px; margin: 0 auto 18px; place-items: center; border-radius: 13px; background: #ecfccb; color: #4d7c0f; font-weight: 800; }
h1 { margin: 0; font-size: 1.1rem; }
p { margin: 8px 0 0; color: #57534e; font-size: .875rem; line-height: 1.6; }
`;

/** Builds a safe loading state without parsing or injecting generated markup. */
function renderPrintPlaceholder(targetWindow: Window): void {
  try {
    const ownerDocument = targetWindow.document;
    if (!ownerDocument?.head || !ownerDocument.body) return;

    ownerDocument.documentElement.lang = 'zh-Hant';
    ownerDocument.title = '正在準備列印版…';

    const style = ownerDocument.createElement('style');
    style.textContent = PRINT_PLACEHOLDER_STYLE;

    const main = ownerDocument.createElement('main');
    main.setAttribute('role', 'status');
    main.setAttribute('aria-live', 'polite');

    const icon = ownerDocument.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'P';

    const title = ownerDocument.createElement('h1');
    title.textContent = '正在準備列印版';

    const description = ownerDocument.createElement('p');
    description.textContent = '正在套用標註、遮罩與紙張版面，完成後會自動顯示預覽。';

    main.append(icon, title, description);
    ownerDocument.head.append(style);
    ownerDocument.body.replaceChildren(main);
  } catch {
    // The popup can become inaccessible immediately in hardened browsers. A
    // blank placeholder still preserves the user gesture needed for printing.
  }
}

/** Must be called directly from the user's click handler to avoid popup blocking. */
export function openPrintPlaceholder(ownerWindow: Window = globalThis.window): Window | null {
  const placeholder = ownerWindow.open('about:blank', '_blank');
  if (placeholder) {
    renderPrintPlaceholder(placeholder);
    try {
      placeholder.opener = null;
    } catch {
      // A browser may expose a read-only opener; the exported document CSP is
      // still the primary containment boundary.
    }
  }
  return placeholder;
}

/**
 * Navigates an already-opened placeholder to a generated HTML Blob. No
 * document.write or innerHTML assignment is used. The URL is revoked after the
 * destination loads, on cancellation, or after a bounded fallback delay.
 */
export async function loadHtmlIntoWindow(
  targetWindow: Window,
  html: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfDownloadAborted(signal);
  const objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const revoke = () => URL.revokeObjectURL(objectUrl);
    const cleanup = () => {
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      targetWindow.removeEventListener('load', handleLoad);
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      revoke();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const handleLoad = () => {
      // Ignore a late about:blank load that races the Blob navigation.
      try {
        if (targetWindow.location.href !== objectUrl) return;
      } catch {
        // A loaded destination may no longer expose its location. It has still
        // consumed the URL, so revocation is safe.
      }
      finish();
    };
    const handleAbort = () => finish(abortError(signal!));

    targetWindow.addEventListener('load', handleLoad);
    signal?.addEventListener('abort', handleAbort, { once: true });

    try {
      throwIfDownloadAborted(signal);
      targetWindow.location.replace(objectUrl);
      fallbackTimer = setTimeout(() => finish(), PRINT_URL_REVOKE_FALLBACK_MS);
    } catch (error) {
      finish(error);
    }
  });
}

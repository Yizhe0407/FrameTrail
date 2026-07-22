export interface DownloadBlobOptions {
  signal?: AbortSignal;
  document?: Document;
}

const PRINT_URL_REVOKE_FALLBACK_MS = 5_000;

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

  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    ownerDocument.body.append(anchor);
    throwIfDownloadAborted(signal);
    anchor.click();
    // Let the browser consume the click before revoking the backing URL.
    await Promise.resolve();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
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

/** Must be called directly from the user's click handler to avoid popup blocking. */
export function openPrintPlaceholder(ownerWindow: Window = globalThis.window): Window | null {
  return ownerWindow.open('about:blank', '_blank');
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

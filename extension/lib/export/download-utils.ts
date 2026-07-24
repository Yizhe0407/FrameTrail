export interface DownloadBlobOptions {
  signal?: AbortSignal;
  document?: Document;
}

const DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;

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

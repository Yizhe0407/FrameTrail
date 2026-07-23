const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const OUTPUT_CHUNK_SIZE = 32_768;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
}

/** Encodes bytes without creating one array entry per output character. */
export function encodeBase64(bytes: Uint8Array, signal?: AbortSignal): string {
  const chunks: string[] = [];
  let chunk = '';

  for (let index = 0; index < bytes.length; index += 3) {
    if ((index & 0xffff) === 0) throwIfAborted(signal);
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    chunk += BASE64_ALPHABET[(value >>> 18) & 63];
    chunk += BASE64_ALPHABET[(value >>> 12) & 63];
    chunk += index + 1 < bytes.length ? BASE64_ALPHABET[(value >>> 6) & 63] : '=';
    chunk += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : '=';

    if (chunk.length >= OUTPUT_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = '';
    }
  }

  if (chunk) chunks.push(chunk);
  throwIfAborted(signal);
  return chunks.join('');
}

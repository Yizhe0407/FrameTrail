import { describe, expect, it } from 'vitest';
import { BASE64_ALPHABET, encodeBase64, encodeBase64Fallback } from '@/lib/export/base64';
import { BASE64_VALUES } from '@/lib/export/project-archive-contract';

describe('chunked base64 encoding', () => {
  it('derives the archive decoder value table from the single shared alphabet', () => {
    expect(BASE64_ALPHABET).toHaveLength(64);
    for (const [index, character] of [...BASE64_ALPHABET].entries()) {
      expect(BASE64_VALUES[character.charCodeAt(0)]).toBe(index);
    }
    expect(BASE64_VALUES['='.charCodeAt(0)]).toBe(-1);
  });

  it('matches the platform encoder across chunk boundaries and padding lengths', () => {
    for (const size of [0, 1, 2, 3, 32_767, 32_768, 65_537]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) & 255);
      const expected = Buffer.from(bytes).toString('base64');
      expect(encodeBase64(bytes)).toBe(expected);
      // The pure-JS fallback must stay byte-identical for runtimes without
      // the native Uint8Array.prototype.toBase64 fast path.
      expect(encodeBase64Fallback(bytes)).toBe(expected);
    }
  });

  it('matches the platform encoder across the native input chunk boundary', () => {
    // The native fast path encodes 3 MiB sub-slices; a payload just past one
    // boundary exercises chunk concatenation plus a padded final chunk.
    const size = 3 * 1024 * 1024 + 5;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 255;
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('polls AbortSignal during large encodes', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => encodeBase64(new Uint8Array(100_000), controller.signal)).toThrowError(/abort/i);
    expect(() => encodeBase64Fallback(new Uint8Array(100_000), controller.signal)).toThrowError(/abort/i);
  });
});

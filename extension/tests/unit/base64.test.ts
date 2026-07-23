import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/lib/export/base64';

describe('chunked base64 encoding', () => {
  it('matches the platform encoder across chunk boundaries and padding lengths', () => {
    for (const size of [0, 1, 2, 3, 32_767, 32_768, 65_537]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) & 255);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('polls AbortSignal during large encodes', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => encodeBase64(new Uint8Array(100_000), controller.signal)).toThrowError(/abort/i);
  });
});

import { describe, expect, it } from 'vitest';
import { requireRuntimeMessageResult } from '@/lib/runtime-message-result';

describe('requireRuntimeMessageResult', () => {
  it('returns a structured runtime result unchanged', () => {
    const result = { ok: true as const, value: 3 };
    expect(requireRuntimeMessageResult<typeof result>(result)).toBe(result);
  });

  it.each([null, undefined, {}, { ok: 'yes' }])(
    'turns a missing or malformed response into a useful transport error: %j',
    (value) => {
      expect(() => requireRuntimeMessageResult(value, 'background unavailable'))
        .toThrow('background unavailable');
    },
  );
});

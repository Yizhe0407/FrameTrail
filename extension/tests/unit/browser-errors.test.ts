import { describe, expect, it } from 'vitest';
import { describeBrowserError, isMissingTabError } from '@/lib/runtime/browser-errors';

describe('browser API errors', () => {
  it('keeps the DOMException name when its message is empty', () => {
    const error = { name: 'InvalidStateError', message: '' };
    expect(describeBrowserError(error)).toBe('InvalidStateError');
  });

  it('does not collapse a bare DOMException to [object DOMException]', () => {
    const error = { toString: () => '[object DOMException]' };
    expect(describeBrowserError(error, 'browser operation failed')).toBe('browser operation failed');
  });

  it('recognizes Chrome and Firefox missing-tab failures', () => {
    expect(isMissingTabError(new Error('No tab with id: 670034135.'))).toBe(true);
    expect(isMissingTabError(new Error('Invalid tab ID: 42'))).toBe(true);
    expect(isMissingTabError(new Error('Cannot access contents of the page'))).toBe(false);
  });
});

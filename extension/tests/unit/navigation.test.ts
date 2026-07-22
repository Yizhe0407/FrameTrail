import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { getEditorSessionIdFromUrl } from '@/lib/navigation';

describe('getEditorSessionIdFromUrl', () => {
  it('reads the explicit Guide session from an editor URL', () => {
    expect(
      getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html?entryId=step&sessionId=guide-a'),
    ).toBe('guide-a');
  });

  it('returns null for absent, empty, or malformed session URLs', () => {
    expect(getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html')).toBeNull();
    expect(getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html?sessionId=')).toBeNull();
    expect(getEditorSessionIdFromUrl('not a url')).toBeNull();
  });
});

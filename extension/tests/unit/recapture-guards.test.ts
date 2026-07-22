import { describe, expect, it } from 'vitest';
import {
  isTrustedEditorSender,
  isTrustedRecaptureSourceSender,
  type RecaptureMessageSender,
} from '@/lib/recapture-guards';

const editorUrl = 'chrome-extension://extension-id/editor.html';

function sender(overrides: Partial<RecaptureMessageSender> = {}): RecaptureMessageSender {
  return {
    frameId: 0,
    url: `${editorUrl}?entryId=step-1`,
    tab: {
      id: 0,
      windowId: 7,
      url: `${editorUrl}?entryId=step-1`,
    },
    ...overrides,
  };
}

describe('isTrustedEditorSender', () => {
  it('accepts only the exact top-level editor document, including a valid tab id of zero', () => {
    expect(isTrustedEditorSender(sender(), editorUrl)).toBe(true);
    expect(isTrustedEditorSender(sender({ frameId: 1 }), editorUrl)).toBe(false);
    expect(isTrustedEditorSender(sender({ url: 'https://evil.example/frame' }), editorUrl)).toBe(false);
    expect(
      isTrustedEditorSender(
        sender({ tab: { id: 0, windowId: 7, url: 'https://evil.example/' } }),
        editorUrl,
      ),
    ).toBe(false);
    expect(isTrustedEditorSender(sender({ url: 'not a url' }), editorUrl)).toBe(false);
  });
});

describe('isTrustedRecaptureSourceSender', () => {
  const context = {
    sourceTabId: 12,
    sourceWindowId: 4,
    sourceUrl: 'https://example.com/exact?page=1#target',
  };
  const valid: RecaptureMessageSender = {
    frameId: 0,
    url: context.sourceUrl,
    tab: { id: 12, windowId: 4, url: context.sourceUrl },
  };

  it('requires the persisted top-level tab, window, frame URL, and tab URL', () => {
    expect(isTrustedRecaptureSourceSender(valid, context)).toBe(true);
    expect(isTrustedRecaptureSourceSender({ ...valid, frameId: 2 }, context)).toBe(false);
    expect(isTrustedRecaptureSourceSender({ ...valid, url: 'https://example.com/other' }, context)).toBe(false);
    expect(
      isTrustedRecaptureSourceSender(
        { ...valid, tab: { ...valid.tab, windowId: 5 } },
        context,
      ),
    ).toBe(false);
  });
});

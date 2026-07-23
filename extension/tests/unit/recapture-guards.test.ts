import { describe, expect, it } from 'vitest';
import {
  hasMatchingEditorSessionQuery,
  isTrustedEditorSender,
  isTrustedEditorSenderForSession,
  isTrustedRecaptureSourceSender,
  type RecaptureMessageSender,
} from '@/lib/capture/recapture-guards';

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

describe('editor session query validation', () => {
  it('requires the expected session on both the actual frame and top-level tab URLs', () => {
    const valid = sender({
      url: `${editorUrl}?sessionId=guide-a&entryId=step-1`,
      tab: { id: 0, windowId: 7, url: `${editorUrl}?entryId=step-1&sessionId=guide-a` },
    });

    expect(hasMatchingEditorSessionQuery(valid, 'guide-a')).toBe(true);
    expect(isTrustedEditorSenderForSession(valid, editorUrl, 'guide-a')).toBe(true);
    expect(hasMatchingEditorSessionQuery(valid, 'guide-b')).toBe(false);
    expect(
      hasMatchingEditorSessionQuery(
        { ...valid, tab: { ...valid.tab, url: `${editorUrl}?sessionId=guide-b` } },
        'guide-a',
      ),
    ).toBe(false);
    expect(hasMatchingEditorSessionQuery({ ...valid, url: 'not a url' }, 'guide-a')).toBe(false);
  });

  it('does not let a matching query bypass editor origin/path trust', () => {
    const evil = {
      frameId: 0,
      url: 'https://evil.example/editor.html?sessionId=guide-a',
      tab: { id: 3, windowId: 7, url: 'https://evil.example/editor.html?sessionId=guide-a' },
    };

    expect(hasMatchingEditorSessionQuery(evil, 'guide-a')).toBe(true);
    expect(isTrustedEditorSenderForSession(evil, editorUrl, 'guide-a')).toBe(false);
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

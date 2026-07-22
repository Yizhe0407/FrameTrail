import { describe, expect, it } from 'vitest';
import { isTrustedEditorSenderForSession, type RecaptureMessageSender } from '@/lib/recapture-guards';

const editorUrl = 'chrome-extension://extension-id/editor.html';

function editorSender(frameSession: string, tabSession = frameSession): RecaptureMessageSender {
  return {
    frameId: 0,
    url: `${editorUrl}?sessionId=${encodeURIComponent(frameSession)}&entryId=step-1`,
    tab: {
      id: 7,
      windowId: 3,
      url: `${editorUrl}?entryId=step-1&sessionId=${encodeURIComponent(tabSession)}`,
    },
  };
}

describe('session-scoped editor control security', () => {
  it('rejects insertion START when Guide A editor targets Guide B', () => {
    expect(isTrustedEditorSenderForSession(editorSender('guide-a'), editorUrl, 'guide-b')).toBe(false);
  });

  it('rejects a sender whose frame query matches but top-level tab query is spoofed', () => {
    expect(isTrustedEditorSenderForSession(editorSender('guide-a', 'guide-b'), editorUrl, 'guide-a')).toBe(false);
  });

  it.each(['START', 'CANCEL', 'FOCUS', 'ACK']) (
    'requires the expected message or persisted session for recapture %s',
    () => {
      const guideAEditor = editorSender('guide-a');
      expect(isTrustedEditorSenderForSession(guideAEditor, editorUrl, 'guide-b')).toBe(false);
      expect(isTrustedEditorSenderForSession(guideAEditor, editorUrl, 'guide-a')).toBe(true);
    },
  );

  it('rejects subframes and non-editor origins even with matching session ids', () => {
    expect(
      isTrustedEditorSenderForSession({ ...editorSender('guide-a'), frameId: 1 }, editorUrl, 'guide-a'),
    ).toBe(false);
    expect(
      isTrustedEditorSenderForSession({
        ...editorSender('guide-a'),
        url: 'https://evil.example/editor.html?sessionId=guide-a',
      }, editorUrl, 'guide-a'),
    ).toBe(false);
  });
});

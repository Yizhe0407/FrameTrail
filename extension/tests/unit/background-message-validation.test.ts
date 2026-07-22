import { describe, expect, it } from 'vitest';
import {
  isBackgroundMessage,
  isExtensionPageOnlyMessage,
  isTrustedExtensionPageSender,
} from '@/lib/background-message-validation';
import type { BackgroundMessage } from '@/lib/messages';

const validClick = {
  type: 'FRAME_TRAIL_CLICK',
  captureId: 'capture-1',
  runId: 'run-1',
  rect: { x: 10.5, y: -2, width: 40, height: 20 },
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 100 },
  devicePixelRatio: 2,
  text: 'Settings',
  tagName: 'BUTTON',
  intent: 'click',
  url: 'https://example.com/page',
  timestamp: 123,
} as const;

describe('background runtime message validation', () => {
  it.each<unknown>([
    validClick,
    { type: 'START_RECORDING', sessionId: 'guide-1', mode: 'steps', numbered: true },
    { type: 'OPEN_EDITOR', sessionId: 'guide-1', entryId: 'step-1' },
    { type: 'PAUSE_RECORDING', runId: 'run-1' },
    {
      type: 'FRAME_TRAIL_READY',
      runId: 'run-1',
      snapshotContext: {
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
        devicePixelRatio: 1,
        url: 'https://example.com/',
        timestamp: 456,
      },
    },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'guide-1',
      target: { kind: 'snapshot-singleton', anchorId: 'anchor-1', annotationId: 'annotation-1' },
      preferredTabId: 7,
    },
  ])('accepts a structurally valid message %#', (message) => {
    expect(isBackgroundMessage(message)).toBe(true);
  });

  it.each<unknown>([
    null,
    [],
    {},
    { type: 'UNKNOWN' },
    { ...validClick, rect: { ...validClick.rect, width: 0 } },
    { ...validClick, rect: { ...validClick.rect, x: Number.NaN } },
    { ...validClick, viewport: { ...validClick.viewport, height: -1 } },
    { ...validClick, devicePixelRatio: 0 },
    { ...validClick, devicePixelRatio: 33 },
    { ...validClick, text: 'x'.repeat(10_001) },
    { ...validClick, url: 'javascript:alert(1)' },
    { ...validClick, url: 'https://user:secret@example.com/' },
    { ...validClick, timestamp: 1.5 },
    { type: 'START_RECORDING', sessionId: '', mode: 'steps', numbered: true },
    { type: 'OPEN_EDITOR', sessionId: 'x'.repeat(513) },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'guide-1',
      target: { kind: 'single', stepId: 'step-1' },
      preferredTabId: -1,
    },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'guide-1',
      target: { kind: 'snapshot-singleton', anchorId: 'same', annotationId: 'same' },
    },
  ])('rejects malformed or resource-unbounded input %#', (message) => {
    expect(isBackgroundMessage(message)).toBe(false);
  });
});

describe('background sender authorization', () => {
  const extensionRoot = 'chrome-extension://frame-trail-id/';

  it('accepts popup and top-level pages owned by this extension', () => {
    expect(isTrustedExtensionPageSender(
      { url: 'chrome-extension://frame-trail-id/popup.html' },
      extensionRoot,
    )).toBe(true);
    expect(isTrustedExtensionPageSender(
      {
        frameId: 0,
        url: 'chrome-extension://frame-trail-id/editor.html?session=1',
        tab: { id: 9, url: 'chrome-extension://frame-trail-id/editor.html?session=1' },
      },
      extensionRoot,
    )).toBe(true);
  });

  it.each([
    { url: 'https://example.com/', tab: { id: 1, url: 'https://example.com/' }, frameId: 0 },
    {
      url: 'chrome-extension://frame-trail-id/editor.html',
      tab: { id: 1, url: 'chrome-extension://frame-trail-id/editor.html' },
      frameId: 2,
    },
    {
      url: 'chrome-extension://frame-trail-id/editor.html',
      tab: { id: 1, url: 'https://example.com/' },
      frameId: 0,
    },
    { url: 'chrome-extension://different-extension/popup.html' },
    { url: 'moz-extension://frame-trail-id/popup.html' },
  ])('rejects content, child-frame, mixed-origin, and foreign-extension senders %#', (sender) => {
    expect(isTrustedExtensionPageSender(sender, extensionRoot)).toBe(false);
  });

  it('classifies lifecycle and destructive controls separately from recorder events', () => {
    const extensionOnly: BackgroundMessage[] = [
      { type: 'START_RECORDING', sessionId: 'guide-1', mode: 'steps', numbered: true },
      { type: 'STOP_RECORDING' },
      { type: 'RESET_GUIDE', sessionId: 'guide-1' },
      { type: 'OPEN_EDITOR' },
      { type: 'DISCARD_CURRENT_RECORDING', runId: 'run-1' },
    ];
    const recorderMessages: BackgroundMessage[] = [
      validClick,
      { type: 'FRAME_TRAIL_CANCEL_CAPTURE', runId: 'run-1', captureId: 'capture-1' },
      { type: 'FRAME_TRAIL_READY', runId: 'run-1' },
    ];

    expect(extensionOnly.every(isExtensionPageOnlyMessage)).toBe(true);
    expect(recorderMessages.some(isExtensionPageOnlyMessage)).toBe(false);
  });
});

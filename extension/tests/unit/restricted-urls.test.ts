import { describe, expect, it } from 'vitest';
import { isRecordableTab, isRecordableTabUrl, isRestrictedUrl } from '@/lib/shared/restricted-urls';

describe('isRestrictedUrl', () => {
  it('allows ordinary http and https pages', () => {
    expect(isRestrictedUrl('https://example.com/dashboard?tab=1')).toBe(false);
    expect(isRestrictedUrl('http://localhost:5173/app')).toBe(false);
    expect(isRestrictedUrl('https://docs.google.com/spreadsheets/d/abc')).toBe(false);
  });

  it('fails closed on a missing or empty URL', () => {
    expect(isRestrictedUrl(undefined)).toBe(true);
    expect(isRestrictedUrl('')).toBe(true);
  });

  it('blocks browser-internal schemes', () => {
    expect(isRestrictedUrl('chrome://settings/')).toBe(true);
    expect(isRestrictedUrl('chrome://newtab/')).toBe(true);
    expect(isRestrictedUrl('edge://settings/profiles')).toBe(true);
    expect(isRestrictedUrl('about:blank')).toBe(true);
    expect(isRestrictedUrl('about:srcdoc')).toBe(true);
  });

  it('blocks every chrome-extension:// page, including this extension itself', () => {
    // The editor/library/practice pages are chrome-extension:// URLs; no layer
    // may ever offer to record them, so there is no extension-page escape hatch.
    expect(isRestrictedUrl('chrome-extension://abcdefghijklmnop/editor.html')).toBe(true);
    expect(isRestrictedUrl('chrome-extension://otherextensionid/popup.html')).toBe(true);
  });

  it('blocks both Chrome Web Store hosts', () => {
    expect(isRestrictedUrl('https://chrome.google.com/webstore/detail/x/abc')).toBe(true);
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x/abc')).toBe(true);
  });

  it('does not block lookalike URLs that merely contain a restricted prefix', () => {
    expect(isRestrictedUrl('https://example.com/docs/chrome://settings')).toBe(false);
    expect(isRestrictedUrl('https://chrome.google.com.evil.example/webstore')).toBe(false);
    expect(isRestrictedUrl('https://example.com/?next=chrome-extension://abc')).toBe(false);
  });

  it('documents the current policy for other schemes the browser may still script', () => {
    // file: and data: pages are not restricted by this allowlist; recording
    // them is governed by host permissions instead. A policy change here must
    // be deliberate, not accidental.
    expect(isRestrictedUrl('file:///Users/me/report.html')).toBe(false);
    expect(isRestrictedUrl('data:text/html,<p>hi</p>')).toBe(false);
  });
});

describe('isRecordableTabUrl', () => {
  it('accepts ordinary http and https pages', () => {
    expect(isRecordableTabUrl('https://example.com/dashboard?tab=1')).toBe(true);
    expect(isRecordableTabUrl('http://localhost:5173/app')).toBe(true);
  });

  it('rejects a missing or empty URL', () => {
    expect(isRecordableTabUrl(undefined)).toBe(false);
    expect(isRecordableTabUrl('')).toBe(false);
  });

  it('rejects non-web schemes even when they are not policy-restricted', () => {
    // file:/data: pass isRestrictedUrl, but the recorder only targets web
    // pages; the positive http/https requirement is part of this contract.
    expect(isRecordableTabUrl('file:///Users/me/report.html')).toBe(false);
    expect(isRecordableTabUrl('data:text/html,<p>hi</p>')).toBe(false);
    expect(isRecordableTabUrl('chrome://settings/')).toBe(false);
    expect(isRecordableTabUrl('chrome-extension://abcdefghijklmnop/editor.html')).toBe(false);
    expect(isRecordableTabUrl('about:blank')).toBe(false);
  });

  it('rejects restricted https hosts such as the Chrome Web Store', () => {
    expect(isRecordableTabUrl('https://chrome.google.com/webstore/detail/x/abc')).toBe(false);
    expect(isRecordableTabUrl('https://chromewebstore.google.com/detail/x/abc')).toBe(false);
  });
});

describe('isRecordableTab', () => {
  const url = 'https://example.com/page';

  it('accepts a tab with id, windowId, and a recordable URL', () => {
    expect(isRecordableTab({ id: 3, windowId: 1, url })).toBe(true);
    expect(isRecordableTab({ id: 0, windowId: 0, url })).toBe(true);
  });

  it('rejects tabs missing an id or a window', () => {
    expect(isRecordableTab({ windowId: 1, url })).toBe(false);
    expect(isRecordableTab({ id: 3, url })).toBe(false);
    expect(isRecordableTab({ url })).toBe(false);
  });

  it('rejects tabs on non-recordable URLs', () => {
    expect(isRecordableTab({ id: 3, windowId: 1, url: 'chrome://settings/' })).toBe(false);
    expect(isRecordableTab({ id: 3, windowId: 1, url: 'file:///report.html' })).toBe(false);
    expect(isRecordableTab({ id: 3, windowId: 1 })).toBe(false);
  });
});

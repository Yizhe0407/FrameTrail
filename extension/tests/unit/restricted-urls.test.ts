import { describe, expect, it } from 'vitest';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';

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

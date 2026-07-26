import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsUpdate: vi.fn(),
  getURL: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getURL: mocks.getURL },
    tabs: { query: mocks.tabsQuery, create: mocks.tabsCreate, update: mocks.tabsUpdate },
    windows: { update: mocks.windowsUpdate },
  },
}));

import { focusTab, getEditorSessionIdFromUrl, openLibrary } from '@/lib/runtime/navigation';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getURL.mockImplementation((path: string) => `chrome-extension://extension-id${path}`);
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue(undefined);
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
});

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

describe('focusTab', () => {
  it('activates the tab, then focuses its window', async () => {
    await focusTab(7, 2);

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(7, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(2, { focused: true });
    // Tab activation must precede the window focus so a failed focus still
    // leaves the tab selected in its window.
    expect(mocks.tabsUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.windowsUpdate.mock.invocationCallOrder[0],
    );
  });

  it('skips the window focus when no windowId is known', async () => {
    await focusTab(7);
    await focusTab(7, null);

    expect(mocks.tabsUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.windowsUpdate).not.toHaveBeenCalled();
  });

  it('focuses window 0 rather than treating it as absent', async () => {
    await focusTab(7, 0);

    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(0, { focused: true });
  });
});

describe('openLibrary', () => {
  it('focuses an existing library tab instead of opening a duplicate', async () => {
    mocks.tabsQuery.mockResolvedValue([
      { id: 11, windowId: 3, url: 'chrome-extension://extension-id/library.html?x=1' },
    ]);

    await openLibrary();

    expect(mocks.tabsQuery).toHaveBeenCalledWith({ url: 'chrome-extension://extension-id/library.html*' });
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(11, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(3, { focused: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('opens a new library tab when none exists', async () => {
    await openLibrary();

    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'chrome-extension://extension-id/library.html' });
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  });
});

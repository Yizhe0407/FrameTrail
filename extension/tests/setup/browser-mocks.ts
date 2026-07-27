import { vi, type Mock } from 'vitest';

/**
 * Shared `wxt/browser` mock factories. Each factory returns the `browser`
 * object for a `vi.mock('wxt/browser', ...)` factory; tests wire only the
 * handles they assert on and every unnamed API falls back to a fresh vi.fn().
 * Handles must come from `vi.hoisted` because `vi.mock` factories are hoisted
 * above the test file body.
 */

type RuntimeOnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (value?: unknown) => void,
) => unknown;

/**
 * Emulates Chrome's runtime.onMessage dispatch for a captured listener: a
 * listener that returns `true` answers asynchronously through sendResponse;
 * any other return value means no response (the awaited dispatch resolves to
 * undefined, like a closed channel). A returned Promise is deliberately NOT
 * treated as a response: Chrome's promise-reply support shipped in 144 and was
 * reverted (crbug.com/40753031), so the background answers via the callback
 * contract and tests must exercise exactly that.
 */
export function dispatchRuntimeMessage(
  listener: RuntimeOnMessageListener,
  message: unknown,
  sender: unknown,
): Promise<unknown> | undefined {
  let respond!: (value?: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  return listener(message, sender, respond) === true ? response : undefined;
}

export interface BackgroundBrowserMockHandles {
  /** Captures the background's runtime.onMessage listener for direct dispatch.
   * The captured function already wraps the raw listener in
   * dispatchRuntimeMessage, so `await mocks.messageListener(msg, sender)`
   * yields the value the background passed to sendResponse. */
  onMessage?: (listener: (message: unknown, sender: unknown) => unknown) => void;
  onTabActivated?: (listener: (info: { tabId: number; windowId: number }) => void) => void;
  onTabUpdated?: (
    listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string }) => void,
  ) => void;
  onWindowFocusChanged?: (listener: (windowId: number) => void) => void;
  permissionsContains?: Mock;
  permissionsRequest?: Mock;
  tabsCreate?: Mock;
  tabsGet?: Mock;
  tabsQuery?: Mock;
  tabsRemove?: Mock;
  tabsSendMessage?: Mock;
  tabsUpdate?: Mock;
  windowsUpdate?: Mock;
  executeScript?: Mock;
  insertCSS?: Mock;
}

/** MV3 service-worker surface used by entrypoints/background.ts under test. */
export function makeBackgroundBrowserMock(handles: BackgroundBrowserMockHandles = {}) {
  return {
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      onMessage: {
        addListener: (listener: RuntimeOnMessageListener) => {
          handles.onMessage?.((message, sender) => dispatchRuntimeMessage(listener, message, sender));
        },
      },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    commands: { onCommand: { addListener: vi.fn() } },
    permissions: {
      contains: handles.permissionsContains ?? vi.fn(),
      request: handles.permissionsRequest ?? vi.fn(),
    },
    tabs: {
      captureVisibleTab: vi.fn(),
      create: handles.tabsCreate ?? vi.fn(),
      get: handles.tabsGet ?? vi.fn(),
      onActivated: { addListener: handles.onTabActivated ?? vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: handles.onTabUpdated ?? vi.fn() },
      query: handles.tabsQuery ?? vi.fn(),
      remove: handles.tabsRemove ?? vi.fn(),
      sendMessage: handles.tabsSendMessage ?? vi.fn(),
      update: handles.tabsUpdate ?? vi.fn(),
    },
    windows: {
      onFocusChanged: { addListener: handles.onWindowFocusChanged ?? vi.fn() },
      update: handles.windowsUpdate ?? vi.fn(),
    },
    scripting: {
      executeScript: handles.executeScript ?? vi.fn(),
      insertCSS: handles.insertCSS ?? vi.fn(),
      removeCSS: vi.fn(),
    },
  };
}

export interface PopupBrowserMockHandles {
  sendMessage?: Mock;
  tabsQuery?: Mock;
  permissionsContains?: Mock;
  permissionsRequest?: Mock;
  storageGet?: Mock;
  storageSet?: Mock;
  storageRemove?: Mock;
}

/** Popup-page surface used by the RecordControls integration tests. */
export function makePopupBrowserMock(handles: PopupBrowserMockHandles = {}) {
  return {
    runtime: {
      getURL: (path: string) => `chrome-extension://frame${path}`,
      sendMessage: handles.sendMessage ?? vi.fn(),
    },
    tabs: { query: handles.tabsQuery ?? vi.fn() },
    permissions: {
      contains: handles.permissionsContains ?? vi.fn().mockResolvedValue(true),
      request: handles.permissionsRequest ?? vi.fn(),
    },
    storage: {
      local: {
        get: handles.storageGet ?? vi.fn().mockResolvedValue({}),
        set: handles.storageSet ?? vi.fn(),
        remove: handles.storageRemove ?? vi.fn(),
      },
    },
  };
}

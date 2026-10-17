import { browser, type Browser } from 'wxt/browser';

/** The toolbar button: MV3 exposes `action`; Firefox's MV2 build only has `browserAction`. */
export function toolbarAction() {
  return browser.action ?? browser.browserAction;
}

/**
 * Whether the person has pinned the toolbar button. `unknown` means this
 * browser cannot say, so callers must keep showing how to pin rather than
 * guess either way.
 */
export type ToolbarPin = 'pinned' | 'unpinned' | 'unknown';

// Chrome has had getUserSettings since 91 and onUserSettingsChanged since 130;
// the MV2 `browserAction` typings carry neither, so both are probed.
type UserSettingsSource = {
  getUserSettings?: () => Promise<Browser.action.UserSettings>;
  onUserSettingsChanged?: Browser.events.Event<(change: Browser.action.UserSettingsChange) => void>;
};

function userSettingsSource(): UserSettingsSource {
  return toolbarAction() as UserSettingsSource;
}

export async function readToolbarPin(): Promise<ToolbarPin> {
  const source = userSettingsSource();
  if (typeof source.getUserSettings !== 'function') return 'unknown';
  try {
    const settings = await source.getUserSettings();
    return typeof settings?.isOnToolbar === 'boolean' ? (settings.isOnToolbar ? 'pinned' : 'unpinned') : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Calls `onChange` with the current pin state and again whenever it may have
 * changed. Pinning happens in browser UI outside the page, so where the
 * browser has no change event the page re-reads when it regains focus — the
 * person is back from that UI by then. Returns the unsubscribe.
 */
export function watchToolbarPin(onChange: (pin: ToolbarPin) => void): () => void {
  let disposed = false;
  let latest = 0;
  const refresh = () => {
    const request = ++latest;
    void readToolbarPin().then((pin) => {
      if (!disposed && request === latest) onChange(pin);
    });
  };

  const event = userSettingsSource().onUserSettingsChanged;
  const listener = (change: Browser.action.UserSettingsChange) => {
    if (typeof change.isOnToolbar !== 'boolean') return;
    // Supersede any read still in flight so a stale answer cannot land after this one.
    latest++;
    onChange(change.isOnToolbar ? 'pinned' : 'unpinned');
  };
  const hasEvent = typeof event?.addListener === 'function';
  if (hasEvent) event.addListener(listener);
  else window.addEventListener('focus', refresh);

  refresh();
  return () => {
    disposed = true;
    if (hasEvent) event.removeListener(listener);
    else window.removeEventListener('focus', refresh);
  };
}

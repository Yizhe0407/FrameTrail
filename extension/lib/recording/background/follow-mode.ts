import { browser, type Browser } from 'wxt/browser';
import { queueLifecycle } from '../background-queues';
import { getRecordingState } from '../../storage/storage';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { describeBrowserError } from '../../runtime/browser-errors';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';

/** How long a newly activated tab must stay active before a live steps run
 * follows it. Flicking through several tabs (Ctrl+Tab, tab strip scrubbing)
 * must not inject the recorder into every tab passed on the way. */
const FOLLOW_ACTIVATION_DEBOUNCE_MS = 300;

/**
 * Follow-the-user recording: while a steps run is live and the user activates
 * a different eligible tab, the run moves there instead of silently dropping
 * every click. Snapshot mode never follows (its coordinates belong to one
 * frozen document), and without the <all_urls> grant (asked once at the first
 * steps start, or opted into later via the popup's 「啟用跨分頁錄製」 link)
 * the run keeps its original single-tab behavior. An ineligible tab
 * (restricted/extension page) moves nothing: the recording stays on the
 * previous tab, toolbar and all, until an eligible tab is activated.
 *
 * The tab listeners themselves stay wired in the background entrypoint; this
 * module owns the debounce and the move.
 */
export function createFollowMode(deps: { control: ControlPlane; runtime: RecorderRuntime }) {
  const { control, runtime } = deps;
  let followDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounces tab activations, then serializes the actual move through the
   * lifecycle queue so it can never interleave with START/STOP or another move. */
  function scheduleRecordingFollow(tabId: number): void {
    if (followDebounceTimer != null) clearTimeout(followDebounceTimer);
    followDebounceTimer = setTimeout(() => {
      followDebounceTimer = null;
      void queueLifecycle(() => followRecordingToTab(tabId)).catch((error) => {
        console.error('[frametrail] failed to follow the activated tab', describeBrowserError(error), error);
      });
    }, FOLLOW_ACTIVATION_DEBOUNCE_MS);
  }

  async function followRecordingToTab(tabId: number): Promise<void> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recording' ||
      !state.isRecording ||
      state.mode !== 'steps' ||
      !state.runId ||
      state.tabId == null ||
      state.tabId === tabId ||
      (state.phase !== 'recording' && state.phase !== 'paused')
    ) {
      return;
    }
    if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) return;
    let tab: Browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return; // The activated tab is already gone; a later activation will follow.
    }
    // `active` re-checks after the debounce that this tab still holds focus in
    // its window; a same-window switch-away already scheduled its own follow.
    // The recorder may only move into a normal web page, never a
    // browser/extension page (the editor included).
    if (!tab.active || !isRecordableTabUrl(tab.url)) return;

    const runId = state.runId;
    const previousTabId = state.tabId;
    // Publish the new tabId BEFORE injecting: the recorder's READY handshake and
    // its keep-alive port are validated against state.tabId, so injecting first
    // would make the fresh recorder reject itself and tear down immediately.
    const moved = await control.writeStateIf(
      expectedControlVersion,
      (current) =>
        current.isRecording &&
        current.operation === 'recording' &&
        current.runId === runId &&
        current.tabId === previousTabId,
      (current) => ({ ...current, tabId }),
    );
    if (!moved) return;
    try {
      // All-frames mirrors the START injection so iframe clicks in the followed
      // tab are relayed to its top-frame recorder rather than silently lost.
      await runtime.injectRecorder(tabId, true);
    } catch (error) {
      console.warn(
        '[frametrail] failed to move the recording into the activated tab',
        describeBrowserError(error),
        error,
      );
      // Hand the run back to the previous tab, whose recorder was never stopped;
      // no error is surfaced because nothing about the run was lost.
      await control.writeStateIf(
        expectedControlVersion,
        (current) =>
          current.isRecording &&
          current.operation === 'recording' &&
          current.runId === runId &&
          current.tabId === tabId,
        (current) => ({ ...current, tabId: previousTabId }),
      );
      return;
    }
    // The keep-alive rejection path would retire the old recorder eventually; an
    // explicit stop removes its toolbar right away. If the message cannot reach
    // a bfcached document, that same rejection path remains the backstop.
    await runtime.stopRecorderInTab(previousTabId);
  }

  return { scheduleRecordingFollow };
}


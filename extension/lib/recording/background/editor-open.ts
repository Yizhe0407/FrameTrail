import { browser } from 'wxt/browser';
import { getGuide } from '../../storage/guide-repository';
import { getSteps } from '../../storage/step-repository';
import { getRecordingState } from '../../storage/storage';
import { describeBrowserError } from '../../runtime/browser-errors';
import { isEditorHandoffResult } from '../../runtime/runtime-message-result';
import { EDITOR_OPEN_FAILED_MESSAGE } from '../../runtime/user-messages';
import {
  createExtensionPage,
  extensionPageUrl,
  findExtensionPage,
  forgetExtensionPage,
  showExtensionPage,
} from './extension-page-tabs';
import {
  clearEditorRecovery,
  markEditorOpenFailed,
  needsEditorRecovery,
} from '../recording-recovery';
import type { ControlPlane } from './control-plane';
import type { EditorHandoffMessage, OpenEditorMessage, OpenEditorResult } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';

/** What an editor tab should end up showing. */
export interface EditorTarget {
  /** Omitted only by recovery that has no Guide left to name. */
  sessionId?: string;
  entryId?: string | null;
}

/** How a remembered editor tab can be reused for a target. */
type EditorReuse =
  | { action: 'focus' | 'navigate' }
  /** The page is holding a draft it needs the user to resolve first. */
  | { action: 'blocked'; error: string }
  /** The record no longer names a live tab. */
  | { action: 'discard' };

function editorUrl(target: EditorTarget): string {
  const url = new URL(extensionPageUrl('editor'));
  // The query params remain the load-time contract: recapture-guards
  // authenticates editor senders by the sessionId carried in their URL, and the
  // page reads its initial entry from the URL on mount.
  if (target.sessionId) {
    url.searchParams.set('sessionId', target.sessionId);
    if (target.entryId) url.searchParams.set('entryId', target.entryId);
  }
  return url.href;
}

async function editorTabStillExists(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the open editor to take over the target Guide. The page decides, because
 * it is the only component that knows what it is displaying and whether it has
 * unsaved work — which is also why the discovery record never has to store a
 * session id.
 */
async function negotiateEditorReuse(tabId: number, message: EditorHandoffMessage): Promise<EditorReuse> {
  let reply: unknown;
  try {
    reply = await browser.tabs.sendMessage(tabId, message);
  } catch {
    // Nothing answered: the tab was discarded, is mid-reload, or no longer
    // holds an editor. If the tab is still there it has no live page state to
    // protect, so reuse it; otherwise the record is stale.
    return (await editorTabStillExists(tabId)) ? { action: 'navigate' } : { action: 'discard' };
  }
  // An unshaped or absent reply means whatever answered is not our editor page,
  // so again there is no draft to protect.
  if (!isEditorHandoffResult(reply)) return { action: 'navigate' };
  if (!reply.ok) return { action: 'blocked', error: reply.error };
  return { action: reply.ready ? 'focus' : 'navigate' };
}

/**
 * Opening (or reusing) the editor for a stored session, including the
 * editor-recovery bookkeeping in the run state. The runtime.onMessage listener
 * stays wired in the background entrypoint, mirroring follow-mode's
 * listener/logic split; state writes go through the injected control plane.
 */
export function createEditorOpen(deps: { control: ControlPlane }) {
  const { control } = deps;

  /**
   * The one way the editor ever opens: finishing a run, the OPEN_EDITOR
   * message, and returning from a recapture all come through here, so the
   * product keeps exactly one editor tab.
   */
  async function openEditor(target: EditorTarget = {}): Promise<OpenEditorResult> {
    const url = editorUrl(target);
    const existing = await findExtensionPage('editor');
    if (!existing) {
      await createExtensionPage(url);
      return { ok: true };
    }
    if (!target.sessionId) {
      // Recovery with no Guide to name: whatever the open editor shows beats a
      // second, contentless tab, so focus it without negotiating anything.
      await showExtensionPage('editor', existing, { url, navigate: false });
      return { ok: true };
    }

    const reuse = await negotiateEditorReuse(existing.tabId, {
      type: 'EDITOR_HANDOFF',
      sessionId: target.sessionId,
      ...(target.entryId ? { entryId: target.entryId } : {}),
    });
    if (reuse.action === 'discard') {
      await forgetExtensionPage('editor');
      await createExtensionPage(url);
      return { ok: true };
    }
    await showExtensionPage('editor', existing, { url, navigate: reuse.action === 'navigate' });
    // The editor is in front either way. A blocked page kept its draft and is
    // showing what needs confirming; the caller's UI repeats the reason.
    return reuse.action === 'blocked' ? { ok: false, error: reuse.error } : { ok: true };
  }

  /** The newest capture in a Guide: where an interrupted run resumes. */
  async function latestEntryId(sessionId: string): Promise<string | null> {
    const steps = await getSteps(sessionId);
    const lastItem = steps.filter((step) => step.bounds !== null).at(-1) ?? null;
    return lastItem?.groupId ?? lastItem?.id ?? null;
  }

  async function openEditorForStoredSession(message: OpenEditorMessage): Promise<OpenEditorResult> {
    const expectedControlVersion = control.controlVersion;
    let state: RecordingState | null = null;
    let targetSessionId = message.sessionId;
    try {
      state = await getRecordingState();
      targetSessionId ??= state.sessionId ?? undefined;
      if (!targetSessionId) return await openEditor();
      const guide = await getGuide(targetSessionId);
      if (!guide) return { ok: false, error: '找不到這份內容。' };
      // Only a hand-off continues where the capture stopped: finishing a run, or
      // recovering one whose recorded tab went away. Ordinary navigation opens the
      // guide at its first entry — deriving the target from the newest capture
      // made every "open editor" land on the last step.
      const resumesInterruptedRun =
        state.sessionId === targetSessionId && needsEditorRecovery(state.recoverableError);
      const entryId =
        message.entryId ?? (resumesInterruptedRun ? await latestEntryId(targetSessionId) : null);
      const result = await openEditor({ sessionId: targetSessionId, entryId });
      if (state.sessionId === targetSessionId) {
        await control.writeStateForControl(expectedControlVersion, (current) => {
          if (current.sessionId !== targetSessionId) return current;
          return clearEditorRecovery(current);
        });
      }
      return result;
    } catch (error) {
      console.error('[frametrail] failed to open editor:', describeBrowserError(error), error);
      if (state?.sessionId === targetSessionId) {
        try {
          await control.writeStateForControl(expectedControlVersion, (current) => {
            if (current.sessionId !== targetSessionId) return current;
            return markEditorOpenFailed(current);
          });
        } catch (recoveryError) {
          console.error(
            '[frametrail] failed to persist editor recovery state:',
            describeBrowserError(recoveryError),
            recoveryError,
          );
        }
      }
      return { ok: false, error: EDITOR_OPEN_FAILED_MESSAGE };
    }
  }

  return { openEditor, openEditorForStoredSession };
}

export type EditorOpen = ReturnType<typeof createEditorOpen>;

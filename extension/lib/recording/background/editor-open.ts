import { browser } from 'wxt/browser';
import { getGuide, getSteps } from '../../storage/db';
import { getRecordingState } from '../../storage/storage';
import { focusTab } from '../../runtime/navigation';
import { describeBrowserError } from '../../runtime/browser-errors';
import { EDITOR_OPEN_FAILED_MESSAGE } from '../../runtime/user-messages';
import {
  clearEditorRecovery,
  markEditorOpenFailed,
  needsEditorRecovery,
} from '../recording-recovery';
import type { ControlPlane } from './control-plane';
import type { FinishResult, OpenEditorMessage, OpenEditorResult } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';

/**
 * Opening (or focusing) the editor for a stored session, including the
 * editor-recovery bookkeeping in the run state. The runtime.onMessage listener
 * stays wired in the background entrypoint, mirroring follow-mode's
 * listener/logic split; state writes go through the injected control plane.
 */
export function createEditorOpen(deps: { control: ControlPlane }) {
  const { control } = deps;

  async function openOrFocusEditor(result?: FinishResult): Promise<void> {
    const editorBase = browser.runtime.getURL('/editor.html');
    const editorUrl = new URL(editorBase);
    if (result) {
      editorUrl.searchParams.set('sessionId', result.sessionId);
      if (result.entryId) editorUrl.searchParams.set('entryId', result.entryId);
      if (result.groupId) editorUrl.searchParams.set('groupId', result.groupId);
    }

    // Never redirect an editor that may contain an unsaved description for a
    // different Guide. Focus an existing same-Guide editor or open a new tab.
    const editors = await browser.tabs.query({ url: `${editorBase}*` });
    const existing = result
      ? editors.find((tab) => {
          if (tab.id == null || !tab.url) return false;
          try {
            return new URL(tab.url).searchParams.get('sessionId') === result.sessionId;
          } catch {
            return false;
          }
        })
      : editors.find((tab) => tab.id != null && tab.url === editorBase);
    if (existing?.id != null) {
      await focusTab(existing.id, existing.windowId);
      return;
    }
    await browser.tabs.create({ url: editorUrl.href, active: true });
  }

  async function latestFinishResult(sessionId: string): Promise<FinishResult> {
    const steps = await getSteps(sessionId);
    const items = steps.filter((step) => step.bounds !== null);
    const lastItem = items.at(-1) ?? null;
    return {
      sessionId,
      entryId: lastItem?.groupId ?? lastItem?.id ?? null,
      groupId: lastItem?.groupId ?? null,
      itemCount: items.length,
    };
  }

  async function openEditorForStoredSession(message: OpenEditorMessage): Promise<OpenEditorResult> {
    const expectedControlVersion = control.controlVersion;
    let state: RecordingState | null = null;
    let targetSessionId = message.sessionId;
    try {
      state = await getRecordingState();
      targetSessionId ??= state.sessionId ?? undefined;
      if (!targetSessionId) {
        await openOrFocusEditor();
        return { ok: true };
      }
      const guide = await getGuide(targetSessionId);
      if (!guide) return { ok: false, error: '找不到這份教學。' };
      // Only a hand-off continues where the capture stopped: finishing a run, or
      // recovering one whose recorded tab went away. Ordinary navigation opens the
      // guide at its first entry — deriving the target from the newest capture
      // made every "open editor" land on the last step.
      const resumesInterruptedRun =
        state.sessionId === targetSessionId && needsEditorRecovery(state.recoverableError);
      const result: FinishResult = resumesInterruptedRun
        ? await latestFinishResult(targetSessionId)
        : { sessionId: targetSessionId, entryId: null, groupId: null, itemCount: 0 };
      if (message.entryId) result.entryId = message.entryId;
      await openOrFocusEditor(result);
      if (state.sessionId === targetSessionId) {
        await control.writeStateForControl(expectedControlVersion, (current) => {
          if (current.sessionId !== targetSessionId) return current;
          return clearEditorRecovery(current);
        });
      }
      return { ok: true };
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

  return { openOrFocusEditor, openEditorForStoredSession };
}

export type EditorOpen = ReturnType<typeof createEditorOpen>;

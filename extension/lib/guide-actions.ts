import { browser } from 'wxt/browser';
import { createGuide, getGuide, type Guide } from './db';
import {
  clearActiveGuideId,
  getActiveGuideId,
  setActiveGuideId,
} from './storage';
import type { OpenEditorResult } from './messages';
import { requireRuntimeMessageResult } from './runtime-message-result';

// Preserve invocation order across async IndexedDB lookups. Without this, a
// slow earlier select could overwrite a newer selection after its lookup ends.
let selectionAction: Promise<void> = Promise.resolve();

function queueSelectionAction<T>(action: () => Promise<T>): Promise<T> {
  const result = selectionAction.then(action, action);
  selectionAction = result.then(() => undefined, () => undefined);
  return result;
}

async function selectExistingGuide(guideId: string): Promise<Guide> {
  const guide = await getGuide(guideId);
  if (!guide) throw new Error('找不到這份教學。');
  await setActiveGuideId(guide.id);
  return guide;
}

/** Selects a Guide for UI navigation only. Capture ownership remains entirely
 * in RecordingState, so this operation is safe from recording-state races. */
export function selectGuide(guideId: string): Promise<Guide> {
  return queueSelectionAction(() => selectExistingGuide(guideId));
}

export function createAndSelectGuide(title?: string): Promise<Guide> {
  return queueSelectionAction(async () => {
    const guide = await createGuide({ title });
    await setActiveGuideId(guide.id);
    return guide;
  });
}

/** Explicit UI-flow helper (for example, pressing Start with no selection).
 * Passive startup/recovery code must use getActiveGuideId instead. A stale id
 * is cleared and replaced with a fresh Guide; it is never recreated via
 * ensureGuide, which could resurrect a permanently deleted Guide. */
export function ensureSelectedGuide(): Promise<Guide> {
  return queueSelectionAction(async () => {
    const selectedId = await getActiveGuideId();
    if (selectedId) {
      const selected = await getGuide(selectedId);
      if (selected) return selected;
      await clearActiveGuideId(selectedId);
    }

    const guide = await createGuide();
    await setActiveGuideId(guide.id);
    return guide;
  });
}

export async function openSelectedGuideInEditor(guideId: string): Promise<void> {
  const guide = await selectGuide(guideId);
  // Keep the payload structural so this remains source-compatible while the
  // shared message/background contract is rolled out by the primary agent.
  const message = { type: 'OPEN_EDITOR', sessionId: guide.id } as const;
  const result = requireRuntimeMessageResult<OpenEditorResult>(
    await browser.runtime.sendMessage(message),
    '無法連接編輯器服務，請重新開啟 FrameTrail 後再試一次。',
  );
  if (!result.ok) throw new Error(result.error);
}

/** Compare-and-clears only the matching UI selection. It deliberately does
 * not inspect or rewrite RecordingState; the global operation lock protects
 * Guide data mutations, not harmless navigation state. */
export function clearSelectedGuide(guideId: string): Promise<void> {
  return queueSelectionAction(async () => {
    await clearActiveGuideId(guideId);
  });
}

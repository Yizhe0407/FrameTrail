import { browser } from 'wxt/browser';
import { createGuide, discardPristineGuide, getGuide } from '../storage/guide-repository';
import { type Guide } from '../storage/models';
import {
  clearActiveGuideId,
  getActiveGuideId,
  getRecordingState,
  setActiveGuideId,
} from '../storage/storage';
import type { OpenEditorResult, StartRecordingResult } from '../runtime/messages';
import type { RecordingMode } from '../storage/recording-state';
import {
  isOpenEditorResult,
  isStartRecordingResult,
  requireRuntimeMessageResult,
} from '../runtime/runtime-message-result';
import { t } from '@/lib/shared/i18n';

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
  if (!guide) throw new Error(t().runtime.guideNotFound);
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

/** Reads the currently selected Guide, or null when nothing valid is
 * selected. Read-only; a stale selection is reported as null, not cleared. */
export async function getSelectedGuide(): Promise<Guide | null> {
  const selectedId = await getActiveGuideId();
  if (!selectedId) return null;
  return (await getGuide(selectedId)) ?? null;
}

/**
 * UI-flow wrapper over the storage-side discardPristineGuide: reclaims a Guide
 * that was auto-created for a recording run which never produced anything.
 * The pristine guard and compare-and-clear of the selection live in
 * lib/storage; this wrapper only adds selection-queue ordering and the
 * restorePreviousGuideId behavior, which re-selects the pre-start selection
 * after a failed start so the aborted attempt is invisible. Callers must only
 * pass ids they themselves auto-created — an explicitly created 作品庫 guide
 * shares the same empty shape and must never reach this. Returns whether it
 * deleted.
 */
export function discardUntouchedGuide(
  guideId: string,
  restorePreviousGuideId: string | null = null,
): Promise<boolean> {
  return queueSelectionAction(async () => {
    const deleted = await discardPristineGuide(guideId);
    if (!deleted) return false;
    if (restorePreviousGuideId && restorePreviousGuideId !== guideId) {
      const previous = await getGuide(restorePreviousGuideId);
      if (previous) await setActiveGuideId(previous.id);
    }
    return true;
  });
}

/** The Guide a run records into, claimed before START_RECORDING is sent. */
export interface RecordingGuideClaim {
  guide: Guide;
  /** True when the claim created the Guide, so an empty run may reclaim it. */
  autoCreated: boolean;
  /** Undoes the claim after a start that never produced a live run: reclaims
   * an auto-created shell, or puts the pre-claim selection back. */
  release: () => Promise<void>;
}

function restoreSelection(previousGuideId: string | null, claimedGuideId: string): Promise<void> {
  return queueSelectionAction(async () => {
    if (previousGuideId === claimedGuideId) return;
    const previous = previousGuideId ? await getGuide(previousGuideId) : undefined;
    if (previous) await setActiveGuideId(previous.id);
    else await clearActiveGuideId(claimedGuideId);
  });
}

/**
 * Picks the Guide a popup-initiated run records into and makes it the UI
 * selection. `null` creates a brand-new Guide; an id appends to that existing
 * one (the same append the editor's 接續錄製 performs). Shared by the popup
 * and the background's permission-resumed start so both resolve a target the
 * same way.
 */
export async function claimRecordingGuide(targetGuideId: string | null): Promise<RecordingGuideClaim> {
  // The pre-claim selection is remembered so a failed start is invisible.
  const previousGuideId = (await getSelectedGuide())?.id ?? null;
  if (targetGuideId === null) {
    const guide = await createAndSelectGuide();
    return {
      guide,
      autoCreated: true,
      release: async () => {
        await discardUntouchedGuide(guide.id, previousGuideId);
      },
    };
  }
  const guide = await selectGuide(targetGuideId);
  return { guide, autoCreated: false, release: () => restoreSelection(previousGuideId, guide.id) };
}

/**
 * The popup's start transaction. By default every start records into a
 * brand-new Guide (Scribe/Tango convention); passing `targetGuideId` is the
 * explicit opt-in to append to an existing one. Claims the Guide, asks the
 * background to start recording into it, and on failure rolls the world back
 * to exactly how it was. Returns the Guide the live run records into.
 */
export async function startRecordingIntoGuide(
  mode: RecordingMode,
  targetGuideId: string | null = null,
): Promise<Guide> {
  const claim = await claimRecordingGuide(targetGuideId);
  const { guide } = claim;
  try {
    const result = requireRuntimeMessageResult<StartRecordingResult>(
      await browser.runtime.sendMessage({
        type: 'START_RECORDING',
        sessionId: guide.id,
        mode,
        ...(claim.autoCreated ? { autoCreatedGuide: true } : {}),
      }),
      isStartRecordingResult,
      t().runtime.recordingServiceUnavailable,
    );
    if (!result.ok) throw new Error(result.error);
    return guide;
  } catch (startError) {
    // Best-effort rollback of the claim above. The recording-state probe
    // covers the odd case where the run actually started but the response was
    // lost — releasing a live run's Guide would strand it.
    try {
      const live = await getRecordingState();
      if (!(live.isRecording && live.sessionId === guide.id)) await claim.release();
    } catch (rollbackError) {
      console.error('[frametrail] failed to roll back the recording guide claim', rollbackError);
    }
    throw startError;
  }
}

/** Explicit UI-flow helper for editor navigation with no valid selection
 * (popup 開啟編輯器). Recording starts never use this — the popup's 開始錄製
 * always records into a fresh Guide via createAndSelectGuide, and appending
 * to an existing Guide is exclusively the editor's 接續錄製 flow. Passive
 * startup/recovery code must use getActiveGuideId instead. A stale id is
 * cleared and replaced with a fresh Guide; it is never recreated via
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

/**
 * Selects a Guide and opens it in the single editor tab. With `inPlace`, an
 * extension page asks to become the editor itself when no editor is open
 * elsewhere; an existing editor tab always takes precedence.
 */
export async function openSelectedGuideInEditor(guideId: string, options: { inPlace?: boolean } = {}): Promise<void> {
  const guide = await selectGuide(guideId);
  const result = requireRuntimeMessageResult<OpenEditorResult>(
    await browser.runtime.sendMessage({
      type: 'OPEN_EDITOR',
      sessionId: guide.id,
      ...(options.inPlace ? { inPlace: true } : {}),
    }),
    isOpenEditorResult,
    t().popup.editorServiceUnavailable,
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

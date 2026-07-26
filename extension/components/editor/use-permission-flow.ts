import { useCallback, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { PreparedCapturePermission } from '@/lib/editor/editor-app-model';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';
import { entryId, type StepEntry } from '@/lib/storage/db';
import type {
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepRecaptureTarget,
} from '@/lib/runtime/messages';
import {
  isPreflightGuideContinuationSourcePermissionResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isStartRecordingResult,
  isStartStepRecaptureResult,
  requireRuntimeMessageResult,
} from '@/lib/runtime/runtime-message-result';

function validatePreparedPermissionSource(
  sourceOrigin: string,
  permissionPattern: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceOrigin);
  } catch {
    throw new Error('來源網站授權資料無效，已停止操作。');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== sourceOrigin ||
    permissionPattern !== `${parsed.origin}/*`
  ) {
    throw new Error('來源網站授權資料不符合安全規則，已停止操作。');
  }
}

/** Same recordability rule the popup start path applies: a normal web page.
 * Tab URLs are only visible for origins the user already granted (or the
 * active tab), which is exactly the set the recorder can be injected into. */
function isRecordableContinuationTab(tab: Browser.tabs.Tab): boolean {
  return (
    tab.id != null &&
    tab.windowId != null &&
    typeof tab.url === 'string' &&
    (tab.url.startsWith('http://') || tab.url.startsWith('https://')) &&
    !isRestrictedUrl(tab.url)
  );
}

/** The most recently used normal web page tab, so 「改在其他頁面接續」 lands on
 * the page the user was just working in rather than an arbitrary tab. */
async function findLatestRecordableTab(): Promise<Browser.tabs.Tab | null> {
  const tabs = await browser.tabs.query({});
  const candidates = tabs
    .filter(isRecordableContinuationTab)
    .sort((first, second) => (second.lastAccessed ?? 0) - (first.lastAccessed ?? 0));
  return candidates[0] ?? null;
}

interface UsePermissionFlowOptions {
  sessionId: string | null;
  operationActive: boolean;
  /** True while a structural data operation holds the editor's data lock. */
  isDataOperationLocked: () => boolean;
  flushDescriptions: () => Promise<void>;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setOperationError: (message: string | null) => void;
}

/**
 * The source-permission state machine for recapture and continuation runs.
 *
 * Invariants preserved from the original inline implementation:
 * - `generation` increments on every begin/clear, and every asynchronous
 *   continuation re-checks it so a cancelled or superseded flow can never
 *   apply state or errors for an earlier attempt.
 * - `lock` is held from preflight until the flow is cleared, blocking
 *   structural data operations and re-entrant preflights.
 * - `flowEntryId`/`flowSessionId` bind a prepared grant to the entry and Guide
 *   it was prepared for; any selection or session change cancels it.
 */
export function usePermissionFlow({
  sessionId,
  operationActive,
  isDataOperationLocked,
  flushDescriptions,
  requireSelectedEntry,
  setOperationError,
}: UsePermissionFlowOptions) {
  const [preparedPermission, setPreparedPermission] = useState<PreparedCapturePermission | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);
  const [continueElsewherePending, setContinueElsewherePending] = useState(false);
  const [continueElsewhereError, setContinueElsewhereError] = useState<string | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const flowEntryId = useRef<string | null>(null);
  const flowSessionId = useRef<string | null>(null);
  const permissionFlowActive = preparedPermission !== null || permissionPending;

  const isPermissionFlowLocked = useCallback(() => lock.current, []);

  const clearPreparedPermission = useCallback(() => {
    generation.current += 1;
    lock.current = false;
    flowEntryId.current = null;
    flowSessionId.current = null;
    setPreparedPermission(null);
    setPermissionPending(false);
    setContinueElsewherePending(false);
    setContinueElsewhereError(null);
  }, []);

  /** Cancels a prepared grant when the selection or Guide it was bound to is
   * no longer current. */
  const syncWithSelection = useCallback((selectedEntryId: string | null, currentSessionId: string | null) => {
    const boundEntryId = flowEntryId.current;
    if (!boundEntryId) return;
    if (boundEntryId !== selectedEntryId || flowSessionId.current !== currentSessionId) {
      clearPreparedPermission();
    }
  }, [clearPreparedPermission]);

  function beginPermissionPreflight(entryIdToPrepare: string | null): number | null {
    if (
      !sessionId ||
      isDataOperationLocked() ||
      lock.current ||
      operationActive
    ) return null;
    const nextGeneration = generation.current + 1;
    generation.current = nextGeneration;
    lock.current = true;
    flowEntryId.current = entryIdToPrepare;
    flowSessionId.current = sessionId;
    setPreparedPermission(null);
    setPermissionPending(true);
    setOperationError(null);
    return nextGeneration;
  }

  function finishPermissionPreflight(flowGeneration: number, prepared: PreparedCapturePermission | null): void {
    if (generation.current !== flowGeneration) return;
    setPermissionPending(false);
    if (prepared) {
      setPreparedPermission(prepared);
      return;
    }
    lock.current = false;
    flowEntryId.current = null;
    flowSessionId.current = null;
  }

  async function confirmPreparedPermission(): Promise<void> {
    const prepared = preparedPermission;
    if (
      !prepared ||
      prepared.source.kind !== 'origin' ||
      !sessionId ||
      permissionPending ||
      continueElsewherePending ||
      !lock.current ||
      flowSessionId.current !== sessionId
    ) return;

    if (prepared.entryId) requireSelectedEntry(prepared.entryId);
    validatePreparedPermissionSource(prepared.source.sourceOrigin, prepared.source.permissionPattern);
    const flowGeneration = generation.current;
    setPermissionPending(true);
    setOperationError(null);

    try {
      // This must remain the first asynchronous browser API in this explicit
      // confirmation click so Chromium preserves transient user activation.
      const granted = await browser.permissions.request({ origins: [prepared.source.permissionPattern] });
      if (generation.current !== flowGeneration) return;
      if (!granted) throw new Error('需要允許存取來源網站，才能回到該頁面錄製。');

      try {
        await flushDescriptions();
      } catch {
        // flushDescriptions already surfaced its own localized message; a
        // generic overwrite here would hide which descriptions failed to save.
        return;
      }
      if (generation.current !== flowGeneration) return;
      if (prepared.action.kind === 'continuation') {
        const started = requireRuntimeMessageResult<StartRecordingResult>(
          await browser.runtime.sendMessage({
            type: 'START_RECORDING',
            sessionId,
            mode: 'steps',
            continuation: {},
          }),
          isStartRecordingResult,
        );
        if (!started.ok) throw new Error(started.error);
        return;
      }
      const result = requireRuntimeMessageResult<StartStepRecaptureResult>(
        await browser.runtime.sendMessage({
          type: 'START_STEP_RECAPTURE',
          sessionId,
          target: prepared.action.target,
        }),
        isStartStepRecaptureResult,
      );
      if (!result.ok) throw new Error(result.error);
    } catch (permissionError) {
      console.error('授權並啟動來源錄製失敗', permissionError);
      if (generation.current === flowGeneration) {
        setOperationError(
          permissionError instanceof Error
            ? permissionError.message
            : '無法啟動來源錄製；現有內容未變更，請再試一次。',
        );
      }
    } finally {
      if (generation.current === flowGeneration) clearPreparedPermission();
    }
  }

  /**
   * The site-agnostic continuation path: instead of reopening the Guide's
   * stored source URL, recording resumes on the most recently used normal web
   * page tab. It sends a plain START_RECORDING (no continuation field), i.e.
   * the popup's contract — the background records the active tab under the
   * grants it already holds, so no host-permission request happens here and
   * the editor still never nominates a source URL.
   */
  async function confirmContinueElsewhere(): Promise<void> {
    const prepared = preparedPermission;
    if (
      !prepared ||
      prepared.action.kind !== 'continuation' ||
      !sessionId ||
      permissionPending ||
      continueElsewherePending ||
      !lock.current ||
      flowSessionId.current !== sessionId
    ) return;
    const flowGeneration = generation.current;
    setContinueElsewherePending(true);
    setContinueElsewhereError(null);
    setOperationError(null);
    // The dialog stays open only for the "no eligible tab" outcome so the user
    // can open a site and retry; every other outcome settles the flow.
    let keepDialogOpen = false;

    try {
      const target = await findLatestRecordableTab();
      if (generation.current !== flowGeneration) return;
      if (!target || target.id == null) {
        keepDialogOpen = true;
        setContinueElsewhereError('找不到可錄製的一般網頁分頁，請先開啟要接續錄製的網站。');
        return;
      }

      try {
        await flushDescriptions();
      } catch {
        // flushDescriptions already surfaced its own localized message; a
        // generic overwrite here would hide which descriptions failed to save.
        return;
      }
      if (generation.current !== flowGeneration) return;

      // The background resolves a plain start against the active tab of the
      // last focused window, so focus the target window and tab first, then
      // confirm the switch actually took before sending the message.
      if (target.windowId != null) {
        await browser.windows.update(target.windowId, { focused: true });
      }
      await browser.tabs.update(target.id, { active: true });
      const confirmed = await browser.tabs.get(target.id);
      if (generation.current !== flowGeneration) return;
      if (!confirmed.active || !isRecordableContinuationTab(confirmed)) {
        throw new Error('無法切換到要錄製的分頁，請再試一次。');
      }

      const started = requireRuntimeMessageResult<StartRecordingResult>(
        await browser.runtime.sendMessage({
          type: 'START_RECORDING',
          sessionId,
          mode: 'steps',
        }),
        isStartRecordingResult,
      );
      if (!started.ok) throw new Error(started.error);
    } catch (continueError) {
      console.error('改在其他頁面接續錄製失敗', continueError);
      if (generation.current === flowGeneration) {
        setOperationError(
          continueError instanceof Error
            ? continueError.message
            : '無法在其他頁面接續錄製；現有內容未變更，請再試一次。',
        );
      }
    } finally {
      if (generation.current === flowGeneration) {
        if (keepDialogOpen) setContinueElsewherePending(false);
        else clearPreparedPermission();
      }
    }
  }

  async function handleRecapture(): Promise<void> {
    if (!sessionId || isDataOperationLocked() || lock.current || operationActive) return;
    const currentEntry = requireSelectedEntry();
    const target: StepRecaptureTarget =
      currentEntry.kind === 'single'
        ? { kind: 'single', stepId: currentEntry.step.id }
        : currentEntry.annotations.length === 1
          ? {
              kind: 'snapshot-singleton',
              anchorId: currentEntry.anchor.id,
              annotationId: currentEntry.annotations[0].id,
            }
          : (() => {
              throw new Error('此快照包含多個標註；更換底圖會使其他框選失效，請重新製作整張快照。');
            })();
    const targetEntryId = entryId(currentEntry);
    const flowGeneration = beginPermissionPreflight(targetEntryId);
    if (flowGeneration == null) return;
    let prepared: PreparedCapturePermission | null = null;
    try {
      const result = requireRuntimeMessageResult<PreflightStepRecaptureSourcePermissionResult>(
        await browser.runtime.sendMessage({
          type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
          sessionId,
          target,
        }),
        isPreflightStepRecaptureSourcePermissionResult,
      );
      if (!result.ok) throw new Error(result.message);
      validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
      prepared = {
        source: { kind: 'origin', sourceOrigin: result.sourceOrigin, permissionPattern: result.permissionPattern },
        entryId: targetEntryId,
        action: { kind: 'recapture', target },
      };
    } catch (recaptureError) {
      console.error('檢查補拍來源失敗', recaptureError);
      if (generation.current === flowGeneration) {
        setOperationError(
          recaptureError instanceof Error
            ? recaptureError.message
            : '無法安全確認補拍來源；原本內容未變更。',
        );
      }
    } finally {
      finishPermissionPreflight(flowGeneration, prepared);
    }
  }

  // Resuming a recording is how missing steps are added: the run reopens the
  // Guide's own source page and appends its captures, so the editor never has
  // to fabricate a step from an unrelated image.
  async function handleContinueRecording(): Promise<void> {
    if (!sessionId || isDataOperationLocked() || lock.current || operationActive) return;
    const flowGeneration = beginPermissionPreflight(null);
    if (flowGeneration == null) return;
    let prepared: PreparedCapturePermission | null = null;
    try {
      const result = requireRuntimeMessageResult<PreflightGuideContinuationSourcePermissionResult>(
        await browser.runtime.sendMessage({
          type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
          sessionId,
        }),
        isPreflightGuideContinuationSourcePermissionResult,
      );
      if (!result.ok) {
        // A Guide without steps has no source page to lock onto. That is not a
        // terminal error: the dialog still opens and offers the site-agnostic
        // 「改在其他頁面接續」 path, which needs no stored source.
        if (result.code !== 'SOURCE_NOT_FOUND') throw new Error(result.message);
        prepared = {
          source: { kind: 'unavailable', reason: result.message },
          entryId: null,
          action: { kind: 'continuation' },
        };
      } else {
        validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
        prepared = {
          source: { kind: 'origin', sourceOrigin: result.sourceOrigin, permissionPattern: result.permissionPattern },
          entryId: null,
          action: { kind: 'continuation' },
        };
      }
    } catch (continuationError) {
      console.error('檢查接續錄製來源失敗', continuationError);
      if (generation.current === flowGeneration) {
        setOperationError(
          continuationError instanceof Error
            ? continuationError.message
            : '無法安全確認接續錄製的來源；現有內容未變更。',
        );
      }
    } finally {
      finishPermissionPreflight(flowGeneration, prepared);
    }
  }

  return {
    preparedPermission,
    permissionPending,
    permissionFlowActive,
    continueElsewherePending,
    continueElsewhereError,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
  };
}

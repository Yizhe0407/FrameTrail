import { useCallback, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { PreparedCapturePermission } from '@/lib/editor/editor-app-model';
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
      !sessionId ||
      permissionPending ||
      !lock.current ||
      flowSessionId.current !== sessionId
    ) return;

    if (prepared.entryId) requireSelectedEntry(prepared.entryId);
    validatePreparedPermissionSource(prepared.sourceOrigin, prepared.permissionPattern);
    const flowGeneration = generation.current;
    setPermissionPending(true);
    setOperationError(null);

    try {
      // This must remain the first asynchronous browser API in this explicit
      // confirmation click so Chromium preserves transient user activation.
      const granted = await browser.permissions.request({ origins: [prepared.permissionPattern] });
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
        sourceOrigin: result.sourceOrigin,
        permissionPattern: result.permissionPattern,
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
      if (!result.ok) throw new Error(result.message);
      validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
      prepared = {
        sourceOrigin: result.sourceOrigin,
        permissionPattern: result.permissionPattern,
        entryId: null,
        action: { kind: 'continuation' },
      };
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
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    handleRecapture,
    handleContinueRecording,
  };
}

import { useCallback, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { ContinuationTabOption, PreparedCapturePermission } from '@/lib/editor/editor-app-model';
import {
  defaultContinuationTab,
  listRecordableTabs,
  validatePreparedPermissionSource,
} from '@/lib/editor/continuation-tabs';
import { MULTI_ANNOTATION_RECAPTURE_BLOCKED } from '@/lib/editor/editor-messages';
import { isRecordableTab } from '@/lib/shared/restricted-urls';
import { focusTab } from '@/lib/runtime/navigation';
import { reportError } from '@/components/shared/report-error';
import { entryId, type StepEntry } from '@/lib/storage/models';
import type {
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  StartRecordingMessage,
  StartRecordingResult,
  StartStepRecaptureResult,
} from '@/lib/runtime/messages';
import type { StepRecaptureTarget } from '@/lib/storage/recording-state';
import {
  isPreflightGuideContinuationSourcePermissionResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isStartRecordingResult,
  isStartStepRecaptureResult,
  requireRuntimeMessageResult,
} from '@/lib/runtime/runtime-message-result';

interface UsePermissionFlowOptions {
  sessionId: string | null;
  operationActive: boolean;
  /** True while a structural data operation holds the editor's data lock. */
  isDataOperationLocked: () => boolean;
  flushDescriptions: () => Promise<void>;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setOperationError: (message: string | null) => void;
}

/** Captured at the start of an asynchronous continuation; `isCurrent()` is
 * re-checked after every await so a cancelled or superseded flow can never
 * apply state or errors for an earlier attempt. */
interface FlowToken {
  isCurrent(): boolean;
}

/**
 * The source-permission state machine for recapture and continuation runs.
 *
 * Invariants preserved from the original inline implementation:
 * - `generation` increments on every begin/clear, and every asynchronous
 *   continuation re-checks it (through its FlowToken) so a cancelled or
 *   superseded flow can never apply state or errors for an earlier attempt.
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
  /** Non-null once the elsewhere path opened its explicit tab picker. */
  const [continuationTabs, setContinuationTabs] = useState<ContinuationTabOption[] | null>(null);
  const [selectedContinuationTabId, setSelectedContinuationTabId] = useState<number | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const flowEntryId = useRef<string | null>(null);
  const flowSessionId = useRef<string | null>(null);
  const permissionFlowActive = preparedPermission !== null || permissionPending;

  const isPermissionFlowLocked = useCallback(() => lock.current, []);

  function tokenFor(flowGeneration: number): FlowToken {
    return { isCurrent: () => generation.current === flowGeneration };
  }

  /** A token for the flow that is current right now (no generation bump). */
  function currentFlowToken(): FlowToken {
    return tokenFor(generation.current);
  }

  const clearPreparedPermission = useCallback(() => {
    generation.current += 1;
    lock.current = false;
    flowEntryId.current = null;
    flowSessionId.current = null;
    setPreparedPermission(null);
    setPermissionPending(false);
    setContinueElsewherePending(false);
    setContinueElsewhereError(null);
    setContinuationTabs(null);
    setSelectedContinuationTabId(null);
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

  /** Whether a new flow may begin: the editor must be viewing a Guide with no
   * data operation, no live run, and no flow already holding the lock. */
  function canBeginFlow(): boolean {
    return Boolean(sessionId) && !isDataOperationLocked() && !lock.current && !operationActive;
  }

  /**
   * Guards shared by every confirm step: a flow must be prepared, current, and
   * not already mid-transition. `kind` additionally requires the shape the
   * caller is about to act on ('origin' source vs continuation action).
   */
  function currentPreparedFlow(kind: 'origin' | 'continuation'): PreparedCapturePermission | null {
    const prepared = preparedPermission;
    if (
      !prepared ||
      !sessionId ||
      permissionPending ||
      continueElsewherePending ||
      !lock.current ||
      flowSessionId.current !== sessionId
    ) {
      return null;
    }
    if (kind === 'origin' && prepared.source.kind !== 'origin') return null;
    if (kind === 'continuation' && prepared.action.kind !== 'continuation') return null;
    return prepared;
  }

  /** Shared failure leg of every flow catch: log under `label`, then surface
   * the (already localized) error message — or `fallback` — unless the flow
   * has been superseded meanwhile. */
  function failFlow(flow: FlowToken, label: string, error: unknown, fallback: string): void {
    const message = reportError(label, error, fallback);
    if (flow.isCurrent()) setOperationError(message);
  }

  /** Flushes pending descriptions before starting a run. Returns false when
   * the flush failed or the flow went stale while flushing. */
  async function flushOrBail(flow: FlowToken): Promise<boolean> {
    try {
      await flushDescriptions();
    } catch {
      // flushDescriptions already surfaced its own localized message; a
      // generic overwrite here would hide which descriptions failed to save.
      return false;
    }
    return flow.isCurrent();
  }

  async function startRecordingOrThrow(message: StartRecordingMessage): Promise<void> {
    const started = requireRuntimeMessageResult<StartRecordingResult>(
      await browser.runtime.sendMessage(message),
      isStartRecordingResult,
    );
    if (!started.ok) throw new Error(started.error);
  }

  function beginPermissionPreflight(entryIdToPrepare: string | null): FlowToken | null {
    if (!canBeginFlow()) return null;
    const nextGeneration = generation.current + 1;
    generation.current = nextGeneration;
    lock.current = true;
    flowEntryId.current = entryIdToPrepare;
    flowSessionId.current = sessionId;
    setPreparedPermission(null);
    setPermissionPending(true);
    setOperationError(null);
    return tokenFor(nextGeneration);
  }

  function finishPermissionPreflight(flow: FlowToken, prepared: PreparedCapturePermission | null): void {
    if (!flow.isCurrent()) return;
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
    const prepared = currentPreparedFlow('origin');
    if (!prepared || prepared.source.kind !== 'origin' || !sessionId) return;

    const flow = currentFlowToken();
    setPermissionPending(true);
    setOperationError(null);

    try {
      // Callers void this promise, so guard throws must stay inside the try
      // to surface through setOperationError instead of an unhandled rejection.
      if (prepared.entryId) requireSelectedEntry(prepared.entryId);
      validatePreparedPermissionSource(prepared.source.sourceOrigin, prepared.source.permissionPattern);
      // The synchronous guards above are fine, but this must remain the first
      // asynchronous browser API in this explicit confirmation click so
      // Chromium preserves transient user activation.
      const granted = await browser.permissions.request({ origins: [prepared.source.permissionPattern] });
      if (!flow.isCurrent()) return;
      if (!granted) throw new Error('需要允許存取來源網站，才能回到該頁面錄製。');

      if (!(await flushOrBail(flow))) return;
      if (prepared.action.kind === 'continuation') {
        await startRecordingOrThrow({
          type: 'START_RECORDING',
          sessionId,
          mode: 'steps',
          continuation: {},
        });
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
      failFlow(flow, '授權並啟動來源錄製失敗', permissionError, '無法啟動來源錄製；現有內容未變更，請再試一次。');
    } finally {
      if (flow.isCurrent()) clearPreparedPermission();
    }
  }

  /**
   * First elsewhere step: list the open recordable tabs so the user picks the
   * target explicitly. Recency auto-picking is deliberately gone — it kept
   * choosing the tab the user had just recorded. The most recent tab whose URL
   * differs from the Guide's last step is preselected instead.
   */
  async function openContinueElsewhere(): Promise<void> {
    const prepared = currentPreparedFlow('continuation');
    if (!prepared) return;
    const flow = currentFlowToken();
    setContinueElsewherePending(true);
    setContinueElsewhereError(null);
    setOperationError(null);

    try {
      const tabs = await listRecordableTabs();
      if (!flow.isCurrent()) return;
      if (tabs.length === 0) {
        setContinuationTabs(null);
        setSelectedContinuationTabId(null);
        setContinueElsewhereError('找不到可錄製的一般網頁分頁，請先開啟要接續錄製的網站。');
        return;
      }
      const lastStepUrl = prepared.source.kind === 'origin' ? prepared.source.sourceUrl : null;
      setContinuationTabs(tabs);
      setSelectedContinuationTabId(defaultContinuationTab(tabs, lastStepUrl)?.id ?? null);
    } catch (listError) {
      console.error('列出可接續錄製的分頁失敗', listError);
      if (flow.isCurrent()) {
        setContinueElsewhereError('無法讀取目前開啟的分頁，請再試一次。');
      }
    } finally {
      if (flow.isCurrent()) setContinueElsewherePending(false);
    }
  }

  /**
   * Second elsewhere step, after an explicit pick: focus the chosen tab and
   * send a plain START_RECORDING (no continuation field), i.e. the popup's
   * contract — the background records the active tab under the grants it
   * already holds, so no host-permission request happens here and the editor
   * still never nominates a source URL. With follow-mode recording the user
   * can freely switch tabs once the run is live.
   */
  async function confirmContinueElsewhere(): Promise<void> {
    if (!currentPreparedFlow('continuation')) return;
    const target = continuationTabs?.find((tab) => tab.id === selectedContinuationTabId) ?? null;
    if (!target) return;
    const flow = currentFlowToken();
    setContinueElsewherePending(true);
    setContinueElsewhereError(null);
    setOperationError(null);
    // The dialog stays open only for the "picked tab disappeared" outcome so
    // the user can pick another tab; every other outcome settles the flow.
    let keepDialogOpen = false;

    try {
      if (!(await flushOrBail(flow))) return;

      // The background resolves a plain start against the active tab of the
      // last focused window, so activate the target tab and focus its window
      // first, then confirm the switch actually took before sending the
      // message. Ordering within focusTab does not matter here: only the
      // combined end state (tab active in its now-focused window) does, and
      // tabs.get re-checks it either way.
      let confirmed: Browser.tabs.Tab;
      try {
        await focusTab(target.id, target.windowId);
        confirmed = await browser.tabs.get(target.id);
      } catch (switchError) {
        // The picked tab closed while the dialog was open. Refresh the list in
        // place instead of settling the flow on a stale choice.
        console.warn('切換到選取的接續分頁失敗', switchError);
        if (flow.isCurrent()) {
          keepDialogOpen = true;
          setContinueElsewherePending(false);
          await openContinueElsewhere();
        }
        return;
      }
      if (!flow.isCurrent()) return;
      if (!confirmed.active || !isRecordableTab(confirmed)) {
        throw new Error('無法切換到要錄製的分頁，請再試一次。');
      }

      await startRecordingOrThrow({
        type: 'START_RECORDING',
        sessionId: sessionId!,
        mode: 'steps',
      });
    } catch (continueError) {
      failFlow(flow, '改在其他頁面接續錄製失敗', continueError, '無法在其他頁面接續錄製；現有內容未變更，請再試一次。');
    } finally {
      if (flow.isCurrent() && !keepDialogOpen) clearPreparedPermission();
    }
  }

  async function handleRecapture(): Promise<void> {
    if (!canBeginFlow()) return;
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
              throw new Error(MULTI_ANNOTATION_RECAPTURE_BLOCKED);
            })();
    const targetEntryId = entryId(currentEntry);
    const flow = beginPermissionPreflight(targetEntryId);
    if (flow == null) return;
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
        source: {
          kind: 'origin',
          sourceOrigin: result.sourceOrigin,
          permissionPattern: result.permissionPattern,
          sourceUrl: result.sourceUrl,
        },
        entryId: targetEntryId,
        action: { kind: 'recapture', target },
      };
    } catch (recaptureError) {
      failFlow(flow, '檢查補拍來源失敗', recaptureError, '無法安全確認補拍來源；原本內容未變更。');
    } finally {
      finishPermissionPreflight(flow, prepared);
    }
  }

  // Resuming a recording is how missing steps are added: the run reopens the
  // Guide's own source page and appends its captures, so the editor never has
  // to fabricate a step from an unrelated image.
  async function handleContinueRecording(): Promise<void> {
    if (!canBeginFlow()) return;
    const flow = beginPermissionPreflight(null);
    if (flow == null) return;
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
          source: {
            kind: 'origin',
            sourceOrigin: result.sourceOrigin,
            permissionPattern: result.permissionPattern,
            sourceUrl: result.sourceUrl,
          },
          entryId: null,
          action: { kind: 'continuation' },
        };
      }
    } catch (continuationError) {
      failFlow(flow, '檢查接續錄製來源失敗', continuationError, '無法安全確認接續錄製的來源；現有內容未變更。');
    } finally {
      finishPermissionPreflight(flow, prepared);
    }
  }

  return {
    preparedPermission,
    permissionPending,
    permissionFlowActive,
    continueElsewherePending,
    continueElsewhereError,
    continuationTabs,
    selectedContinuationTabId,
    selectContinuationTab: setSelectedContinuationTabId,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    openContinueElsewhere,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
  };
}

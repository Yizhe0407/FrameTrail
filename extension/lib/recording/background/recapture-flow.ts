import { browser, type Browser } from 'wxt/browser';
import { StaleCaptureError, waitForQueuedClicks } from '../background-queues';
import { getRecordingState } from '../../storage/storage';
import {
  getEffectiveBounds,
  getStep,
  getSteps,
  replaceStepCaptureAtomically,
  StepRecaptureError,
  stepRole,
  type StepRecaptureTarget as DbStepRecaptureTarget,
} from '../../storage/db';
import { isTrustedRecaptureSourceSender } from '../../capture/recapture-guards';
import { focusTab } from '../../runtime/navigation';
import {
  checkSourcePermission,
  isEditorSenderForSession,
  openVerifiedSourceTab,
  SOURCE_TAB_OPEN_FAILED_MESSAGE,
  sourcePermissionPreflightSuccess,
  withUncommittedSourceTab,
} from './source-tab';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  isCaptureCommitting,
  markCaptureCommitting,
  releaseCapture,
} from './capture-registry';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';
import type {
  AckStepRecaptureResultMessage,
  CancelStepRecaptureMessage,
  CancelStepRecaptureResult,
  ClickCapture,
  FocusStepRecaptureSourceMessage,
  FocusStepRecaptureSourceResult,
  FrameTrailRecaptureReadyMessage,
  FrameTrailRecaptureTargetMessage,
  PreflightStepRecaptureSourcePermissionErrorCode,
  PreflightStepRecaptureSourcePermissionMessage,
  PreflightStepRecaptureSourcePermissionResult,
  StartStepRecaptureMessage,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from '../../runtime/messages';
import type { RecordingState, StepRecaptureResult } from '../../storage/recording-state';

// Exported: startRecording rejects with the same wording when the single
// capture-operation slot is taken.
export const ACTIVE_OPERATION_MESSAGE = '目前已有錄製或補拍正在進行。';
const OPERATION_CHANGED_MESSAGE = '操作狀態已改變，請再試一次。';
const RECAPTURE_SOURCE_REDIRECTED_MESSAGE = '原始頁面已重新導向，未開始補拍。';
const RESTRICTED_RECAPTURE_SOURCE_MESSAGE = '此來源頁面不允許補拍。';
const EDITOR_ONLY_RECAPTURE_PREFLIGHT_MESSAGE = '只能從目前 Guide 的 FrameTrail 編輯器驗證補拍來源。';
const EDITOR_ONLY_RECAPTURE_START_MESSAGE = '只能從 FrameTrail 編輯器啟動補拍。';
const EDITOR_ONLY_GUIDE_RECAPTURE_START_MESSAGE = '只能從目前 Guide 的 FrameTrail 編輯器啟動補拍。';

type ValidatedRecaptureTarget = {
  target: DbStepRecaptureTarget;
  entryId: string;
  sourceUrl: string;
};

type StepRecaptureValidationErrorCode = Exclude<
  PreflightStepRecaptureSourcePermissionErrorCode,
  'INVALID_EDITOR' | 'RESTRICTED_SOURCE'
>;

class StepRecaptureStartError extends Error {
  constructor(
    readonly code: StepRecaptureValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StepRecaptureStartError';
  }
}

function recaptureFailure(
  code: Exclude<StartStepRecaptureResult, { ok: true }>['code'],
  error: string,
): StartStepRecaptureResult {
  return { ok: false, code, error };
}

function isRecaptureSourceSender(
  sender: Browser.runtime.MessageSender,
  context: NonNullable<RecordingState['recapture']>,
): boolean {
  return isTrustedRecaptureSourceSender(sender, context);
}

function recapturePreflightFailure(
  code: Exclude<PreflightStepRecaptureSourcePermissionResult, { ok: true }>['code'],
  message: string,
): PreflightStepRecaptureSourcePermissionResult {
  return { ok: false, code, message };
}

async function validateRecaptureTarget(
  sessionId: string,
  target: StartStepRecaptureMessage['target'],
): Promise<ValidatedRecaptureTarget> {
  if (target.kind === 'single') {
    const step = await getStep(target.stepId);
    if (!step || step.sessionId !== sessionId) {
      throw new StepRecaptureStartError('TARGET_NOT_FOUND', '找不到要補拍的步驟。');
    }
    if (step.groupId || !step.screenshotBlob || !getEffectiveBounds(step)) {
      throw new StepRecaptureStartError('TARGET_CHANGED', '此步驟已變更，請重新整理編輯器後再試一次。');
    }
    return { target, entryId: step.id, sourceUrl: step.url };
  }

  const [anchor, annotation, steps] = await Promise.all([
    getStep(target.anchorId),
    getStep(target.annotationId),
    getSteps(sessionId),
  ]);
  if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
    throw new StepRecaptureStartError('TARGET_NOT_FOUND', '找不到要補拍的快照。');
  }
  if (
    stepRole(anchor) !== 'anchor' ||
    annotation.groupId !== anchor.id ||
    stepRole(annotation) !== 'annotation' ||
    !anchor.screenshotBlob ||
    !getEffectiveBounds(annotation)
  ) {
    throw new StepRecaptureStartError('TARGET_CHANGED', '快照結構已變更，請重新整理編輯器後再試一次。');
  }
  const annotations = steps.filter(
    (step) => step.groupId === anchor.id && stepRole(step) === 'annotation' && getEffectiveBounds(step),
  );
  if (annotations.length !== 1 || annotations[0].id !== annotation.id) {
    throw new StepRecaptureStartError(
      'UNSUPPORTED_SNAPSHOT_GROUP',
      '此快照包含多個標註；更換底圖會使其他標註失效，請改用重拍整張快照。',
    );
  }
  return { target, entryId: anchor.id, sourceUrl: anchor.url };
}

async function returnToRecaptureEditor(context: RecordingState['recapture']): Promise<void> {
  if (!context) return;
  try {
    await focusTab(context.editorTabId, context.editorWindowId);
    return;
  } catch {
    // The initiating editor was closed. Reuse another editor or recreate it.
  }
  const editorBase = browser.runtime.getURL('/editor.html');
  const [existing] = await browser.tabs.query({ url: `${editorBase}*` });
  if (existing?.id != null) {
    await focusTab(existing.id, existing.windowId);
    return;
  }
  const editorUrl = new URL(editorBase);
  editorUrl.searchParams.set('sessionId', context.sessionId);
  editorUrl.searchParams.set('entryId', context.entryId);
  editorUrl.searchParams.set('recaptureRunId', context.runId);
  await browser.tabs.create({ url: editorUrl.href, active: true });
}

async function wasRecaptureCommitted(context: NonNullable<RecordingState['recapture']>): Promise<boolean> {
  const ownerId = context.target.kind === 'single' ? context.target.stepId : context.target.anchorId;
  const owner = await getStep(ownerId);
  return owner?.sessionId === context.sessionId && owner.lastCaptureRunId === context.runId;
}

async function isRecaptureSourceTabIntact(
  context: NonNullable<RecordingState['recapture']>,
): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(context.sourceTabId);
    // Recapture required a host permission grant for the source origin, so the
    // URL is readable whenever the tab still shows the page selection armed on.
    return tab.url === context.sourceUrl;
  } catch {
    return false;
  }
}

export interface RecaptureFlowDeps {
  control: ControlPlane;
  runtime: RecorderRuntime;
  /** The serialized, presentation-aware screenshot pipeline shared with step
   * capture; the flow supplies its own recapture context assertion. The
   * cancellation/commit markers both flows share live in capture-registry. */
  captureScreenshotWithGuard(
    message: Pick<ClickCapture, 'viewport' | 'devicePixelRatio' | 'captureId'>,
    tabId: number,
    windowId: number,
    assertContext: () => Promise<void>,
  ): Promise<{ blob: Blob; scale: number }>;
}

/**
 * The one-shot step/snapshot recapture flow: preflight, start, target capture,
 * settle, and its startup/interruption recovery. All persisted state lives in
 * RecordingState.recapture; this module privately owns only the start mutex
 * and the id of the capture currently in flight.
 */
export function createRecaptureFlow(deps: RecaptureFlowDeps) {
  const { control, runtime } = deps;

  // A dedicated start mutex instead of queueLifecycle: the recapture start
  // holds it across a ready-gate wait of up to RECORDER_READY_TIMEOUT_MS, and
  // queueing that behind START/STOP would let one hung start delay every
  // lifecycle control. The mutex only needs to serialize concurrent recapture
  // starts — everything else is guarded by the persisted single-owner state.
  let startingRecapture = false;
  let activeRecaptureCaptureId: string | null = null;

  async function settleStepRecapture(
    runId: string,
    status: StepRecaptureResult['status'],
    version: number,
    errorCode?: string,
    message?: string,
  ): Promise<boolean> {
    const settled = await control.writeStateIf(
      version,
      (current) => current.operation === 'recapture' && current.recapture?.runId === runId,
      (current) => {
        const recapture = current.recapture!;
        const result: StepRecaptureResult = {
          runId,
          status,
          sessionId: recapture.sessionId,
          entryId: recapture.entryId,
          ...(errorCode ? { errorCode } : {}),
          ...(message ? { message } : {}),
          completedAt: Date.now(),
        };
        // Not resetRunStateToIdle: settling a recapture deliberately leaves the
        // run-scoped counters it never owned (itemCount &c.) untouched — state
        // normalization already governs how they read outside a recording run.
        return {
          ...current,
          operation: null,
          isRecording: false,
          phase: 'idle',
          tabId: null,
          runId: null,
          recapture: null,
          recaptureResult: result,
          error: status === 'failed' ? message ?? '補拍失敗。' : null,
          recoverableError: null,
        };
      },
    );
    if (!settled) return false;
    const context = settled.previous.recapture!;
    activeRecaptureCaptureId = null;
    await runtime.stopRecorderInTab(context.sourceTabId);
    if (context.sourceTabCreated) {
      await browser.tabs.remove(context.sourceTabId).catch((error) => {
        console.warn('[frametrail] failed to close temporary recapture tab', error);
      });
    }
    try {
      await returnToRecaptureEditor(context);
    } catch (error) {
      console.error('[frametrail] failed to return to editor after recapture', error);
    }
    return true;
  }

  function failStepRecapture(
    runId: string,
    errorCode: string,
    message: string,
    expectedControlVersion: number,
  ): Promise<boolean> {
    if (expectedControlVersion !== control.controlVersion) return Promise.resolve(false);
    if (activeRecaptureCaptureId) cancelCapture(activeRecaptureCaptureId);
    const version = control.claimControl({ cancelRecaptureGate: true });
    return settleStepRecapture(runId, 'failed', version, errorCode, message);
  }

  /**
   * MV3 may terminate the service worker between capture and durable result
   * handoff. A persisted capture marker lets startup distinguish a committed
   * replacement from abandoned in-flight work instead of leaving the editor
   * permanently locked in recapture mode.
   */
  async function recoverInterruptedRecapture(): Promise<void> {
    const state = await getRecordingState();
    const context = state.recapture;
    if (state.operation !== 'recapture' || !context) return;

    if (context.phase === 'awaiting-target') {
      // Selection mode survives ordinary worker restarts — the injected recorder
      // lives on in the source tab. A browser restart, however, reissues tab
      // ids: the persisted sourceTabId then names nothing or an unrelated page,
      // and the claimed single-owner slot would block every future operation.
      if (await isRecaptureSourceTabIntact(context)) return;
      const version = control.claimControl({});
      await settleStepRecapture(
        context.runId,
        'failed',
        version,
        'SOURCE_TAB_CLOSED',
        '補拍已停止，因為原始分頁已關閉或已變更。原本內容未變更。',
      );
      return;
    }

    const committed = context.phase === 'capturing' && await wasRecaptureCommitted(context);
    const version = control.claimControl({});
    if (committed) {
      await settleStepRecapture(context.runId, 'replaced', version);
      return;
    }
    await settleStepRecapture(
      context.runId,
      'failed',
      version,
      'WORKER_RESTARTED',
      '補拍流程曾中斷，原本內容未變更；請重新補拍。',
    );
  }

  /**
   * Recapture leg of the tabs.onUpdated listener (which stays wired in the
   * background entrypoint, mirroring follow-mode's listener/logic split).
   * Returns true when the update belonged to this flow's source tab — handled
   * or deliberately ignored — so the listener skips its recording legs.
   */
  async function handleSourceTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
  ): Promise<boolean> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.sourceTabId !== tabId
    ) {
      return false;
    }
    const context = state.recapture;
    // Startup intentionally waits for the initial document to finish. Once
    // selection is enabled, any navigation invalidates this one-shot job.
    if (
      context.phase !== 'starting' &&
      (changeInfo.status === 'loading' || (changeInfo.url != null && changeInfo.url !== context.sourceUrl))
    ) {
      await failStepRecapture(
        context.runId,
        'SOURCE_NAVIGATED',
        '補拍已停止，因為原始頁面在選取期間發生導覽。原本內容未變更。',
        expectedControlVersion,
      );
    }
    return true;
  }

  /** Recapture leg of tabs.onRemoved; same contract as handleSourceTabUpdated. */
  async function handleSourceTabRemoved(tabId: number): Promise<boolean> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.sourceTabId !== tabId
    ) {
      return false;
    }
    await failStepRecapture(
      state.recapture.runId,
      'SOURCE_TAB_CLOSED',
      '補拍已停止，因為原始分頁已關閉。原本內容未變更。',
      expectedControlVersion,
    );
    return true;
  }

  async function handleRecaptureReady(
    message: FrameTrailRecaptureReadyMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    const context = (await getRecordingState()).recapture;
    if (
      !context ||
      context.runId !== message.runId ||
      context.phase !== 'starting' ||
      !isRecaptureSourceSender(sender, context) ||
      message.url !== context.sourceUrl
    ) {
      return false;
    }
    return control.pendingRecaptureReady?.signal({
      runId: message.runId,
      tabId: context.sourceTabId,
      controlVersion: control.controlVersion,
    }) ?? false;
  }

  async function preflightStepRecaptureSourcePermission(
    message: PreflightStepRecaptureSourcePermissionMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<PreflightStepRecaptureSourcePermissionResult> {
    // The message shape (including the target) was already validated by the
    // canonical isBackgroundMessage guard at listener entry; only the trust
    // relationship between this editor and the session remains to check here.
    if (
      typeof message.sessionId !== 'string' ||
      message.sessionId.trim().length === 0 ||
      !isEditorSenderForSession(sender, message.sessionId)
    ) {
      return recapturePreflightFailure('INVALID_EDITOR', EDITOR_ONLY_RECAPTURE_PREFLIGHT_MESSAGE);
    }

    let validated: ValidatedRecaptureTarget;
    try {
      validated = await validateRecaptureTarget(message.sessionId, message.target);
    } catch (error) {
      if (error instanceof StepRecaptureStartError) {
        return recapturePreflightFailure(error.code, error.message);
      }
      throw error;
    }

    return (
      sourcePermissionPreflightSuccess(validated.sourceUrl) ??
      recapturePreflightFailure('RESTRICTED_SOURCE', RESTRICTED_RECAPTURE_SOURCE_MESSAGE)
    );
  }

  async function handleStartStepRecapture(
    message: StartStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
    version: number,
  ): Promise<StartStepRecaptureResult> {
    await waitForQueuedClicks();
    if (version !== control.controlVersion) return recaptureFailure('ACTIVE_OPERATION', OPERATION_CHANGED_MESSAGE);

    const editorTab = sender.tab;
    if (!isEditorSenderForSession(sender, message.sessionId) || editorTab?.id == null) {
      return recaptureFailure('INVALID_EDITOR', EDITOR_ONLY_RECAPTURE_START_MESSAGE);
    }
    const current = await getRecordingState();
    if (current.operation !== null || current.isRecording) {
      return recaptureFailure('ACTIVE_OPERATION', ACTIVE_OPERATION_MESSAGE);
    }

    let validated: ValidatedRecaptureTarget;
    try {
      validated = await validateRecaptureTarget(message.sessionId, message.target);
    } catch (error) {
      if (error instanceof StepRecaptureStartError) return recaptureFailure(error.code, error.message);
      throw error;
    }
    const permission = await checkSourcePermission(validated.sourceUrl);
    if (permission === 'restricted') {
      return recaptureFailure('RESTRICTED_SOURCE', RESTRICTED_RECAPTURE_SOURCE_MESSAGE);
    }
    if (permission === 'permission-required') {
      return recaptureFailure('HOST_PERMISSION_REQUIRED', '需要先允許 FrameTrail 存取此網站，才能補拍。');
    }

    const opened = await openVerifiedSourceTab(
      validated.sourceUrl,
      message.preferredTabId,
      'failed to open recapture source tab',
    );
    if (!opened.ok) {
      return recaptureFailure(
        'SOURCE_TAB_FAILED',
        opened.reason === 'open-failed' ? SOURCE_TAB_OPEN_FAILED_MESSAGE : RECAPTURE_SOURCE_REDIRECTED_MESSAGE,
      );
    }
    const source = opened.source;
    const sourceTab = source.tab;

    return withUncommittedSourceTab(source, async (commit) => {
      if (sourceTab.id == null || sourceTab.windowId == null) {
        return recaptureFailure('SOURCE_TAB_FAILED', RECAPTURE_SOURCE_REDIRECTED_MESSAGE);
      }
      if (version !== control.controlVersion) {
        return recaptureFailure('ACTIVE_OPERATION', OPERATION_CHANGED_MESSAGE);
      }

      const runId = crypto.randomUUID();
      const recapture = {
        runId,
        sessionId: message.sessionId,
        target: validated.target,
        entryId: validated.entryId,
        phase: 'starting' as const,
        editorTabId: editorTab.id!,
        editorWindowId: editorTab.windowId ?? null,
        sourceTabId: sourceTab.id,
        sourceWindowId: sourceTab.windowId,
        sourceUrl: validated.sourceUrl,
        sourceTabCreated: !source.reused,
        startedAt: Date.now(),
      };
      const started = await control.writeStateForControl(version, (state) => ({
        ...state,
        operation: 'recapture',
        isRecording: false,
        phase: 'idle',
        sessionId: message.sessionId,
        tabId: null,
        runId: null,
        error: null,
        recoverableError: null,
        recapture,
        recaptureResult: null,
      }));
      if (!started) {
        return recaptureFailure('ACTIVE_OPERATION', OPERATION_CHANGED_MESSAGE);
      }
      // From here the persisted recapture context owns the tab; failure paths
      // settle through failStepRecapture, which closes a created tab itself.
      commit();

      try {
        return await control.withRecorderReadyGate({
          slot: 'pendingRecaptureReady',
          identity: { runId, tabId: sourceTab.id, controlVersion: version },
          inject: () => runtime.injectRecorder(sourceTab.id!, true),
          notReadyError: () => new Error('Recapture recorder did not become ready before timeout.'),
          ready: async () => {
            const activated = await control.writeStateIf(
              version,
              (state) =>
                state.operation === 'recapture' &&
                state.recapture?.runId === runId &&
                state.recapture.phase === 'starting',
              (state) => ({
                ...state,
                recapture: { ...state.recapture!, phase: 'awaiting-target' },
              }),
            );
            if (!activated) throw new StaleCaptureError('Recapture changed during startup.');
            control.acceptingClicks = true;
            await focusTab(sourceTab.id!, sourceTab.windowId);
            return { ok: true as const, runId, tabId: sourceTab.id!, reusedTab: source.reused };
          },
        });
      } catch (error) {
        console.error('[frametrail] failed to start recapture recorder', error);
        if (version === control.controlVersion) {
          await failStepRecapture(runId, 'INJECTION_FAILED', '無法在原始頁面啟動補拍。', version);
        }
        return recaptureFailure('INJECTION_FAILED', '無法在原始頁面啟動補拍。');
      }
    });
  }

  async function startStepRecapture(
    message: StartStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<StartStepRecaptureResult> {
    if (!isEditorSenderForSession(sender, message.sessionId)) {
      return recaptureFailure('INVALID_EDITOR', EDITOR_ONLY_GUIDE_RECAPTURE_START_MESSAGE);
    }
    if (startingRecapture) return recaptureFailure('ACTIVE_OPERATION', '目前已有補拍正在啟動。');
    startingRecapture = true;
    try {
      const current = await getRecordingState();
      if (current.operation !== null || current.isRecording) {
        return recaptureFailure('ACTIVE_OPERATION', ACTIVE_OPERATION_MESSAGE);
      }
      const version = control.claimControl({
        cancelRecorderGate: true,
        cancelRecaptureGate: true,
        discardUndo: true,
      });
      return await handleStartStepRecapture(message, sender, version);
    } finally {
      startingRecapture = false;
    }
  }

  async function cancelStepRecapture(
    message: CancelStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<CancelStepRecaptureResult> {
    const state = await getRecordingState();
    if (state.recaptureResult?.runId === message.runId) return { ok: true, status: 'already-completed' };
    if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
      return { ok: false, error: '這次補拍已經結束。' };
    }
    const context = state.recapture;
    if (!isEditorSenderForSession(sender, context.sessionId) && !isRecaptureSourceSender(sender, context)) {
      return { ok: false, error: '無效的補拍來源。' };
    }
    const captureId = activeRecaptureCaptureId;
    if (captureId && isCaptureCommitting(captureId)) {
      await waitForQueuedClicks();
      return { ok: true, status: 'already-completed' };
    }
    if (captureId) cancelCapture(captureId);
    const version = control.claimControl({ cancelRecaptureGate: true });
    await waitForQueuedClicks();
    // 原本內容 (not 原內容) matches the editor's own recapture wording.
    const settled = await settleStepRecapture(message.runId, 'cancelled', version, 'CANCELLED', '已取消補拍，原本內容未變更。');
    return settled ? { ok: true, status: 'cancelled' } : { ok: true, status: 'already-completed' };
  }

  async function ackStepRecaptureResult(
    message: AckStepRecaptureResultMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    if (!isEditorSenderForSession(sender, message.sessionId)) return false;
    const acknowledged = await control.writeStateIf(
      null,
      (state) =>
        state.recaptureResult?.runId === message.runId &&
        state.recaptureResult.sessionId === message.sessionId,
      (state) => ({ ...state, recaptureResult: null }),
    );
    return acknowledged !== null;
  }

  async function focusStepRecaptureSource(
    message: FocusStepRecaptureSourceMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<FocusStepRecaptureSourceResult> {
    const state = await getRecordingState();
    if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
      return { ok: false, error: '這次補拍已經結束。' };
    }
    if (!isEditorSenderForSession(sender, state.recapture.sessionId)) {
      return { ok: false, error: '無效的編輯器來源。' };
    }
    try {
      await focusTab(state.recapture.sourceTabId, state.recapture.sourceWindowId);
      return { ok: true };
    } catch {
      return { ok: false, error: '找不到補拍分頁。' };
    }
  }

  // Intentionally not routed through getCaptureGuardFailure: recapture identity
  // lives in state.recapture (sourceTabId/sourceWindowId/sourceUrl), which the
  // guard's recording-run fields cannot express, and this check is stricter
  // about an unreadable active-tab URL (it fails instead of passing).
  async function assertRecaptureCaptureContext(
    expectedControlVersion: number,
    runId: string,
    tabId: number,
    windowId: number,
    expectedUrl: string,
  ): Promise<void> {
    if (expectedControlVersion !== control.controlVersion) {
      throw new StaleCaptureError('Recapture control changed before the screenshot could be taken.');
    }
    const state = await getRecordingState();
    const [activeTab] = await browser.tabs.query({ active: true, windowId });
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.runId !== runId ||
      state.recapture.sourceTabId !== tabId ||
      state.recapture.sourceWindowId !== windowId ||
      state.recapture.sourceUrl !== expectedUrl
    ) {
      throw new StaleCaptureError('Recapture changed before the screenshot could be taken.');
    }
    if (activeTab?.id !== tabId) throw new Error('補拍失敗：原始頁面已不是目前作用中的分頁。');
    if (activeTab.url !== expectedUrl) throw new Error('補拍失敗：原始頁面已變更。');
  }

  async function handleRecaptureTarget(
    message: FrameTrailRecaptureTargetMessage,
    sender: Browser.runtime.MessageSender,
    expectedControlVersion: number,
  ): Promise<StepRecaptureTargetResult> {
    const reject = (status: 'rejected' | 'cancelled' | 'failed', error?: string): StepRecaptureTargetResult => ({
      ok: false,
      status,
      ...(error ? { error } : {}),
    });
    if (expectedControlVersion !== control.controlVersion) return reject('rejected');
    const state = await getRecordingState();
    const context = state.recapture;
    if (
      state.operation !== 'recapture' ||
      !context ||
      context.runId !== message.runId ||
      context.phase !== 'awaiting-target' ||
      !isRecaptureSourceSender(sender, context) ||
      message.url !== context.sourceUrl
    ) {
      return reject('rejected');
    }
    if (!control.acceptingClicks || activeRecaptureCaptureId) return reject('rejected');
    const claimed = await control.writeStateIf(
      expectedControlVersion,
      (current) =>
        current.operation === 'recapture' &&
        current.recapture?.runId === message.runId &&
        current.recapture.phase === 'awaiting-target',
      (current) => ({
        ...current,
        recapture: { ...current.recapture!, phase: 'capturing' },
      }),
    );
    if (!claimed) return reject('rejected');
    // Claim globals only after both sender and persisted context validation. An
    // old or forged content-script message must not consume the one-shot slot.
    control.acceptingClicks = false;
    activeRecaptureCaptureId = message.captureId;

    try {
      const captured = await deps.captureScreenshotWithGuard(
        message,
        context.sourceTabId,
        context.sourceWindowId,
        () =>
          assertRecaptureCaptureContext(
            expectedControlVersion,
            message.runId,
            context.sourceTabId,
            context.sourceWindowId,
            context.sourceUrl,
          ),
      );
      assertCaptureNotCancelled(message.captureId);
      const current = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        current.operation !== 'recapture' ||
        current.recapture?.runId !== message.runId ||
        current.recapture.phase !== 'capturing'
      ) {
        throw new StaleCaptureError('Recapture changed before the replacement transaction.');
      }

      // Synchronous commit marker: cancellation after this point waits for the
      // atomic IndexedDB replacement and reports the completed result.
      markCaptureCommitting(message.captureId);
      await replaceStepCaptureAtomically(
        context.sessionId,
        context.target,
        {
          screenshotBlob: captured.blob,
          bounds: message.rect,
          devicePixelRatio: message.devicePixelRatio,
          screenshotScale: captured.scale,
          url: message.url,
          timestamp: message.timestamp,
        },
        message.runId,
      );
      const version = control.bumpVersion();
      await settleStepRecapture(message.runId, 'replaced', version);
      return { ok: true, status: 'replaced' };
    } catch (error) {
      if (error instanceof StaleCaptureError) return reject('cancelled');
      const errorCode = error instanceof StepRecaptureError ? error.code : 'CAPTURE_FAILED';
      const errorMessage =
        error instanceof StepRecaptureError
          ? error.message
          : error instanceof Error
            ? error.message
            // 原本內容 (not 原內容) matches the editor's own recapture wording.
            : '補拍失敗，原本內容未變更。';
      console.error('[frametrail] failed to replace step capture', error);
      if (expectedControlVersion === control.controlVersion) {
        const version = control.bumpVersion();
        await settleStepRecapture(message.runId, 'failed', version, errorCode, errorMessage);
      }
      return reject('failed', errorMessage);
    } finally {
      releaseCapture(message.captureId);
      if (activeRecaptureCaptureId === message.captureId) activeRecaptureCaptureId = null;
    }
  }

  return {
    /** Read by START_RECORDING and RESET_GUIDE: their single-owner check must
     * also cover a recapture start that has not published state yet. */
    isStartingRecapture: () => startingRecapture,
    preflightStepRecaptureSourcePermission,
    startStepRecapture,
    cancelStepRecapture,
    ackStepRecaptureResult,
    focusStepRecaptureSource,
    handleRecaptureReady,
    handleRecaptureTarget,
    handleSourceTabUpdated,
    handleSourceTabRemoved,
    failStepRecapture,
    recoverInterruptedRecapture,
  };
}

export type RecaptureFlow = ReturnType<typeof createRecaptureFlow>;

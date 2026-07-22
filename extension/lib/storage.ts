import { browser, type Browser } from 'wxt/browser';
import {
  RECORDING_STATE_KEY,
  type RecordingState,
  type StepRecaptureContext,
  type StepRecaptureResult,
  type StepRecaptureTarget,
} from './messages';

const DEFAULT_STATE: RecordingState = {
  operation: null,
  isRecording: false,
  phase: 'idle',
  sessionId: null,
  tabId: null,
  error: null,
  recoverableError: null,
  mode: 'steps',
  itemCount: 0,
  numbered: true,
  groupAnchorId: null,
  runId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
  recapture: null,
  recaptureResult: null,
};

export function createDefaultRecordingState(): RecordingState {
  return { ...DEFAULT_STATE };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeRecaptureTarget(value: unknown): StepRecaptureTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<StepRecaptureTarget> & Record<string, unknown>;
  if (target.kind === 'single' && isNonEmptyString(target.stepId)) {
    return { kind: 'single', stepId: target.stepId };
  }
  if (
    target.kind === 'snapshot-singleton' &&
    isNonEmptyString(target.anchorId) &&
    isNonEmptyString(target.annotationId) &&
    target.anchorId !== target.annotationId
  ) {
    return {
      kind: 'snapshot-singleton',
      anchorId: target.anchorId,
      annotationId: target.annotationId,
    };
  }
  return null;
}

function normalizeRecaptureContext(value: unknown): StepRecaptureContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as Partial<StepRecaptureContext>;
  const target = normalizeRecaptureTarget(context.target);
  if (
    !target ||
    !isNonEmptyString(context.runId) ||
    !isNonEmptyString(context.sessionId) ||
    !isNonEmptyString(context.entryId) ||
    !['starting', 'awaiting-target', 'capturing'].includes(context.phase ?? '') ||
    !Number.isSafeInteger(context.editorTabId) ||
    (context.editorWindowId !== null && !Number.isSafeInteger(context.editorWindowId)) ||
    !Number.isSafeInteger(context.sourceTabId) ||
    !Number.isSafeInteger(context.sourceWindowId) ||
    !isNonEmptyString(context.sourceUrl) ||
    typeof context.sourceTabCreated !== 'boolean' ||
    !Number.isFinite(context.startedAt)
  ) {
    return null;
  }
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    target,
    entryId: context.entryId,
    phase: context.phase as StepRecaptureContext['phase'],
    editorTabId: context.editorTabId!,
    editorWindowId: context.editorWindowId ?? null,
    sourceTabId: context.sourceTabId!,
    sourceWindowId: context.sourceWindowId!,
    sourceUrl: context.sourceUrl,
    sourceTabCreated: context.sourceTabCreated,
    startedAt: context.startedAt!,
  };
}

function normalizeRecaptureResult(value: unknown): StepRecaptureResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<StepRecaptureResult>;
  if (
    !isNonEmptyString(result.runId) ||
    !['replaced', 'cancelled', 'failed'].includes(result.status ?? '') ||
    !isNonEmptyString(result.sessionId) ||
    !isNonEmptyString(result.entryId) ||
    !Number.isFinite(result.completedAt) ||
    (result.errorCode !== undefined && typeof result.errorCode !== 'string') ||
    (result.message !== undefined && typeof result.message !== 'string')
  ) {
    return null;
  }
  return {
    runId: result.runId,
    status: result.status as StepRecaptureResult['status'],
    sessionId: result.sessionId,
    entryId: result.entryId,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.message ? { message: result.message } : {}),
    completedAt: result.completedAt!,
  };
}

export function normalizeRecordingState(stored: Partial<RecordingState> | undefined): RecordingState {
  const normalized = { ...DEFAULT_STATE, ...stored };
  const mode = normalized.mode === 'steps' || normalized.mode === 'snapshot' ? normalized.mode : DEFAULT_STATE.mode;
  const validPhases = new Set<RecordingState['phase']>([
    'idle',
    'starting',
    'recording',
    'paused',
    'preparing-next',
    'invalidated',
    'finishing',
    'error',
  ]);
  const phase = validPhases.has(normalized.phase)
    ? normalized.phase
    : normalized.isRecording
      ? 'recording'
      : 'idle';
  const recapture = normalizeRecaptureContext(normalized.recapture);
  const storedOperation = normalized.operation;
  // Legacy states predate the discriminator. A malformed persisted recapture
  // fails closed instead of leaving the extension in an un-cancellable mode.
  const operation =
    storedOperation === 'recapture'
      ? recapture
        ? 'recapture'
        : null
      : storedOperation === 'recording' || (storedOperation == null && normalized.isRecording)
        ? 'recording'
        : null;

  return {
    ...normalized,
    operation,
    isRecording: operation === 'recording' && Boolean(normalized.isRecording),
    phase: operation === 'recording' ? phase : phase === 'error' ? 'error' : 'idle',
    mode,
    itemCount: Number.isSafeInteger(normalized.itemCount) && normalized.itemCount >= 0 ? normalized.itemCount : 0,
    recapture: operation === 'recapture' ? recapture : null,
    recaptureResult: normalizeRecaptureResult(normalized.recaptureResult),
  };
}

export async function getRecordingState(): Promise<RecordingState> {
  const result = await browser.storage.local.get(RECORDING_STATE_KEY);
  return normalizeRecordingState(result[RECORDING_STATE_KEY] as Partial<RecordingState> | undefined);
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await browser.storage.local.set({ [RECORDING_STATE_KEY]: state });
}

/** Subscribes to recording-state changes; returns an unsubscribe function. */
export function onRecordingStateChange(callback: (state: RecordingState) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[RECORDING_STATE_KEY];
    if (change) callback(normalizeRecordingState(change.newValue as Partial<RecordingState> | undefined));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

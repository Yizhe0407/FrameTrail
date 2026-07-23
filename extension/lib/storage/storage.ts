import { browser, type Browser } from 'wxt/browser';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
import {
  RECORDING_STATE_KEY,
  type InsertionRecordingContext,
  type RecoverableRecordingError,
  type RecordingState,
  type StepRecaptureContext,
  type StepRecaptureResult,
  type StepRecaptureTarget,
} from '../runtime/messages';

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
  insertion: null,
  recapture: null,
  recaptureResult: null,
};

export function createDefaultRecordingState(): RecordingState {
  return { ...DEFAULT_STATE };
}

const MAX_STATE_ID_LENGTH = PERSISTED_STEP_LIMITS.maxIdLength;
const MAX_STATE_VALUE_LENGTH = 512;
const MAX_STATE_MESSAGE_LENGTH = 10_000;
const MAX_VIEWPORT_MAGNITUDE = 10_000_000;
const MAX_DEVICE_PIXEL_RATIO = 32;

function isNonEmptyString(value: unknown, maximumLength = MAX_STATE_VALUE_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function normalizeNullableString(value: unknown, maximumLength = MAX_STATE_VALUE_LENGTH): string | null {
  return isNonEmptyString(value, maximumLength) ? value : null;
}

function isSafeBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeSourceUrl(value: unknown): string | null {
  if (!isNonEmptyString(value, 8_192) || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function normalizeRecoverableError(value: unknown): RecoverableRecordingError | null {
  if (!value || typeof value !== 'object') return null;
  const error = value as Partial<RecoverableRecordingError>;
  if (!isNonEmptyString(error.code) || !isNonEmptyString(error.message, MAX_STATE_MESSAGE_LENGTH)) return null;
  return { code: error.code, message: error.message };
}

function normalizeViewport(value: unknown): RecordingState['snapshotViewport'] {
  if (!value || typeof value !== 'object') return null;
  const viewport = value as Record<string, unknown>;
  const finiteWithinLimit = (candidate: unknown) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && Math.abs(candidate) <= MAX_VIEWPORT_MAGNITUDE;
  if (
    !finiteWithinLimit(viewport.width) ||
    !finiteWithinLimit(viewport.height) ||
    !finiteWithinLimit(viewport.scrollX) ||
    !finiteWithinLimit(viewport.scrollY) ||
    (viewport.width as number) <= 0 ||
    (viewport.height as number) <= 0
  ) {
    return null;
  }
  return {
    width: viewport.width as number,
    height: viewport.height as number,
    scrollX: viewport.scrollX as number,
    scrollY: viewport.scrollY as number,
  };
}

function normalizeRecaptureTarget(value: unknown): StepRecaptureTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<StepRecaptureTarget> & Record<string, unknown>;
  if (target.kind === 'single' && isNonEmptyString(target.stepId, MAX_STATE_ID_LENGTH)) {
    return { kind: 'single', stepId: target.stepId };
  }
  if (
    target.kind === 'snapshot-singleton' &&
    isNonEmptyString(target.anchorId, MAX_STATE_ID_LENGTH) &&
    isNonEmptyString(target.annotationId, MAX_STATE_ID_LENGTH) &&
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

function normalizeInsertionContext(value: unknown): InsertionRecordingContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as Partial<InsertionRecordingContext>;
  if (
    !isNonEmptyString(context.anchorEntryId, MAX_STATE_ID_LENGTH) ||
    (context.side !== 'before' && context.side !== 'after') ||
    !Array.isArray(context.runBlockIds) ||
    context.runBlockIds.length > PERSISTED_STEP_LIMITS.maxStepsPerGuide ||
    !context.runBlockIds.every((id) => isNonEmptyString(id, MAX_STATE_ID_LENGTH)) ||
    new Set(context.runBlockIds).size !== context.runBlockIds.length ||
    !normalizeSourceUrl(context.sourceUrl) ||
    typeof context.sourceTabCreated !== 'boolean' ||
    !isTimestamp(context.startedAt)
  ) {
    return null;
  }
  return {
    anchorEntryId: context.anchorEntryId,
    side: context.side,
    runBlockIds: [...context.runBlockIds],
    sourceUrl: normalizeSourceUrl(context.sourceUrl)!,
    sourceTabCreated: context.sourceTabCreated,
    startedAt: context.startedAt!,
  };
}

function normalizeRecaptureContext(value: unknown): StepRecaptureContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as Partial<StepRecaptureContext>;
  const target = normalizeRecaptureTarget(context.target);
  if (
    !target ||
    !isNonEmptyString(context.runId, MAX_STATE_ID_LENGTH) ||
    !isNonEmptyString(context.sessionId, MAX_STATE_ID_LENGTH) ||
    !isNonEmptyString(context.entryId, MAX_STATE_ID_LENGTH) ||
    !['starting', 'awaiting-target', 'capturing'].includes(context.phase ?? '') ||
    !isSafeBrowserId(context.editorTabId) ||
    (context.editorWindowId !== null && !isSafeBrowserId(context.editorWindowId)) ||
    !isSafeBrowserId(context.sourceTabId) ||
    !isSafeBrowserId(context.sourceWindowId) ||
    !normalizeSourceUrl(context.sourceUrl) ||
    typeof context.sourceTabCreated !== 'boolean' ||
    !isTimestamp(context.startedAt)
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
    sourceUrl: normalizeSourceUrl(context.sourceUrl)!,
    sourceTabCreated: context.sourceTabCreated,
    startedAt: context.startedAt!,
  };
}

function normalizeRecaptureResult(value: unknown): StepRecaptureResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<StepRecaptureResult>;
  if (
    !isNonEmptyString(result.runId, MAX_STATE_ID_LENGTH) ||
    !['replaced', 'cancelled', 'failed'].includes(result.status ?? '') ||
    !isNonEmptyString(result.sessionId, MAX_STATE_ID_LENGTH) ||
    !isNonEmptyString(result.entryId, MAX_STATE_ID_LENGTH) ||
    !isTimestamp(result.completedAt) ||
    (result.errorCode !== undefined && !isNonEmptyString(result.errorCode, MAX_STATE_VALUE_LENGTH)) ||
    (result.message !== undefined && !isNonEmptyString(result.message, MAX_STATE_MESSAGE_LENGTH))
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
  const raw = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const mode = raw.mode === 'steps' || raw.mode === 'snapshot' ? raw.mode : DEFAULT_STATE.mode;
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
  const requestedRecording = raw.operation === 'recording' || (raw.operation == null && raw.isRecording === true);
  const requestedRecapture = raw.operation === 'recapture';
  const insertion = normalizeInsertionContext(raw.insertion);
  const recapture = normalizeRecaptureContext(raw.recapture);
  const sessionId = normalizeNullableString(raw.sessionId, MAX_STATE_ID_LENGTH);
  const tabId = isSafeBrowserId(raw.tabId) ? raw.tabId : null;
  const runId = normalizeNullableString(raw.runId, MAX_STATE_ID_LENGTH);
  const hasMalformedPersistedInsertion = raw.insertion != null && insertion === null;
  const hasValidItemCount =
    raw.itemCount == null ||
    (Number.isSafeInteger(raw.itemCount) && (raw.itemCount as number) >= 0 &&
      (raw.itemCount as number) <= PERSISTED_STEP_LIMITS.maxStepsPerGuide);
  const hasCompleteRecordingIdentity =
    raw.isRecording === true && sessionId !== null && tabId !== null && runId !== null && hasValidItemCount;
  const operation = requestedRecapture
    ? recapture
      ? 'recapture'
      : null
    : requestedRecording && hasCompleteRecordingIdentity && !hasMalformedPersistedInsertion
      ? 'recording'
      : null;
  const isRecording = operation === 'recording' && raw.isRecording === true;
  const candidatePhase = validPhases.has(raw.phase as RecordingState['phase'])
    ? raw.phase as RecordingState['phase']
    : isRecording
      ? 'recording'
      : 'idle';
  const phase = operation === 'recording' ? candidatePhase : candidatePhase === 'error' ? 'error' : 'idle';
  const snapshotViewport = normalizeViewport(raw.snapshotViewport);
  const snapshotDevicePixelRatio =
    typeof raw.snapshotDevicePixelRatio === 'number' &&
    Number.isFinite(raw.snapshotDevicePixelRatio) &&
    raw.snapshotDevicePixelRatio > 0 &&
    raw.snapshotDevicePixelRatio <= MAX_DEVICE_PIXEL_RATIO
      ? raw.snapshotDevicePixelRatio
      : null;

  return {
    operation,
    isRecording,
    phase,
    sessionId: operation === 'recapture' ? recapture!.sessionId : sessionId,
    tabId: operation === 'recording' ? tabId : null,
    error: normalizeNullableString(raw.error, MAX_STATE_MESSAGE_LENGTH),
    recoverableError: normalizeRecoverableError(raw.recoverableError),
    mode,
    itemCount:
      Number.isSafeInteger(raw.itemCount) &&
      (raw.itemCount as number) >= 0 &&
      (raw.itemCount as number) <= PERSISTED_STEP_LIMITS.maxStepsPerGuide
        ? raw.itemCount as number
        : 0,
    numbered: typeof raw.numbered === 'boolean' ? raw.numbered : DEFAULT_STATE.numbered,
    groupAnchorId:
      operation === 'recording' && mode === 'snapshot'
        ? normalizeNullableString(raw.groupAnchorId, MAX_STATE_ID_LENGTH)
        : null,
    runId: operation === 'recording' ? runId : null,
    snapshotViewport: operation === 'recording' && mode === 'snapshot' ? snapshotViewport : null,
    snapshotDevicePixelRatio: operation === 'recording' && mode === 'snapshot' ? snapshotDevicePixelRatio : null,
    insertion: operation === 'recording' ? insertion : null,
    recapture: operation === 'recapture' ? recapture : null,
    recaptureResult: normalizeRecaptureResult(raw.recaptureResult),
  };
}

/** UI-only Guide selection. RecordingState remains the durable owner of an
 * active capture transaction and must never be rewritten merely to navigate. */
export const ACTIVE_GUIDE_ID_KEY = 'frametrail:activeGuideId';

function normalizeActiveGuideId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// Serializes same-context selection mutations so a compare-and-clear cannot
// remove a selection queued after it. browser.storage has no cross-context
// compare-and-swap primitive, so callers should always use these helpers.
let activeGuideMutation: Promise<void> = Promise.resolve();

function queueActiveGuideMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = activeGuideMutation.then(mutation, mutation);
  activeGuideMutation = result.then(() => undefined, () => undefined);
  return result;
}

export async function getActiveGuideId(): Promise<string | null> {
  const result = await browser.storage.local.get(ACTIVE_GUIDE_ID_KEY);
  return normalizeActiveGuideId(result[ACTIVE_GUIDE_ID_KEY]);
}

export function setActiveGuideId(guideId: string): Promise<void> {
  const normalized = normalizeActiveGuideId(guideId);
  if (!normalized) return Promise.reject(new TypeError('Guide id must be a non-empty string.'));
  return queueActiveGuideMutation(async () => {
    await browser.storage.local.set({ [ACTIVE_GUIDE_ID_KEY]: normalized });
  });
}

/** Removes the UI selection only if it still points at expectedGuideId.
 * Returns false when another selection has already won the race. */
export function clearActiveGuideId(expectedGuideId: string): Promise<boolean> {
  const expected = normalizeActiveGuideId(expectedGuideId);
  if (!expected) return Promise.reject(new TypeError('Expected Guide id must be a non-empty string.'));
  return queueActiveGuideMutation(async () => {
    const current = await getActiveGuideId();
    if (current !== expected) return false;
    await browser.storage.local.remove(ACTIVE_GUIDE_ID_KEY);
    return true;
  });
}

/** Subscribes to UI Guide-selection changes; returns an unsubscribe function. */
export function onActiveGuideIdChange(callback: (guideId: string | null) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[ACTIVE_GUIDE_ID_KEY];
    if (change) callback(normalizeActiveGuideId(change.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
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

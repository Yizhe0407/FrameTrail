import type {
  CancelStepRecaptureResult,
  ClickCaptureResult,
  FocusStepRecaptureSourceResult,
  OpenEditorResult,
  PreflightInsertionSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  RecordingControlResult,
  ResetGuideResult,
  StartInsertionRecordingResult,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from './messages';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';

export type RuntimeMessageResultGuard<T> = (value: unknown) => value is T;

const RUNTIME_ERROR_LIMIT = 4_096;
const RUNTIME_PERMISSION_PATTERN_LIMIT = 8_192;
const MAX_GUIDE_ITEMS = PERSISTED_STEP_LIMITS.maxStepsPerGuide;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0)
  );
}

function isId(value: unknown): value is string {
  return isBoundedString(value, PERSISTED_STEP_LIMITS.maxIdLength);
}

function isErrorMessage(value: unknown): value is string {
  return isBoundedString(value, RUNTIME_ERROR_LIMIT);
}

function isOptionalErrorMessage(value: unknown): value is string | undefined {
  return value === undefined || isErrorMessage(value);
}

function isSafeNonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function isSourcePermissionPreflightSuccess(
  value: Record<string, unknown>,
): boolean {
  return (
    value.ok === true &&
    hasOnlyKeys(value, ['ok', 'sourceUrl', 'sourceOrigin', 'permissionPattern']) &&
    isBoundedString(value.sourceUrl, PERSISTED_STEP_LIMITS.maxUrlLength) &&
    isBoundedString(value.sourceOrigin, PERSISTED_STEP_LIMITS.maxUrlLength) &&
    isBoundedString(value.permissionPattern, RUNTIME_PERMISSION_PATTERN_LIMIT)
  );
}

const INSERTION_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'GUIDE_NOT_FOUND',
  'GUIDE_ARCHIVED',
  'ANCHOR_NOT_FOUND',
  'ANCHOR_CHANGED',
  'RESTRICTED_SOURCE',
] as const;

const RECAPTURE_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'TARGET_NOT_FOUND',
  'TARGET_CHANGED',
  'UNSUPPORTED_SNAPSHOT_GROUP',
  'RESTRICTED_SOURCE',
] as const;

const INSERTION_START_ERROR_CODES = [
  'ACTIVE_OPERATION',
  ...INSERTION_PREFLIGHT_ERROR_CODES,
  'HOST_PERMISSION_REQUIRED',
  'SOURCE_TAB_FAILED',
  'INJECTION_FAILED',
] as const;

const RECAPTURE_START_ERROR_CODES = [
  'ACTIVE_OPERATION',
  ...RECAPTURE_PREFLIGHT_ERROR_CODES,
  'HOST_PERMISSION_REQUIRED',
  'SOURCE_TAB_FAILED',
  'INJECTION_FAILED',
] as const;

export function isStartRecordingResult(value: unknown): value is StartRecordingResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return hasOnlyKeys(value, ['ok', 'sessionId', 'runId']) && isId(value.sessionId) && isId(value.runId);
  }
  return value.ok === false && hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
}

export function isResetGuideResult(value: unknown): value is ResetGuideResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'contentRevision']) &&
      (value.contentRevision === undefined || isSafeNonNegativeInteger(value.contentRevision))
    );
  }
  return value.ok === false && hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
}

export function isOpenEditorResult(value: unknown): value is OpenEditorResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasOnlyKeys(value, ['ok']);
  return value.ok === false && hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
}

function isFinishResult(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'entryId', 'groupId', 'itemCount'])) return false;
  return (
    isId(value.sessionId) &&
    (value.entryId === null || isId(value.entryId)) &&
    (value.groupId === null || isId(value.groupId)) &&
    isSafeNonNegativeInteger(value.itemCount, MAX_GUIDE_ITEMS)
  );
}

export function isRecordingControlResult(value: unknown): value is RecordingControlResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
  }
  return (
    value.ok === true &&
    hasOnlyKeys(value, ['ok', 'undoToken', 'removedItemNumber', 'finish']) &&
    (value.undoToken === undefined || isId(value.undoToken)) &&
    (value.removedItemNumber === undefined ||
      (Number.isSafeInteger(value.removedItemNumber) &&
        (value.removedItemNumber as number) > 0 &&
        (value.removedItemNumber as number) <= MAX_GUIDE_ITEMS)) &&
    (value.finish === undefined || isFinishResult(value.finish))
  );
}

export function isPreflightInsertionSourcePermissionResult(
  value: unknown,
): value is PreflightInsertionSourcePermissionResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isSourcePermissionPreflightSuccess(value);
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'message']) &&
    isOneOf(value.code, INSERTION_PREFLIGHT_ERROR_CODES) &&
    isErrorMessage(value.message)
  );
}

export function isStartInsertionRecordingResult(value: unknown): value is StartInsertionRecordingResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'sessionId', 'runId', 'tabId', 'reusedTab']) &&
      isId(value.sessionId) &&
      isId(value.runId) &&
      isSafeNonNegativeInteger(value.tabId) &&
      typeof value.reusedTab === 'boolean'
    );
  }
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'error']) &&
    isOneOf(value.code, INSERTION_START_ERROR_CODES) &&
    isErrorMessage(value.error)
  );
}

export function isPreflightStepRecaptureSourcePermissionResult(
  value: unknown,
): value is PreflightStepRecaptureSourcePermissionResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isSourcePermissionPreflightSuccess(value);
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'message']) &&
    isOneOf(value.code, RECAPTURE_PREFLIGHT_ERROR_CODES) &&
    isErrorMessage(value.message)
  );
}

export function isStartStepRecaptureResult(value: unknown): value is StartStepRecaptureResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'runId', 'tabId', 'reusedTab']) &&
      isId(value.runId) &&
      isSafeNonNegativeInteger(value.tabId) &&
      typeof value.reusedTab === 'boolean'
    );
  }
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'error']) &&
    isOneOf(value.code, RECAPTURE_START_ERROR_CODES) &&
    isErrorMessage(value.error)
  );
}

export function isFocusStepRecaptureSourceResult(value: unknown): value is FocusStepRecaptureSourceResult {
  return isOpenEditorResult(value);
}

export function isCancelStepRecaptureResult(value: unknown): value is CancelStepRecaptureResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'status']) &&
      isOneOf(value.status, ['cancelled', 'already-completed'] as const)
    );
  }
  return value.ok === false && hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
}

export function isClickCaptureResult(value: unknown): value is ClickCaptureResult {
  return isRecord(value) && hasOnlyKeys(value, ['ok']) && typeof value.ok === 'boolean';
}

export function isStepRecaptureTargetResult(value: unknown): value is StepRecaptureTargetResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return hasOnlyKeys(value, ['ok', 'status']) && value.status === 'replaced';
  }
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'status', 'error']) &&
    isOneOf(value.status, ['rejected', 'cancelled', 'failed'] as const) &&
    isOptionalErrorMessage(value.error)
  );
}

export function isRuntimeBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Runtime responses cross an extension-context boundary and can be absent or
 * stale during reload/navigation. Requiring a contract-specific guard keeps a
 * merely truthy `ok` property from turning malformed data into trusted state.
 */
export function requireRuntimeMessageResult<T>(
  value: unknown,
  guard: RuntimeMessageResultGuard<T>,
  unavailableMessage = 'FrameTrail 背景服務暫時無法回應，請重新整理頁面後再試一次。',
): T {
  if (!guard(value)) throw new Error(unavailableMessage);
  return value;
}

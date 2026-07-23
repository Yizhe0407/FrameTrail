import type {
  BackgroundMessage,
  ClickCapture,
  RecordingControlMessage,
  StepRecaptureTarget,
} from './messages';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

const MAX_ID_LENGTH = PERSISTED_STEP_LIMITS.maxIdLength;
const MAX_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 10_000;
const MAX_COORDINATE_MAGNITUDE = 10_000_000;
const MAX_DEVICE_PIXEL_RATIO = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown, maximumLength: number = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isOptionalString(value: unknown, maximumLength: number = MAX_ID_LENGTH): value is string | undefined {
  return value === undefined || isString(value, maximumLength);
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteWithin(value: unknown, maximumMagnitude = MAX_COORDINATE_MAGNITUDE): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximumMagnitude;
}

function isDevicePixelRatio(value: unknown): value is number {
  return isFiniteWithin(value, MAX_DEVICE_PIXEL_RATIO) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isViewport(value: unknown): value is ClickCapture['viewport'] {
  if (!isRecord(value)) return false;
  return (
    isFiniteWithin(value.width) && value.width > 0 &&
    isFiniteWithin(value.height) && value.height > 0 &&
    isFiniteWithin(value.scrollX) &&
    isFiniteWithin(value.scrollY)
  );
}

function isRect(value: unknown): value is ClickCapture['rect'] {
  if (!isRecord(value)) return false;
  return (
    isFiniteWithin(value.x) &&
    isFiniteWithin(value.y) &&
    isFiniteWithin(value.width) && value.width > 0 &&
    isFiniteWithin(value.height) && value.height > 0
  );
}

function isHttpUrl(value: unknown): value is string {
  if (!isString(value, MAX_URL_LENGTH) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isTarget(value: unknown): value is StepRecaptureTarget {
  if (!isRecord(value)) return false;
  if (value.kind === 'single') return isString(value.stepId);
  return (
    value.kind === 'snapshot-singleton' &&
    isString(value.anchorId) &&
    isString(value.annotationId) &&
    value.anchorId !== value.annotationId
  );
}

const RECORDING_CONTROLS = new Set([
  'PAUSE_RECORDING',
  'RESUME_RECORDING',
  'UNDO_LAST_CAPTURE',
  'RESTORE_LAST_CAPTURE',
  'PREPARE_NEXT_SNAPSHOT',
  'CREATE_NEXT_SNAPSHOT',
  'REBUILD_INVALIDATED_SNAPSHOT',
  'DISCARD_CURRENT_RECORDING',
  'FINISH_RECORDING',
]);

/** Runtime messages cross a JavaScript trust boundary and require validation even when TypeScript callers are typed. */
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  if (RECORDING_CONTROLS.has(value.type)) {
    return isString(value.runId) && isOptionalString(value.undoToken);
  }

  switch (value.type) {
    case 'START_RECORDING':
      return (
        isString(value.sessionId) &&
        (value.mode === 'steps' || value.mode === 'snapshot') &&
        typeof value.numbered === 'boolean' &&
        (value.permissionScope === undefined || value.permissionScope === 'current-page' || value.permissionScope === 'cross-page')
      );
    case 'PREFLIGHT_INSERTION_SOURCE_PERMISSION':
      return isString(value.sessionId) && isString(value.anchorEntryId);
    case 'START_INSERTION_RECORDING':
      return (
        isString(value.sessionId) &&
        isString(value.anchorEntryId) &&
        (value.side === 'before' || value.side === 'after') &&
        (value.mode === 'steps' || value.mode === 'snapshot') &&
        typeof value.numbered === 'boolean' &&
        (value.preferredTabId === undefined || isBrowserId(value.preferredTabId))
      );
    case 'STOP_RECORDING':
      return true;
    case 'OPEN_EDITOR':
      return isOptionalString(value.sessionId) && isOptionalString(value.entryId);
    case 'RESET_GUIDE':
      return isString(value.sessionId);
    case 'SNAPSHOT_INVALIDATED':
      return isString(value.runId) && isViewport(value.viewport) && isDevicePixelRatio(value.devicePixelRatio);
    case 'SNAPSHOT_RECORDER_FAILED':
      return isString(value.runId) && value.reason === 'shield-channel';
    case 'FRAME_TRAIL_CANCEL_CAPTURE':
      return isString(value.runId) && isString(value.captureId);
    case 'FRAME_TRAIL_READY': {
      if (!isString(value.runId)) return false;
      if (value.snapshotContext === undefined) return true;
      if (!isRecord(value.snapshotContext)) return false;
      return (
        isViewport(value.snapshotContext.viewport) &&
        isDevicePixelRatio(value.snapshotContext.devicePixelRatio) &&
        isHttpUrl(value.snapshotContext.url) &&
        isTimestamp(value.snapshotContext.timestamp)
      );
    }
    case 'FRAME_TRAIL_CLICK':
      return (
        (value.captureKind === undefined || value.captureKind === 'element' || value.captureKind === 'region') &&
        isString(value.captureId) &&
        isString(value.runId) &&
        isRect(value.rect) &&
        isDevicePixelRatio(value.devicePixelRatio) &&
        isViewport(value.viewport) &&
        typeof value.text === 'string' && value.text.length <= MAX_TEXT_LENGTH &&
        isString(value.tagName, 128) &&
        (value.intent === 'click' || value.intent === 'mark') &&
        isHttpUrl(value.url) &&
        isTimestamp(value.timestamp)
      );
    case 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION':
      return isString(value.sessionId) && isTarget(value.target);
    case 'START_STEP_RECAPTURE':
      return isString(value.sessionId) && isTarget(value.target) &&
        (value.preferredTabId === undefined || isBrowserId(value.preferredTabId));
    case 'FRAME_TRAIL_RECAPTURE_READY':
      return isString(value.runId) && isHttpUrl(value.url);
    case 'FRAME_TRAIL_RECAPTURE_TARGET':
      return (
        isString(value.runId) &&
        isString(value.captureId) &&
        isRect(value.rect) &&
        isViewport(value.viewport) &&
        isDevicePixelRatio(value.devicePixelRatio) &&
        isHttpUrl(value.url) &&
        isTimestamp(value.timestamp)
      );
    case 'CANCEL_STEP_RECAPTURE':
    case 'FOCUS_STEP_RECAPTURE_SOURCE':
      return isString(value.runId);
    case 'ACK_STEP_RECAPTURE_RESULT':
      return isString(value.runId) && isString(value.sessionId);
    default:
      return false;
  }
}

export interface RuntimeMessageSenderLike {
  frameId?: number;
  url?: string;
  tab?: { id?: number; url?: string };
}

function sameExtensionOrigin(candidate: string | undefined, extensionUrl: string): boolean {
  if (!candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(extensionUrl);
    // URL.origin is the string "null" for chrome-extension:/moz-extension:
    // URLs, so compare the actual extension scheme and host instead.
    return candidateUrl.protocol === expectedUrl.protocol && candidateUrl.host === expectedUrl.host;
  } catch {
    return false;
  }
}

/** Rejects content scripts and child frames from extension-page-only lifecycle controls. */
export function isTrustedExtensionPageSender(sender: RuntimeMessageSenderLike, extensionUrl: string): boolean {
  if (!sameExtensionOrigin(sender.url, extensionUrl)) return false;
  if (!sender.tab) return true; // popup and other extension views are not associated with a tab
  return sender.frameId === 0 && sender.tab.id != null && sameExtensionOrigin(sender.tab.url, extensionUrl);
}

export function isRecordingControlMessage(
  message: BackgroundMessage,
): message is RecordingControlMessage {
  return RECORDING_CONTROLS.has(message.type);
}

/**
 * In-page toolbars run in the dynamically injected top-frame recorder, not an
 * extension page. Bind their controls to the authoritative recorded tab; the
 * control handler separately verifies the unguessable run id and current phase.
 */
export function isTrustedRecorderControlSender(
  sender: RuntimeMessageSenderLike,
  recordedTabId: number | null,
): boolean {
  return (
    recordedTabId !== null &&
    sender.frameId === 0 &&
    sender.tab?.id === recordedTabId
  );
}

/** Keeps MV3 alive only for the top frame that owns the active capture job. */
export function isTrustedKeepAliveSender(
  sender: RuntimeMessageSenderLike,
  state: {
    operation: 'recording' | 'recapture' | null;
    isRecording: boolean;
    tabId: number | null;
    recapture: { sourceTabId: number } | null;
  },
): boolean {
  if (sender.frameId !== 0 || sender.tab?.id == null) return false;
  if (state.operation === 'recording') {
    return state.isRecording && state.tabId === sender.tab.id;
  }
  return state.operation === 'recapture' && state.recapture?.sourceTabId === sender.tab.id;
}

export function isExtensionPageOnlyMessage(message: BackgroundMessage): boolean {
  return message.type === 'START_RECORDING' ||
    message.type === 'STOP_RECORDING' ||
    message.type === 'RESET_GUIDE' ||
    message.type === 'OPEN_EDITOR';
}

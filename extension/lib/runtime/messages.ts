/** Shared message contracts between content script, background, and popup. */

import type { RecordingMode, StepRecaptureTarget, Viewport } from '../storage/recording-state';

type CaptureIntent = 'click' | 'mark';

/** Clicked element rect in CSS px, relative to the viewport at capture time. */
interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClickCapture {
  type: 'FRAME_TRAIL_CLICK';
  /** Element selections replay the original page click; region selections are capture-only. */
  captureKind?: 'element' | 'region';
  /** Identifies one in-flight screenshot so a cancelled gesture can invalidate it. */
  captureId: string;
  /** Identifies the exact recording run that injected the sender. */
  runId: string;
  rect: CaptureRect;
  devicePixelRatio: number;
  /** CSS viewport occupied by the screenshot, used to derive its real pixel scale. */
  viewport: Viewport;
  text: string;
  tagName: string;
  /** Controls the generated description; generic visible targets are marks. */
  intent: CaptureIntent;
  url: string;
  timestamp: number;
}

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  /** Explicit Guide target. UI selection is intentionally separate from RecordingState. */
  sessionId: string;
  mode: RecordingMode;
  /**
   * True when the caller created sessionId's Guide solely for this run (the
   * popup's 開始錄製 always records into a fresh Guide). Lets background
   * reclaim the empty shell if the run ends with nothing captured; guides the
   * user created explicitly (作品庫 新增教學) or continued from the editor
   * never carry this flag and are never auto-deleted.
   */
  autoCreatedGuide?: boolean;
  /**
   * Editor-initiated continuation of an existing Guide. The editor tab itself
   * cannot be recorded, so background resolves the Guide's own persisted source
   * page instead of using whichever tab happens to be active. The source URL is
   * never accepted from the caller.
   */
  continuation?: { preferredTabId?: number };
}

export type StartRecordingResult =
  | { ok: true; sessionId: string; runId: string }
  | { ok: false; error: string };

export interface SourcePermissionPreflightSuccess {
  ok: true;
  /** Exact persisted HTTP(S) URL resolved by background; never accepted from editor state. */
  sourceUrl: string;
  /** Parsed origin of sourceUrl, suitable for permission copy/UI. */
  sourceOrigin: string;
  /** Browser host-permission match pattern derived from sourceOrigin. */
  permissionPattern: string;
}

export interface StopRecordingMessage {
  type: 'STOP_RECORDING';
}

export interface OpenEditorMessage {
  type: 'OPEN_EDITOR';
  /** Explicit Guide target for normal navigation. Omitted only for recovery. */
  sessionId?: string;
  entryId?: string;
}

export interface ResetGuideMessage {
  type: 'RESET_GUIDE';
  sessionId: string;
}

export type ResetGuideResult =
  | { ok: true; contentRevision?: number }
  | { ok: false; error: string };

export type OpenEditorResult = { ok: true } | { ok: false; error: string };

export interface RecordingControlMessage {
  type:
    | 'PAUSE_RECORDING'
    | 'RESUME_RECORDING'
    | 'UNDO_LAST_CAPTURE'
    | 'RESTORE_LAST_CAPTURE'
    | 'PREPARE_NEXT_SNAPSHOT'
    | 'CREATE_NEXT_SNAPSHOT'
    | 'REBUILD_INVALIDATED_SNAPSHOT'
    | 'DISCARD_CURRENT_RECORDING'
    | 'FINISH_RECORDING';
  runId: string;
  undoToken?: string;
}

/** Sent by the top-level snapshot recorder when its immutable base-image
 * viewport contract no longer matches the live page. */
export interface SnapshotInvalidatedMessage {
  type: 'SNAPSHOT_INVALIDATED';
  runId: string;
  viewport: Viewport;
  devicePixelRatio: number;
}

/** Sent by the top-level snapshot recorder when its private UI channel fails
 * after startup. Background stops the run so the page cannot remain frozen
 * while durable state incorrectly claims recording is still active. */
export interface SnapshotRecorderFailureMessage {
  type: 'SNAPSHOT_RECORDER_FAILED';
  runId: string;
  reason: 'shield-channel';
}

export interface FinishResult {
  sessionId: string;
  entryId: string | null;
  groupId: string | null;
  itemCount: number;
}

export type RecordingControlResult =
  | {
      ok: true;
      undoToken?: string;
      removedItemNumber?: number;
      finish?: FinishResult;
    }
  | { ok: false; error: string };

/** Sent background -> content script (not through the BackgroundMessage
 *  union) telling the recorder in a specific tab to tear itself down —
 *  removes its listeners and closes the keep-alive port so the tab stops
 *  holding the service worker alive after recording stops. */
export interface FrameTrailStopMessage {
  type: 'FRAME_TRAIL_STOP';
}

/** Sent background -> the top-level snapshot recorder only after its clean
 * anchor screenshot has been captured and persisted. Until this arrives the
 * shield consumes input but does not show hover previews or accept marks. */
export interface FrameTrailSnapshotActiveMessage {
  type: 'FRAME_TRAIL_SNAPSHOT_ACTIVE';
  runId: string;
}

export interface ClickCaptureResult {
  ok: boolean;
}

interface CancelCaptureMessage {
  type: 'FRAME_TRAIL_CANCEL_CAPTURE';
  runId: string;
  captureId: string;
}

export interface RecorderReadyMessage {
  type: 'FRAME_TRAIL_READY';
  runId: string;
  /** Snapshot mode captures its clean base image during START, before the
   * user can create any live annotations. */
  snapshotContext?: {
    viewport: Viewport;
    devicePixelRatio: number;
    url: string;
    timestamp: number;
  };
}

export interface PreflightStepRecaptureSourcePermissionMessage {
  type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION';
  sessionId: string;
  target: StepRecaptureTarget;
}

/** Single source of truth for the recapture-preflight failure codes; the
 * result guard in runtime-message-result.ts validates against this same array. */
export const RECAPTURE_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'TARGET_NOT_FOUND',
  'TARGET_CHANGED',
  'UNSUPPORTED_SNAPSHOT_GROUP',
  'RESTRICTED_SOURCE',
] as const;

export type PreflightStepRecaptureSourcePermissionErrorCode =
  (typeof RECAPTURE_PREFLIGHT_ERROR_CODES)[number];

export type PreflightStepRecaptureSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightStepRecaptureSourcePermissionErrorCode; message: string };

export interface PreflightGuideContinuationSourcePermissionMessage {
  type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION';
  sessionId: string;
}

export const CONTINUATION_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'SOURCE_NOT_FOUND',
  'RESTRICTED_SOURCE',
] as const;

export type PreflightGuideContinuationSourcePermissionErrorCode =
  (typeof CONTINUATION_PREFLIGHT_ERROR_CODES)[number];

export type PreflightGuideContinuationSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightGuideContinuationSourcePermissionErrorCode; message: string };

export interface StartStepRecaptureMessage {
  type: 'START_STEP_RECAPTURE';
  sessionId: string;
  target: StepRecaptureTarget;
  /** Editor may nominate an already-open exact-URL tab. Background revalidates it. */
  preferredTabId?: number;
}

/** Superset of the preflight codes: START re-runs the preflight and adds the
 * failure modes of actually taking over a source tab. */
export const RECAPTURE_START_ERROR_CODES = [
  'ACTIVE_OPERATION',
  ...RECAPTURE_PREFLIGHT_ERROR_CODES,
  'HOST_PERMISSION_REQUIRED',
  'SOURCE_TAB_FAILED',
  'INJECTION_FAILED',
] as const;

type StartStepRecaptureErrorCode = (typeof RECAPTURE_START_ERROR_CODES)[number];

export type StartStepRecaptureResult =
  | { ok: true; runId: string; tabId: number; reusedTab: boolean }
  | { ok: false; code: StartStepRecaptureErrorCode; error: string };

export interface FrameTrailRecaptureReadyMessage {
  type: 'FRAME_TRAIL_RECAPTURE_READY';
  runId: string;
  url: string;
}

export interface FrameTrailRecaptureTargetMessage {
  type: 'FRAME_TRAIL_RECAPTURE_TARGET';
  runId: string;
  captureId: string;
  rect: CaptureRect;
  viewport: Viewport;
  devicePixelRatio: number;
  url: string;
  timestamp: number;
}

export type StepRecaptureTargetResult =
  | { ok: true; status: 'replaced' }
  | { ok: false; status: 'rejected' | 'cancelled' | 'failed'; error?: string };

export interface CancelStepRecaptureMessage {
  type: 'CANCEL_STEP_RECAPTURE';
  runId: string;
}

export type CancelStepRecaptureResult =
  | { ok: true; status: 'cancelled' | 'already-completed' }
  | { ok: false; error: string };

export interface AckStepRecaptureResultMessage {
  type: 'ACK_STEP_RECAPTURE_RESULT';
  runId: string;
  sessionId: string;
}

export interface FocusStepRecaptureSourceMessage {
  type: 'FOCUS_STEP_RECAPTURE_SOURCE';
  runId: string;
}

export type FocusStepRecaptureSourceResult =
  | { ok: true }
  | { ok: false; error: string };

export type BackgroundMessage =
  | ClickCapture
  | CancelCaptureMessage
  | SnapshotInvalidatedMessage
  | SnapshotRecorderFailureMessage
  | StartRecordingMessage
  | StopRecordingMessage
  | OpenEditorMessage
  | ResetGuideMessage
  | RecordingControlMessage
  | RecorderReadyMessage
  | PreflightStepRecaptureSourcePermissionMessage
  | PreflightGuideContinuationSourcePermissionMessage
  | StartStepRecaptureMessage
  | FrameTrailRecaptureReadyMessage
  | FrameTrailRecaptureTargetMessage
  | CancelStepRecaptureMessage
  | AckStepRecaptureResultMessage
  | FocusStepRecaptureSourceMessage;

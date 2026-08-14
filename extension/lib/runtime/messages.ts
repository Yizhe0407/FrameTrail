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
  /** 讓已取消 gesture 使進行中的截圖失效。 */
  captureId: string;
  runId: string;
  rect: CaptureRect;
  devicePixelRatio: number;
  /** CSS viewport occupied by the screenshot, used to derive its real pixel scale. */
  viewport: Viewport;
  text: string;
  tagName: string;
  intent: CaptureIntent;
  url: string;
  timestamp: number;
}

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  sessionId: string;
  mode: RecordingMode;
  /** 未擷取內容時，允許 background 回收該流程建立的 Guide。 */
  autoCreatedGuide?: boolean;
  /** 從持久化來源接續；一律不信任呼叫端提供的來源 URL。 */
  continuation?: { preferredTabId?: number };
}

export type StartRecordingResult =
  | { ok: true; sessionId: string; runId: string }
  | { ok: false; error: string };

export interface SourcePermissionPreflightSuccess {
  ok: true;
  /** Exact persisted HTTP(S) URL resolved by background; never accepted from editor state. */
  sourceUrl: string;
  sourceOrigin: string;
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

/** 在 BackgroundMessage 外傳送，用於卸載 tab 錄製器並釋放 keep-alive port。 */
export interface FrameTrailStopMessage {
  type: 'FRAME_TRAIL_STOP';
}

/** 僅在乾淨 anchor 持久化後啟用快照互動。 */
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
  /** 快照模式會先擷取此乾淨底圖，再接受標註。 */
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

/** 與 runtime-message-result.ts 的結果 guard 共用。 */
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

/** START 會重跑 preflight，並加入接管來源 tab 的失敗類型。 */
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

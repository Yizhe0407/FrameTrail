/** Shared message contracts between content script, background, and popup. */

export type CaptureIntent = 'click' | 'mark';

export interface ClickCapture {
  type: 'FRAME_TRAIL_CLICK';
  /** Element selections replay the original page click; region selections are capture-only. */
  captureKind?: 'element' | 'region';
  /** Identifies one in-flight screenshot so a cancelled gesture can invalidate it. */
  captureId: string;
  /** Identifies the exact recording run that injected the sender. */
  runId: string;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  /** CSS viewport occupied by the screenshot, used to derive its real pixel scale. */
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  text: string;
  tagName: string;
  /** Controls the generated description; generic visible targets are marks. */
  intent: CaptureIntent;
  url: string;
  timestamp: number;
}

/** 'steps': one screenshot per selection (default). 'snapshot': every
 * selection in the session is annotated onto one shared screenshot instead. */
export type RecordingMode = 'steps' | 'snapshot';
export type InsertionSide = 'before' | 'after';

export type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'preparing-next'
  | 'invalidated'
  | 'finishing'
  | 'error';

export interface RecoverableRecordingError {
  code: string;
  message: string;
}

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  /** Explicit Guide target. UI selection is intentionally separate from RecordingState. */
  sessionId: string;
  mode: RecordingMode;
  /** Snapshot mode only: whether boxes get a numbered order badge. */
  numbered: boolean;
  permissionScope?: 'current-page' | 'cross-page';
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

export interface PreflightInsertionSourcePermissionMessage {
  type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION';
  sessionId: string;
  /** Stable timeline entry id; background resolves its current persisted image owner. */
  anchorEntryId: string;
}

export type PreflightInsertionSourcePermissionErrorCode =
  | 'INVALID_EDITOR'
  | 'GUIDE_NOT_FOUND'
  | 'GUIDE_ARCHIVED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_CHANGED'
  | 'RESTRICTED_SOURCE';

export type PreflightInsertionSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightInsertionSourcePermissionErrorCode; message: string };

export interface StartInsertionRecordingMessage {
  type: 'START_INSERTION_RECORDING';
  sessionId: string;
  /** Stable timeline entry id: an ordinary step id or a snapshot anchor id. */
  anchorEntryId: string;
  side: InsertionSide;
  mode: RecordingMode;
  /** Snapshot mode only: whether boxes get a numbered order badge. */
  numbered: boolean;
  /** Editor may nominate an already-open exact-URL tab. Background revalidates it. */
  preferredTabId?: number;
}

export type StartInsertionRecordingErrorCode =
  | 'ACTIVE_OPERATION'
  | 'INVALID_EDITOR'
  | 'GUIDE_NOT_FOUND'
  | 'GUIDE_ARCHIVED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_CHANGED'
  | 'RESTRICTED_SOURCE'
  | 'HOST_PERMISSION_REQUIRED'
  | 'SOURCE_TAB_FAILED'
  | 'INJECTION_FAILED';

export type StartInsertionRecordingResult =
  | { ok: true; sessionId: string; runId: string; tabId: number; reusedTab: boolean }
  | { ok: false; code: StartInsertionRecordingErrorCode; error: string };

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
  viewport: ClickCapture['viewport'];
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

export interface CancelCaptureMessage {
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
    viewport: ClickCapture['viewport'];
    devicePixelRatio: number;
    url: string;
    timestamp: number;
  };
}


export type ActiveOperation = 'recording' | 'recapture' | null;
export type RecapturePhase = 'starting' | 'awaiting-target' | 'capturing';

export type StepRecaptureTarget =
  | { kind: 'single'; stepId: string }
  | { kind: 'snapshot-singleton'; anchorId: string; annotationId: string };

export interface InsertionRecordingContext {
  anchorEntryId: string;
  side: InsertionSide;
  /** Exact ids committed by this run, in their internal chronological order. */
  runBlockIds: string[];
  /** Persisted only after being derived from the DB anchor; never accepted from UI. */
  sourceUrl: string;
  sourceTabCreated: boolean;
  startedAt: number;
}

export interface StepRecaptureContext {
  runId: string;
  sessionId: string;
  target: StepRecaptureTarget;
  /** Timeline entry that the editor should reselect after the workflow ends. */
  entryId: string;
  phase: RecapturePhase;
  editorTabId: number;
  editorWindowId: number | null;
  sourceTabId: number;
  sourceWindowId: number;
  sourceUrl: string;
  sourceTabCreated: boolean;
  startedAt: number;
}

export type StepRecaptureResultStatus = 'replaced' | 'cancelled' | 'failed';

export interface StepRecaptureResult {
  runId: string;
  status: StepRecaptureResultStatus;
  sessionId: string;
  entryId: string;
  errorCode?: string;
  message?: string;
  completedAt: number;
}

export interface PreflightStepRecaptureSourcePermissionMessage {
  type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION';
  sessionId: string;
  target: StepRecaptureTarget;
}

export type PreflightStepRecaptureSourcePermissionErrorCode =
  | 'INVALID_EDITOR'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_CHANGED'
  | 'UNSUPPORTED_SNAPSHOT_GROUP'
  | 'RESTRICTED_SOURCE';

export type PreflightStepRecaptureSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightStepRecaptureSourcePermissionErrorCode; message: string };

export interface StartStepRecaptureMessage {
  type: 'START_STEP_RECAPTURE';
  sessionId: string;
  target: StepRecaptureTarget;
  /** Editor may nominate an already-open exact-URL tab. Background revalidates it. */
  preferredTabId?: number;
}

export type StartStepRecaptureErrorCode =
  | 'ACTIVE_OPERATION'
  | 'INVALID_EDITOR'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_CHANGED'
  | 'UNSUPPORTED_SNAPSHOT_GROUP'
  | 'RESTRICTED_SOURCE'
  | 'HOST_PERMISSION_REQUIRED'
  | 'SOURCE_TAB_FAILED'
  | 'INJECTION_FAILED';

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
  rect: ClickCapture['rect'];
  viewport: ClickCapture['viewport'];
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
  | PreflightInsertionSourcePermissionMessage
  | StartInsertionRecordingMessage
  | StopRecordingMessage
  | OpenEditorMessage
  | ResetGuideMessage
  | RecordingControlMessage
  | RecorderReadyMessage
  | PreflightStepRecaptureSourcePermissionMessage
  | StartStepRecaptureMessage
  | FrameTrailRecaptureReadyMessage
  | FrameTrailRecaptureTargetMessage
  | CancelStepRecaptureMessage
  | AckStepRecaptureResultMessage
  | FocusStepRecaptureSourceMessage;

export interface RecordingState {
  /** Explicitly distinguishes ordinary recording from the one-shot recapture workflow. */
  operation: ActiveOperation;
  isRecording: boolean;
  phase: RecordingPhase;
  sessionId: string | null;
  tabId: number | null;
  error: string | null;
  recoverableError: RecoverableRecordingError | null;
  mode: RecordingMode;
  itemCount: number;
  numbered: boolean;
  /** Snapshot mode: id of the current recording run's shared-image anchor
   * step. START_RECORDING captures and creates it before accepting clicks;
   * null means startup has not completed or this is not a snapshot run. */
  groupAnchorId: string | null;
  /** Changes on every START and is cleared by STOP, invalidating messages and
   * async work left behind by an older content-script instance. */
  runId: string | null;
  /** Viewport used by the current snapshot anchor. Later annotations must
   * match it or their coordinates would be drawn onto the wrong pixels. */
  snapshotViewport: ClickCapture['viewport'] | null;
  snapshotDevicePixelRatio: number | null;
  /** Present only for a targeted insertion recording run. */
  insertion?: InsertionRecordingContext | null;
  recapture: StepRecaptureContext | null;
  /** Durable handoff; the editor clears it with ACK_STEP_RECAPTURE_RESULT. */
  recaptureResult: StepRecaptureResult | null;
}

// Preserve the existing key so renaming the product does not discard an
// in-progress local recording during the upgrade.
export const RECORDING_STATE_KEY = 'scribe:recordingState';

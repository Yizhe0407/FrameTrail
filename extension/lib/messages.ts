/** Shared message contracts between content script, background, and popup. */

export type CaptureIntent = 'click' | 'mark';

export interface ClickCapture {
  type: 'FRAME_TRAIL_CLICK';
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
  mode: RecordingMode;
  /** Snapshot mode only: whether boxes get a numbered order badge. */
  numbered: boolean;
  permissionScope?: 'current-page' | 'cross-page';
}

export interface StopRecordingMessage {
  type: 'STOP_RECORDING';
}

export interface RecordingControlMessage {
  type:
    | 'PAUSE_RECORDING'
    | 'RESUME_RECORDING'
    | 'UNDO_LAST_CAPTURE'
    | 'RESTORE_LAST_CAPTURE'
    | 'PREPARE_NEXT_SNAPSHOT'
    | 'CREATE_NEXT_SNAPSHOT'
    | 'FINISH_RECORDING';
  runId: string;
  undoToken?: string;
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

export type BackgroundMessage =
  | ClickCapture
  | CancelCaptureMessage
  | StartRecordingMessage
  | StopRecordingMessage
  | RecordingControlMessage
  | RecorderReadyMessage;

export interface RecordingState {
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
}

// Preserve the existing key so renaming the product does not discard an
// in-progress local recording during the upgrade.
export const RECORDING_STATE_KEY = 'scribe:recordingState';

/**
 * Persisted recording-state schema: the durable shape written under
 * RECORDING_STATE_KEY plus the domain vocabulary it is built from. Wire
 * message contracts (lib/runtime/messages.ts) embed these types in payloads,
 * so this module must stay dependency-free: messages depends on the persisted
 * schema, never the other way around.
 */

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

/** CSS viewport occupied by a screenshot, used to derive its real pixel scale. */
export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export type ActiveOperation = 'recording' | 'recapture' | null;
export type RecapturePhase = 'starting' | 'awaiting-target' | 'capturing';

export type StepRecaptureTarget =
  | { kind: 'single'; stepId: string }
  | { kind: 'snapshot-singleton'; anchorId: string; annotationId: string };

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
  /** Every run starts numbered; the editor turns it off per snapshot. Captures
   * stamp this onto each step so a later change cannot rewrite old images. */
  numbered: boolean;
  /** Snapshot mode: id of the current recording run's shared-image anchor
   * step. START_RECORDING captures and creates it before accepting clicks;
   * null means startup has not completed or this is not a snapshot run. */
  groupAnchorId: string | null;
  /** Changes on every START and is cleared by STOP, invalidating messages and
   * async work left behind by an older content-script instance. */
  runId: string | null;
  /** Set when this run's Guide was auto-created just for it (popup start).
   * Read by the stop/discard paths to reclaim a still-untouched empty shell;
   * null for library-created guides and editor continuations. */
  autoCreatedGuideId: string | null;
  /** Viewport used by the current snapshot anchor. Later annotations must
   * match it or their coordinates would be drawn onto the wrong pixels. */
  snapshotViewport: Viewport | null;
  snapshotDevicePixelRatio: number | null;
  recapture: StepRecaptureContext | null;
  /** Durable handoff; the editor clears it with ACK_STEP_RECAPTURE_RESULT. */
  recaptureResult: StepRecaptureResult | null;
}

// Preserve the existing key so renaming the product does not discard an
// in-progress local recording during the upgrade.
export const RECORDING_STATE_KEY = 'scribe:recordingState';

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
  autoCreatedGuideId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
  recapture: null,
  recaptureResult: null,
};

export function createDefaultRecordingState(): RecordingState {
  return { ...DEFAULT_STATE };
}

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

/** Canonical phase vocabularies as const arrays: the types derive from them,
 * and persisted-state normalization builds its accept lists from the same
 * source, so adding a phase can never silently normalize stored runs to idle. */
export const RECORDING_PHASES = [
  'idle',
  'starting',
  'recording',
  'paused',
  'preparing-next',
  'invalidated',
  'finishing',
  'error',
] as const;

export type RecordingPhase = (typeof RECORDING_PHASES)[number];

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

export const RECAPTURE_PHASES = ['starting', 'awaiting-target', 'capturing'] as const;
export type RecapturePhase = (typeof RECAPTURE_PHASES)[number];

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
  sourceTabId: number;
  sourceWindowId: number;
  sourceUrl: string;
  sourceTabCreated: boolean;
  startedAt: number;
}

export const STEP_RECAPTURE_RESULT_STATUSES = ['replaced', 'cancelled', 'failed'] as const;
type StepRecaptureResultStatus = (typeof STEP_RECAPTURE_RESULT_STATUSES)[number];

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

export const RECORDING_STATE_KEY = 'frametrail:recordingState';

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

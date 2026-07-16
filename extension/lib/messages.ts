/** Shared message contracts between content script, background, and popup. */

export interface ClickCapture {
  type: 'FRAME_TRAIL_CLICK';
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  /** CSS viewport occupied by the screenshot, used to derive its real pixel scale. */
  viewport: { width: number; height: number };
  text: string;
  tagName: string;
  role: string | null;
  url: string;
  pageTitle: string;
  timestamp: number;
}

/** 'steps': one screenshot per click (default). 'snapshot': every click in the
 *  session is annotated onto one shared screenshot instead. */
export type RecordingMode = 'steps' | 'snapshot';

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  mode: RecordingMode;
  /** Snapshot mode only: whether boxes get a numbered order badge. */
  numbered: boolean;
}

export interface StopRecordingMessage {
  type: 'STOP_RECORDING';
}

/** Sent background -> content script (not through the BackgroundMessage
 *  union) telling the recorder in a specific tab to tear itself down —
 *  removes its listeners and closes the keep-alive port so the tab stops
 *  holding the service worker alive after recording stops. */
export interface FrameTrailStopMessage {
  type: 'FRAME_TRAIL_STOP';
}

export type BackgroundMessage = ClickCapture | StartRecordingMessage | StopRecordingMessage;

export interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  tabId: number | null;
  error: string | null;
  mode: RecordingMode;
  numbered: boolean;
  /** Snapshot mode: id of the current recording run's shared-image anchor
   * step, or null if this run hasn't captured its first click yet. Reset to
   * null on every START_RECORDING so each run gets its own fresh image instead
   * of resuming an older group. */
  groupAnchorId: string | null;
}

// Preserve the existing key so renaming the product does not discard an
// in-progress local recording during the upgrade.
export const RECORDING_STATE_KEY = 'scribe:recordingState';

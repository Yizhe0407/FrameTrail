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

/** 'multi': one screenshot per click (default). 'single': every click in the
 *  session is annotated onto one shared screenshot instead. */
export type RecordingMode = 'multi' | 'single';

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  mode: RecordingMode;
  /** Single-image mode only: whether boxes get a numbered order badge. */
  numbered: boolean;
}

export interface StopRecordingMessage {
  type: 'STOP_RECORDING';
}

export type BackgroundMessage = ClickCapture | StartRecordingMessage | StopRecordingMessage;

export interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  tabId: number | null;
  error: string | null;
  mode: RecordingMode;
  numbered: boolean;
  /** Single-image mode: id of the current recording run's shared-image anchor
   * step, or null if this run hasn't captured its first click yet. Reset to
   * null on every START_RECORDING so each run gets its own fresh image instead
   * of resuming an older group. */
  groupAnchorId: string | null;
}

// Preserve the existing key so renaming the product does not discard an
// in-progress local recording during the upgrade.
export const RECORDING_STATE_KEY = 'scribe:recordingState';

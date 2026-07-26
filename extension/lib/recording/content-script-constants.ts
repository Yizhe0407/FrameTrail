import { browser } from 'wxt/browser';
import { KEEPALIVE_PORT_NAME } from '../runtime/keep-alive';

/** The background matches keep-alive ports by this exact name; both sides
 * derive it from the canonical lib/runtime/keep-alive export. */
export const CONTENT_KEEPALIVE_PORT_NAME = KEEPALIVE_PORT_NAME;
export const CONTENT_KEEPALIVE_INTERVAL_MS = 20_000;

/** Budget for a recording control command (toolbar or shield) before the UI
 * gives up on the background. Shared by the in-page toolbar and the shield
 * page so both surfaces re-enable their controls on the same schedule. */
export const RECORDING_CONTROL_TIMEOUT_MS = 15_000;

/** Error copy surfaced whenever the recording control channel is broken or
 * times out; identical across the toolbar, shield, and content script. */
export const RECORDING_CHANNEL_LOST_MESSAGE = '錄製服務已中斷，請重新整理頁面後再試一次。';
export const STEP_FOLLOWUP_EVENTS = [
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
] as const;

/** Same-target debounce window shared by the top-frame step recorder and the
 * child-frame relay so a rapid double gesture dedups identically everywhere. */
export const STEP_DEDUP_MS = 400;
/** Trailing-trusted-click suppression window, likewise shared by the top
 * frame and every instrumented child frame. */
export const STEP_LATE_CLICK_SUPPRESS_MS = 2_000;

export const CLEANUP_EVENT = `frame_trail_cleanup_${browser.runtime.id}`;

/** Events a frozen snapshot page must consume before the input shield is
 * ready (and, in child frames, for the whole snapshot). Kept aligned with the
 * shield page's own freeze list so the pre-ready window has no gaps. */
export const SNAPSHOT_FREEZE_EVENTS = [
  'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click',
  'dblclick', 'auxclick', 'contextmenu', 'submit', 'keydown', 'keyup', 'keypress',
  'beforeinput', 'input', 'wheel', 'touchstart', 'touchmove', 'touchend',
  'dragstart', 'drop', 'selectstart',
] as const;

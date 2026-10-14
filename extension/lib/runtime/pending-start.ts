import { browser } from 'wxt/browser';
import { isRecord } from '../shared/validation';
import type { RecordingMode } from '../storage/recording-state';

/**
 * A start request parked across the cross-tab permission prompt. Chromium
 * destroys the action popup the moment its permission dialog steals focus, so
 * the popup cannot be trusted to continue the start after the user grants.
 * The popup persists this intent first; the background (which survives) picks
 * it up from permissions.onAdded and finishes the start. Whoever removes the
 * intent first owns the start, so a popup that does survive (Firefox) and the
 * background never both start.
 */
export interface PendingStart {
  mode: RecordingMode;
  tabId: number;
  createdAt: number;
}

const STORAGE_KEY = 'frametrail:pending-start:v1';
/** A grant this long after the click is no longer the user's start gesture. */
export const PENDING_START_TTL_MS = 2 * 60 * 1000;

function normalize(value: unknown, now: number): PendingStart | null {
  if (!isRecord(value)) return null;
  const { mode, tabId, createdAt } = value;
  if (mode !== 'steps' && mode !== 'snapshot') return null;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (now - createdAt > PENDING_START_TTL_MS || createdAt - now > PENDING_START_TTL_MS) return null;
  return { mode, tabId, createdAt };
}

export async function parkPendingStart(mode: RecordingMode, tabId: number, now = Date.now()): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: { mode, tabId, createdAt: now } satisfies PendingStart });
}

export async function discardPendingStart(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

/** Removes and returns the parked intent; null when absent, stale or already claimed. */
export async function claimPendingStart(now = Date.now()): Promise<PendingStart | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const pending = normalize(stored[STORAGE_KEY], now);
  if (stored[STORAGE_KEY] === undefined) return null;
  await browser.storage.local.remove(STORAGE_KEY);
  return pending;
}

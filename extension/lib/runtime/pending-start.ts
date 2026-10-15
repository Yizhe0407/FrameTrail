import { browser } from 'wxt/browser';
import { isRecord } from '../shared/validation';
import type { RecordingMode } from '../storage/recording-state';

/** Chromium destroys the popup when its permission dialog opens, so the background finishes a start parked here. Whoever claims it first owns the start. */
export interface PendingStart {
  mode: RecordingMode;
  tabId: number;
  /** The Guide the resumed run appends to; null means a fresh Guide, so a
   * target picked before the permission dialog survives the popup closing. */
  guideId: string | null;
  createdAt: number;
}

const STORAGE_KEY = 'stepmark:pending-start:v1';
export const PENDING_START_TTL_MS = 2 * 60 * 1000;

function normalize(value: unknown, now: number): PendingStart | null {
  if (!isRecord(value)) return null;
  const { mode, tabId, guideId, createdAt } = value;
  if (mode !== 'steps' && mode !== 'snapshot') return null;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return null;
  if (guideId !== null && (typeof guideId !== 'string' || guideId.length === 0)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (now - createdAt > PENDING_START_TTL_MS || createdAt - now > PENDING_START_TTL_MS) return null;
  return { mode, tabId, guideId, createdAt };
}

export async function parkPendingStart(
  start: Pick<PendingStart, 'mode' | 'tabId' | 'guideId'>,
  now = Date.now(),
): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: { ...start, createdAt: now } satisfies PendingStart });
}

export async function discardPendingStart(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

export async function claimPendingStart(now = Date.now()): Promise<PendingStart | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const pending = normalize(stored[STORAGE_KEY], now);
  if (stored[STORAGE_KEY] === undefined) return null;
  await browser.storage.local.remove(STORAGE_KEY);
  return pending;
}

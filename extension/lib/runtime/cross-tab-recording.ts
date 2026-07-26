import { browser } from 'wxt/browser';

/**
 * Increment this when the cross-tab permission ask changes enough that users
 * who previously declined should be asked once more. Each version gets its own
 * local-storage key, so an old decline never suppresses a newer ask.
 */
export const CROSS_TAB_DECLINE_VERSION = 1 as const;
export const CROSS_TAB_DECLINE_STORAGE_KEY = `frametrail:cross-tab-decline:v${CROSS_TAB_DECLINE_VERSION}`;

export interface CrossTabDeclineState {
  version: typeof CROSS_TAB_DECLINE_VERSION;
  declined: true;
  declinedAt: number;
}

/** Returns a valid marker, or null for missing, stale, or malformed data. */
export function normalizeCrossTabDeclineState(value: unknown): CrossTabDeclineState | null {
  if (!value || typeof value !== 'object') return null;

  const state = value as Partial<CrossTabDeclineState>;
  if (
    state.version !== CROSS_TAB_DECLINE_VERSION ||
    state.declined !== true ||
    !Number.isFinite(state.declinedAt) ||
    state.declinedAt! < 0
  ) {
    return null;
  }

  return {
    version: CROSS_TAB_DECLINE_VERSION,
    declined: true,
    declinedAt: state.declinedAt!,
  };
}

/**
 * Whether the user has already declined the <all_urls> ask at a steps-recording
 * start. A remembered decline suppresses the automatic prompt on later starts;
 * the popup still offers a passive opt-in affordance.
 */
export async function hasDeclinedCrossTabRecording(): Promise<boolean> {
  const stored = await browser.storage.local.get(CROSS_TAB_DECLINE_STORAGE_KEY);
  return normalizeCrossTabDeclineState(stored[CROSS_TAB_DECLINE_STORAGE_KEY]) !== null;
}

export async function markCrossTabRecordingDeclined(declinedAt = Date.now()): Promise<CrossTabDeclineState> {
  if (!Number.isFinite(declinedAt) || declinedAt < 0) {
    throw new RangeError('declinedAt must be a non-negative finite timestamp');
  }

  const state: CrossTabDeclineState = {
    version: CROSS_TAB_DECLINE_VERSION,
    declined: true,
    declinedAt,
  };
  await browser.storage.local.set({ [CROSS_TAB_DECLINE_STORAGE_KEY]: state });
  return state;
}

export async function clearCrossTabRecordingDecline(): Promise<void> {
  await browser.storage.local.remove(CROSS_TAB_DECLINE_STORAGE_KEY);
}

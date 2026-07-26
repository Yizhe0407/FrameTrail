import { createVersionedMarkerStore } from './versioned-marker-store';

/**
 * Increment this when the cross-tab permission ask changes enough that users
 * who previously declined should be asked once more. Each version gets its own
 * local-storage key, so an old decline never suppresses a newer ask.
 */
export const CROSS_TAB_DECLINE_VERSION = 1 as const;

const store = createVersionedMarkerStore({
  name: 'cross-tab-decline',
  version: CROSS_TAB_DECLINE_VERSION,
  flagField: 'declined',
  atField: 'declinedAt',
});

export const CROSS_TAB_DECLINE_STORAGE_KEY = store.storageKey;

export interface CrossTabDeclineState {
  version: typeof CROSS_TAB_DECLINE_VERSION;
  declined: true;
  declinedAt: number;
}

/** Returns a valid marker, or null for missing, stale, or malformed data. */
export function normalizeCrossTabDeclineState(value: unknown): CrossTabDeclineState | null {
  return store.normalize(value);
}

/**
 * Whether the user has already declined the <all_urls> ask at a steps-recording
 * start. A remembered decline suppresses the automatic prompt on later starts;
 * the popup still offers a passive opt-in affordance.
 */
export async function hasDeclinedCrossTabRecording(): Promise<boolean> {
  return store.isMarked();
}

export function markCrossTabRecordingDeclined(declinedAt = Date.now()): Promise<CrossTabDeclineState> {
  return store.mark(declinedAt);
}

export async function clearCrossTabRecordingDecline(): Promise<void> {
  await store.clear();
}

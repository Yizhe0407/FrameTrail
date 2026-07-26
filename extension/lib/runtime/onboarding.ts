import { browser } from 'wxt/browser';
import type { RecordingMode } from '@/lib/storage/recording-state';
import { createVersionedMarkerStore } from './versioned-marker-store';

/**
 * Increment this when returning users should see a materially changed
 * onboarding flow. Each version gets its own local-storage key, so an older
 * completion marker never suppresses a newer onboarding experience.
 */
export const ONBOARDING_VERSION = 1 as const;

const store = createVersionedMarkerStore({
  name: 'onboarding',
  version: ONBOARDING_VERSION,
  flagField: 'completed',
  atField: 'completedAt',
});

export const ONBOARDING_STORAGE_KEY = store.storageKey;

export interface OnboardingState {
  version: typeof ONBOARDING_VERSION;
  completed: true;
  completedAt: number;
}

/** Returns a valid marker, or null for missing, stale, or malformed data. */
export function normalizeOnboardingState(value: unknown): OnboardingState | null {
  return store.normalize(value);
}

export async function getOnboardingState(): Promise<OnboardingState | null> {
  return store.get();
}

export async function hasCompletedOnboarding(): Promise<boolean> {
  return store.isMarked();
}

export async function shouldShowOnboarding(): Promise<boolean> {
  return !(await hasCompletedOnboarding());
}

/** Persists completion in extension-local browser storage only. */
export function markOnboardingComplete(completedAt = Date.now()): Promise<OnboardingState> {
  return store.mark(completedAt);
}


/** The bundled, extension-only page used for first-run practice. */
export const PRACTICE_PAGE_PATH = '/practice.html' as const;

/**
 * Opens a practice tab using the extension runtime URL. This deliberately does
 * not accept a caller-provided URL, so onboarding can never send users to an
 * external site.
 */
export async function openLocalPracticePage(mode: RecordingMode): Promise<void> {
  const url = new URL(browser.runtime.getURL(PRACTICE_PAGE_PATH));
  url.searchParams.set('mode', mode);
  await browser.tabs.create({ url: url.toString() });
}

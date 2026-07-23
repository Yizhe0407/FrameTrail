import { browser } from 'wxt/browser';
import type { RecordingMode } from '@/lib/runtime/messages';

/**
 * Increment this when returning users should see a materially changed
 * onboarding flow. Each version gets its own local-storage key, so an older
 * completion marker never suppresses a newer onboarding experience.
 */
export const ONBOARDING_VERSION = 1 as const;
export const ONBOARDING_STORAGE_KEY = `frametrail:onboarding:v${ONBOARDING_VERSION}`;

export interface OnboardingState {
  version: typeof ONBOARDING_VERSION;
  completed: true;
  completedAt: number;
}

/** Returns a valid marker, or null for missing, stale, or malformed data. */
export function normalizeOnboardingState(value: unknown): OnboardingState | null {
  if (!value || typeof value !== 'object') return null;

  const state = value as Partial<OnboardingState>;
  if (
    state.version !== ONBOARDING_VERSION ||
    state.completed !== true ||
    !Number.isFinite(state.completedAt) ||
    state.completedAt! < 0
  ) {
    return null;
  }

  return {
    version: ONBOARDING_VERSION,
    completed: true,
    completedAt: state.completedAt!,
  };
}

export async function getOnboardingState(): Promise<OnboardingState | null> {
  const stored = await browser.storage.local.get(ONBOARDING_STORAGE_KEY);
  return normalizeOnboardingState(stored[ONBOARDING_STORAGE_KEY]);
}

export async function hasCompletedOnboarding(): Promise<boolean> {
  return (await getOnboardingState()) !== null;
}

export async function shouldShowOnboarding(): Promise<boolean> {
  return !(await hasCompletedOnboarding());
}

/** Persists completion in extension-local browser storage only. */
export async function markOnboardingComplete(completedAt = Date.now()): Promise<OnboardingState> {
  if (!Number.isFinite(completedAt) || completedAt < 0) {
    throw new RangeError('completedAt must be a non-negative finite timestamp');
  }

  const state: OnboardingState = {
    version: ONBOARDING_VERSION,
    completed: true,
    completedAt,
  };
  await browser.storage.local.set({ [ONBOARDING_STORAGE_KEY]: state });
  return state;
}

/** Removes only the current onboarding marker, allowing onboarding to reappear. */
export async function resetOnboarding(): Promise<void> {
  await browser.storage.local.remove(ONBOARDING_STORAGE_KEY);
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

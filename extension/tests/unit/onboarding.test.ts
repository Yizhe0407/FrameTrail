import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorage = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ getURL: vi.fn() }));
const tabs = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: localStorage,
    },
    runtime,
    tabs,
  },
}));

import {
  ONBOARDING_STORAGE_KEY,
  PRACTICE_PAGE_PATH,
  ONBOARDING_VERSION,
  getOnboardingState,
  hasCompletedOnboarding,
  markOnboardingComplete,
  openLocalPracticePage,
  normalizeOnboardingState,
  resetOnboarding,
  shouldShowOnboarding,
} from '@/lib/runtime/onboarding';

describe('onboarding state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.get.mockResolvedValue({});
    localStorage.set.mockResolvedValue(undefined);
    localStorage.remove.mockResolvedValue(undefined);
    runtime.getURL.mockReturnValue('chrome-extension://frametrail-test/practice.html');
    tabs.create.mockResolvedValue(undefined);
  });

  it('uses a versioned key so a new onboarding version can be shown independently', () => {
    expect(ONBOARDING_VERSION).toBe(1);
    expect(ONBOARDING_STORAGE_KEY).toBe(`frametrail:onboarding:v${ONBOARDING_VERSION}`);
  });

  it('treats missing, stale, and malformed markers as incomplete', async () => {
    expect(normalizeOnboardingState(undefined)).toBeNull();
    expect(normalizeOnboardingState({ version: 0, completed: true, completedAt: 10 })).toBeNull();
    expect(normalizeOnboardingState({ version: 1, completed: false, completedAt: 10 })).toBeNull();
    expect(normalizeOnboardingState({ version: 1, completed: true, completedAt: -1 })).toBeNull();

    localStorage.get.mockResolvedValue({
      [ONBOARDING_STORAGE_KEY]: { version: 0, completed: true, completedAt: 10 },
    });

    await expect(getOnboardingState()).resolves.toBeNull();
    await expect(hasCompletedOnboarding()).resolves.toBe(false);
    await expect(shouldShowOnboarding()).resolves.toBe(true);
    expect(localStorage.get).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY);
  });

  it('reads a valid current-version completion marker', async () => {
    const marker = { version: ONBOARDING_VERSION, completed: true, completedAt: 1234 } as const;
    localStorage.get.mockResolvedValue({ [ONBOARDING_STORAGE_KEY]: marker });

    await expect(getOnboardingState()).resolves.toEqual(marker);
    await expect(hasCompletedOnboarding()).resolves.toBe(true);
    await expect(shouldShowOnboarding()).resolves.toBe(false);
  });

  it('stores completion in browser local storage and returns the marker', async () => {
    const marker = await markOnboardingComplete(5678);

    expect(marker).toEqual({ version: ONBOARDING_VERSION, completed: true, completedAt: 5678 });
    expect(localStorage.set).toHaveBeenCalledOnce();
    expect(localStorage.set).toHaveBeenCalledWith({ [ONBOARDING_STORAGE_KEY]: marker });
  });

  it('rejects invalid completion timestamps instead of persisting them', async () => {
    await expect(markOnboardingComplete(Number.NaN)).rejects.toThrow(RangeError);
    await expect(markOnboardingComplete(-1)).rejects.toThrow(RangeError);
    expect(localStorage.set).not.toHaveBeenCalled();
  });

  it('opens practice only through the extension-local practice page', async () => {
    await openLocalPracticePage('snapshot');

    expect(runtime.getURL).toHaveBeenCalledWith(PRACTICE_PAGE_PATH);
    expect(tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://frametrail-test/practice.html?mode=snapshot',
    });
  });

  it('resets only the current onboarding marker', async () => {
    await resetOnboarding();
    expect(localStorage.remove).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY);
  });
});

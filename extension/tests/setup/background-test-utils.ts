import { vi } from 'vitest';

/**
 * Shared mock-fn table for the background service-worker suites. vi.mock
 * factories must stay file-local (vitest hoists them per test file), so each
 * suite wires its own factories to a table produced here:
 *
 *   const mocks = await vi.hoisted(async () =>
 *     (await import('../setup/background-test-utils')).makeBackgroundMocks());
 *
 * The table is a superset; suites use the slice they care about.
 */
export function makeBackgroundMocks() {
  return {
    messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
    tabActivatedListener: null as null | ((info: { tabId: number; windowId: number }) => void),
    windowFocusListener: null as null | ((windowId: number) => void),
    getGuide: vi.fn(),
    getStep: vi.fn(),
    getSteps: vi.fn(),
    addStep: vi.fn(),
    deleteStep: vi.fn(),
    deleteStepsForRun: vi.fn(),
    discardPristineGuide: vi.fn(),
    getRecordingState: vi.fn(),
    setRecordingState: vi.fn(),
    permissionsContains: vi.fn(),
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    tabsGet: vi.fn(),
    tabsUpdate: vi.fn(),
    tabsRemove: vi.fn(),
    tabsSendMessage: vi.fn(),
    windowsUpdate: vi.fn(),
    executeScript: vi.fn(),
    savePendingUndoRecord: vi.fn(),
    readPendingUndoRecord: vi.fn(),
    clearPendingUndoRecord: vi.fn(),
  };
}

export type BackgroundMocks = ReturnType<typeof makeBackgroundMocks>;

/**
 * (Re)imports the background entrypoint so each test starts a fresh
 * service-worker instance against the mocks configured in the calling file.
 */
export async function importBackground(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  await import('@/entrypoints/background');
}

/** Drains chained microtask work (mocked async storage/tabs round trips). */
export async function flushAsyncWork(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

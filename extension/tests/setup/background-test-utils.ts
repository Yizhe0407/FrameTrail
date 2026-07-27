import { vi } from 'vitest';
import type { BackgroundBrowserMockHandles } from './browser-mocks';

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
    tabUpdatedListener: null as
      | null
      | ((tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string }) => void),
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
    permissionsRequest: vi.fn(),
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    tabsGet: vi.fn(),
    tabsUpdate: vi.fn(),
    tabsRemove: vi.fn(),
    tabsSendMessage: vi.fn(),
    windowsUpdate: vi.fn(),
    executeScript: vi.fn(),
    insertCSS: vi.fn(),
    savePendingUndoRecord: vi.fn(),
    readPendingUndoRecord: vi.fn(),
    clearPendingUndoRecord: vi.fn(),
  };
}

export type BackgroundMocks = ReturnType<typeof makeBackgroundMocks>;

/**
 * Canonical vi.mock factory bodies for the background suites. vi.mock calls
 * themselves must stay file-local (vitest hoists them per test file), but the
 * factory BODY runs lazily on first module resolution, so each suite reduces
 * to one line per mocked module:
 *
 *   vi.mock('wxt/browser', async () =>
 *     (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
 *   vi.mock('@/lib/storage/db', async (importOriginal) =>
 *     (await import('../setup/background-test-utils')).mockStorageDbModule(mocks, importOriginal));
 *   vi.mock('@/lib/storage/storage', async (importOriginal) =>
 *     (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
 *   vi.mock('@/lib/recording/background/pending-undo-store', async () =>
 *     (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));
 */

/** Factory body for vi.mock('wxt/browser'): the full background surface wired
 * to the shared mock table. Wiring is a superset — suites that never touch an
 * API simply leave its mock untouched. `extraHandles` may override any entry. */
export async function mockWxtBrowserModule(
  mocks: BackgroundMocks,
  extraHandles: BackgroundBrowserMockHandles = {},
) {
  const { makeBackgroundBrowserMock } = await import('./browser-mocks');
  return {
    browser: makeBackgroundBrowserMock({
      onMessage: (listener) => {
        mocks.messageListener = listener;
      },
      onTabActivated: (listener) => {
        mocks.tabActivatedListener = listener;
      },
      onTabUpdated: (listener) => {
        mocks.tabUpdatedListener = listener;
      },
      onWindowFocusChanged: (listener) => {
        mocks.windowFocusListener = listener;
      },
      permissionsContains: mocks.permissionsContains,
      permissionsRequest: mocks.permissionsRequest,
      tabsCreate: mocks.tabsCreate,
      tabsGet: mocks.tabsGet,
      tabsQuery: mocks.tabsQuery,
      tabsRemove: mocks.tabsRemove,
      tabsSendMessage: mocks.tabsSendMessage,
      tabsUpdate: mocks.tabsUpdate,
      windowsUpdate: mocks.windowsUpdate,
      executeScript: mocks.executeScript,
      insertCSS: mocks.insertCSS,
      ...extraHandles,
    }),
  };
}

type StorageDbModule = typeof import('@/lib/storage/db');

/**
 * Factory body for vi.mock('@/lib/storage/db'): read/write step APIs routed
 * to the shared table, everything else real. Suites needing more (for example
 * guide reclamation) pass the extra members via `overrides`.
 */
export async function mockStorageDbModule(
  mocks: BackgroundMocks,
  importOriginal: () => Promise<StorageDbModule>,
  overrides: Partial<Record<keyof StorageDbModule, unknown>> = {},
) {
  const actual = await importOriginal();
  return {
    ...actual,
    getGuide: mocks.getGuide,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
    addStep: mocks.addStep,
    // Background persists captures through the batched write; route it to the
    // same per-step mock so existing addStep assertions keep observing rows.
    addSteps: async (steps: readonly unknown[]) => {
      for (const step of steps) await mocks.addStep(step);
    },
    deleteStep: mocks.deleteStep,
    ...overrides,
  };
}

/** Factory body for vi.mock('@/lib/storage/storage'): recording state only. */
export async function mockStorageModule(
  mocks: BackgroundMocks,
  importOriginal: () => Promise<typeof import('@/lib/storage/storage')>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    getRecordingState: mocks.getRecordingState,
    setRecordingState: mocks.setRecordingState,
  };
}

/** Factory body for vi.mock('@/lib/recording/background/pending-undo-store'). */
export function mockPendingUndoStoreModule(mocks: BackgroundMocks) {
  return {
    savePendingUndoRecord: mocks.savePendingUndoRecord,
    readPendingUndoRecord: mocks.readPendingUndoRecord,
    clearPendingUndoRecord: mocks.clearPendingUndoRecord,
  };
}

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

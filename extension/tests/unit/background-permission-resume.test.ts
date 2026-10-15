import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { ACTIVE_GUIDE_ID_KEY } from '@/lib/storage/storage';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';

const PENDING_START_KEY = 'frametrail:pending-start:v1';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());
const extra = vi.hoisted(() => ({
  permissionsAddedListener: null as null | ((permissions: { origins?: string[] }) => void),
  createGuide: vi.fn(),
  local: new Map<string, unknown>(),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks, {
    onPermissionsAdded: (listener) => {
      extra.permissionsAddedListener = listener;
    },
    // In-memory storage.local: the pending start and the Guide selection both live there.
    localGet: vi.fn(async (key: string) => (extra.local.has(key) ? { [key]: extra.local.get(key) } : {})),
    localSet: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) extra.local.set(key, value);
    }),
    localRemove: vi.fn(async (key: string) => void extra.local.delete(key)),
  }));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/guide-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockGuideRepositoryModule(mocks, importOriginal, {
    createGuide: extra.createGuide,
    discardPristineGuide: mocks.discardPristineGuide,
  }));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

const ALL_URLS_GRANT = { origins: ['<all_urls>'] };
const PENDING_TAB = { id: 7, windowId: 1, active: true, url: 'https://example.com/start' };
const GUIDE_ROW = (id: string) => ({ id, title: id, entryCount: 0, stepCount: 0 });

let storedState: RecordingState;

function parkPending(guideId: string | null, mode: 'steps' | 'snapshot' = 'steps'): void {
  extra.local.set(PENDING_START_KEY, { mode, tabId: 7, guideId, createdAt: Date.now() });
}

/** Fires the grant the way the browser does once the user accepts the dialog. */
async function grantAllUrls(permissions: { origins?: string[] } = ALL_URLS_GRANT): Promise<void> {
  extra.permissionsAddedListener?.(permissions);
  await flushAsyncWork(200);
}

/** The first state the resumed start persisted for a run, i.e. which Guide it claimed. */
function startedRunState(): RecordingState | undefined {
  return mocks.setRecordingState.mock.calls
    .map(([state]) => state as RecordingState)
    .find((state) => state.isRecording && state.phase === 'starting');
}

beforeEach(() => {
  vi.clearAllMocks();
  extra.permissionsAddedListener = null;
  extra.local.clear();
  storedState = makeRecordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.getGuide.mockImplementation(async (id: string) => GUIDE_ROW(id));
  mocks.discardPristineGuide.mockResolvedValue(true);
  extra.createGuide.mockResolvedValue(GUIDE_ROW('guide-new'));
  mocks.tabsGet.mockResolvedValue(PENDING_TAB);
  mocks.tabsQuery.mockResolvedValue([PENDING_TAB]);
  mocks.tabsUpdate.mockResolvedValue(PENDING_TAB);
  mocks.windowsUpdate.mockResolvedValue({});
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
  extra.local.set(ACTIVE_GUIDE_ID_KEY, 'guide-previous');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('start resumed after the cross-tab permission grant', () => {
  it('appends to the guide parked with the start instead of creating one', async () => {
    parkPending('guide-old');
    await importBackground();

    await grantAllUrls();

    expect(extra.createGuide).not.toHaveBeenCalled();
    expect(startedRunState()).toMatchObject({ sessionId: 'guide-old', tabId: 7, mode: 'steps' });
    // An existing guide must never be flagged reclaimable by the run's end.
    expect(startedRunState()?.autoCreatedGuideId).toBeNull();
    expect(extra.local.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-old');
    expect(extra.local.has(PENDING_START_KEY)).toBe(false);
  });

  it('records into a fresh reclaimable guide when none was chosen', async () => {
    parkPending(null, 'snapshot');
    await importBackground();

    await grantAllUrls();

    expect(extra.createGuide).toHaveBeenCalledOnce();
    expect(startedRunState()).toMatchObject({ sessionId: 'guide-new', mode: 'snapshot', autoCreatedGuideId: 'guide-new' });
    expect(extra.local.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-new');
  });

  it('restores the previous selection and keeps the guide when the resumed start fails', async () => {
    parkPending('guide-old');
    mocks.tabsGet.mockResolvedValue({ ...PENDING_TAB, url: 'chrome://extensions' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
    expect(extra.local.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-previous');
  });

  it('reclaims the fresh guide when a start without a chosen guide fails', async () => {
    parkPending(null);
    mocks.tabsGet.mockResolvedValue({ ...PENDING_TAB, url: 'chrome://extensions' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-new');
    expect(extra.local.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-previous');
  });

  it('does not start when the parked guide was deleted meanwhile', async () => {
    parkPending('guide-gone');
    mocks.getGuide.mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(extra.createGuide).not.toHaveBeenCalled();
    expect(extra.local.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-previous');
    expect(error).toHaveBeenCalledWith(
      '[frametrail] failed to resume the start after the permission grant',
      expect.any(Error),
    );
  });

  it('stays idle when nothing was parked', async () => {
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(extra.createGuide).not.toHaveBeenCalled();
  });

  it('ignores grants that are not the cross-tab permission', async () => {
    parkPending('guide-old');
    await importBackground();

    await grantAllUrls({ origins: ['https://example.com/*'] });

    expect(startedRunState()).toBeUndefined();
    // Still parked: only the real grant may claim it.
    expect(extra.local.has(PENDING_START_KEY)).toBe(true);
  });
});

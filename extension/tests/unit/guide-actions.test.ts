import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGuide: vi.fn(),
  getGuide: vi.fn(),
  deleteGuidePermanently: vi.fn(),
  getActiveGuideId: vi.fn(),
  setActiveGuideId: vi.fn(),
  clearActiveGuideId: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
vi.mock('@/lib/storage/db', async (importOriginal) => ({
  // Real defaultGuideTitle: the untouched check must recognise the exact
  // placeholder sanitizeGuide stamps onto unnamed guides.
  defaultGuideTitle: (await importOriginal<typeof import('@/lib/storage/db')>()).defaultGuideTitle,
  createGuide: mocks.createGuide,
  getGuide: mocks.getGuide,
  deleteGuidePermanently: mocks.deleteGuidePermanently,
}));
vi.mock('@/lib/storage/storage', () => ({
  getActiveGuideId: mocks.getActiveGuideId,
  setActiveGuideId: mocks.setActiveGuideId,
  clearActiveGuideId: mocks.clearActiveGuideId,
}));

import {
  clearSelectedGuide,
  discardUntouchedGuide,
  ensureSelectedGuide,
  getSelectedGuide,
  openSelectedGuideInEditor,
  selectGuide,
} from '@/lib/guide/guide-actions';
import { defaultGuideTitle } from '@/lib/storage/db';

function guide(id: string) {
  return {
    id,
    title: id,
    description: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** The exact shape createGuide leaves behind before anyone touches it:
 * sanitizeGuide replaces the empty title with the timestamped placeholder. */
function untouchedGuide(id: string, createdAt = 1) {
  return {
    id,
    title: defaultGuideTitle(createdAt),
    description: '',
    tags: [],
    sections: [],
    stepCount: 0,
    entryCount: 0,
    storageBytes: 0,
    contentRevision: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setActiveGuideId.mockResolvedValue(undefined);
  mocks.clearActiveGuideId.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true });
});

describe('Guide UI selection', () => {
  it('selects through ACTIVE_GUIDE_ID without reading or replacing RecordingState', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));

    await expect(selectGuide('guide-a')).resolves.toMatchObject({ id: 'guide-a' });

    expect(mocks.getGuide).toHaveBeenCalledWith('guide-a');
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('guide-a');
  });

  it('preserves invocation order when an earlier Guide lookup resolves slowly', async () => {
    const first = deferred<ReturnType<typeof guide>>();
    mocks.getGuide.mockImplementation((id: string) =>
      id === 'guide-a' ? first.promise : Promise.resolve(guide(id)),
    );

    const selectingA = selectGuide('guide-a');
    const selectingB = selectGuide('guide-b');
    await Promise.resolve();
    expect(mocks.getGuide).toHaveBeenCalledTimes(1);

    first.resolve(guide('guide-a'));
    await Promise.all([selectingA, selectingB]);

    expect(mocks.setActiveGuideId.mock.calls).toEqual([['guide-a'], ['guide-b']]);
  });

  it('creates a fresh Guide for a stale selection instead of resurrecting its deleted id', async () => {
    mocks.getActiveGuideId.mockResolvedValue('deleted-guide');
    mocks.getGuide.mockResolvedValue(undefined);
    mocks.createGuide.mockResolvedValue(guide('fresh-guide'));

    await expect(ensureSelectedGuide()).resolves.toMatchObject({ id: 'fresh-guide' });

    expect(mocks.clearActiveGuideId).toHaveBeenCalledWith('deleted-guide');
    expect(mocks.createGuide).toHaveBeenCalledOnce();
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('fresh-guide');
  });

  it('sends an explicit sessionId when opening the selected Guide', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));

    await openSelectedGuideInEditor('guide-a');

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'OPEN_EDITOR',
      sessionId: 'guide-a',
    });
  });


  it('reports a missing background response instead of dereferencing undefined', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));
    mocks.sendMessage.mockResolvedValue(undefined);

    await expect(openSelectedGuideInEditor('guide-a')).rejects.toThrow('無法連接編輯器服務');
  });

  it('compare-and-clears selection without consulting capture operation state', async () => {
    await clearSelectedGuide('guide-a');

    expect(mocks.clearActiveGuideId).toHaveBeenCalledWith('guide-a');
  });

  it('reads the selected Guide without clearing a stale selection', async () => {
    mocks.getActiveGuideId.mockResolvedValue('deleted-guide');
    mocks.getGuide.mockResolvedValue(undefined);

    await expect(getSelectedGuide()).resolves.toBeNull();

    expect(mocks.clearActiveGuideId).not.toHaveBeenCalled();
    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });
});

describe('auto-created Guide reclamation', () => {
  it('deletes a still-untouched Guide, clears it, and restores the previous selection', async () => {
    mocks.getGuide.mockImplementation(async (id: string) =>
      id === 'guide-fresh' ? untouchedGuide('guide-fresh') : guide(id),
    );

    await expect(discardUntouchedGuide('guide-fresh', 'guide-old')).resolves.toBe(true);

    expect(mocks.deleteGuidePermanently).toHaveBeenCalledExactlyOnceWith('guide-fresh');
    expect(mocks.clearActiveGuideId).toHaveBeenCalledWith('guide-fresh');
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('guide-old');
  });

  it('never deletes a Guide the user has meanwhile named or recorded into', async () => {
    mocks.getGuide.mockResolvedValueOnce({ ...untouchedGuide('guide-fresh'), stepCount: 2, entryCount: 2 });
    await expect(discardUntouchedGuide('guide-fresh')).resolves.toBe(false);

    mocks.getGuide.mockResolvedValueOnce({ ...untouchedGuide('guide-named'), title: '我的教學' });
    await expect(discardUntouchedGuide('guide-named')).resolves.toBe(false);

    expect(mocks.deleteGuidePermanently).not.toHaveBeenCalled();
    expect(mocks.clearActiveGuideId).not.toHaveBeenCalled();
  });

  it('skips restoring a previous selection that no longer exists', async () => {
    mocks.getGuide.mockImplementation(async (id: string) =>
      id === 'guide-fresh' ? untouchedGuide('guide-fresh') : undefined,
    );

    await expect(discardUntouchedGuide('guide-fresh', 'guide-gone')).resolves.toBe(true);

    expect(mocks.deleteGuidePermanently).toHaveBeenCalledExactlyOnceWith('guide-fresh');
    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });

  it('treats an already-deleted Guide as a no-op', async () => {
    mocks.getGuide.mockResolvedValue(undefined);

    await expect(discardUntouchedGuide('guide-gone')).resolves.toBe(false);

    expect(mocks.deleteGuidePermanently).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGuide: vi.fn(),
  getGuide: vi.fn(),
  getActiveGuideId: vi.fn(),
  setActiveGuideId: vi.fn(),
  clearActiveGuideId: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
vi.mock('@/lib/storage/db', () => ({
  createGuide: mocks.createGuide,
  getGuide: mocks.getGuide,
}));
vi.mock('@/lib/storage/storage', () => ({
  getActiveGuideId: mocks.getActiveGuideId,
  setActiveGuideId: mocks.setActiveGuideId,
  clearActiveGuideId: mocks.clearActiveGuideId,
}));

import {
  clearSelectedGuide,
  ensureSelectedGuide,
  openSelectedGuideInEditor,
  selectGuide,
} from '@/lib/guide/guide-actions';

function guide(id: string) {
  return {
    id,
    title: id,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
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
});
